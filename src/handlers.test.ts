import { describe, it, expect, vi, afterEach } from 'vitest';
import { conditionMet, isActionsBotPr, shouldSkipBranch, reviveIfZombie, reconcileAutoMerge, startupReconcile } from './handlers';
import { Logger } from './logger';
import type { PrMinderConfig } from './config';

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

  it('re-checks when the head SHA changed (a touched PR)', async () => {
    const { env, store } = fakeKV({ 'pr:o/r#174': 'oldsha' });
    stubFetch([
      { match: '/actions/runs', status: 200, body: { total_count: 0 } },
      { match: '/pulls/174', status: 200 },
    ]);
    expect(await reviveIfZombie(env, 'o/r', botPr({ head: { sha: 'newsha' } }), 'tok', new Logger())).toBe(true);
    expect(store.get('pr:o/r#174')).toBe('newsha');
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
