import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mergeConfig, loadConfig, resetConfigCache, DEFAULT_LABEL_COLOR } from './config';
import { Logger } from './logger';

// A GitHub Contents API response carrying base64-encoded file content.
const contentsBody = (text: string) => ({ encoding: 'base64', content: btoa(text) });

// Route fetches by URL substring so we can answer the per-repo and org `.github` lookups
// independently and count how many calls each test actually makes.
function stubContents(routes: Array<{ match: string; status: number; body?: unknown }>) {
  const fn = vi.fn(async (url: string) => {
    const route = routes.find((r) => (url as string).includes(r.match));
    const status = route?.status ?? 404;
    const body = route?.body;
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('mergeConfig', () => {
  it('returns empty triggers and labels when top has no known fields', () => {
    expect(mergeConfig({}, null)).toEqual({
      triggers: [],
      labels: {},
      autoTriggerWorkflows: false,
      autoOpenPr: { enabled: false, skipBranches: [], skipBranchPatterns: [], targetBase: '', baseFromForkPoint: false, baseBranchPatterns: [], closeWhenEmpty: true },
      autoDescribePr: { enabled: false, model: '' },
    });
  });

  it('null override is a no-op', () => {
    expect(mergeConfig({ auto_label_pr: { foo: { color: '111111' } } }, null).labels.foo.color).toBe('111111');
  });

  describe('auto_update_pr', () => {
    it('picks up triggers from top-level', () => {
      const cfg = mergeConfig({ auto_update_pr: { triggers: [{ min_approvals: 2 }] } }, null);
      expect(cfg.triggers).toEqual([{ min_approvals: 2 }]);
    });

    it('override replaces triggers entirely', () => {
      const cfg = mergeConfig(
        { auto_update_pr: { triggers: [{ approved_by: ['alice'] }] } },
        { auto_update_pr: { triggers: [{ min_approvals: 1 }] } },
      );
      expect(cfg.triggers).toEqual([{ min_approvals: 1 }]);
    });

    it('override with empty triggers clears them (opt-out)', () => {
      const cfg = mergeConfig(
        { auto_update_pr: { triggers: [{ min_approvals: 1 }] } },
        { auto_update_pr: { triggers: [] } },
      );
      expect(cfg.triggers).toEqual([]);
    });

    it('override without auto_update_pr keeps top triggers', () => {
      const cfg = mergeConfig(
        { auto_update_pr: { triggers: [{ min_approvals: 1 }] } },
        { auto_label_pr: { foo: { color: '111111' } } },
      );
      expect(cfg.triggers).toEqual([{ min_approvals: 1 }]);
    });
  });

  describe('auto_trigger_workflows', () => {
    it('defaults to false when absent', () => {
      expect(mergeConfig({}, null).autoTriggerWorkflows).toBe(false);
    });

    it('is picked up from the top level', () => {
      expect(mergeConfig({ auto_trigger_workflows: true }, null).autoTriggerWorkflows).toBe(true);
    });

    it('ignores non-boolean values', () => {
      expect(mergeConfig({ auto_trigger_workflows: 'yes' }, null).autoTriggerWorkflows).toBe(false);
    });

    it('a per-repo override can enable it', () => {
      const cfg = mergeConfig({}, { auto_trigger_workflows: true });
      expect(cfg.autoTriggerWorkflows).toBe(true);
    });

    it('a per-repo override can disable it (opt-out)', () => {
      const cfg = mergeConfig({ auto_trigger_workflows: true }, { auto_trigger_workflows: false });
      expect(cfg.autoTriggerWorkflows).toBe(false);
    });

    it('an override that omits the field keeps the top-level value', () => {
      const cfg = mergeConfig({ auto_trigger_workflows: true }, { auto_label_pr: { foo: {} } });
      expect(cfg.autoTriggerWorkflows).toBe(true);
    });
  });

  describe('auto_open_pr', () => {
    it('defaults to disabled with empty skip list and base', () => {
      expect(mergeConfig({}, null).autoOpenPr).toEqual({ enabled: false, skipBranches: [], skipBranchPatterns: [], targetBase: '', baseFromForkPoint: false, baseBranchPatterns: [], closeWhenEmpty: true });
    });

    it('parses enabled, skip_branches and target_base', () => {
      const cfg = mergeConfig({
        auto_open_pr: { enabled: true, skip_branches: ['staging', 'release'], target_base: 'develop' },
      }, null);
      expect(cfg.autoOpenPr).toEqual({ enabled: true, skipBranches: ['staging', 'release'], skipBranchPatterns: [], targetBase: 'develop', baseFromForkPoint: false, baseBranchPatterns: [], closeWhenEmpty: true });
    });

    it('parses skip_branch_patterns, base_from_fork_point and base_branch_patterns', () => {
      const cfg = mergeConfig({
        auto_open_pr: {
          enabled: true,
          skip_branch_patterns: ['^\\d+\\.\\d+\\.\\d+$', 3, null],
          base_from_fork_point: true,
          base_branch_patterns: ['^\\d+\\.\\d+\\.\\d+$'],
        },
      }, null);
      expect(cfg.autoOpenPr.skipBranchPatterns).toEqual(['^\\d+\\.\\d+\\.\\d+$']);
      expect(cfg.autoOpenPr.baseFromForkPoint).toBe(true);
      expect(cfg.autoOpenPr.baseBranchPatterns).toEqual(['^\\d+\\.\\d+\\.\\d+$']);
    });

    it('ignores a non-boolean base_from_fork_point', () => {
      expect(mergeConfig({ auto_open_pr: { base_from_fork_point: 'yes' } }, null).autoOpenPr.baseFromForkPoint).toBe(false);
    });

    it('close_when_empty defaults to true and parses an explicit opt-out', () => {
      expect(mergeConfig({}, null).autoOpenPr.closeWhenEmpty).toBe(true);
      expect(mergeConfig({ auto_open_pr: { close_when_empty: false } }, null).autoOpenPr.closeWhenEmpty).toBe(false);
      // a non-boolean is ignored, leaving the default
      expect(mergeConfig({ auto_open_pr: { close_when_empty: 'no' } }, null).autoOpenPr.closeWhenEmpty).toBe(true);
    });

    it('drops non-string entries from skip_branches', () => {
      const cfg = mergeConfig({ auto_open_pr: { enabled: true, skip_branches: ['ok', 3, null] } }, null);
      expect(cfg.autoOpenPr.skipBranches).toEqual(['ok']);
    });

    it('ignores a non-boolean enabled', () => {
      const cfg = mergeConfig({ auto_open_pr: { enabled: 'yes' } }, null);
      expect(cfg.autoOpenPr.enabled).toBe(false);
    });

    it('a per-repo override can enable it', () => {
      const cfg = mergeConfig({}, { auto_open_pr: { enabled: true } });
      expect(cfg.autoOpenPr.enabled).toBe(true);
    });

    it('a per-repo override merges field-by-field over the top-level', () => {
      const cfg = mergeConfig(
        { auto_open_pr: { enabled: true, target_base: 'main' } },
        { auto_open_pr: { skip_branches: ['wip'] } },
      );
      expect(cfg.autoOpenPr).toEqual({ enabled: true, skipBranches: ['wip'], skipBranchPatterns: [], targetBase: 'main', baseFromForkPoint: false, baseBranchPatterns: [], closeWhenEmpty: true });
    });
  });

  describe('auto_describe_pr', () => {
    it('defaults to disabled with no model override', () => {
      expect(mergeConfig({}, null).autoDescribePr).toEqual({ enabled: false, model: '' });
    });

    it('parses enabled and model', () => {
      const cfg = mergeConfig({ auto_describe_pr: { enabled: true, model: 'alt-model' } }, null);
      expect(cfg.autoDescribePr).toEqual({ enabled: true, model: 'alt-model' });
    });

    it('ignores a non-boolean enabled and a non-string model', () => {
      const cfg = mergeConfig({ auto_describe_pr: { enabled: 'yes', model: 42 } }, null);
      expect(cfg.autoDescribePr).toEqual({ enabled: false, model: '' });
    });

    it('a per-repo override can enable it and can opt back out', () => {
      expect(mergeConfig({}, { auto_describe_pr: { enabled: true } }).autoDescribePr.enabled).toBe(true);
      expect(mergeConfig({ auto_describe_pr: { enabled: true } }, { auto_describe_pr: { enabled: false } }).autoDescribePr.enabled).toBe(false);
    });

    it('a per-repo override merges field-by-field over the top-level', () => {
      const cfg = mergeConfig(
        { auto_describe_pr: { enabled: true } },
        { auto_describe_pr: { model: 'special' } },
      );
      expect(cfg.autoDescribePr).toEqual({ enabled: true, model: 'special' });
    });
  });

  describe('auto_label_pr', () => {
    it('parses a label with all fields', () => {
      const cfg = mergeConfig({
        auto_label_pr: {
          'auto-pr-update': {
            mode: 'auto_update',
            auto_add: 'on_pr_creation',
            create_label_if_missing_in_repo: true,
            color: '#abcdef',
          },
        },
      }, null);
      expect(cfg.labels).toEqual({
        'auto-pr-update': { mode: 'auto_update', auto_add: 'on_pr_creation', create_label_if_missing_in_repo: true, color: 'abcdef', auto_merge_method: 'squash' },
      });
    });

    it('strips a leading # from color', () => {
      const cfg = mergeConfig({ auto_label_pr: { foo: { color: '#FF0000' } } }, null);
      expect(cfg.labels.foo.color).toBe('FF0000');
    });

    it('defaults: auto_add=false, create_label_if_missing_in_repo=false, color=00FF00, auto_merge_method=squash, no mode', () => {
      const cfg = mergeConfig({ auto_label_pr: { foo: {} } }, null);
      expect(cfg.labels.foo).toEqual({
        auto_add: false,
        create_label_if_missing_in_repo: false,
        color: DEFAULT_LABEL_COLOR,
        auto_merge_method: 'squash',
      });
      expect(cfg.labels.foo.mode).toBeUndefined();
    });

    it('accepts auto_add: false explicitly', () => {
      const cfg = mergeConfig({ auto_label_pr: { foo: { auto_add: false } } }, null);
      expect(cfg.labels.foo.auto_add).toBe(false);
    });

    it('ignores invalid auto_add values', () => {
      const cfg = mergeConfig({ auto_label_pr: { foo: { auto_add: 'whenever' } } }, null);
      expect(cfg.labels.foo.auto_add).toBe(false);
    });

    it('override merges per-label (color only)', () => {
      const cfg = mergeConfig(
        { auto_label_pr: { foo: { auto_add: 'on_pr_creation', color: 'aaaaaa' } } },
        { auto_label_pr: { foo: { color: 'bbbbbb' } } },
      );
      expect(cfg.labels.foo).toEqual({
        auto_add: 'on_pr_creation',
        create_label_if_missing_in_repo: false,
        color: 'bbbbbb',
        auto_merge_method: 'squash',
      });
    });

    it('override merges per-label (auto_add only)', () => {
      const cfg = mergeConfig(
        { auto_label_pr: { foo: { auto_add: 'on_pr_creation', color: 'aaaaaa' } } },
        { auto_label_pr: { foo: { auto_add: false } } },
      );
      expect(cfg.labels.foo).toEqual({
        auto_add: false,
        create_label_if_missing_in_repo: false,
        color: 'aaaaaa',
        auto_merge_method: 'squash',
      });
    });

    it('parses mode: auto_update', () => {
      const cfg = mergeConfig({ auto_label_pr: { 'auto-pr-update': { mode: 'auto_update' } } }, null);
      expect(cfg.labels['auto-pr-update'].mode).toBe('auto_update');
    });

    it('parses mode: auto_merge with auto_merge_method', () => {
      const cfg = mergeConfig({
        auto_label_pr: { 'auto-pr-merge': { mode: 'auto_merge', auto_merge_method: 'rebase' } },
      }, null);
      expect(cfg.labels['auto-pr-merge'].mode).toBe('auto_merge');
      expect(cfg.labels['auto-pr-merge'].auto_merge_method).toBe('rebase');
    });

    it('ignores invalid mode values', () => {
      const cfg = mergeConfig({ auto_label_pr: { foo: { mode: 'invalid' } } }, null);
      expect(cfg.labels.foo.mode).toBeUndefined();
    });

    it('ignores invalid auto_merge_method values', () => {
      const cfg = mergeConfig({ auto_label_pr: { foo: { auto_merge_method: 'fast-forward' } } }, null);
      expect(cfg.labels.foo.auto_merge_method).toBe('squash');
    });

    it('override adds new labels alongside top ones', () => {
      const cfg = mergeConfig(
        { auto_label_pr: { foo: { color: 'aaaaaa' } } },
        { auto_label_pr: { bar: { color: 'bbbbbb' } } },
      );
      expect(Object.keys(cfg.labels).sort()).toEqual(['bar', 'foo']);
    });

    it('override can set mode on a label defined in top', () => {
      const cfg = mergeConfig(
        { auto_label_pr: { foo: { color: 'aaaaaa' } } },
        { auto_label_pr: { foo: { mode: 'auto_update' } } },
      );
      expect(cfg.labels.foo.mode).toBe('auto_update');
      expect(cfg.labels.foo.color).toBe('aaaaaa');
    });
  });
});

describe('loadConfig caching', () => {
  beforeEach(() => resetConfigCache());
  afterEach(() => vi.unstubAllGlobals());

  const log = () => new Logger();
  const PER_REPO = 'o/r/contents/.github/config/pr-minder/pr-minder.jsonc';
  const ORG = 'o/.github/contents/.github/config/pr-minder/pr-minder.jsonc';

  it('resolves once and serves the cache on subsequent calls within the TTL', async () => {
    const fetchMock = stubContents([
      { match: PER_REPO, status: 404 },
      { match: ORG, status: 200, body: contentsBody('{ "auto_trigger_workflows": true }') },
    ]);

    const first = await loadConfig('o', 'r', 'tok', log());
    expect(first.autoTriggerWorkflows).toBe(true);
    const callsAfterFirst = fetchMock.mock.calls.length; // 2: per-repo 404 + org 200

    const second = await loadConfig('o', 'r', 'tok', log());
    expect(second).toBe(first); // same cached object, no re-resolution
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // no new fetches
  });

  it('caches the common "no config" miss so a config-less repo stops hitting the API', async () => {
    const fetchMock = stubContents([
      { match: PER_REPO, status: 404 },
      { match: ORG, status: 404 },
    ]);

    await loadConfig('o', 'r', 'tok', log());
    expect(fetchMock.mock.calls.length).toBe(2);
    await loadConfig('o', 'r', 'tok', log());
    expect(fetchMock.mock.calls.length).toBe(2); // served from cache, not re-fetched
  });

  it('re-resolves after the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = stubContents([
        { match: PER_REPO, status: 404 },
        { match: ORG, status: 404 },
      ]);

      await loadConfig('o', 'r', 'tok', log());
      expect(fetchMock.mock.calls.length).toBe(2);

      vi.advanceTimersByTime(61_000); // past the 60s TTL
      await loadConfig('o', 'r', 'tok', log());
      expect(fetchMock.mock.calls.length).toBe(4); // fetched again
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT cache a transient fetch failure (so the next event retries)', async () => {
    const fetchMock = stubContents([
      { match: PER_REPO, status: 404 },
      { match: ORG, status: 500, body: 'upstream boom' },
    ]);

    const first = await loadConfig('o', 'r', 'tok', log());
    expect(first.autoTriggerWorkflows).toBe(false); // degraded to disabled
    expect(fetchMock.mock.calls.length).toBe(2);

    // GitHub recovers; the second call must re-resolve and pick up the real config.
    stubContents([
      { match: PER_REPO, status: 404 },
      { match: ORG, status: 200, body: contentsBody('{ "auto_trigger_workflows": true }') },
    ]);
    const second = await loadConfig('o', 'r', 'tok', log());
    expect(second.autoTriggerWorkflows).toBe(true);
  });

  it('a per-repo file short-circuits the org lookup and is cached', async () => {
    const fetchMock = stubContents([
      { match: PER_REPO, status: 200, body: contentsBody('{ "auto_trigger_workflows": true }') },
      { match: ORG, status: 200, body: contentsBody('{ "auto_trigger_workflows": false }') },
    ]);

    const cfg = await loadConfig('o', 'r', 'tok', log());
    expect(cfg.autoTriggerWorkflows).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(1); // org never queried

    await loadConfig('o', 'r', 'tok', log());
    expect(fetchMock.mock.calls.length).toBe(1); // cached
  });

  it('fetches the shared org file once per owner across different repos (sweep no longer re-fetches it per repo)', async () => {
    const fetchMock = stubContents([
      { match: 'o/r1/contents/.github/config/pr-minder/pr-minder.jsonc', status: 404 },
      { match: 'o/r2/contents/.github/config/pr-minder/pr-minder.jsonc', status: 404 },
      { match: ORG, status: 200, body: contentsBody('{ "auto_trigger_workflows": true }') },
    ]);

    const a = await loadConfig('o', 'r1', 'tok', log());
    const b = await loadConfig('o', 'r2', 'tok', log());
    expect(a.autoTriggerWorkflows).toBe(true);
    expect(b.autoTriggerWorkflows).toBe(true);
    // r1: per-repo 404 + org 200. r2: per-repo 404 only — the org file is served from the owner cache.
    const orgFetches = fetchMock.mock.calls.filter(([u]) => (u as string).includes('/o/.github/contents/'));
    expect(orgFetches).toHaveLength(1);
  });
});
