import { describe, it, expect, vi, afterEach } from 'vitest';
import { conditionMet, isActionsBotPr, shouldSkipBranch, reviveIfZombie, shouldConsiderRevive } from './handlers';
import { Logger } from './logger';

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

  it('re-revives a touched PR whose new commit has aged without gaining runs', async () => {
    const { env, store } = fakeKV({ 'pr:o/r#174': 'oldsha' });
    stubFetch([
      { match: '/actions/runs', status: 200, body: { total_count: 0 } },
      { match: '/commits/', status: 200, body: { commit: { committer: { date: OLD_DATE } } } },
      { match: '/pulls/174', status: 200 },
    ]);
    expect(await reviveIfZombie(env, 'o/r', botPr({ head: { sha: 'newsha' } }), 'tok', new Logger())).toBe(true);
    expect(store.get('pr:o/r#174')).toBe('newsha');
  });

  it('defers a too-fresh follow-up commit — no second close+reopen (the bug fix)', async () => {
    const { env, store } = fakeKV({ 'pr:o/r#174': 'oldsha' });
    const fetchMock = stubFetch([
      { match: '/actions/runs', status: 200, body: { total_count: 0 } },
      { match: '/commits/', status: 200, body: { commit: { committer: { date: freshDate() } } } },
    ]);
    // Simulates pr-minder's own update-branch merge: a brand-new head SHA with no runs yet.
    expect(await reviveIfZombie(env, 'o/r', botPr({ head: { sha: 'mergesha' } }), 'tok', new Logger())).toBe(false);
    expect(fetchMock.mock.calls.filter(([u]) => u.includes('/pulls/174'))).toHaveLength(0);
    // Not recorded, so a later event re-evaluates it once it has aged (by then it has CI -> no revive).
    expect(store.get('pr:o/r#174')).toBe('oldsha');
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
