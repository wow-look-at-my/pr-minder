import { describe, it, expect, vi, afterEach } from 'vitest';
import { maybeDescribePr, shouldDescribe } from './describe';
import { Logger } from './logger';
import type { PrMinderConfig } from './config';

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
    ({ PR_STATE: kv, DESCRIBE_HOOK_URL: HOOK, DESCRIBE_HOOK_API_KEY: 'hook-key', ...over });
  const cfg = (over: Partial<PrMinderConfig['autoDescribePr']> = {}): PrMinderConfig =>
    ({ triggers: [], labels: {}, autoTriggerWorkflows: false, autoOpenPr: { enabled: false, skipBranches: [], targetBase: '' }, autoDescribePr: { enabled: true, model: '', ...over } });
  const pr = { number: 7, title: 'claude/foo-123', body: 'old human notes' };
  const DIFF = 'diff --git a/x b/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';

  afterEach(() => vi.unstubAllGlobals());

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
    expect(payload).toEqual({
      repo: 'o/r',
      pr_number: 7,
      old_title: 'claude/foo-123',
      old_body: 'old human notes',
      diff: DIFF,
      model: '',
      github_token: 'tok',
    });

    expect(store.get('desc:o/r#7')).toMatch(/^[0-9a-f]{64}$/); // diff fingerprint recorded
    expect(store.get('descrun:o/r#7')).toBe('run-abc'); // run id remembered for cancellation
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

  it('does nothing (no fetches) without DESCRIBE_HOOK_URL', async () => {
    const { kv } = fakeKV();
    const fetchMock = routeFetch([]);
    await maybeDescribePr(makeEnv(kv, { DESCRIBE_HOOK_URL: undefined }), 'o/r', pr, cfg(), 'tok', new Logger());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips quietly when the diff is unavailable (e.g. 406 too large) or empty', async () => {
    const { kv } = fakeKV();
    routeFetch([{ match: '/pulls/7', status: 406, body: 'too big' }]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger());

    const fetchMock = routeFetch([{ match: '/pulls/7', body: '' }]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger());
    expect(fetchMock).toHaveBeenCalledTimes(1); // diff GET only — no hook POST either time
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
