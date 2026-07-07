import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { enabledBackfillCaps, backfillTodo, maybeBackfillRepo, resetBackfillThrottle } from './handlers';
import { backfilledCaps, BACKFILL_CAPS, type BackfillCap } from './state';
import { resetConfigCache, type PrMinderConfig } from './config';
import { resetAppBotLoginCache } from './github';
import { Logger } from './logger';

// A real RSA key (PKCS8 PEM) so installToken's appJWT can sign — the token POST itself is stubbed.
// Generated once via Web Crypto (typed by workers-types; runs under vitest's Node), matching the
// importPkcs8 path appJWT uses.
let TEST_PEM = '';
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  TEST_PEM = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
});

const cfg = (over: Partial<PrMinderConfig> = {}): PrMinderConfig => ({
  triggers: [], labels: {}, autoTriggerWorkflows: false,
  autoOpenPr: { enabled: false, skipBranches: [], skipBranchPatterns: [], targetBase: '', baseFromForkPoint: false, baseBranchPatterns: [], closeWhenEmpty: true, deleteBranchWhenEmpty: false },
  autoDescribePr: { enabled: false, model: '' },
  ...over,
});
const conflictLabel = { auto_add: false as const, create_label_if_missing_in_repo: false, color: '00ff00', mode: 'merge_conflict' as const, auto_merge_method: 'squash' as const };

describe('enabledBackfillCaps', () => {
  it('maps each feature flag to its capability', () => {
    expect(enabledBackfillCaps(cfg())).toEqual([]);
    expect(enabledBackfillCaps(cfg({ autoTriggerWorkflows: true }))).toEqual(['zombie']);
    expect(enabledBackfillCaps(cfg({ autoOpenPr: { ...cfg().autoOpenPr, enabled: true } }))).toEqual(['openpr']);
    expect(enabledBackfillCaps(cfg({ labels: { x: conflictLabel } }))).toEqual(['conflict']);
    expect(enabledBackfillCaps(cfg({ autoDescribePr: { enabled: true, model: '' } }))).toEqual(['describe']);
  });

  it('reports every enabled capability together', () => {
    const c = cfg({ autoTriggerWorkflows: true, autoOpenPr: { ...cfg().autoOpenPr, enabled: true }, labels: { x: conflictLabel }, autoDescribePr: { enabled: true, model: '' } });
    expect(enabledBackfillCaps(c).sort()).toEqual(['conflict', 'describe', 'openpr', 'zombie']);
  });
});

describe('backfillTodo (the gate decision)', () => {
  const openPrCfg = cfg({ autoOpenPr: { ...cfg().autoOpenPr, enabled: true } });

  it('owes a capability that is enabled but never backfilled — the ts0 bug', () => {
    // Repo was backfilled before auto_open_pr existed: its set lacks 'openpr' (here, empty). Enabling
    // auto_open_pr must make 'openpr' owed so the catch-up finally runs.
    expect(backfillTodo(new Set(), openPrCfg)).toEqual(['openpr']);
  });

  it('owes nothing once the enabled capability is recorded', () => {
    expect(backfillTodo(new Set<BackfillCap>(['openpr']), openPrCfg)).toEqual([]);
  });

  it('owes only the newly-enabled capability, not the already-done ones', () => {
    const both = cfg({ autoTriggerWorkflows: true, autoOpenPr: { ...cfg().autoOpenPr, enabled: true } });
    expect(backfillTodo(new Set<BackfillCap>(['zombie']), both)).toEqual(['openpr']);
  });

  it('owes nothing when the feature is disabled, even if never backfilled', () => {
    expect(backfillTodo(new Set(), cfg())).toEqual([]);
  });
});

describe('maybeBackfillRepo', () => {
  function fakeKV(initial: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initial));
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string, _opts?: unknown) => { store.set(k, v); },
      delete: async (k: string) => { store.delete(k); },
    };
    const env = { PR_STATE: kv, GITHUB_APP_ID: 'app', GITHUB_APP_PRIVATE_KEY: TEST_PEM } as any;
    return { env, store };
  }

  // Route fetch by URL substring; serves .json() and .text().
  function stubFetch(routes: Array<{ match: string; status?: number; body?: unknown }>) {
    const fn = vi.fn(async (url: string, _init?: any) => {
      const route = routes.find((r) => url.includes(r.match));
      if (!route) throw new Error(`unexpected fetch to ${url}`);
      const status = route.status ?? 200;
      const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {});
      return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }
  // The org config as the Contents API base64-encodes it.
  const orgCfg = (obj: unknown) => ({ match: '/repos/o/.github/contents/', status: 200, body: { encoding: 'base64', content: btoa(JSON.stringify(obj)) } });
  // A repo with one merge_conflict label -> the 'conflict' capability (the lightest sweep to drive).
  const conflictOrgCfg = { auto_label_pr: { 'needs-rebase': { mode: 'merge_conflict' } } };

  beforeEach(() => { resetConfigCache(); resetBackfillThrottle(); resetAppBotLoginCache(); });
  afterEach(() => vi.unstubAllGlobals());

  it('does nothing (no token mint, no fetch) once every capability is already backfilled', async () => {
    const { env } = fakeKV({ 'backfill:o/r': 'conflict,describe,openpr,zombie' });
    const fetchMock = stubFetch([{ match: '://', body: {} }]);
    await maybeBackfillRepo('o/r', 123, env, new Logger());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-sweeps a capability enabled after the first backfill (legacy value) and records it', async () => {
    // Legacy timestamp value: reads as "nothing done", so the now-enabled conflict cap is owed.
    const { env, store } = fakeKV({ 'backfill:o/r': '2026-05-02T19:18:44.000Z' });
    const fetchMock = stubFetch([
      { match: '/access_tokens', body: { token: 't' } },
      { match: '/repos/o/r/contents/', status: 404, body: {} }, // no per-repo config
      orgCfg(conflictOrgCfg),
      { match: '/pulls?state=open', body: [{ number: 5, draft: false }, { number: 6, draft: true }] },
    ]);

    await maybeBackfillRepo('o/r', 123, env, new Logger());

    // The conflict sweep enqueued a re-check for the open, non-draft PR (and skipped the draft)...
    expect(store.has('conflict:o/r#5')).toBe(true);
    expect(store.has('conflict:o/r#6')).toBe(false);
    // ...and the capability is now recorded so it won't sweep again.
    expect(await backfilledCaps(env.PR_STATE, 'o/r')).toEqual(new Set<BackfillCap>(['conflict']));
    expect(fetchMock.mock.calls.some(([u]) => (u as string).includes('/pulls?state=open'))).toBe(true);
  });

  it('throttles the re-check: an immediate second event does no work', async () => {
    const { env, store } = fakeKV({ 'backfill:o/r': '2026-05-02T19:18:44.000Z' });
    stubFetch([
      { match: '/access_tokens', body: { token: 't' } },
      { match: '/repos/o/r/contents/', status: 404, body: {} },
      orgCfg(conflictOrgCfg),
      { match: '/pulls?state=open', body: [{ number: 5, draft: false }] },
    ]);
    await maybeBackfillRepo('o/r', 123, env, new Logger()); // first event: sweeps
    store.delete('conflict:o/r#5'); // prove the second call doesn't re-enqueue
    await maybeBackfillRepo('o/r', 123, env, new Logger()); // throttled within the interval
    expect(store.has('conflict:o/r#5')).toBe(false);
  });

  it('does no sweep work when the recorded set already covers the enabled capability', async () => {
    // conflict already backfilled; config enables only conflict -> nothing owed (config still loads,
    // but no listOpenPulls / enqueue happens).
    const { env, store } = fakeKV({ 'backfill:o/r': 'conflict' });
    const fetchMock = stubFetch([
      { match: '/access_tokens', body: { token: 't' } },
      { match: '/repos/o/r/contents/', status: 404, body: {} },
      orgCfg(conflictOrgCfg),
    ]);
    await maybeBackfillRepo('o/r', 123, env, new Logger());
    expect(fetchMock.mock.calls.some(([u]) => (u as string).includes('/pulls?state=open'))).toBe(false);
    expect(store.size).toBe(1); // only the backfill key; no conflict reminders written
  });

  it('zombie backfill enqueues recheck reminders instead of reviving inline', async () => {
    const { env, store } = fakeKV({ 'pr:o/r#8': 'sha8' }); // #8 already evaluated at its current commit
    const fetchMock = stubFetch([
      { match: '/access_tokens', body: { token: 't' } },
      { match: '/repos/o/r/contents/', status: 404, body: {} },
      orgCfg({ auto_trigger_workflows: true }),
      { match: '/pulls?state=open', body: [
        { number: 5, draft: false, head: { sha: 'sha5' }, user: { login: 'github-actions[bot]' } },
        { number: 6, draft: false, head: { sha: 'sha6' }, user: { login: 'alice' } },
        { number: 7, draft: true, head: { sha: 'sha7' }, user: { login: 'github-actions[bot]' } },
        { number: 8, draft: false, head: { sha: 'sha8' }, user: { login: 'github-actions[bot]' } },
      ] },
    ]);
    await maybeBackfillRepo('o/r', 123, env, new Logger());
    expect(store.has('recheck:o/r#5')).toBe(true);  // bot-authored, unchecked -> enqueued for the cron
    expect(store.has('recheck:o/r#6')).toBe(false); // human author
    expect(store.has('recheck:o/r#7')).toBe(false); // draft
    expect(store.has('recheck:o/r#8')).toBe(false); // already checked at sha8
    // No inline evaluation: the event spends no /actions/runs read and no close/reopen PATCH.
    expect(fetchMock.mock.calls.some(([u]) => (u as string).includes('/actions/runs'))).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => (init as any)?.method === 'PATCH')).toBe(false);
    expect(await backfilledCaps(env.PR_STATE, 'o/r')).toEqual(new Set<BackfillCap>(['zombie']));
  });

  it('openpr backfill records the capability without any sweep (the reconcile hook owns it)', async () => {
    const { env } = fakeKV();
    const fetchMock = stubFetch([
      { match: '/access_tokens', body: { token: 't' } },
      { match: '/repos/o/r/contents/', status: 404, body: {} },
      orgCfg({ auto_open_pr: { enabled: true } }),
    ]);
    await maybeBackfillRepo('o/r', 123, env, new Logger());
    expect(await backfilledCaps(env.PR_STATE, 'o/r')).toEqual(new Set<BackfillCap>(['openpr']));
    // Nothing repo-sized in the event: no branch listing, no compares, no PR listing or creation.
    for (const frag of ['/branches', '/compare/', '/pulls']) {
      expect(fetchMock.mock.calls.some(([u]) => (u as string).includes(frag))).toBe(false);
    }
  });

  it('shares ONE pulls listing across the zombie/conflict/describe enqueues', async () => {
    const { env, store } = fakeKV();
    const fetchMock = stubFetch([
      { match: '/access_tokens', body: { token: 't' } },
      { match: '/repos/o/r/contents/', status: 404, body: {} },
      orgCfg({
        auto_trigger_workflows: true,
        auto_label_pr: { 'needs-rebase': { mode: 'merge_conflict' } },
        auto_open_pr: { enabled: true },
        auto_describe_pr: { enabled: true },
      }),
      { match: '/pulls?state=open', body: [
        { number: 5, draft: false, title: 'claude/x', head: { sha: 'sha5', ref: 'claude/x' }, user: { login: 'github-actions[bot]' } },
      ] },
      { match: '/app', body: { slug: 'pr-minder' } },
    ]);
    await maybeBackfillRepo('o/r', 123, env, new Logger());
    expect(fetchMock.mock.calls.filter(([u]) => (u as string).includes('/pulls?state=open'))).toHaveLength(1);
    expect(store.has('recheck:o/r#5')).toBe(true);
    expect(store.has('conflict:o/r#5')).toBe(true);
    expect(store.has('describe:o/r#5')).toBe(true);
    expect(await backfilledCaps(env.PR_STATE, 'o/r')).toEqual(new Set<BackfillCap>(BACKFILL_CAPS));
  });

  it('records each capability as it completes: one failing cap does not block the others', async () => {
    // Make the zombie enqueue fail (its recheck: KV put throws); conflict must still enqueue and be
    // recorded, so the failed cap alone retries after the throttle interval.
    const { env, store } = fakeKV();
    const realPut = env.PR_STATE.put;
    env.PR_STATE.put = async (k: string, v: string, opts?: unknown) => {
      if (k.startsWith('recheck:')) throw new Error('kv boom');
      return realPut(k, v, opts);
    };
    stubFetch([
      { match: '/access_tokens', body: { token: 't' } },
      { match: '/repos/o/r/contents/', status: 404, body: {} },
      orgCfg({ auto_trigger_workflows: true, auto_label_pr: { 'needs-rebase': { mode: 'merge_conflict' } } }),
      { match: '/pulls?state=open', body: [{ number: 5, draft: false, head: { sha: 'sha5' }, user: { login: 'github-actions[bot]' } }] },
    ]);
    await maybeBackfillRepo('o/r', 123, env, new Logger());
    expect(store.has('conflict:o/r#5')).toBe(true);
    expect(await backfilledCaps(env.PR_STATE, 'o/r')).toEqual(new Set<BackfillCap>(['conflict']));
  });
});
