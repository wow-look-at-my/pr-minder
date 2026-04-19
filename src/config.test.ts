import { describe, it, expect } from 'vitest';
import { mergeConfig } from './config';

const noTriggers = { enabled: true, triggers: [] };

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
    expect(cfg).toEqual({ enabled: true, triggers: [{ min_approvals: 2 }] });
  });
});
