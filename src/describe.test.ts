import { describe, it, expect, vi, afterEach } from 'vitest';
import { maybeDescribePr, parsePrMetadataResponse, shouldDescribe } from './describe';
import { Logger } from './logger';
import type { PrMinderConfig } from './config';

// A real reply that broke the strict CLI-script parser: the model invented an attribute on
// <suggestedDescription>, indented the tags, dropped the <prMetadata> wrapper, and emitted a tag
// (<oldDescriptionWasValid>) we don't ask for. The worker parser must take all of that in stride.
const GOSMOPOLITAN_REPLY = '<oldTitleWasValid>false</oldTitleWasValid>\n' +
  '  <oldDescriptionWasValid>false</oldDescriptionWasValid>\n' +
  '  <suggestedTitle>Implement native ARM64 macOS support for GOOS=cosmo</suggestedTitle>\n' +
  '  <suggestedDescription la="markdown">This PR implements comprehensive support for `GOOS=cosmo` on ARM64 macOS, transitioning from raw syscalls (which cause `SIGSYS` on Apple Silicon) to a `syslib` function pointer table provided by the APE loader.\n' +
  '\n' +
  '### Key Changes\n' +
  '- **Runtime & Syscalls**:\n' +
  '    - Introduced `syslib` integration for ARM64 macOS to route syscalls through Apple\'s frameworks.\n' +
  '    - Replaced `clone` with `pthread_create` for thread creation on macOS ARM64.\n' +
  '\n' +
  '### Test & Risk Notes\n' +
  '- New Go tests verify the structural integrity of APE polyglot binaries across four formats.\n' +
  '- Requires Go 1.24+ bootstrap toolchain for building.</suggestedDescription>';

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

describe('parsePrMetadataResponse', () => {
  it('parses the gosmopolitan reply (attributes on tags, no wrapper, extra tags)', () => {
    const meta = parsePrMetadataResponse(GOSMOPOLITAN_REPLY);
    expect(meta.oldTitleWasValid).toBe(false);
    expect(meta.suggestedTitle).toBe('Implement native ARM64 macOS support for GOOS=cosmo');
    expect(meta.suggestedDescription).toMatch(/^This PR implements comprehensive support/);
    expect(meta.suggestedDescription).toContain('### Test & Risk Notes');
    expect(meta.suggestedDescription).toMatch(/building\.$/);
  });

  it('parses a well-formed wrapped reply, even inside a code fence', () => {
    const meta = parsePrMetadataResponse(
      '```xml\n<prMetadata>\n<oldTitleWasValid>true</oldTitleWasValid>\n' +
      '<suggestedTitle>Fix the frobnicator</suggestedTitle>\n' +
      '<suggestedDescription>## Summary\nFixes it.</suggestedDescription>\n</prMetadata>\n```',
    );
    expect(meta.oldTitleWasValid).toBe(true);
    expect(meta.suggestedTitle).toBe('Fix the frobnicator');
    expect(meta.suggestedDescription).toBe('## Summary\nFixes it.');
  });

  it('decodes XML entities (named and numeric)', () => {
    const meta = parsePrMetadataResponse(
      '<oldTitleWasValid>false</oldTitleWasValid>' +
      '<suggestedTitle>Use &lt;div&gt; &amp; &quot;span&quot;</suggestedTitle>' +
      '<suggestedDescription>It&#x27;s A&#65;</suggestedDescription>',
    );
    expect(meta.suggestedTitle).toBe('Use <div> & "span"');
    expect(meta.suggestedDescription).toBe("It's AA");
  });

  it('throws when suggestedDescription is missing (the one hard requirement)', () => {
    expect(() => parsePrMetadataResponse('<oldTitleWasValid>false</oldTitleWasValid><suggestedTitle>x</suggestedTitle>'))
      .toThrow(/suggestedDescription/);
    expect(() => parsePrMetadataResponse('Sorry, I cannot help with that.')).toThrow(/suggestedDescription/);
  });

  it('fails safe to "title was valid" when oldTitleWasValid is missing or garbled', () => {
    expect(parsePrMetadataResponse('<suggestedDescription>d</suggestedDescription>').oldTitleWasValid).toBe(true);
    expect(parsePrMetadataResponse('<oldTitleWasValid>maybe</oldTitleWasValid><suggestedDescription>d</suggestedDescription>').oldTitleWasValid).toBe(true);
  });
});

describe('maybeDescribePr', () => {
  // Routes fetches by URL substring AND method — the PR diff GET and the metadata PATCH hit the
  // same /pulls/{num} URL. String bodies are served as-is (the diff endpoint returns raw text).
  function routeFetch(routes: Array<{ match: string; method?: string; status: number; body?: unknown }>) {
    const fn = vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const route = routes.find((r) => url.includes(r.match) && (r.method ?? 'GET') === method);
      if (!route) throw new Error(`unexpected fetch ${method} ${url}`);
      const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {});
      return { ok: route.status >= 200 && route.status < 300, status: route.status, text: async () => text, json: async () => JSON.parse(text) };
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

  const makeEnv = (kv: any, over: Record<string, unknown> = {}): any =>
    ({ PR_STATE: kv, AI_API_KEY: 'sk-test', AI_BASE_URL: 'https://ai.example/v1', AI_MODEL: 'test-model', ...over });
  const cfg = (over: Partial<PrMinderConfig['autoDescribePr']> = {}): PrMinderConfig =>
    ({ triggers: [], labels: {}, autoTriggerWorkflows: false, autoOpenPr: { enabled: false, skipBranches: [], targetBase: '' }, autoDescribePr: { enabled: true, model: '', ...over } });
  const pr = { number: 7, title: 'claude/foo-123', body: 'old human notes' };
  const DIFF = 'diff --git a/x b/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
  const chat = (content: string) => ({ choices: [{ message: { content } }] });

  afterEach(() => vi.unstubAllGlobals());

  it('fetches the full diff, calls the model with temp 0 and the old metadata, and PATCHes title+body', async () => {
    const { kv, store } = fakeKV();
    const fetchMock = routeFetch([
      { match: '/repos/o/r/pulls/7', status: 200, body: DIFF },
      { match: '/chat/completions', method: 'POST', status: 200, body: chat(GOSMOPOLITAN_REPLY) },
      { match: '/repos/o/r/pulls/7', method: 'PATCH', status: 200 },
    ]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger());

    const [diffUrl, diffInit] = fetchMock.mock.calls[0];
    expect(diffUrl).toBe('https://api.github.com/repos/o/r/pulls/7');
    expect(diffInit.headers.accept).toBe('application/vnd.github.diff');

    const chatCall = fetchMock.mock.calls.find(([u]) => (u as string).includes('/chat/completions'))!;
    expect(chatCall[0]).toBe('https://ai.example/v1/chat/completions');
    expect((chatCall[1] as any).headers.authorization).toBe('Bearer sk-test');
    const chatBody = JSON.parse((chatCall[1] as any).body);
    expect(chatBody.temperature).toBe(0);
    expect(chatBody.model).toBe('test-model');
    // system prompt, then two bare user messages: the old metadata JSON, then the diff.
    expect(chatBody.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'user']);
    expect(chatBody.messages[1].content).toContain('claude/foo-123'); // old title rides along
    expect(chatBody.messages[1].content).toContain('old human notes'); // old description rides along
    expect(chatBody.messages[2].content).toBe(DIFF); // the diff message is the diff, nothing else

    const patch = fetchMock.mock.calls.find(([, i]) => (i as any)?.method === 'PATCH')!;
    const patched = JSON.parse((patch[1] as any).body);
    expect(patched.title).toBe('Implement native ARM64 macOS support for GOOS=cosmo');
    expect(patched.body).toMatch(/^This PR implements/);

    expect(store.get('desc:o/r#7')).toMatch(/^[0-9a-f]{64}$/); // diff fingerprint recorded
  });

  it('keeps a valid existing title: the PATCH carries only the body', async () => {
    const { kv } = fakeKV();
    const fetchMock = routeFetch([
      { match: '/pulls/7', status: 200, body: DIFF },
      { match: '/chat/completions', method: 'POST', status: 200, body: chat('<oldTitleWasValid>true</oldTitleWasValid><suggestedTitle>ignored</suggestedTitle><suggestedDescription>new body</suggestedDescription>') },
      { match: '/pulls/7', method: 'PATCH', status: 200 },
    ]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger());
    const patch = fetchMock.mock.calls.find(([, i]) => (i as any)?.method === 'PATCH')!;
    expect(JSON.parse((patch[1] as any).body)).toEqual({ body: 'new body' });
  });

  it('skips the model entirely when the diff is unchanged since the last run', async () => {
    const { kv } = fakeKV();
    routeFetch([
      { match: '/pulls/7', status: 200, body: DIFF },
      { match: '/chat/completions', method: 'POST', status: 200, body: chat('<suggestedDescription>d</suggestedDescription>') },
      { match: '/pulls/7', method: 'PATCH', status: 200 },
    ]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger());

    // Same diff again — only the diff GET is routable; a model or PATCH call would throw.
    const fetchMock = routeFetch([{ match: '/pulls/7', status: 200, body: DIFF }]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing (no fetches) without the AI_API_KEY secret', async () => {
    const { kv } = fakeKV();
    const fetchMock = routeFetch([]);
    await maybeDescribePr(makeEnv(kv, { AI_API_KEY: undefined }), 'o/r', pr, cfg(), 'tok', new Logger());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips quietly when the diff is unavailable (e.g. 406 too large) or empty', async () => {
    const { kv } = fakeKV();
    routeFetch([{ match: '/pulls/7', status: 406, body: 'too big' }]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger());

    const fetchMock = routeFetch([{ match: '/pulls/7', status: 200, body: '' }]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger());
    expect(fetchMock).toHaveBeenCalledTimes(1); // diff GET only — no model call either time
  });

  it('uses the per-repo model override when configured', async () => {
    const { kv } = fakeKV();
    const fetchMock = routeFetch([
      { match: '/pulls/7', status: 200, body: DIFF },
      { match: '/chat/completions', method: 'POST', status: 200, body: chat('<suggestedDescription>d</suggestedDescription>') },
      { match: '/pulls/7', method: 'PATCH', status: 200 },
    ]);
    await maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg({ model: 'special-model' }), 'tok', new Logger());
    const chatCall = fetchMock.mock.calls.find(([u]) => (u as string).includes('/chat/completions'))!;
    expect(JSON.parse((chatCall[1] as any).body).model).toBe('special-model');
  });

  it('rejects on an unparseable model reply, leaving the PR and the KV marker untouched', async () => {
    const { kv, store } = fakeKV();
    routeFetch([
      { match: '/pulls/7', status: 200, body: DIFF },
      { match: '/chat/completions', method: 'POST', status: 200, body: chat('I refuse to answer in XML.') },
    ]);
    await expect(maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger())).rejects.toThrow(/suggestedDescription/);
    expect(store.has('desc:o/r#7')).toBe(false); // next event retries
  });

  it('does not record the diff fingerprint when the PR edit fails', async () => {
    const { kv, store } = fakeKV();
    routeFetch([
      { match: '/pulls/7', status: 200, body: DIFF },
      { match: '/chat/completions', method: 'POST', status: 200, body: chat('<suggestedDescription>d</suggestedDescription>') },
      { match: '/pulls/7', method: 'PATCH', status: 500, body: 'boom' },
    ]);
    await expect(maybeDescribePr(makeEnv(kv), 'o/r', pr, cfg(), 'tok', new Logger())).rejects.toThrow();
    expect(store.has('desc:o/r#7')).toBe(false);
  });
});
