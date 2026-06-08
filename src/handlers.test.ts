import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { conditionMet, isActionsBotPr, shouldSkipBranch, reviveIfZombie, shouldConsiderRevive, reconcileAutoMerge, reconcileInstall, startupReconcile } from './handlers';
import { Logger } from './logger';
import { resetConfigCache, type PrMinderConfig } from './config';

const noApprovers = async () => new Set<string>();
const approvers = (...names: string[]) => async () => new Set(names);
const pr = (labels: string[]) => ({ labels: labels.map((name) => ({ name })) });

describe('conditionMet', () => {
  describe('label', () => {
    it('matches when PR has the label', async () => {
      expect(await conditionMet({ label: 'auto-pr-update' }, pr(['auto-pr-update']), noApprovers)).toBe(true);
    });

    it('fails when PR lacks the label', async () => {
      expect(await conditionMet({ label: 'auto-pr-update' }, pr(['other']), noApprovers)).toBe(false);
    });

    it('fails when PR has no labels', async () => {
      expect(await conditionMet({ label: 'auto-pr-update' }, pr([]), noApprovers)).toBe(false);
    });
  });

  describe('approved_by', () => {
    it('matches when any listed user approved', async () => {
      expect(await conditionMet({ approved_by: ['alice', 'bob'] }, pr([]), approvers('bob'))).toBe(true);
    });

    it('fails when no listed user approved', async () => {
      expect(await conditionMet({ approved_by: ['alice'] }, pr([]), approvers('charlie'))).toBe(false);
    });

    it('fails with no approvals', async () => {
      expect(await conditionMet({ approved_by: ['alice'] }, pr([]), noApprovers)).toBe(false);
    });
  });

  describe('min_approvals', () => {
    it('matches when approval count meets threshold', async () => {
      expect(await conditionMet({ min_approvals: 2 }, pr([]), approvers('alice', 'bob'))).toBe(true);
    });

    it('matches at exact threshold', async () => {
      expect(await conditionMet({ min_approvals: 1 }, pr([]), approvers('alice'))).toBe(true);
    });

    it('fails when approval count is below threshold', async () => {
      expect(await conditionMet({ min_approvals: 2 }, pr([]), approvers('alice'))).toBe(false);
    });
  });

  describe('AND across keys', () => {
    it('requires all keys to pass', async () => {
      const condition = { label: 'auto-pr-update', min_approvals: 2 };
      expect(await conditionMet(condition, pr(['auto-pr-update']), approvers('a', 'b'))).toBe(true);
      expect(await conditionMet(condition, pr(['auto-pr-update']), approvers('a'))).toBe(false);
      expect(await conditionMet(condition, pr([]), approvers('a', 'b'))).toBe(false);
    });

    it('approved_by and min_approvals together require both', async () => {
      const condition = { approved_by: ['alice'], min_approvals: 2 };
      expect(await conditionMet(condition, pr([]), approvers('alice', 'bob'))).toBe(true);
      expect(await conditionMet(condition, pr([]), approvers('alice'))).toBe(false);
      expect(await conditionMet(condition, pr([]), approvers('bob', 'charlie'))).toBe(false);
    });
  });

  it('empty condition (no keys) passes trivially', async () => {
    expect(await conditionMet({}, pr([]), noApprovers)).toBe(true);
  });
});

describe('isActionsBotPr', () => {
  it('is true for a PR authored by github-actions[bot]', () => {
    expect(isActionsBotPr({ user: { login: 'github-actions[bot]' } })).toBe(true);
  });

  it('is false for a human author', () => {
    expect(isActionsBotPr({ user: { login: 'alice' } })).toBe(false);
  });

  it('is false for other bots (e.g. dependabot, which does trigger its own workflows)', () => {
    expect(isActionsBotPr({ user: { login: 'dependabot[bot]' } })).toBe(false);
  });

  it('is false when the author is missing', () => {
    expect(isActionsBotPr({})).toBe(false);
    expect(isActionsBotPr(undefined)).toBe(false);
  });
});

describe('shouldConsiderRevive', () => {
  const gha = { login: 'github-actions[bot]', type: 'Bot' };
  const prMinder = { login: 'pr-minder[bot]', type: 'Bot' };
  const human = { login: 'alice', type: 'User' };

  it('considers opened and synchronize regardless of sender', () => {
    for (const s of [gha, human, prMinder, undefined]) {
      expect(shouldConsiderRevive('opened', s)).toBe(true);
      expect(shouldConsiderRevive('synchronize', s)).toBe(true);
    }
  });

  it('considers reopened unless a Bot sent it (our own close+reopen loop guard)', () => {
    expect(shouldConsiderRevive('reopened', human)).toBe(true);
    expect(shouldConsiderRevive('reopened', gha)).toBe(false);
    expect(shouldConsiderRevive('reopened', prMinder)).toBe(false);
  });

  it('ignores unrelated actions', () => {
    expect(shouldConsiderRevive('labeled', gha)).toBe(false);
    expect(shouldConsiderRevive('closed', gha)).toBe(false);
    expect(shouldConsiderRevive('auto_merge_enabled', human)).toBe(false);
  });
});

describe('shouldSkipBranch', () => {
  it('always skips the base branch and gh-pages', () => {
    expect(shouldSkipBranch('main', 'main', [])).toBe(true);
    expect(shouldSkipBranch('gh-pages', 'main', [])).toBe(true);
  });

  it('skips branches in the configured skip list', () => {
    expect(shouldSkipBranch('staging', 'main', ['staging', 'release'])).toBe(true);
    expect(shouldSkipBranch('release', 'main', ['staging', 'release'])).toBe(true);
  });

  it('does not skip an ordinary feature branch', () => {
    expect(shouldSkipBranch('feature/x', 'main', ['staging'])).toBe(false);
  });
});

describe('reviveIfZombie', () => {
  // Map-backed stand-in for the KV binding (only get/put are used).
  function fakeKV(initial: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initial));
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v); },
      delete: async (k: string) => { store.delete(k); },
    };
    return { env: { PR_STATE: kv } as any, store };
  }

  // Route fetch by URL substring (hasWorkflowRuns hits /actions/runs; retriggerWorkflows PATCHes /pulls/N).
  function stubFetch(routes: Array<{ match: string; status: number; body?: unknown }>) {
    const fn = vi.fn(async (url: string, _init?: any) => {
      const route = routes.find((r) => url.includes(r.match));
      if (!route) throw new Error(`unexpected fetch to ${url}`);
      const text = JSON.stringify(route.body ?? {});
      return { ok: route.status >= 200 && route.status < 300, status: route.status, text: async () => text, json: async () => JSON.parse(text) };
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  const botPr = (overrides: Record<string, unknown> = {}) =>
    ({ number: 174, draft: false, head: { sha: 'abc' }, user: { login: 'github-actions[bot]' }, ...overrides });

  // A commit-age route for hasWorkflowRuns's sibling lookup. Old enough to be a real zombie, or
  // brand-new (still within the "too fresh to judge" window).
  const OLD_DATE = '2020-01-01T00:00:00Z';
  const freshDate = () => new Date().toISOString();

  afterEach(() => vi.unstubAllGlobals());

  it('reopens a bot PR with no runs and records its head SHA', async () => {
    const { env, store } = fakeKV();
    const fetchMock = stubFetch([
      { match: '/actions/runs', status: 200, body: { total_count: 0 } },
      { match: '/pulls/174', status: 200 },
    ]);
    const reopened = await reviveIfZombie(env, 'o/r', botPr(), 'tok', new Logger());

    expect(reopened).toBe(true);
    // close + reopen = two PATCHes to the PR
    expect(fetchMock.mock.calls.filter(([u]) => u.includes('/pulls/174'))).toHaveLength(2);
    expect(store.get('pr:o/r#174')).toBe('abc');
  });

  it('skips a PR already checked at the same SHA (no API calls)', async () => {
    const { env } = fakeKV({ 'pr:o/r#174': 'abc' });
    const fetchMock = stubFetch([]);
    expect(await reviveIfZombie(env, 'o/r', botPr(), 'tok', new Logger())).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reopens the first commit immediately, without a commit-age lookup', async () => {
    const { env } = fakeKV();
    const fetchMock = stubFetch([
      { match: '/actions/runs', status: 200, body: { total_count: 0 } },
      { match: '/pulls/174', status: 200 },
    ]);
    // prev === null (first time we handle this PR) -> revive now; no /commits/ age call is made
    // (a missing route would throw "unexpected fetch", so this also proves it isn't called).
    expect(await reviveIfZombie(env, 'o/r', botPr(), 'tok', new Logger())).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => u.includes('/commits/'))).toBe(false);
  });

  it('re-revives a touched PR whose new commit has aged without gaining runs, clearing the reminder', async () => {
    const { env, store } = fakeKV({ 'pr:o/r#174': 'oldsha', 'recheck:o/r#174': 'ts' });
    stubFetch([
      { match: '/actions/runs', status: 200, body: { total_count: 0 } },
      { match: '/commits/', status: 200, body: { commit: { committer: { date: OLD_DATE } } } },
      { match: '/pulls/174', status: 200 },
    ]);
    expect(await reviveIfZombie(env, 'o/r', botPr({ head: { sha: 'newsha' } }), 'tok', new Logger())).toBe(true);
    expect(store.get('pr:o/r#174')).toBe('newsha');
    expect(store.has('recheck:o/r#174')).toBe(false); // verdict recorded -> reminder cleared
  });

  it('defers a too-fresh follow-up commit and leaves a recheck reminder (the bug fix)', async () => {
    const { env, store } = fakeKV({ 'pr:o/r#174': 'oldsha' });
    const fetchMock = stubFetch([
      { match: '/actions/runs', status: 200, body: { total_count: 0 } },
      { match: '/commits/', status: 200, body: { commit: { committer: { date: freshDate() } } } },
    ]);
    // Simulates pr-minder's own update-branch merge: a brand-new head SHA with no runs yet.
    expect(await reviveIfZombie(env, 'o/r', botPr({ head: { sha: 'mergesha' } }), 'tok', new Logger())).toBe(false);
    expect(fetchMock.mock.calls.filter(([u]) => u.includes('/pulls/174'))).toHaveLength(0);
    // Not recorded (so a later sweep re-evaluates), and a reminder is dropped for that sweep.
    expect(store.get('pr:o/r#174')).toBe('oldsha');
    expect(store.has('recheck:o/r#174')).toBe(true);
  });

  it('ignores a non-bot PR without any API call or KV write', async () => {
    const { env, store } = fakeKV();
    const fetchMock = stubFetch([]);
    expect(await reviveIfZombie(env, 'o/r', botPr({ user: { login: 'alice' } }), 'tok', new Logger())).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('records but does not reopen a bot PR that already has runs', async () => {
    const { env, store } = fakeKV();
    const fetchMock = stubFetch([{ match: '/actions/runs', status: 200, body: { total_count: 3 } }]);
    expect(await reviveIfZombie(env, 'o/r', botPr(), 'tok', new Logger())).toBe(false);
    expect(fetchMock.mock.calls.filter(([u]) => u.includes('/pulls/174'))).toHaveLength(0);
    expect(store.get('pr:o/r#174')).toBe('abc');
  });

  it('skips drafts and PRs with no head SHA', async () => {
    const { env, store } = fakeKV();
    const fetchMock = stubFetch([]);
    expect(await reviveIfZombie(env, 'o/r', botPr({ draft: true }), 'tok', new Logger())).toBe(false);
    expect(await reviveIfZombie(env, 'o/r', botPr({ head: {} }), 'tok', new Logger())).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });
});

describe('reconcileAutoMerge', () => {
  // Route fetch by URL substring. listOpenPulls reads r.json(); enableAutoMerge's graphql reads r.text().
  function stubFetch(routes: Array<{ match: string; status: number; body?: unknown }>) {
    const fn = vi.fn(async (url: string, _init?: any) => {
      const route = routes.find((r) => url.includes(r.match));
      if (!route) throw new Error(`unexpected fetch to ${url}`);
      const text = JSON.stringify(route.body ?? {});
      return { ok: route.status >= 200 && route.status < 300, status: route.status, text: async () => text, json: async () => JSON.parse(text) };
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  const label = (name: string) => ({ name });
  const cfg = (labels: PrMinderConfig['labels']): PrMinderConfig =>
    ({ triggers: [], labels, autoTriggerWorkflows: false, autoOpenPr: { enabled: false, skipBranches: [], targetBase: '' } });
  const autoMergeLabel = { auto_add: false as const, create_label_if_missing_in_repo: false, color: '00ff00', mode: 'auto_merge' as const, auto_merge_method: 'squash' as const };

  afterEach(() => vi.unstubAllGlobals());

  it('enables auto-merge only for non-draft, unarmed PRs that carry an auto_merge label', async () => {
    const prs = [
      { number: 1, draft: false, auto_merge: null, node_id: 'PR1', labels: [label('ship')] },        // -> enable
      { number: 2, draft: false, auto_merge: { enabled_by: {} }, node_id: 'PR2', labels: [label('ship')] }, // already armed -> skip
      { number: 3, draft: false, auto_merge: null, node_id: 'PR3', labels: [label('other')] },        // no auto_merge label -> skip
      { number: 4, draft: true, auto_merge: null, node_id: 'PR4', labels: [label('ship')] },          // draft -> skip
    ];
    const fetchMock = stubFetch([
      { match: '/pulls?state=open', status: 200, body: prs },
      { match: '/graphql', status: 200, body: { data: { enablePullRequestAutoMerge: { pullRequest: { number: 1 } } } } },
    ]);
    await reconcileAutoMerge('o/r', cfg({ ship: autoMergeLabel }), 'tok', new Logger());

    const graphqlCalls = fetchMock.mock.calls.filter(([u]) => u.includes('/graphql'));
    expect(graphqlCalls).toHaveLength(1);
    expect(JSON.parse(graphqlCalls[0][1].body).variables.pullRequestId).toBe('PR1');
  });

  it('does nothing (no API calls) when no auto_merge labels are configured', async () => {
    const fetchMock = stubFetch([]);
    await reconcileAutoMerge('o/r', cfg({ x: { ...autoMergeLabel, mode: 'auto_update' } }), 'tok', new Logger());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps going past one PR whose enable throws (each PR is isolated)', async () => {
    const prs = [
      { number: 1, draft: false, auto_merge: null, node_id: 'PR1', labels: [label('ship')] },
      { number: 2, draft: false, auto_merge: null, node_id: 'PR2', labels: [label('ship')] },
    ];
    // graphql returns 500 -> enableAutoMerge throws GhError; reconcile must catch and continue.
    const fetchMock = stubFetch([
      { match: '/pulls?state=open', status: 200, body: prs },
      { match: '/graphql', status: 500, body: 'boom' },
    ]);
    await expect(reconcileAutoMerge('o/r', cfg({ ship: autoMergeLabel }), 'tok', new Logger())).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.filter(([u]) => u.includes('/graphql'))).toHaveLength(2);
  });
});

describe('reconcileInstall', () => {
  // Routes fetches by URL substring, serving both .json() (config/search/getPull) and .text() (graphql).
  function routeFetch(routes: Array<{ match: string; status: number; body: unknown }>) {
    const fn = vi.fn(async (url: string, _init?: any) => {
      const route = routes.find((r) => url.includes(r.match));
      if (!route) throw new Error(`unexpected fetch to ${url}`);
      const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
      return { ok: route.status >= 200 && route.status < 300, status: route.status, text: async () => text, json: async () => JSON.parse(text) };
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }
  // The owner config lives in the org `.github` repo; encode it as the Contents API would.
  const orgCfg = (obj: unknown) => ({ match: '/repos/o/.github/contents/', status: 200, body: { encoding: 'base64', content: btoa(JSON.stringify(obj)) } });
  const autoMergeCfg = { auto_label_pr: { 'auto-pr-merge': { mode: 'auto_merge', auto_merge_method: 'squash' } } };

  beforeEach(() => resetConfigCache()); // loadOwnerConfig memoizes the org file per owner
  afterEach(() => vi.unstubAllGlobals());

  it('searches the owner for each auto_merge label and arms an unarmed, open, non-draft hit', async () => {
    const fetchMock = routeFetch([
      orgCfg(autoMergeCfg),
      { match: '/search/issues', status: 200, body: { items: [{ number: 1, repository_url: 'https://api.github.com/repos/o/r' }] } },
      { match: '/repos/o/r/pulls/1', status: 200, body: { number: 1, state: 'open', draft: false, auto_merge: null, node_id: 'PR1' } },
      { match: '/graphql', status: 200, body: { data: { enablePullRequestAutoMerge: { pullRequest: { number: 1 } } } } },
    ]);
    await reconcileInstall('o', 'tok', new Logger(), { calls: 50 });
    const graphql = fetchMock.mock.calls.filter(([u]) => (u as string).includes('/graphql'));
    expect(graphql).toHaveLength(1);
    expect(JSON.parse((graphql[0][1] as any).body).variables.pullRequestId).toBe('PR1');
  });

  it('skips a PR that is already armed (no enable call)', async () => {
    const fetchMock = routeFetch([
      orgCfg(autoMergeCfg),
      { match: '/search/issues', status: 200, body: { items: [{ number: 1, repository_url: 'https://api.github.com/repos/o/r' }] } },
      { match: '/repos/o/r/pulls/1', status: 200, body: { number: 1, state: 'open', draft: false, auto_merge: { enabled_by: {} }, node_id: 'PR1' } },
    ]);
    await reconcileInstall('o', 'tok', new Logger(), { calls: 50 });
    expect(fetchMock.mock.calls.some(([u]) => (u as string).includes('/graphql'))).toBe(false);
  });

  it('does nothing (no search) when the owner config has no auto_merge labels', async () => {
    const fetchMock = routeFetch([orgCfg({ auto_label_pr: { 'auto-pr-update': { mode: 'auto_update' } } })]);
    await reconcileInstall('o', 'tok', new Logger(), { calls: 50 });
    expect(fetchMock.mock.calls.some(([u]) => (u as string).includes('/search/issues'))).toBe(false);
  });

  it('respects the call budget: an exhausted budget stops before searching', async () => {
    const fetchMock = routeFetch([orgCfg(autoMergeCfg)]);
    await reconcileInstall('o', 'tok', new Logger(), { calls: 1 }); // spent by loadOwnerConfig
    expect(fetchMock.mock.calls.some(([u]) => (u as string).includes('/search/issues'))).toBe(false);
  });
});

describe('startupReconcile', () => {
  function fakeKV(initial: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initial));
    const env = {
      PR_STATE: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); } },
      CF_VERSION_METADATA: { id: 'v1', tag: '', timestamp: '' },
      GITHUB_APP_ID: 'app',
      GITHUB_APP_PRIVATE_KEY: 'not-a-real-key',
    } as any;
    return { env, store };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('skips the whole sweep when this deploy version was already swept (no API calls)', async () => {
    const { env } = fakeKV({ 'startup:v1': '2026-01-01T00:00:00Z' });
    const fetchMock = vi.fn(async () => { throw new Error('should not fetch'); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(startupReconcile(env, new Logger())).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('claims the per-version flag before sweeping, so a concurrent isolate skips', async () => {
    const { env, store } = fakeKV();
    // The credential-less sweep no-ops (listInstallations fails on the fake key and is swallowed),
    // but the version flag must already be set so a second isolate sees it and bails.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [], text: async () => '[]' })));
    await startupReconcile(env, new Logger());
    expect(store.get('startup:v1')).toBeTruthy();
  });
});
