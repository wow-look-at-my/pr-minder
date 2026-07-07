import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { handle } from './handlers';
import { backfilledCaps, type BackfillCap } from './state';
import { resetConfigCache } from './config';
import { resetAppBotLoginCache } from './github';
import { Logger } from './logger';

// Per-event webhook paths must stay O(few GitHub calls): the inline repo-wide sweeps (close-empty's
// compare-per-PR, the install handlers' zombie/open-PR/auto-merge fan-out) blew Cloudflare's
// 50-subrequest cap on ~40-PR repos and 500'd live deliveries. These tests drive the real handle()
// entry point and assert the sweeps are gone — the pr-minder-reconcile hook owns them fleet-wide.

// A real RSA key (PKCS8 PEM) so installToken's appJWT can sign — the token POST itself is stubbed.
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

// Route fetch by URL substring; serves .json() and .text(). Order matters: the first matching
// route wins (so '/access_tokens' must precede '/app', which it contains).
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

beforeEach(() => { resetConfigCache(); resetAppBotLoginCache(); });
afterEach(() => vi.unstubAllGlobals());

describe('onPushToDefault (via handle)', () => {
  it('no longer runs the close-empty compare sweep — the reconcile hook owns it', async () => {
    // Repo fully backfilled, so the opportunistic block is a single KV read. auto_open_pr enabled
    // with close_when_empty defaulting on — exactly the config that used to trigger one
    // compareCommits per open PR right here (42 compares on a 42-PR repo).
    const { env } = fakeKV({ 'backfill:o/r': 'conflict,describe,openpr,zombie' });
    const fetchMock = stubFetch([
      { match: '/access_tokens', body: { token: 't' } },
      { match: '/repos/o/r/contents/', status: 404, body: {} },
      orgCfg({ auto_open_pr: { enabled: true } }),
      { match: '/pulls?state=open', body: [
        { number: 5, draft: false, labels: [], head: { ref: 'claude/b5', sha: 'sha5' }, base: { ref: 'main' } },
        { number: 6, draft: false, labels: [], head: { ref: 'claude/b6', sha: 'sha6' }, base: { ref: 'main' } },
      ] },
    ]);
    const payload = { ref: 'refs/heads/main', after: 'newtip', repository: { full_name: 'o/r', default_branch: 'main' }, installation: { id: 123 } };
    await handle('push', payload, env, new Logger());

    // The per-PR auto-update scan still lists open PRs — exactly once (the old close-empty sweep
    // added a second listing) — and spends nothing per PR beyond it.
    expect(fetchMock.mock.calls.filter(([u]) => (u as string).includes('/pulls?state=open'))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([u]) => (u as string).includes('/compare/'))).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => (init as any)?.method === 'PATCH')).toBe(false); // no closes
  });
});

describe('install events (via handle)', () => {
  it('enqueues KV reminders from ONE pulls listing — no auto-merge/branch/compare/runs fan-out', async () => {
    const { env, store } = fakeKV();
    const fetchMock = stubFetch([
      { match: '/access_tokens', body: { token: 't' } },
      { match: '/installation/repositories', body: { total_count: 1, repositories: [{ full_name: 'o/r' }] } },
      { match: '/repos/o/r/contents/', status: 404, body: {} },
      orgCfg({
        auto_trigger_workflows: true,
        auto_label_pr: { 'needs-rebase': { mode: 'merge_conflict' } },
        auto_open_pr: { enabled: true },
        auto_describe_pr: { enabled: true },
      }),
      { match: '/pulls?state=open', body: [
        { number: 5, draft: false, title: 'claude/x', head: { sha: 'sha5', ref: 'claude/x' }, user: { login: 'github-actions[bot]' } },
        { number: 6, draft: false, title: 'A real title', head: { sha: 'sha6', ref: 'feat' }, user: { login: 'alice' } },
      ] },
      { match: '/app', body: { slug: 'pr-minder' } },
    ]);
    await handle('installation', { action: 'created', installation: { id: 123 } }, env, new Logger());

    // Cheap KV reminders for the budgeted cron drains, and the capability set recorded:
    expect(store.has('recheck:o/r#5')).toBe(true);
    expect(store.has('recheck:o/r#6')).toBe(false); // human author — not a zombie candidate
    expect(store.has('conflict:o/r#5')).toBe(true);
    expect(store.has('conflict:o/r#6')).toBe(true); // conflict flags every open non-draft PR
    expect(store.has('describe:o/r#5')).toBe(true);
    expect(store.has('describe:o/r#6')).toBe(false); // human/retitled PRs never backfill-described
    expect(await backfilledCaps(env.PR_STATE, 'o/r')).toEqual(
      new Set<BackfillCap>(['conflict', 'describe', 'openpr', 'zombie']),
    );

    // ONE pulls listing, and none of the old inline sweeps:
    expect(fetchMock.mock.calls.filter(([u]) => (u as string).includes('/pulls?state=open'))).toHaveLength(1);
    for (const frag of ['/graphql', '/branches', '/compare/', '/actions/runs']) {
      expect(fetchMock.mock.calls.some(([u]) => (u as string).includes(frag))).toBe(false);
    }
  });
});
