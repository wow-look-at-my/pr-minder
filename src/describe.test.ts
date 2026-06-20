import { describe, it, expect, vi, afterEach } from 'vitest';
import { maybeDescribePr, describeSafely, shouldDescribe, ZERO_DIFF_PREFIX } from './describe';
import { resetAppBotLoginCache } from './github';
import { Logger } from './logger';
import type { PrMinderConfig } from './config';

// A valid PKCS8 RSA private key in PEM form, so appBotLogin's appJWT actually imports (the 0-diff
// rename path resolves the App's own bot login before relabeling). Mirrors handlers.test.ts.
async function makePem(): Promise<string> {
  const kp = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', kp.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

describe('shouldDescribe', () => {
  it('fires on opened, ready_for_review, and synchronize', () => {
    expect(shouldDescribe('opened')).toBe(true);
    expect(shouldDescribe('ready_for_review')).toBe(true);
    expect(shouldDescribe('synchronize')).toBe(true);
  });

  it('ignores reopened (our own zombie close+reopen) and unrelated actions', () => {
    expect(shouldDescribe('reopened')).toBe(false);
    expect(shouldDescribe('labeled')).toBe(false);
    expect(shouldDescribe('submitted')).toBe(false);
  });
});

describe('maybeDescribePr', () => {
  // Routes fetches by URL substring AND method. String bodies are served as-is (the diff
  // endpoint returns raw text). `throws: true` simulates a network failure.
  function routeFetch(routes: Array<{ match: string; method?: string; status?: number; body?: unknown; throws?: boolean }>) {
    const fn = vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const route = routes.find((r) => url.includes(r.match) && (r.method ?? 'GET') === method);
      if (!route) throw new Error(`unexpected fetch ${method} ${url}`);
      if (route.throws) throw new TypeError('fetch failed');
      const status = route.status ?? 200;
      const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {});
      return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  function fakeKV(initial: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initial));
    return {
      store,
      kv: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => { store.set(k, v); },
        delete: async (k: string) => { store.delete(k); },
      },
    };
  }

  const HOOK = 'https://hooks.example/hook/pr-describe';
  const makeEnv = (kv: any, over: Record<string, unknown> = {}): any =>
    ({ PR_STATE: kv, DESCRIBE_HOOK_URL: HOOK, DESCRIBE_HOOK_API_KEY: 'hook-key', PR_MINDER_PUBLIC_URL: 'https://pm.example', ...over });
  const cfg = (over: Partial<PrMinderConfig['autoDescribePr']> = {}): PrMinderConfig =>
    ({ triggers: [], labels: {}, autoTriggerWorkflows: false, autoOpenPr: { enabled: false, skipBranches: [], skipBranchPatterns: [], targetBase: '', baseFromForkPoint: false, baseBranchPatterns: [], closeWhenEmpty: true, deleteBranchWhenEmpty: false }, autoDescribePr: { enabled: true, model: '', ...over } });
  const pr = { number: 7, title: 'claude/foo-123', body: 'old human notes' };
  const DIFF = 'diff --git a/x b/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';

  afterEach(() => { vi.unstubAllGlobals(); resetAppBotLoginCache(); });

  it('fetches the diff and hands it off to the hook with the old metadata and token', async () => {
    const { kv, store } = fakeKV();
    const fetchMock = routeFetch([
      { match: '/repos/o/r/pulls/7', body: DIFF },
      { match: '/hook/pr-describe', method: 'POST', status: 202, body: { run_id: 'run-abc' } },
    ]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger());

    const [diffUrl, diffInit] = fetchMock.mock.calls[0];
    expect(diffUrl).toBe('https://api.github.com/repos/o/r/pulls/7');
    expect(diffInit.headers.accept).toBe('application/vnd.github.diff');

    const post = fetchMock.mock.calls.find(([u]) => (u as string) === HOOK)!;
    expect((post[1] as any).headers['x-api-key']).toBe('hook-key');
    const payload = JSON.parse((post[1] as any).body);
    expect(payload.repo).toBe('o/r');
    expect(payload.pr_number).toBe(7);
    expect(payload.old_title).toBe('claude/foo-123');
    expect(payload.old_body).toBe('old human notes');
    expect(payload.diff).toBe(DIFF);
    expect(payload.model).toBe('');
    expect(payload.github_token).toBe('tok');
    // The hard-contract failure-callback fields are always sent.
    expect(payload.fail_callback_url).toBe('https://pm.example/_describe-result');
    expect(payload.fail_callback_key).toBe('hook-key');
    expect(payload.diff_hash).toMatch(/^[0-9a-f]{64}$/);

    expect(store.get('desc:o/r#7')).toBe(payload.diff_hash); // recorded marker == the hash sent for the callback
    expect(store.get('descrun:o/r#7')).toBe('run-abc'); // run id remembered for cancellation
  });

  it('withholds the old description (old_body empty) when omitOldBody is set, but keeps the old title and diff', async () => {
    const { kv } = fakeKV();
    const fetchMock = routeFetch([
      { match: '/repos/o/r/pulls/7', body: DIFF },
      { match: '/hook/pr-describe', method: 'POST', status: 202, body: { run_id: 'run-c' } },
    ]);
    // Simulates a describe triggered right after a merge-conflict resolution (handlers passes
    // omitOldBody when a merge_conflict label is present): the model must re-derive the description
    // from the resolved diff rather than carry the stale one forward.
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger(), { omitOldBody: true });

    const post = fetchMock.mock.calls.find(([u]) => (u as string) === HOOK)!;
    const payload = JSON.parse((post[1] as any).body);
    expect(payload.old_body).toBe(''); // prior description withheld from the model
    expect(payload.old_title).toBe('claude/foo-123'); // title still sent — it drives the validity check
    expect(payload.diff).toBe(DIFF); // diff (and therefore the dedup hash) is unaffected
  });

  it('skips the hand-off entirely when the diff is unchanged since the last run', async () => {
    const { kv } = fakeKV();
    routeFetch([
      { match: '/pulls/7', body: DIFF },
      { match: '/hook/pr-describe', method: 'POST', status: 202, body: { run_id: 'r1' } },
    ]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger());

    // Same diff again — only the diff GET is routable; a hook POST would throw.
    const fetchMock = routeFetch([{ match: '/pulls/7', body: DIFF }]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the superseded run before handing off a new diff', async () => {
    const { kv, store } = fakeKV({ 'descrun:o/r#7': 'run-old', 'desc:o/r#7': 'stale-hash' });
    const fetchMock = routeFetch([
      { match: '/pulls/7', body: DIFF },
      { match: '/hook/pr-describe/cancel/run-old', method: 'POST', status: 202, body: { status: 'cancelling' } },
      { match: '/hook/pr-describe', method: 'POST', status: 202, body: { run_id: 'run-new' } },
    ]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger());

    const urls = fetchMock.mock.calls.map(([u]) => u as string);
    const cancelIdx = urls.findIndex((u) => u.includes('/cancel/run-old'));
    const postIdx = urls.findIndex((u) => u === HOOK);
    expect(cancelIdx).toBeGreaterThan(-1);
    expect(postIdx).toBeGreaterThan(cancelIdx); // cancel strictly before the new hand-off
    expect(fetchMock.mock.calls[cancelIdx][1].headers['x-api-key']).toBe('hook-key');
    expect(store.get('descrun:o/r#7')).toBe('run-new');
  });

  it('still hands off when the cancel fails (best-effort)', async () => {
    const { kv, store } = fakeKV({ 'descrun:o/r#7': 'run-old' });
    routeFetch([
      { match: '/pulls/7', body: DIFF },
      { match: '/hook/pr-describe/cancel/run-old', method: 'POST', throws: true },
      { match: '/hook/pr-describe', method: 'POST', status: 202, body: { run_id: 'run-new' } },
    ]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger());
    expect(store.get('descrun:o/r#7')).toBe('run-new');
    expect(store.get('desc:o/r#7')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws on missing DESCRIBE_HOOK_URL — enabled-but-unconfigured is a misconfiguration, not an opt-out', async () => {
    const { kv } = fakeKV();
    const fetchMock = routeFetch([]);
    await expect(maybeDescribePr(makeEnv(kv, { DESCRIBE_HOOK_URL: undefined }), 'o/r', pr, cfg(), 'tok', new Logger()))
      .rejects.toThrow(/DESCRIBE_HOOK_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on missing PR_MINDER_PUBLIC_URL — the failure-callback URL is required, not optional', async () => {
    const { kv } = fakeKV();
    const fetchMock = routeFetch([]);
    await expect(maybeDescribePr(makeEnv(kv, { PR_MINDER_PUBLIC_URL: undefined }), 'o/r', pr, cfg(), 'tok', new Logger()))
      .rejects.toThrow(/PR_MINDER_PUBLIC_URL/);
    expect(fetchMock).not.toHaveBeenCalled(); // checked before any diff fetch or hand-off
  });

  it('skips quietly when the diff is empty and the PR is not identifiable as our bot', async () => {
    const { kv } = fakeKV();
    const fetchMock = routeFetch([{ match: '/pulls/7', body: '' }]);
    // No GITHUB_APP_ID/KEY -> appBotLogin can't resolve -> no relabel, no hook POST: just the diff GET.
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks a 0-diff PR from our own bot with a [zero diff] title instead of skipping', async () => {
    const { kv } = fakeKV();
    const pem = await makePem();
    const botPr = { number: 7, title: 'claude/foo-123', body: 'claude/foo-123', user: { login: 'pr-minder[bot]' }, head: { ref: 'claude/foo-123' } };
    const fetchMock = routeFetch([
      { match: 'api.github.com/app', body: { slug: 'pr-minder' } },
      { match: '/repos/o/r/pulls/7', method: 'GET', body: '' }, // empty diff
      { match: '/repos/o/r/pulls/7', method: 'PATCH', status: 200, body: {} },
    ]);
    await maybeDescribePr(makeEnv(kv, { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: pem }), 'o/r', botPr, cfg(), 'tok', new Logger());

    const patch = fetchMock.mock.calls.find(([, i]) => (i as any)?.method === 'PATCH');
    expect(patch).toBeTruthy();
    const sent = JSON.parse((patch![1] as any).body);
    expect(sent.title).toBe(`${ZERO_DIFF_PREFIX} claude/foo-123`);
    expect(sent.body).toContain('no net diff');
    // An empty diff is never handed off to the describe hook.
    expect(fetchMock.mock.calls.some(([u]) => (u as string) === HOOK)).toBe(false);
  });

  it('leaves a 0-diff PR from a non-bot author untouched (never relabels a human PR)', async () => {
    const { kv } = fakeKV();
    const pem = await makePem();
    const humanPr = { number: 7, title: 'My real title', body: 'b', user: { login: 'octocat' }, head: { ref: 'feature' } };
    const fetchMock = routeFetch([
      { match: 'api.github.com/app', body: { slug: 'pr-minder' } },
      { match: '/repos/o/r/pulls/7', method: 'GET', body: '' },
    ]);
    // A stray PATCH would throw "unexpected fetch" in routeFetch, so the absence of a reject also proves no relabel.
    await maybeDescribePr(makeEnv(kv, { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: pem }), 'o/r', humanPr, cfg(), 'tok', new Logger());
    expect(fetchMock.mock.calls.some(([, i]) => (i as any)?.method === 'PATCH')).toBe(false);
  });

  it('does not re-mark a PR whose title is already the [zero diff] marker (idempotent)', async () => {
    const { kv } = fakeKV();
    const pem = await makePem();
    const marked = { number: 7, title: `${ZERO_DIFF_PREFIX} claude/foo-123`, body: 'x', user: { login: 'pr-minder[bot]' }, head: { ref: 'claude/foo-123' } };
    const fetchMock = routeFetch([
      { match: 'api.github.com/app', body: { slug: 'pr-minder' } },
      { match: '/repos/o/r/pulls/7', method: 'GET', body: '' },
    ]);
    await maybeDescribePr(makeEnv(kv, { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: pem }), 'o/r', marked, cfg(), 'tok', new Logger());
    expect(fetchMock.mock.calls.some(([, i]) => (i as any)?.method === 'PATCH')).toBe(false);
  });

  it('falls back to the files API when the unified diff is 406 (too large), then hands off the reassembled diff', async () => {
    const { kv, store } = fakeKV();
    const files = [
      { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' },
      { filename: 'img.png', status: 'added', additions: 0, deletions: 0 }, // binary: no patch
    ];
    const fetchMock = routeFetch([
      { match: '/pulls/7/files', body: files }, // more specific match must come first
      { match: '/pulls/7', status: 406, body: 'too big' },
      { match: '/hook/pr-describe', method: 'POST', status: 202, body: { run_id: 'run-z' } },
    ]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger());

    const post = fetchMock.mock.calls.find(([u]) => (u as string) === HOOK)!;
    expect(post).toBeTruthy();
    const sentDiff = JSON.parse((post[1] as any).body).diff as string;
    expect(sentDiff).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(sentDiff).toContain('+b');
    expect(sentDiff).toContain('diff --git a/img.png b/img.png');
    expect(sentDiff).toContain('no textual patch: status=added');
    expect(store.get('descrun:o/r#7')).toBe('run-z'); // handed off, run remembered
  });

  it('passes the per-repo model override through the payload', async () => {
    const { kv } = fakeKV();
    const fetchMock = routeFetch([
      { match: '/pulls/7', body: DIFF },
      { match: '/hook/pr-describe', method: 'POST', status: 202, body: { run_id: 'r' } },
    ]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg({ model: 'special-model' }), 'tok', new Logger());
    const post = fetchMock.mock.calls.find(([u]) => (u as string) === HOOK)!;
    expect(JSON.parse((post[1] as any).body).model).toBe('special-model');
  });

  it('rejects when the hook refuses the hand-off, leaving the KV marker untouched', async () => {
    const { kv, store } = fakeKV();
    routeFetch([
      { match: '/pulls/7', body: DIFF },
      { match: '/hook/pr-describe', method: 'POST', status: 401, body: { error: 'invalid api key' } },
    ]);
    await expect(maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger())).rejects.toThrow(/401/);
    expect(store.has('desc:o/r#7')).toBe(false); // next event retries
    expect(store.has('descrun:o/r#7')).toBe(false);
  });
});

describe('describeSafely', () => {
  function fakeKV(initial: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initial));
    return {
      store,
      kv: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => { store.set(k, v); },
        delete: async (k: string) => { store.delete(k); },
      },
    };
  }

  const cfg = (): PrMinderConfig =>
    ({ triggers: [], labels: {}, autoTriggerWorkflows: false, autoOpenPr: { enabled: false, skipBranches: [], skipBranchPatterns: [], targetBase: '', baseFromForkPoint: false, baseBranchPatterns: [], closeWhenEmpty: true, deleteBranchWhenEmpty: false }, autoDescribePr: { enabled: true, model: '' } });
  const pr = { number: 7, title: 't', body: 'b' };

  afterEach(() => vi.unstubAllGlobals());

  it('never rejects and logs at error level — failures go to Workers Logs, never the PR', async () => {
    const { kv } = fakeKV();
    const fetchMock = vi.fn(async () => { throw new Error('no fetch expected'); });
    vi.stubGlobal('fetch', fetchMock);
    const log = new Logger();
    await expect(
      describeSafely({ PR_STATE: kv, DESCRIBE_HOOK_URL: undefined } as any, 'o/r', pr, cfg(), 'tok', log),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled(); // no comment POST, no anything
    expect(log.toString()).toContain('ERROR: o/r#7: describe failed');
    expect(log.toString()).toContain('DESCRIBE_HOOK_URL');
  });
});
