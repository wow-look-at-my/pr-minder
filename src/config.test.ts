import { describe, it, expect } from 'vitest';
import { mergeConfig, DEFAULT_LABEL_COLOR } from './config';

const defaultLabels = { autocreate: false, color: DEFAULT_LABEL_COLOR };
const noTriggers = { enabled: true, triggers: [], labels: defaultLabels };

describe('mergeConfig', () => {
  it('returns enabled:true with empty triggers when top has no known fields', () => {
    expect(mergeConfig({}, null)).toEqual(noTriggers);
  });

  it('picks up triggers from top-level', () => {
    const cfg = mergeConfig({ triggers: [{ label: 'automerge' }] }, null);
    expect(cfg.triggers).toEqual([{ label: 'automerge' }]);
    expect(cfg.enabled).toBe(true);
  });

  it('override replaces triggers entirely', () => {
    const cfg = mergeConfig(
      { triggers: [{ label: 'automerge' }] },
      { triggers: [{ label: 'ready' }] },
    );
    expect(cfg.triggers).toEqual([{ label: 'ready' }]);
  });

  it('override can disable without touching triggers', () => {
    const cfg = mergeConfig({ triggers: [{ label: 'automerge' }] }, { enabled: false });
    expect(cfg.enabled).toBe(false);
    expect(cfg.triggers).toEqual([{ label: 'automerge' }]);
  });

  it('null override is a no-op', () => {
    const cfg = mergeConfig({ triggers: [{ min_approvals: 2 }] }, null);
    expect(cfg).toEqual({ enabled: true, triggers: [{ min_approvals: 2 }], labels: defaultLabels });
  });

  describe('labels', () => {
    it('defaults autocreate=false and color=00FF00', () => {
      expect(mergeConfig({}, null).labels).toEqual({ autocreate: false, color: '00FF00' });
    });

    it('reads autocreate and color from top-level', () => {
      const cfg = mergeConfig({ labels: { autocreate: true, color: 'ABCDEF' } }, null);
      expect(cfg.labels).toEqual({ autocreate: true, color: 'ABCDEF' });
    });

    it('strips leading # from color', () => {
      const cfg = mergeConfig({ labels: { color: '#FF0000' } }, null);
      expect(cfg.labels.color).toBe('FF0000');
    });

    it('override partially updates labels (color only)', () => {
      const cfg = mergeConfig(
        { labels: { autocreate: true, color: '00FF00' } },
        { labels: { color: '123456' } },
      );
      expect(cfg.labels).toEqual({ autocreate: true, color: '123456' });
    });

    it('override partially updates labels (autocreate only)', () => {
      const cfg = mergeConfig(
        { labels: { autocreate: true, color: 'ABCDEF' } },
        { labels: { autocreate: false } },
      );
      expect(cfg.labels).toEqual({ autocreate: false, color: 'ABCDEF' });
    });
  });
});
