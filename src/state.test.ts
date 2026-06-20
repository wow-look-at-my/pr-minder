import { describe, it, expect } from 'vitest';
import { backfilledCaps, markBackfilled, BACKFILL_CAPS, type BackfillCap } from './state';

// Map-backed stand-in for the KV binding (only get/put are used here).
function fakeKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
  } as any;
  return { kv, store };
}

describe('backfill capability set', () => {
  it('returns an empty set when nothing is recorded', async () => {
    const { kv } = fakeKV();
    expect(await backfilledCaps(kv, 'o/r')).toEqual(new Set());
  });

  it('round-trips a recorded set (stored sorted + de-duplicated)', async () => {
    const { kv, store } = fakeKV();
    await markBackfilled(kv, 'o/r', ['openpr', 'zombie', 'openpr']);
    expect(store.get('backfill:o/r')).toBe('openpr,zombie'); // sorted, de-duped
    expect(await backfilledCaps(kv, 'o/r')).toEqual(new Set<BackfillCap>(['zombie', 'openpr']));
  });

  it('migrates the legacy ISO-timestamp value to an empty set (so it re-sweeps under current config)', async () => {
    // The old boolean flag stored a timestamp; none of its comma-split parts is a known capability,
    // so it reads as "nothing backfilled yet" rather than "all done" — the whole point of the fix.
    const { kv } = fakeKV({ 'backfill:o/r': '2026-05-02T19:18:44.000Z' });
    expect(await backfilledCaps(kv, 'o/r')).toEqual(new Set());
  });

  it('filters unknown tokens out of a stored value', async () => {
    const { kv } = fakeKV({ 'backfill:o/r': 'openpr,bogus,conflict' });
    expect(await backfilledCaps(kv, 'o/r')).toEqual(new Set<BackfillCap>(['openpr', 'conflict']));
  });

  it('a fully-recorded set contains every BACKFILL_CAPS member', async () => {
    const { kv } = fakeKV();
    await markBackfilled(kv, 'o/r', BACKFILL_CAPS);
    const done = await backfilledCaps(kv, 'o/r');
    expect(BACKFILL_CAPS.every((c) => done.has(c))).toBe(true);
  });
});
