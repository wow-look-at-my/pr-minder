import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Drive the merge_conflict label flow without credentials: mock the GitHub layer (token minting,
// PR read, label add/remove) and config loading. State (KV) stays real, backed by the fake KV below.
vi.mock('./github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github')>();
  return {
    ...actual,
    repoInstallationId: vi.fn(),
    installToken: vi.fn(),
    getPull: vi.fn(),
    addLabelsToPr: vi.fn(),
    removeLabelFromPr: vi.fn(),
  };
});
vi.mock('./config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config')>();
  return { ...actual, loadConfig: vi.fn() };
});

import * as gh from './github';
import * as cfg from './config';
import { evaluateMergeConflict, runConflictChecks } from './handlers';
import { Logger } from './logger';
import type { PrMinderConfig } from './config';

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

// A config carrying merge_conflict-mode label(s). Pass [] for "feature off" (no such label).
const conflictCfg = (names: string[] = ['conflict']): PrMinderConfig => ({
  triggers: [],
  labels: Object.fromEntries(
    names.map((n) => [n, { auto_add: false as const, create_label_if_missing_in_repo: false, color: '00ff00', mode: 'merge_conflict' as const, auto_merge_method: 'squash' as const }]),
  ),
  autoTriggerWorkflows: false,
  autoOpenPr: { enabled: false, skipBranches: [], skipBranchPatterns: [], targetBase: '', baseFromForkPoint: false, baseBranchPatterns: [], closeWhenEmpty: true },
  autoDescribePr: { enabled: false, model: '' },
});

const pr = (o: Record<string, unknown> = {}) =>
  ({ number: 5, state: 'open', draft: false, mergeable: null, labels: [], ...o });
const label = (name: string) => ({ name });

afterEach(() => vi.clearAllMocks());

describe('evaluateMergeConflict (live PR events)', () => {
  it('adds the label when the PR has a conflict, and leaves no reminder', async () => {
    const { env, store } = fakeKV();
    vi.mocked(gh.getPull).mockResolvedValue(pr({ mergeable: false, labels: [] }));
    await evaluateMergeConflict(env, 'o/r', 5, conflictCfg(), 'tok', new Logger());
    expect(gh.addLabelsToPr).toHaveBeenCalledWith('o/r', 5, ['conflict'], 'tok', expect.anything());
    expect(gh.removeLabelFromPr).not.toHaveBeenCalled();
    expect(store.has('conflict:o/r#5')).toBe(false);
  });

  it('removes the label when a previously-conflicted PR now merges cleanly', async () => {
    const { env, store } = fakeKV({ 'conflict:o/r#5': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(pr({ mergeable: true, labels: [label('conflict')] }));
    await evaluateMergeConflict(env, 'o/r', 5, conflictCfg(), 'tok', new Logger());
    expect(gh.removeLabelFromPr).toHaveBeenCalledWith('o/r', 5, 'conflict', 'tok', expect.anything());
    expect(gh.addLabelsToPr).not.toHaveBeenCalled();
    expect(store.has('conflict:o/r#5')).toBe(false); // resolved -> reminder cleared
  });

  it('does nothing to a clean PR that never had the label', async () => {
    const { env, store } = fakeKV();
    vi.mocked(gh.getPull).mockResolvedValue(pr({ mergeable: true, labels: [] }));
    await evaluateMergeConflict(env, 'o/r', 5, conflictCfg(), 'tok', new Logger());
    expect(gh.addLabelsToPr).not.toHaveBeenCalled();
    expect(gh.removeLabelFromPr).not.toHaveBeenCalled();
    expect(store.has('conflict:o/r#5')).toBe(false);
  });

  it('defers to the cron (leaves a reminder) when GitHub has not computed mergeability yet', async () => {
    const { env, store } = fakeKV();
    vi.mocked(gh.getPull).mockResolvedValue(pr({ mergeable: null }));
    await evaluateMergeConflict(env, 'o/r', 5, conflictCfg(), 'tok', new Logger());
    expect(gh.addLabelsToPr).not.toHaveBeenCalled();
    expect(store.has('conflict:o/r#5')).toBe(true);
  });

  it('defers (leaves a reminder) on a transient PR-fetch failure', async () => {
    const { env, store } = fakeKV();
    vi.mocked(gh.getPull).mockResolvedValue(null);
    await evaluateMergeConflict(env, 'o/r', 5, conflictCfg(), 'tok', new Logger());
    expect(store.has('conflict:o/r#5')).toBe(true);
  });

  it('clears any reminder and does nothing for a closed or draft PR', async () => {
    for (const state of [{ state: 'closed' }, { draft: true }]) {
      const { env, store } = fakeKV({ 'conflict:o/r#5': 'ts' });
      vi.mocked(gh.getPull).mockResolvedValue(pr(state));
      await evaluateMergeConflict(env, 'o/r', 5, conflictCfg(), 'tok', new Logger());
      expect(gh.addLabelsToPr).not.toHaveBeenCalled();
      expect(gh.removeLabelFromPr).not.toHaveBeenCalled();
      expect(store.has('conflict:o/r#5')).toBe(false);
      vi.clearAllMocks();
    }
  });

  it('makes no API call when no merge_conflict label is configured', async () => {
    const { env } = fakeKV();
    await evaluateMergeConflict(env, 'o/r', 5, conflictCfg([]), 'tok', new Logger());
    expect(gh.getPull).not.toHaveBeenCalled();
  });
});

describe('runConflictChecks (cron sweep)', () => {
  beforeEach(() => {
    vi.mocked(gh.repoInstallationId).mockResolvedValue(42);
    vi.mocked(gh.installToken).mockResolvedValue('tok');
    vi.mocked(cfg.loadConfig).mockResolvedValue(conflictCfg());
  });

  it('makes no GitHub calls when there are no reminders', async () => {
    const { env } = fakeKV({ 'pr:o/r#1': 'abc' }); // unrelated keys only
    await runConflictChecks(env, new Logger(), { calls: 15 });
    expect(gh.repoInstallationId).not.toHaveBeenCalled();
    expect(gh.getPull).not.toHaveBeenCalled();
  });

  it('labels a conflicted PR and clears its reminder', async () => {
    const { env, store } = fakeKV({ 'conflict:o/r#5': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(pr({ mergeable: false, labels: [] }));
    await runConflictChecks(env, new Logger(), { calls: 15 });
    expect(gh.addLabelsToPr).toHaveBeenCalledWith('o/r', 5, ['conflict'], 'tok', expect.anything());
    expect(store.has('conflict:o/r#5')).toBe(false);
  });

  it('unlabels a resolved PR and clears its reminder', async () => {
    const { env, store } = fakeKV({ 'conflict:o/r#5': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(pr({ mergeable: true, labels: [label('conflict')] }));
    await runConflictChecks(env, new Logger(), { calls: 15 });
    expect(gh.removeLabelFromPr).toHaveBeenCalledWith('o/r', 5, 'conflict', 'tok', expect.anything());
    expect(store.has('conflict:o/r#5')).toBe(false);
  });

  it('leaves the reminder when mergeability is still uncomputed', async () => {
    const { env, store } = fakeKV({ 'conflict:o/r#5': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(pr({ mergeable: null }));
    await runConflictChecks(env, new Logger(), { calls: 15 });
    expect(gh.addLabelsToPr).not.toHaveBeenCalled();
    expect(store.has('conflict:o/r#5')).toBe(true);
  });

  it('clears the reminder for a closed PR without touching labels', async () => {
    const { env, store } = fakeKV({ 'conflict:o/r#5': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(pr({ state: 'closed' }));
    await runConflictChecks(env, new Logger(), { calls: 15 });
    expect(gh.addLabelsToPr).not.toHaveBeenCalled();
    expect(store.has('conflict:o/r#5')).toBe(false);
  });

  it('clears the reminder (no PR read) when the repo no longer configures a merge_conflict label', async () => {
    const { env, store } = fakeKV({ 'conflict:o/r#5': 'ts' });
    vi.mocked(cfg.loadConfig).mockResolvedValue(conflictCfg([])); // feature turned off
    await runConflictChecks(env, new Logger(), { calls: 15 });
    expect(gh.getPull).not.toHaveBeenCalled();
    expect(store.has('conflict:o/r#5')).toBe(false);
  });

  it('leaves the reminder when no installation token is available (uninstalled/transient)', async () => {
    const { env, store } = fakeKV({ 'conflict:o/r#5': 'ts' });
    vi.mocked(gh.repoInstallationId).mockResolvedValue(null);
    await runConflictChecks(env, new Logger(), { calls: 15 });
    expect(gh.getPull).not.toHaveBeenCalled();
    expect(store.has('conflict:o/r#5')).toBe(true);
  });

  it('leaves the reminder on a transient PR-fetch failure', async () => {
    const { env, store } = fakeKV({ 'conflict:o/r#5': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(null);
    await runConflictChecks(env, new Logger(), { calls: 15 });
    expect(store.has('conflict:o/r#5')).toBe(true);
  });

  it('stops at the call budget, leaving the unreached reminder for the next tick', async () => {
    const { env, store } = fakeKV({ 'conflict:o/r#1': 'ts', 'conflict:o/r#2': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(pr({ mergeable: false, labels: [] }));
    await runConflictChecks(env, new Logger(), { calls: 1 });
    expect(vi.mocked(gh.getPull)).toHaveBeenCalledTimes(1); // budget spent after one PR
    // one cleared, one left (insertion order: #1 processed, #2 deferred)
    expect(store.has('conflict:o/r#1')).toBe(false);
    expect(store.has('conflict:o/r#2')).toBe(true);
  });

  it('mints one token per repo across multiple reminders', async () => {
    const { env } = fakeKV({ 'conflict:o/r#1': 'ts', 'conflict:o/r#2': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(pr({ state: 'closed' })); // clear quickly, detail irrelevant
    await runConflictChecks(env, new Logger(), { calls: 15 });
    expect(gh.repoInstallationId).toHaveBeenCalledTimes(1); // cached per repo
    expect(gh.installToken).toHaveBeenCalledTimes(1);
  });
});
