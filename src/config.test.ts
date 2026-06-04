import { describe, it, expect } from 'vitest';
import { mergeConfig, DEFAULT_LABEL_COLOR } from './config';

describe('mergeConfig', () => {
  it('returns empty triggers and labels when top has no known fields', () => {
    expect(mergeConfig({}, null)).toEqual({
      triggers: [],
      labels: {},
      autoTriggerWorkflows: false,
      autoOpenPr: { enabled: false, skipBranches: [], targetBase: '' },
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
      expect(mergeConfig({}, null).autoOpenPr).toEqual({ enabled: false, skipBranches: [], targetBase: '' });
    });

    it('parses enabled, skip_branches and target_base', () => {
      const cfg = mergeConfig({
        auto_open_pr: { enabled: true, skip_branches: ['staging', 'release'], target_base: 'develop' },
      }, null);
      expect(cfg.autoOpenPr).toEqual({ enabled: true, skipBranches: ['staging', 'release'], targetBase: 'develop' });
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
      expect(cfg.autoOpenPr).toEqual({ enabled: true, skipBranches: ['wip'], targetBase: 'main' });
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
