import { describe, it, expect, vi, afterEach } from 'vitest';
import { enableAutoMerge, disableAutoMerge, GhError } from './github';
import { Logger } from './logger';

// Auto-merge goes through GraphQL (there is no REST endpoint), so we stub `fetch` and
// assert on the request the helper builds. The helper only touches r.ok/r.status/r.text().
type FetchInit = { method: string; body: string; headers: Record<string, string> };

function stubFetch(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const fn = vi.fn(async (_url: string, _init: FetchInit) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const sentBody = (fn: ReturnType<typeof stubFetch>) => JSON.parse(fn.mock.calls[0][1].body);

afterEach(() => vi.unstubAllGlobals());

describe('enableAutoMerge', () => {
  it('POSTs the GraphQL enable mutation with the PR node id', async () => {
    const fetchMock = stubFetch(200, { data: { enablePullRequestAutoMerge: { pullRequest: { number: 5 } } } });
    await enableAutoMerge('o/r', 5, 'PR_node123', 'squash', 'tok', new Logger());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/graphql');
    expect(init.method).toBe('POST');
    const sent = sentBody(fetchMock);
    expect(sent.query).toContain('enablePullRequestAutoMerge');
    expect(sent.variables.pullRequestId).toBe('PR_node123');
  });

  it('uppercases the merge method to the PullRequestMergeMethod enum', async () => {
    for (const [method, expected] of [['squash', 'SQUASH'], ['merge', 'MERGE'], ['rebase', 'REBASE']] as const) {
      const fetchMock = stubFetch(200, { data: {} });
      await enableAutoMerge('o/r', 1, 'PR_x', method, 'tok', new Logger());
      expect(sentBody(fetchMock).variables.mergeMethod).toBe(expected);
      vi.unstubAllGlobals();
    }
  });

  it('swallows GraphQL logical errors (HTTP 200 + errors[])', async () => {
    stubFetch(200, { errors: [{ message: 'Pull request Auto merge is not allowed for this repository' }] });
    await expect(enableAutoMerge('o/r', 5, 'PR_x', 'squash', 'tok', new Logger())).resolves.toBeUndefined();
  });

  it('throws GhError on a transport failure (non-2xx)', async () => {
    stubFetch(500, 'boom');
    await expect(enableAutoMerge('o/r', 5, 'PR_x', 'squash', 'tok', new Logger())).rejects.toBeInstanceOf(GhError);
  });
});

describe('disableAutoMerge', () => {
  it('POSTs the GraphQL disable mutation with the PR node id', async () => {
    const fetchMock = stubFetch(200, { data: { disablePullRequestAutoMerge: { pullRequest: { number: 7 } } } });
    await disableAutoMerge('o/r', 7, 'PR_node7', 'tok', new Logger());

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/graphql');
    const sent = sentBody(fetchMock);
    expect(sent.query).toContain('disablePullRequestAutoMerge');
    expect(sent.variables).toEqual({ pullRequestId: 'PR_node7' });
  });

  it('swallows GraphQL logical errors (auto-merge was not enabled)', async () => {
    stubFetch(200, { errors: [{ message: 'Can not disable auto merge. Auto merge is not enabled' }] });
    await expect(disableAutoMerge('o/r', 7, 'PR_x', 'tok', new Logger())).resolves.toBeUndefined();
  });

  it('throws GhError on a transport failure (non-2xx)', async () => {
    stubFetch(502, 'bad gateway');
    await expect(disableAutoMerge('o/r', 7, 'PR_x', 'tok', new Logger())).rejects.toBeInstanceOf(GhError);
  });
});
