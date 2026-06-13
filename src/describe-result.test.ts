import { describe, it, expect } from 'vitest';
import { handleDescribeResult, timingSafeEqual } from './describe-result';
import { Logger } from './logger';

function fakeKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v); },
      delete: async (k: string) => { store.delete(k); },
    } as any,
  };
}

const KEY = 'hook-key';
const body = (o: unknown) => JSON.stringify(o);

describe('handleDescribeResult', () => {
  it('clears the described-diff marker when the reported hash matches, so the next event retries', async () => {
    const { kv, store } = fakeKV({ 'desc:o/r#7': 'HASH', 'descrun:o/r#7': 'run-1' });
    const r = await handleDescribeResult({ DESCRIBE_HOOK_API_KEY: KEY, PR_STATE: kv }, KEY,
      body({ repo: 'o/r', pr_number: 7, diff_hash: 'HASH' }), new Logger());
    expect(r.status).toBe(200);
    expect(store.has('desc:o/r#7')).toBe(false); // cleared
    expect(store.get('descrun:o/r#7')).toBe('run-1'); // left to its TTL (cancelled harmlessly next time)
  });

  it('leaves a newer describe alone when the reported hash no longer matches (200, no-op)', async () => {
    const { kv, store } = fakeKV({ 'desc:o/r#7': 'NEWHASH' });
    const r = await handleDescribeResult({ DESCRIBE_HOOK_API_KEY: KEY, PR_STATE: kv }, KEY,
      body({ repo: 'o/r', pr_number: 7, diff_hash: 'OLDHASH' }), new Logger());
    expect(r.status).toBe(200);
    expect(store.get('desc:o/r#7')).toBe('NEWHASH');
  });

  it('rejects a wrong or empty api key (401) and touches nothing', async () => {
    const { kv, store } = fakeKV({ 'desc:o/r#7': 'HASH' });
    const env = { DESCRIBE_HOOK_API_KEY: KEY, PR_STATE: kv };
    expect((await handleDescribeResult(env, 'nope', body({ repo: 'o/r', pr_number: 7, diff_hash: 'HASH' }), new Logger())).status).toBe(401);
    expect((await handleDescribeResult(env, '', body({ repo: 'o/r', pr_number: 7, diff_hash: 'HASH' }), new Logger())).status).toBe(401);
    expect(store.get('desc:o/r#7')).toBe('HASH'); // untouched
  });

  it('401s when the Worker has no api key configured', async () => {
    const { kv } = fakeKV();
    const r = await handleDescribeResult({ PR_STATE: kv }, 'anything', body({ repo: 'o/r', pr_number: 7, diff_hash: 'h' }), new Logger());
    expect(r.status).toBe(401);
  });

  it('400s on a malformed body', async () => {
    const { kv } = fakeKV();
    const env = { DESCRIBE_HOOK_API_KEY: KEY, PR_STATE: kv };
    expect((await handleDescribeResult(env, KEY, 'not json', new Logger())).status).toBe(400);
    expect((await handleDescribeResult(env, KEY, body({ repo: 'o/r' }), new Logger())).status).toBe(400); // no pr_number
    expect((await handleDescribeResult(env, KEY, body({ pr_number: 7, diff_hash: 'h' }), new Logger())).status).toBe(400); // no repo
  });
});

describe('timingSafeEqual', () => {
  it('is true only for equal strings (length mismatch short-circuits)', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});
