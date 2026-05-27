import { describe, it, expect } from 'vitest';
import { mergeConfig, DEFAULT_LABEL_COLOR } from './config';

const empty = { triggers: [], labels: {} };

describe('mergeConfig', () => {
  it('returns empty triggers and labels when top has no known fields', () => {
    expect(mergeConfig({}, null)).toEqual(empty);
  });

  it('null override is a no-op', () => {
    const cfg = mergeConfig({ auto_update_pr: { triggers: [{ min_approvals: 2 }] } }, null);
    expect(cfg).toEqual({ triggers: [{ min_approvals: 2 }], labels: {} });
  });

  describe('auto_update_pr', () => {
    it('picks up triggers from top-level', () => {
      const cfg = mergeConfig({ auto_update_pr: { triggers: [{ label: 'automerge' }] } }, null);
      expect(cfg.triggers).toEqual([{ label: 'automerge' }]);
    });

    it('override replaces triggers entirely', () => {
      const cfg = mergeConfig(
        { auto_update_pr: { triggers: [{ label: 'automerge' }] } },
        { auto_update_pr: { triggers: [{ label: 'ready' }] } },
      );
      expect(cfg.triggers).toEqual([{ label: 'ready' }]);
    });

    it('override with empty triggers clears them (opt-out)', () => {
      const cfg = mergeConfig(
        { auto_update_pr: { triggers: [{ label: 'automerge' }] } },
        { auto_update_pr: { triggers: [] } },
      );
      expect(cfg.triggers).toEqual([]);
    });

    it('override without auto_update_pr keeps top triggers', () => {
      const cfg = mergeConfig(
        { auto_update_pr: { triggers: [{ label: 'automerge' }] } },
        { auto_label_pr: { foo: { color: '111111' } } },
      );
      expect(cfg.triggers).toEqual([{ label: 'automerge' }]);
    });
  });

  describe('auto_label_pr', () => {
    it('parses a label with all fields', () => {
      const cfg = mergeConfig({
        auto_label_pr: {
          automerge: {
            auto_add: 'on_pr_creation',
            create_label_if_missing_in_repo: true,
            color: '#abcdef',
          },
        },
      }, null);
      expect(cfg.labels).toEqual({
        automerge: { auto_add: 'on_pr_creation', create_label_if_missing_in_repo: true, color: 'abcdef', auto_merge_method: 'squash' },
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
        { auto_label_pr: { automerge: { auto_add: 'on_pr_creation', color: 'aaaaaa' } } },
        { auto_label_pr: { automerge: { color: 'bbbbbb' } } },
      );
      expect(cfg.labels.automerge).toEqual({
        auto_add: 'on_pr_creation',
        create_label_if_missing_in_repo: false,
        color: 'bbbbbb',
        auto_merge_method: 'squash',
      });
    });

    it('override merges per-label (auto_add only)', () => {
      const cfg = mergeConfig(
        { auto_label_pr: { automerge: { auto_add: 'on_pr_creation', color: 'aaaaaa' } } },
        { auto_label_pr: { automerge: { auto_add: false } } },
      );
      expect(cfg.labels.automerge).toEqual({
        auto_add: false,
        create_label_if_missing_in_repo: false,
        color: 'aaaaaa',
        auto_merge_method: 'squash',
      });
    });

    it('parses mode: auto_merge with auto_merge_method', () => {
      const cfg = mergeConfig({
        auto_label_pr: {
          'auto-pr-merge': { mode: 'auto_merge', auto_merge_method: 'rebase', create_label_if_missing_in_repo: true },
        },
      }, null);
      expect(cfg.labels['auto-pr-merge'].mode).toBe('auto_merge');
      expect(cfg.labels['auto-pr-merge'].auto_merge_method).toBe('rebase');
    });

    it('parses mode: auto_update', () => {
      const cfg = mergeConfig({ auto_label_pr: { 'auto-pr-update': { mode: 'auto_update' } } }, null);
      expect(cfg.labels['auto-pr-update'].mode).toBe('auto_update');
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
        { auto_label_pr: { automerge: { color: 'aaaaaa' } } },
        { auto_label_pr: { ready: { color: 'bbbbbb' } } },
      );
      expect(Object.keys(cfg.labels).sort()).toEqual(['automerge', 'ready']);
    });
  });
});
