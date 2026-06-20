import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Drive the auto_describe_pr backfill (enqueue + cron drain) without credentials: mock the GitHub
// layer (token minting, PR read/list, App-bot-login) and config loading, and stub describeSafely so
// we assert *which* PRs are handed off without exercising the hook. State (KV) stays real, backed by
// the fake KV below.
vi.mock('./github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github')>();
  return {
    ...actual,
    repoInstallationId: vi.fn(),
    installToken: vi.fn(),
    getPull: vi.fn(),
    listOpenPulls: vi.fn(),
    appBotLogin: vi.fn(),
  };
});
vi.mock('./config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config')>();
  return { ...actual, loadConfig: vi.fn() };
});
vi.mock('./describe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./describe')>();
  return { ...actual, describeSafely: vi.fn() };
});

import * as gh from './github';
import * as cfg from './config';
import * as desc from './describe';
import { enqueueDescribeChecksForRepo, runDescribeChecks } from './handlers';
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

const describeCfg = (enabled = true): PrMinderConfig => ({
  triggers: [],
  labels: {},
  autoTriggerWorkflows: false,
  autoOpenPr: { enabled: false, skipBranches: [], skipBranchPatterns: [], targetBase: '', baseFromForkPoint: false, baseBranchPatterns: [], closeWhenEmpty: true, deleteBranchWhenEmpty: false },
  autoDescribePr: { enabled, model: '' },
});

// A PR shaped like the REST list/get payload. By default it's a github-actions[bot] PR whose title is
// still its branch name — i.e. a describe-backfill candidate.
const pr = (o: Record<string, unknown> = {}) =>
  ({ number: 5, state: 'open', draft: false, title: 'claude/foo', head: { ref: 'claude/foo' }, user: { login: 'github-actions[bot]' }, ...o });

const BOT = 'pr-minder[bot]';

afterEach(() => vi.clearAllMocks());

describe('enqueueDescribeChecksForRepo (backfill/install enqueue)', () => {
  beforeEach(() => vi.mocked(gh.appBotLogin).mockResolvedValue(BOT));

  it('enqueues a bot PR still titled with its branch name', async () => {
    const { env, store } = fakeKV();
    vi.mocked(gh.listOpenPulls).mockResolvedValue([pr({ number: 5 })]);
    await enqueueDescribeChecksForRepo('o/r', describeCfg(), env, 'tok', new Logger());
    expect(store.has('describe:o/r#5')).toBe(true);
  });

  it("enqueues pr-minder's own bot PR (matched via appBotLogin)", async () => {
    const { env, store } = fakeKV();
    vi.mocked(gh.listOpenPulls).mockResolvedValue([pr({ number: 6, user: { login: BOT } })]);
    await enqueueDescribeChecksForRepo('o/r', describeCfg(), env, 'tok', new Logger());
    expect(store.has('describe:o/r#6')).toBe(true);
  });

  it('skips a PR whose title is no longer its branch name (already described/curated)', async () => {
    const { env, store } = fakeKV();
    vi.mocked(gh.listOpenPulls).mockResolvedValue([pr({ number: 7, title: 'Add a real feature' })]);
    await enqueueDescribeChecksForRepo('o/r', describeCfg(), env, 'tok', new Logger());
    expect(store.has('describe:o/r#7')).toBe(false);
  });

  it('skips a human PR and a dependabot PR (never clobber their descriptions)', async () => {
    const { env, store } = fakeKV();
    vi.mocked(gh.listOpenPulls).mockResolvedValue([
      pr({ number: 8, user: { login: 'alice' }, title: 'feature/x', head: { ref: 'feature/x' } }), // human, even title===branch
      pr({ number: 9, user: { login: 'dependabot[bot]' }, title: 'Bump x from 1 to 2', head: { ref: 'dependabot/x' } }),
    ]);
    await enqueueDescribeChecksForRepo('o/r', describeCfg(), env, 'tok', new Logger());
    expect(store.has('describe:o/r#8')).toBe(false);
    expect(store.has('describe:o/r#9')).toBe(false);
  });

  it('skips a draft', async () => {
    const { env, store } = fakeKV();
    vi.mocked(gh.listOpenPulls).mockResolvedValue([pr({ number: 10, draft: true })]);
    await enqueueDescribeChecksForRepo('o/r', describeCfg(), env, 'tok', new Logger());
    expect(store.has('describe:o/r#10')).toBe(false);
  });

  it('makes no GitHub call when auto_describe_pr is disabled', async () => {
    const { env } = fakeKV();
    await enqueueDescribeChecksForRepo('o/r', describeCfg(false), env, 'tok', new Logger());
    expect(gh.listOpenPulls).not.toHaveBeenCalled();
  });
});

describe('runDescribeChecks (cron sweep)', () => {
  beforeEach(() => {
    vi.mocked(gh.repoInstallationId).mockResolvedValue(42);
    vi.mocked(gh.installToken).mockResolvedValue('tok');
    vi.mocked(cfg.loadConfig).mockResolvedValue(describeCfg());
    vi.mocked(gh.appBotLogin).mockResolvedValue(BOT);
  });

  it('makes no GitHub calls when there are no reminders', async () => {
    const { env } = fakeKV({ 'pr:o/r#1': 'abc' }); // unrelated keys only
    await runDescribeChecks(env, new Logger(), { calls: 10 });
    expect(gh.repoInstallationId).not.toHaveBeenCalled();
    expect(gh.getPull).not.toHaveBeenCalled();
    expect(desc.describeSafely).not.toHaveBeenCalled();
  });

  it('describes a never-described candidate and clears its reminder', async () => {
    const { env, store } = fakeKV({ 'describe:o/r#5': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(pr({ number: 5 }));
    await runDescribeChecks(env, new Logger(), { calls: 10 });
    expect(desc.describeSafely).toHaveBeenCalledWith(env, 'o/r', expect.objectContaining({ number: 5 }), expect.anything(), 'tok', expect.anything());
    expect(store.has('describe:o/r#5')).toBe(false);
  });

  it('skips (and clears) a PR already described — desc: marker present, no diff fetch', async () => {
    const { env, store } = fakeKV({ 'describe:o/r#5': 'ts', 'desc:o/r#5': 'somehash' });
    await runDescribeChecks(env, new Logger(), { calls: 10 });
    expect(gh.getPull).not.toHaveBeenCalled(); // short-circuited before the PR read
    expect(desc.describeSafely).not.toHaveBeenCalled();
    expect(store.has('describe:o/r#5')).toBe(false);
  });

  it('skips (and clears) a PR that has since been retitled away from its branch name', async () => {
    const { env, store } = fakeKV({ 'describe:o/r#5': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(pr({ number: 5, title: 'A real AI title' }));
    await runDescribeChecks(env, new Logger(), { calls: 10 });
    expect(desc.describeSafely).not.toHaveBeenCalled();
    expect(store.has('describe:o/r#5')).toBe(false);
  });

  it('clears the reminder for a closed PR without describing', async () => {
    const { env, store } = fakeKV({ 'describe:o/r#5': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(pr({ number: 5, state: 'closed' }));
    await runDescribeChecks(env, new Logger(), { calls: 10 });
    expect(desc.describeSafely).not.toHaveBeenCalled();
    expect(store.has('describe:o/r#5')).toBe(false);
  });

  it('clears the reminder (no PR read) when the repo no longer has auto_describe_pr enabled', async () => {
    const { env, store } = fakeKV({ 'describe:o/r#5': 'ts' });
    vi.mocked(cfg.loadConfig).mockResolvedValue(describeCfg(false)); // feature turned off
    await runDescribeChecks(env, new Logger(), { calls: 10 });
    expect(gh.getPull).not.toHaveBeenCalled();
    expect(desc.describeSafely).not.toHaveBeenCalled();
    expect(store.has('describe:o/r#5')).toBe(false);
  });

  it('leaves the reminder when no installation token is available (uninstalled/transient)', async () => {
    const { env, store } = fakeKV({ 'describe:o/r#5': 'ts' });
    vi.mocked(gh.repoInstallationId).mockResolvedValue(null);
    await runDescribeChecks(env, new Logger(), { calls: 10 });
    expect(gh.getPull).not.toHaveBeenCalled();
    expect(store.has('describe:o/r#5')).toBe(true);
  });

  it('leaves the reminder on a transient PR-fetch failure', async () => {
    const { env, store } = fakeKV({ 'describe:o/r#5': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(null);
    await runDescribeChecks(env, new Logger(), { calls: 10 });
    expect(desc.describeSafely).not.toHaveBeenCalled();
    expect(store.has('describe:o/r#5')).toBe(true);
  });

  it('stops at the call budget, leaving the unreached reminder for the next tick', async () => {
    const { env, store } = fakeKV({ 'describe:o/r#1': 'ts', 'describe:o/r#2': 'ts' });
    vi.mocked(gh.getPull).mockImplementation(async (_r: string, num: number) => pr({ number: num }));
    // calls=4: first PR spends 2 (token) + 1 (config) + 1 (getPull) and reaches describeSafely;
    // by the second PR the budget is already <= 0, so it's left for the next tick.
    await runDescribeChecks(env, new Logger(), { calls: 4 });
    expect(desc.describeSafely).toHaveBeenCalledTimes(1);
    expect(store.has('describe:o/r#1')).toBe(false); // processed
    expect(store.has('describe:o/r#2')).toBe(true); // deferred
  });

  it('mints one token per repo across multiple reminders', async () => {
    const { env } = fakeKV({ 'describe:o/r#1': 'ts', 'describe:o/r#2': 'ts' });
    vi.mocked(gh.getPull).mockResolvedValue(pr({ state: 'closed' })); // clear quickly, detail irrelevant
    await runDescribeChecks(env, new Logger(), { calls: 20 });
    expect(gh.repoInstallationId).toHaveBeenCalledTimes(1); // cached per repo
    expect(gh.installToken).toHaveBeenCalledTimes(1);
  });
});
