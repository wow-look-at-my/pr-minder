import { describe, it, expect, vi, afterEach } from 'vitest';
import { enableAutoMerge, disableAutoMerge, mergePullRequest, updateBranch, retriggerWorkflows, hasWorkflowRuns, compareCommits, hasOpenPrForBranch, listOpenPulls, createPull, GhError } from './github';
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
    json: async () => JSON.parse(text),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const sentBody = (fn: ReturnType<typeof stubFetch>) => JSON.parse(fn.mock.calls[0][1].body);

// Route responses by URL substring, for flows that hit more than one endpoint.
function stubFetchRoutes(routes: Array<{ match: string; status: number; body: unknown }>) {
  const fn = vi.fn(async (url: string, _init: FetchInit) => {
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`unexpected fetch to ${url}`);
    const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
    return { ok: route.status >= 200 && route.status < 300, status: route.status, text: async () => text };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

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

  it('swallows other GraphQL logical errors without merging (e.g. auto-merge not allowed)', async () => {
    const fetchMock = stubFetchRoutes([
      { match: '/graphql', status: 200, body: { errors: [{ message: 'Pull request Auto merge is not allowed for this repository' }] } },
    ]);
    await expect(enableAutoMerge('o/r', 5, 'PR_x', 'squash', 'tok', new Logger())).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.every(([url]) => !url.includes('/merge'))).toBe(true);
  });

  it('falls back to a direct merge when the PR is already in "clean status"', async () => {
    const fetchMock = stubFetchRoutes([
      { match: '/graphql', status: 200, body: { data: { enablePullRequestAutoMerge: null }, errors: [{ type: 'UNPROCESSABLE', message: 'Pull request Pull request is in clean status' }] } },
      { match: '/pulls/163/merge', status: 200, body: { merged: true } },
    ]);
    await enableAutoMerge('o/r', 163, 'PR_x', 'rebase', 'tok', new Logger());

    const mergeCall = fetchMock.mock.calls.find(([url]) => url.includes('/pulls/163/merge'));
    expect(mergeCall).toBeDefined();
    expect(mergeCall![0]).toBe('https://api.github.com/repos/o/r/pulls/163/merge');
    expect(mergeCall![1].method).toBe('PUT');
    expect(JSON.parse(mergeCall![1].body).merge_method).toBe('rebase');
  });

  it('throws GhError on a transport failure (non-2xx)', async () => {
    stubFetch(500, 'boom');
    await expect(enableAutoMerge('o/r', 5, 'PR_x', 'squash', 'tok', new Logger())).rejects.toBeInstanceOf(GhError);
  });
});

describe('mergePullRequest', () => {
  it('PUTs the REST merge with the configured (lowercase) method', async () => {
    const fetchMock = stubFetch(200, { merged: true });
    await mergePullRequest('o/r', 5, 'squash', 'tok', new Logger());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/o/r/pulls/5/merge');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ merge_method: 'squash' });
  });

  it('swallows a 405 (PR not mergeable) without throwing', async () => {
    stubFetch(405, { message: 'Pull Request is not mergeable' });
    await expect(mergePullRequest('o/r', 5, 'squash', 'tok', new Logger())).resolves.toBeUndefined();
  });

  it('swallows a 409 (head moved) without throwing', async () => {
    stubFetch(409, { message: 'Head branch was modified. Review and try the merge again.' });
    await expect(mergePullRequest('o/r', 5, 'squash', 'tok', new Logger())).resolves.toBeUndefined();
  });

  it('throws on 5xx (transient)', async () => {
    stubFetch(503, 'service unavailable');
    await expect(mergePullRequest('o/r', 5, 'squash', 'tok', new Logger())).rejects.toBeInstanceOf(GhError);
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

describe('retriggerWorkflows', () => {
  it('PATCHes the PR closed then back open (close+reopen fires a fresh pull_request event)', async () => {
    const fetchMock = stubFetch(200, { number: 5 });
    await retriggerWorkflows('o/r', 5, 'tok', new Logger());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [closeUrl, closeInit] = fetchMock.mock.calls[0];
    expect(closeUrl).toBe('https://api.github.com/repos/o/r/pulls/5');
    expect(closeInit.method).toBe('PATCH');
    expect(JSON.parse(closeInit.body)).toEqual({ state: 'closed' });

    const [openUrl, openInit] = fetchMock.mock.calls[1];
    expect(openUrl).toBe('https://api.github.com/repos/o/r/pulls/5');
    expect(openInit.method).toBe('PATCH');
    expect(JSON.parse(openInit.body)).toEqual({ state: 'open' });
  });

  it('throws GhError if the close fails (and never attempts the reopen)', async () => {
    const fetchMock = stubFetch(403, { message: 'Resource not accessible by integration' });
    await expect(retriggerWorkflows('o/r', 5, 'tok', new Logger())).rejects.toBeInstanceOf(GhError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('hasWorkflowRuns', () => {
  it('queries the runs endpoint filtered by head_sha', async () => {
    const fetchMock = stubFetch(200, { total_count: 0, workflow_runs: [] });
    await hasWorkflowRuns('o/r', 'deadbeef', 'tok', new Logger());
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/actions/runs?head_sha=deadbeef&per_page=1');
  });

  it('is true when the head commit has at least one run', async () => {
    stubFetch(200, { total_count: 3, workflow_runs: [{ id: 1 }] });
    expect(await hasWorkflowRuns('o/r', 'sha', 'tok', new Logger())).toBe(true);
  });

  it('is false when the head commit has no runs (a zombie)', async () => {
    stubFetch(200, { total_count: 0, workflow_runs: [] });
    expect(await hasWorkflowRuns('o/r', 'sha', 'tok', new Logger())).toBe(false);
  });

  it('fails safe to true on a non-2xx, so a transient error never forces a reopen', async () => {
    stubFetch(500, 'boom');
    expect(await hasWorkflowRuns('o/r', 'sha', 'tok', new Logger())).toBe(true);
  });
});

describe('listOpenPulls', () => {
  it('follows pagination until a short page and returns every PR', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }));
    const page2 = [{ number: 101 }, { number: 102 }];
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes('page=2') ? page2 : page1),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const pulls = await listOpenPulls('o/r', 'tok', new Logger());
    expect(pulls).toHaveLength(102);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/pulls?state=open&per_page=100&page=1');
  });

  it('returns [] on a query error, so the sweep degrades to a no-op', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => [] })));
    expect(await listOpenPulls('o/r', 'tok', new Logger())).toEqual([]);
  });
});

describe('compareCommits', () => {
  it('compares base...head and returns ahead_by/behind_by', async () => {
    const fetchMock = stubFetch(200, { ahead_by: 2, behind_by: 5 });
    const cmp = await compareCommits('o/r', 'main', 'feature/x', 'tok', new Logger());
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/compare/main...feature/x');
    expect(cmp).toEqual({ ahead_by: 2, behind_by: 5 });
  });

  it('returns null on error', async () => {
    stubFetch(404, { message: 'Not Found' });
    expect(await compareCommits('o/r', 'main', 'x', 'tok', new Logger())).toBeNull();
  });
});

describe('hasOpenPrForBranch', () => {
  it('queries open PRs by head owner:branch and is true when one exists', async () => {
    const fetchMock = stubFetch(200, [{ number: 9 }]);
    const has = await hasOpenPrForBranch('o/r', 'feature/x', 'tok', new Logger());
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/pulls?head=o:feature%2Fx&state=open&per_page=1');
    expect(has).toBe(true);
  });

  it('is false when no open PR exists', async () => {
    stubFetch(200, []);
    expect(await hasOpenPrForBranch('o/r', 'b', 'tok', new Logger())).toBe(false);
  });

  it('fails safe to true on error, so a transient failure never opens a duplicate', async () => {
    stubFetch(500, 'boom');
    expect(await hasOpenPrForBranch('o/r', 'b', 'tok', new Logger())).toBe(true);
  });
});

describe('createPull', () => {
  it('POSTs head/base/title/body and returns the new PR number', async () => {
    const fetchMock = stubFetch(201, { number: 42 });
    const num = await createPull('o/r', 'feature/x', 'main', 'feature/x', 'body', 'tok', new Logger());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/o/r/pulls');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ head: 'feature/x', base: 'main', title: 'feature/x', body: 'body' });
    expect(num).toBe(42);
  });

  it('returns null on a 422 (no commits between base and head, or PR already exists)', async () => {
    stubFetch(422, { message: 'No commits between main and feature/x' });
    expect(await createPull('o/r', 'feature/x', 'main', 't', 'b', 'tok', new Logger())).toBeNull();
  });

  it('throws on 5xx (transient)', async () => {
    stubFetch(503, 'service unavailable');
    await expect(createPull('o/r', 'b', 'main', 't', 'b', 'tok', new Logger())).rejects.toBeInstanceOf(GhError);
  });
});

describe('updateBranch', () => {
  it('resolves on 202 Accepted', async () => {
    stubFetch(202, '');
    await expect(updateBranch('o/r', 1, 'tok', new Logger())).resolves.toBeUndefined();
  });

  it('swallows the "no new commits on the base branch" 422 (branch already current)', async () => {
    stubFetch(422, { message: 'There are no new commits on the base branch.' });
    await expect(updateBranch('o/r', 163, 'tok', new Logger())).resolves.toBeUndefined();
  });

  it('throws on a genuine 422 such as a merge conflict', async () => {
    stubFetch(422, { message: 'merge conflict between base and head' });
    await expect(updateBranch('o/r', 1, 'tok', new Logger())).rejects.toBeInstanceOf(GhError);
  });

  it('throws on non-422 failures (e.g. 403)', async () => {
    stubFetch(403, { message: 'Resource not accessible by integration' });
    await expect(updateBranch('o/r', 1, 'tok', new Logger())).rejects.toBeInstanceOf(GhError);
  });
});
