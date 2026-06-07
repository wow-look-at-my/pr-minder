import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// runRechecks mints installation tokens (real JWTs), so mock the GitHub layer to drive it without
// credentials. Spread the real module and override only the functions the re-check path touches;
// state (KV) stays real, backed by the fake KV below.
vi.mock('./github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github')>();
  return {
    ...actual,
    repoInstallationId: vi.fn(),
    installToken: vi.fn(),
    getPull: vi.fn(),
    hasWorkflowRuns: vi.fn(),
    commitAgeSeconds: vi.fn(),
    retriggerWorkflows: vi.fn(),
  };
});

import * as gh from './github';
import { runRechecks } from './handlers';
import { Logger } from './logger';

function fakeKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
    list: async ({ prefix = '' }: { prefix?: string; cursor?: string } = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true as const,
    }),
  };
  return { env: { PR_STATE: kv, GITHUB_APP_ID: 'app', GITHUB_APP_PRIVATE_KEY: 'key' } as any, store };
}

const botPr = (o: Record<string, unknown> = {}) =>
  ({ number: 174, state: 'open', draft: false, head: { sha: 'newsha' }, user: { login: 'github-actions[bot]' }, ...o });

describe('runRechecks', () => {
  beforeEach(() => {
    vi.mocked(gh.repoInstallationId).mockResolvedValue(42);
    vi.mocked(gh.installToken).mockResolvedValue('tok');
    vi.mocked(gh.retriggerWorkflows).mockResolvedValue(undefined);
    vi.mocked(gh.hasWorkflowRuns).mockResolvedValue(false); // no runs by default
    vi.mocked(gh.commitAgeSeconds).mockResolvedValue(300);   // aged past the threshold by default
  });
  afterEach(() => vi.clearAllMocks());

  it('makes no GitHub calls when there are no reminders', async () => {
    const { env } = fakeKV({ 'pr:o/r#1': 'abc' }); // unrelated keys only
    await runRechecks(env, new Logger());
    expect(gh.repoInstallationId).not.toHaveBeenCalled();
    expect(gh.getPull).not.toHaveBeenCalled();
  });

  it('revives a still-CI-less aged commit and clears its reminder', async () => {
    const { env, store } = fakeKV({ 'recheck:o/r#174': 'ts', 'pr:o/r#174': 'oldsha' });
    vi.mocked(gh.getPull).mockResolvedValue(botPr());
    await runRechecks(env, new Logger());
    expect(gh.retriggerWorkflows).toHaveBeenCalledWith('o/r', 174, 'tok', expect.anything());
    expect(store.has('recheck:o/r#174')).toBe(false);
    expect(store.get('pr:o/r#174')).toBe('newsha');
  });

  it('clears the reminder without reviving once the commit has gained runs', async () => {
    const { env, store } = fakeKV({ 'recheck:o/r#174': 'ts', 'pr:o/r#174': 'oldsha' });
    vi.mocked(gh.hasWorkflowRuns).mockResolvedValue(true);
    vi.mocked(gh.getPull).mockResolvedValue(botPr());
    await runRechecks(env, new Logger());
    expect(gh.retriggerWorkflows).not.toHaveBeenCalled();
    expect(store.has('recheck:o/r#174')).toBe(false);
    expect(store.get('pr:o/r#174')).toBe('newsha');
  });

  it('clears the reminder for a closed PR without reviving', async () => {
    const { env, store } = fakeKV({ 'recheck:o/r#174': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(botPr({ state: 'closed' }));
    await runRechecks(env, new Logger());
    expect(gh.retriggerWorkflows).not.toHaveBeenCalled();
    expect(store.has('recheck:o/r#174')).toBe(false);
  });

  it('leaves the reminder when no installation token is available (transient/uninstalled)', async () => {
    const { env, store } = fakeKV({ 'recheck:o/r#174': 'ts' });
    vi.mocked(gh.repoInstallationId).mockResolvedValue(null);
    await runRechecks(env, new Logger());
    expect(gh.getPull).not.toHaveBeenCalled();
    expect(store.has('recheck:o/r#174')).toBe(true);
  });

  it('leaves the reminder on a transient PR-fetch failure', async () => {
    const { env, store } = fakeKV({ 'recheck:o/r#174': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(null);
    await runRechecks(env, new Logger());
    expect(gh.retriggerWorkflows).not.toHaveBeenCalled();
    expect(store.has('recheck:o/r#174')).toBe(true);
  });

  it('mints one token per repo across multiple reminders', async () => {
    const { env } = fakeKV({ 'recheck:o/r#1': 'ts', 'recheck:o/r#2': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(botPr({ state: 'closed' })); // clear quickly, detail irrelevant
    await runRechecks(env, new Logger());
    expect(gh.repoInstallationId).toHaveBeenCalledTimes(1); // cached per repo
    expect(gh.installToken).toHaveBeenCalledTimes(1);
  });
});
