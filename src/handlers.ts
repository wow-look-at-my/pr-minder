import type { Env } from './worker';
import { loadConfig, loadOwnerConfig, type PrMinderConfig, type TriggerCondition } from './config';
import { addLabelsToPr, removeLabelFromPr, ensureLabel, installToken, updateBranch, mergeWouldBeEmpty, retriggerWorkflows, hasWorkflowRuns, commitAgeSeconds, enableAutoMerge, disableAutoMerge, fetchApprovers, listInstallations, listInstallationRepos, repoInstallationId, getPull, compareCommits, hasOpenPrForBranch, listBranchHeads, listCommitShas, listOpenPulls, getDefaultBranch, createPull, searchPrsByLabel, closePull, commentOnPr, deleteBranch, appBotLogin, gh } from './github';
import { checkedSha, markChecked, wasBackfilled, markBackfilled, setRecheck, clearRecheck, listRechecks, setConflictCheck, clearConflictCheck, listConflictChecks, setDescribeCheck, clearDescribeCheck, listDescribeChecks, describedDiffHash, markSwept, recentlySwept } from './state';
import { describeSafely, shouldDescribe } from './describe';
import type { Logger } from './logger';

// Runs side work (the auto_describe_pr hand-off to the pr-describe webhook) outside the
// webhook's response path — worker.ts passes ctx.waitUntil. When absent (tests), the work is
// awaited inline.
export type Defer = (work: Promise<unknown>) => void;

// Per-repo throttle for opportunistic label checks. Module-scope cache lives
// for the life of the isolate; a cold start just re-checks once, no harm.
const labelCheckedAt = new Map<string, number>();
const LABEL_CHECK_INTERVAL_MS = 15 * 60 * 1000;

// GitHub-call budgets for the search-based auto-merge backstop (reconcileInstall). Each unit ~= one
// external GitHub fetch; the budget keeps a single invocation well under the 50-external-subrequest
// cap (and leaves headroom for the work the same invocation already did). The webhook pass is the
// smallest because it shares the event's invocation; the cron has a fresh invocation. Owners/PRs not
// reached within budget are picked up on the next cron tick or webhook.
const STARTUP_SWEEP_BUDGET = 30;
const WEBHOOK_SWEEP_BUDGET = 15;
// Per-owner cooldown (seconds) between webhook-driven backstop runs, so a burst of webhooks for one
// owner can't exceed GitHub's ~30/min search rate limit. The cron pass ignores this.
const BACKSTOP_COOLDOWN_S = 60;

export async function handle(event: string | null, p: any, env: Env, log: Logger, defer?: Defer): Promise<void> {
  const repo = p.repository?.full_name;
  const action = p.action;
  const prNum = p.pull_request?.number;
  log.log(`event=${event} action=${action} repo=${repo} pr=${prNum}`);

  // Opportunistic per-repo work on every event for the source repo: ensure labels (throttled),
  // and backfill the zombie check once (the first time we ever see this repo). This is how a repo
  // installed before the feature existed gets its pre-existing PRs checked — GitHub never re-sends
  // its install event, so the repo's next webhook of any kind triggers the one-time sweep.
  if (repo && p.installation?.id) {
    await maybeEnsureLabelsForRepo(repo, p.installation.id, env, log);
    await maybeBackfillRepo(repo, p.installation.id, env, log);
  }

  await dispatch(event, p, env, log, defer);

  // Auto-merge backstop: after handling the event, opportunistically re-arm any auto_merge-labeled PR
  // in this owner that the live path may have dropped (the failure mode that left PRs unmerged with no
  // error). Cooldown-gated per owner so a burst of webhooks can't exceed GitHub's search rate limit;
  // the cron is the unconditional periodic pass. Self-feeding — a merge here emits its own webhook,
  // which drains the next. Failures are swallowed: the backstop must never fail the webhook. The
  // cooldown is claimed before running so concurrent isolates don't pile on.
  if (repo && p.installation?.id && env.PR_STATE) {
    const owner = repo.split('/')[0];
    try {
      if (!(await recentlySwept(env.PR_STATE, owner))) {
        await markSwept(env.PR_STATE, owner, BACKSTOP_COOLDOWN_S);
        const token = await installToken(p.installation.id, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
        await reconcileInstall(owner, token, log, { calls: WEBHOOK_SWEEP_BUDGET });
      }
    } catch (e) {
      log.log(`backstop ${owner}: ${(e as Error).message}`);
    }
  }
}

// Route an event to its handler. Extracted from handle() so the auto-merge backstop runs after the
// event-specific work regardless of which branch handled it (or none).
async function dispatch(event: string | null, p: any, env: Env, log: Logger, defer?: Defer): Promise<void> {
  const action = p.action;
  if (event === 'pull_request' && ['opened', 'reopened', 'ready_for_review', 'labeled', 'unlabeled', 'synchronize', 'auto_merge_enabled', 'auto_merge_disabled'].includes(action)) {
    return onPR(p, env, log, defer);
  }
  // Webhook payload uses lowercase state; REST API uses uppercase — different conventions.
  if (event === 'pull_request_review' && action === 'submitted' && p.review?.state === 'approved') {
    return onPR(p, env, log, defer);
  }
  if (event === 'push' && typeof p.ref === 'string' && p.ref.startsWith('refs/heads/') && !p.deleted) {
    if (p.ref === `refs/heads/${p.repository.default_branch}`) {
      return onPushToDefault(p, env, log);
    }
    return onPushToBranch(p, env, log);
  }
  if (event === 'installation' && (action === 'created' || action === 'new_permissions_accepted')) {
    return onInstallation(p, env, log);
  }
  if (event === 'installation_repositories' && action === 'added') {
    return onReposAdded(p, env, log);
  }
  log.log(`skip: no handler matched (event=${event} action=${action})`);
}

async function maybeEnsureLabelsForRepo(
  fullName: string,
  installationId: number,
  env: Env,
  log: Logger,
): Promise<void> {
  const now = Date.now();
  const last = labelCheckedAt.get(fullName);
  if (last !== undefined && now - last < LABEL_CHECK_INTERVAL_MS) return;
  labelCheckedAt.set(fullName, now);
  try {
    const token = await installToken(installationId, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
    const [owner, name] = fullName.split('/');
    const config = await loadConfig(owner, name, token, log);
    await createConfiguredLabels(fullName, config, token, log);
  } catch (e) {
    log.log(`maybeEnsureLabels: ${fullName}: ${(e as Error).message}`);
  }
}

// The auto-merge backstop across every installation — the safety net for an auto_merge-labeled PR
// the live webhook path dropped (e.g. a webhook that hit the subrequest cap). The cron calls this
// every few minutes and a redeploy calls it once (startupReconcile). With the search-based
// reconcileInstall it costs ~one search plus a couple calls per *labeled* PR per owner — no per-repo
// config loads or PR listings — so it never fans out across the whole fleet in a single invocation
// (that per-repo fan-out was exactly what blew the subrequest cap and silently dropped the work).
// `budget.calls` bounds it; installs not reached are picked up on the next cron tick.
export async function reconcileAllInstalls(env: Env, log: Logger, budget: { calls: number }): Promise<void> {
  let installs: Array<{ id: number; login: string }>;
  try {
    installs = await listInstallations(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
  } catch (e) {
    log.log(`reconcileAllInstalls: listInstallations failed: ${(e as Error).message}`);
    return;
  }
  log.log(`reconcileAllInstalls: ${installs.length} installation(s)`);
  for (const { id, login } of installs) {
    if (budget.calls <= 0) { log.log(`reconcileAllInstalls: budget spent before ${login}`); break; }
    try {
      budget.calls--;
      const token = await installToken(id, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
      await reconcileInstall(login, token, log, budget);
    } catch (e) {
      log.log(`reconcileAllInstalls: install ${id} (${login}): ${(e as Error).message}`);
    }
  }
}

// The auto-merge backstop for one installation/owner: re-arm any auto_merge-labeled PR that isn't
// armed. Loads the owner's org config for the auto_merge label names, then searches the whole
// installation for each label (one call covers all the owner's repos), and on each hit not already
// armed calls enableAutoMerge — which direct-merges a PR that's already mergeable, so a "ready" PR
// the event path dropped gets merged instead of sitting forever. Cost scales with labeled PRs, not
// repo count. `budget.calls` bounds the GitHub calls; per-PR work is isolated so one failure doesn't
// abort the pass.
export async function reconcileInstall(owner: string, token: string, log: Logger, budget: { calls: number }): Promise<void> {
  budget.calls--; // loadOwnerConfig: the org file, owner-cached after the first read
  const config = await loadOwnerConfig(owner, token, log);
  const methodByLabel = new Map<string, string>();
  for (const [name, opts] of Object.entries(config.labels)) {
    if (opts.mode === 'auto_merge') methodByLabel.set(name, opts.auto_merge_method);
  }
  if (methodByLabel.size === 0) return;

  for (const [label, method] of methodByLabel) {
    if (budget.calls <= 0) return;
    budget.calls--;
    const hits = await searchPrsByLabel(label, token, log);
    if (hits.length) log.log(`reconcileInstall ${owner}: "${label}" -> ${hits.length} open PR(s)`);
    for (const { repo, number } of hits) {
      if (budget.calls <= 1) return; // leave room for the getPull + enable below
      const tag = `${repo}#${number}`;
      try {
        budget.calls--;
        const pr = await getPull(repo, number, token, log);
        if (!pr || pr.state !== 'open' || pr.draft || pr.auto_merge) continue; // gone, draft, or already armed
        budget.calls--;
        log.log(`${tag}: backstop arm auto-merge (label "${label}")`);
        await enableAutoMerge(repo, number, pr.node_id, method, token, log);
      } catch (e) {
        log.log(`${tag}: backstop failed: ${(e as Error).message}`);
      }
    }
  }
}

// Re-arm-on-deploy: the version-gated entry point (fired from worker.ts on the first request of a
// fresh isolate). Keeps the once-per-deploy KV gate from the old cross-repo sweep, but the work is
// now reconcileAllInstalls (the cheap, search-based backstop) rather than a per-repo fan-out.
export async function startupReconcile(env: Env, log: Logger): Promise<void> {
  // Gate on the deploy version so the sweep runs once per *deploy*, not once per isolate. After a
  // deploy many isolates cold-start across the edge and each would otherwise sweep; keying a KV flag
  // on the Worker version id collapses those to a single trigger. Set the flag before sweeping so a
  // concurrent isolate that loses the race skips. With no version binding we can't dedup safely (a
  // constant key would block all future deploys), so we fall back to the per-isolate guard alone.
  const version = env.CF_VERSION_METADATA?.id;
  if (env.PR_STATE && version) {
    const key = `startup:${version}`;
    if (await env.PR_STATE.get(key)) {
      log.log(`startupReconcile: already swept for version ${version}`);
      return;
    }
    await env.PR_STATE.put(key, new Date().toISOString());
  }
  await reconcileAllInstalls(env, log, { calls: STARTUP_SWEEP_BUDGET });
}

// Reconcile native auto-merge for a repo's open PRs: every PR that carries an `auto_merge`-mode
// label but doesn't have auto-merge armed yet gets (re)enabled — and enableAutoMerge merges the PR
// directly when it's already mergeable and GitHub won't arm it, so a "ready" PR gets merged instead
// of sitting forever. This is NOT a poll: it runs only on startup and on install (see callers). It's
// cheap — listOpenPulls already carries each PR's labels and current auto_merge state, so we only
// spend an enableAutoMerge call on a PR that has the label but isn't armed.
export async function reconcileAutoMerge(repo: string, config: PrMinderConfig, token: string, log: Logger): Promise<void> {
  const methodByLabel = new Map<string, string>();
  for (const [name, opts] of Object.entries(config.labels)) {
    if (opts.mode === 'auto_merge') methodByLabel.set(name, opts.auto_merge_method);
  }
  if (methodByLabel.size === 0) return;

  const prs = await listOpenPulls(repo, token, log);
  for (const pr of prs) {
    if (pr.draft || pr.auto_merge) continue; // skip drafts and PRs that already have auto-merge armed
    const label = (pr.labels ?? []).map((l: any) => l.name).find((n: string) => methodByLabel.has(n));
    if (!label) continue;
    try {
      log.log(`${repo}#${pr.number}: reconcile auto-merge (label "${label}")`);
      await enableAutoMerge(repo, pr.number, pr.node_id, methodByLabel.get(label)!, token, log);
    } catch (e) {
      log.log(`${repo}#${pr.number}: reconcile auto-merge failed: ${(e as Error).message}`);
    }
  }
}

async function onPR(p: any, env: Env, log: Logger, defer?: Defer): Promise<void> {
  const pr = p.pull_request;
  const repo = p.repository.full_name;
  const tag = `${repo}#${pr.number}`;
  const action = p.action;

  if (pr.draft) {
    log.log(`${tag}: skip (draft)`);
    return;
  }

  const token = await installToken(p.installation.id, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
  const [owner, name] = repo.split('/');
  const config = await loadConfig(owner, name, token, log);
  log.log(`${tag}: labels=${Object.keys(config.labels).length}`);

  // AI title/description from the PR's full diff — handed off to the pr-describe webhook
  // (webhook-runner), which makes the slow model call outside the Worker's time limits and
  // PATCHes the PR itself. Still deferred via waitUntil when available: the hand-off is a few
  // fast subrequests (diff fetch, cancel, hook POST) that needn't delay the webhook ack.
  // Scheduled before the zombie-revive early return below so a PR we close+reopen is still
  // described from this event (our reopen comes back as `reopened`, which shouldDescribe
  // excludes). Failures never fail the webhook, but they are NOT silent either: describeSafely
  // logs them at error level (Workers Logs), because an enabled feature failing invisibly
  // cost a debugging round once already. Operator surfaces only — never PR comments.
  if (config.autoDescribePr.enabled && shouldDescribe(action)) {
    const work = describeSafely(env, repo, pr, config, token, log);
    if (defer) defer(work); else await work;
  }

  if (action === 'opened') {
    await applyAutoAddLabels(repo, pr, config, token, log);
  }

  // Revive a "zombie" PR — author github-actions[bot] with no workflow runs of its own (created
  // with the default GITHUB_TOKEN, whose events GitHub won't let trigger workflows). Closing+
  // reopening with our App token fires a fresh event that DOES run them. shouldConsiderRevive picks
  // the eligible events (skipping our own bot reopen); reviveIfZombie then decides whether to act,
  // and in particular won't re-close a follow-up commit (e.g. our own update-branch merge) until it
  // has aged without gaining CI. If we did reopen, return — the fresh event drives the rest.
  if (config.autoTriggerWorkflows && shouldConsiderRevive(action, p.sender)) {
    if (await reviveIfZombie(env, repo, pr, token, log)) return;
  }

  // Apply/remove the merge_conflict label. A PR's head just changed (opened/reopened/synchronize),
  // so its mergeability may have changed too. The webhook payload's `mergeable` is unreliable
  // (GitHub computes it asynchronously), so evaluateMergeConflict re-reads it and either acts now or
  // defers to the cron once GitHub has the answer.
  if (['opened', 'reopened', 'synchronize'].includes(action) && conflictLabelNames(config).length > 0) {
    await evaluateMergeConflict(env, repo, pr.number, config, token, log);
  }

  // Sync label ↔ GitHub native auto-merge (bidirectional).
  // label added   → enable auto-merge; label removed  → disable auto-merge.
  // auto_merge_enabled event → add label; auto_merge_disabled event → remove label.
  if (action === 'labeled' || action === 'unlabeled') {
    const changedLabel = p.label?.name as string | undefined;
    const labelOpts = changedLabel ? config.labels[changedLabel] : undefined;
    if (labelOpts?.mode === 'auto_merge') {
      if (action === 'labeled') {
        log.log(`${tag}: enableAutoMerge (label added: "${changedLabel}")`);
        await enableAutoMerge(repo, pr.number, pr.node_id, labelOpts.auto_merge_method, token, log);
      } else {
        log.log(`${tag}: disableAutoMerge (label removed: "${changedLabel}")`);
        await disableAutoMerge(repo, pr.number, pr.node_id, token, log);
      }
    }
  }
  if (action === 'auto_merge_enabled') {
    await syncAutoMergeLabelEnabled(repo, pr, config, token, log);
  }
  if (action === 'auto_merge_disabled') {
    await syncAutoMergeLabelDisabled(repo, pr, config, token, log);
  }

  if (!(await prQualifies(pr, repo, config, token, log))) {
    log.log(`${tag}: skip (no trigger matched; labels=${JSON.stringify(pr.labels?.map((l: any) => l.name))})`);
    return;
  }

  // updateBranch is idempotent via 422, so we call it regardless of mergeable_state.
  // Webhook payloads frequently carry stale values ('unknown', 'unstable', or 'blocked'
  // masking 'behind') before GitHub finishes its async mergeability compute.
  log.log(`${tag}: updateBranch (mergeable_state=${pr.mergeable_state})`);
  await updateBranchUnlessEmpty(repo, pr, pr.base?.sha ?? null, token, log);
}

// Update a PR's branch with its base, skipping when the merge would introduce nothing. GitHub's
// update-branch merges base into head whenever head is behind by commit *count* — even when head
// already contains base's *content* — which leaves an empty "Merge branch ..." commit on the PR.
// mergeWouldBeEmpty catches that from GitHub's test-merge of the PR; it's safe (a genuine update is
// never skipped). `baseTipSha` is the current base-branch tip the caller already knows (the push's
// new head, or the PR payload's base.sha) — it lets mergeWouldBeEmpty confirm the test-merge is
// current before trusting it.
async function updateBranchUnlessEmpty(repo: string, pr: any, baseTipSha: string | null, token: string, log: Logger): Promise<void> {
  const tag = `${repo}#${pr.number}`;
  if (await mergeWouldBeEmpty(repo, pr, baseTipSha, token, log)) {
    log.log(`${tag}: skip updateBranch (head already contains base; merge would be empty)`);
    return;
  }
  log.log(`${tag}: updateBranch`);
  await updateBranch(repo, pr.number, token, log);
  log.log(`${tag}: updateBranch ok`);
}

async function onPushToDefault(p: any, env: Env, log: Logger): Promise<void> {
  const repo = p.repository.full_name;
  const token = await installToken(p.installation.id, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
  const [owner, name] = repo.split('/');
  const config = await loadConfig(owner, name, token, log);

  const r = await gh(`/repos/${owner}/${name}/pulls?state=open&per_page=100`, token, log);
  const prs: any[] = await r.json();
  log.log(`${repo} push: scanning ${prs.length} open PRs`);

  for (const pr of prs) {
    const tag = `${repo}#${pr.number}`;
    if (pr.draft) { log.log(`${tag}: skip (draft)`); continue; }
    if (!(await prQualifies(pr, repo, config, token, log))) {
      log.log(`${tag}: skip (no trigger matched)`);
      continue;
    }
    try {
      // p.after is the default branch's new tip (what update-branch would merge in).
      await updateBranchUnlessEmpty(repo, pr, p.after ?? pr.base?.sha ?? null, token, log);
    } catch (e) {
      log.log(`${tag}: updateBranch failed: ${(e as Error).message}`);
    }
  }

  // The base just moved, so any open PR that merged cleanly before may now conflict (or vice-versa).
  // Flag each for a merge-conflict re-check — a cheap KV put, no GitHub call — and let the cron settle
  // the label once GitHub has recomputed mergeability (a base move leaves the payload's `mergeable`
  // stale/null, so we can't read it here). Gated so it's free for repos without a merge_conflict label.
  if (conflictLabelNames(config).length > 0) {
    await enqueueConflictChecks(env, prs, repo, log);
  }

  // Catch a never-described auto-opened PR. auto_describe_pr is otherwise live-only, so a PR that
  // predates the feature/install (or whose opened-event hand-off failed) is stuck with its branch
  // name as the title forever — no synchronize will revisit it. Enqueue the qualifying ones (a KV
  // put each, no GitHub call beyond the App-bot-login lookup, which is cached) for the cron to hand
  // off. Runs here too — not just on the one-time backfill — so an already-installed repo's stuck
  // PRs get picked up on its next default-branch push. No-op unless auto_describe_pr is enabled.
  if (config.autoDescribePr.enabled) {
    const botLogin = await appBotLogin(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
    await enqueueDescribeChecks(env, prs, repo, botLogin, log);
  }

  // The default branch just advanced, so any open PR whose content landed in it (e.g. via a sibling
  // squash-merge) is now content-empty — close those, whoever opened them. No-op unless auto_open_pr
  // + close_when_empty are on.
  await closeEmptyAutoPrs(repo, config, token, env, log);
}

// A push to a non-default branch: if auto_open_pr is on, open a PR for that branch when it's
// ahead of base and doesn't already have one. Opening it with our App token (not the pushing
// workflow's GITHUB_TOKEN) means the PR triggers its workflows normally — it's never a zombie.
async function onPushToBranch(p: any, env: Env, log: Logger): Promise<void> {
  const repo = p.repository.full_name;
  const token = await installToken(p.installation.id, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
  const [owner, name] = repo.split('/');
  const config = await loadConfig(owner, name, token, log);
  if (!config.autoOpenPr.enabled) {
    log.log(`${repo}: skip (auto_open_pr disabled)`);
    return;
  }
  const branch = p.ref.slice('refs/heads/'.length);
  const base = config.autoOpenPr.targetBase || p.repository.default_branch;
  await maybeOpenPrForBranch(repo, branch, base, config, token, log);
}

// The default branch and gh-pages are always skipped; the config can skip more by exact name or by
// regex pattern (e.g. version branches in an archive repo, so they never each become a PR head).
export function shouldSkipBranch(branch: string, base: string, skipBranches: string[], skipBranchPatterns: string[] = []): boolean {
  if (new Set<string>(['gh-pages', base, ...skipBranches]).has(branch)) return true;
  return skipBranchPatterns.some((p) => matchesPattern(branch, p));
}

// Test a branch name against a config-supplied regex. A malformed pattern never throws — it just
// doesn't match — so a typo in config can't crash a handler.
function matchesPattern(name: string, pattern: string): boolean {
  try { return new RegExp(pattern).test(name); } catch { return false; }
}

// Map each branch HEAD commit SHA -> the branch name(s) at that commit, for fork-point detection.
function buildTipMap(heads: { name: string; sha: string }[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const h of heads) { const a = m.get(h.sha) ?? []; a.push(h.name); m.set(h.sha, a); }
  return m;
}

// Pick the base for a branch from its fork point: walk the branch's commits newest-first and return
// the first ancestor that is the HEAD of another *qualifying* branch — that branch is where this
// branch was forked from, and so where its PR should merge back into. **By default (no
// baseBranchPatterns) ANY other branch qualifies**, so a branch is routed to whatever branch it was
// actually forked from — a branch forked off another working branch targets that working branch, not
// the default branch beneath it. The nearest such ancestor wins (the most specific fork point). When
// baseBranchPatterns IS configured it becomes a restriction: only the default branch or a
// pattern-matching branch may be a base (the archive/version-branch opt-in, where a working branch
// forked from a long-lived version branch opens back into it). Among branches sharing the fork-point
// commit (the same commit, so interchangeable as a base) the default branch is preferred. `ahead` is
// how many commits the branch adds on top of that base (its index in the commit list). Returns null
// when no qualifying ancestor is found, so the caller falls back to the default base. tipsBySha comes
// from buildTipMap; the branch's own name is excluded so it can't pick itself.
export async function detectForkBase(
  repo: string,
  branch: string,
  defaultBranch: string,
  baseBranchPatterns: string[],
  tipsBySha: Map<string, string[]>,
  token: string,
  log: Logger,
): Promise<{ base: string; ahead: number } | null> {
  const qualifies = (n: string) =>
    n !== branch &&
    (baseBranchPatterns.length === 0 || n === defaultBranch || baseBranchPatterns.some((p) => matchesPattern(n, p)));
  const commits = await listCommitShas(repo, branch, token, log);
  for (let i = 0; i < commits.length; i++) {
    const names = (tipsBySha.get(commits[i]) ?? []).filter(qualifies);
    if (names.length === 0) continue;
    return { base: names.includes(defaultBranch) ? defaultBranch : names[0], ahead: i };
  }
  return null;
}

// Open a PR for one branch into its base, when it's ahead and has no open PR. With base_from_fork_point
// on (the default) the base is detected from the branch's fork point — the branch it was created from
// (see detectForkBase) — falling back to targetBase (or the repo default) when none is found; with it
// off the base is always targetBase (or the repo default). tipsBySha is built once by the caller for a
// sweep; for a single push it's built here on demand (only when fork-point detection is enabled).
export async function maybeOpenPrForBranch(repo: string, branch: string, defaultBase: string, config: PrMinderConfig, token: string, log: Logger, tipsBySha?: Map<string, string[]>): Promise<void> {
  const tag = `${repo}@${branch}`;
  const ao = config.autoOpenPr;
  if (shouldSkipBranch(branch, defaultBase, ao.skipBranches, ao.skipBranchPatterns)) {
    log.log(`${tag}: skip (excluded branch)`);
    return;
  }

  let base = defaultBase;
  if (ao.baseFromForkPoint) {
    const tips = tipsBySha ?? buildTipMap(await listBranchHeads(repo, token, log));
    const detected = await detectForkBase(repo, branch, defaultBase, ao.baseBranchPatterns, tips, token, log);
    if (detected) {
      base = detected.base;
      log.log(`${tag}: fork-point base ${base} (+${detected.ahead})`);
    } else {
      log.log(`${tag}: no fork-point base, falling back to ${base}`);
    }
  }
  if (base === branch) { log.log(`${tag}: skip (base == head)`); return; }

  // Gate on the actual base...head comparison, requiring BOTH:
  //   - ahead_by > 0     : the branch has commits base lacks (else there is nothing to PR), and
  //   - changed_files > 0 : those commits introduce a NON-EMPTY net diff.
  // The file-change check is what fixes the orphaned-PR bug. After a squash-merge, a branch's unique
  // commits already live in base by *content*, but git still counts them as "ahead" (a squash is a
  // fresh commit sharing no history), so ahead_by stays > 0 while the net diff is empty. Opening then
  // produces a content-empty PR that auto_describe_pr correctly refuses to describe ("no diff"),
  // leaving a PR stuck with the branch name as its title/body forever (the #224/#225/#226 case). We
  // always compare here — even in fork-point mode, where detectForkBase already gave an ahead count —
  // because emptiness can only be read from the real diff, and one compare per about-to-open branch
  // (a rare event) is cheap. changed_files === null means GitHub omitted the files array (oversized
  // response): treat it as "has changes" and open, never suppress a real PR on an unknown.
  const cmp = await compareCommits(repo, base, branch, token, log);
  if (!cmp) { log.log(`${tag}: skip (compare failed)`); return; }
  if (cmp.ahead_by === 0) { log.log(`${tag}: skip (not ahead of ${base})`); return; }
  if (cmp.changed_files === 0) { log.log(`${tag}: skip (no diff vs ${base} — content already merged)`); return; }
  if (await hasOpenPrForBranch(repo, branch, token, log)) { log.log(`${tag}: skip (PR already open)`); return; }

  const num = await createPull(repo, branch, base, branch, `Automated PR for branch \`${branch}\`.`, token, log);
  if (num !== null) log.log(`${tag}: opened PR #${num} -> ${base}`);
}

// Catch-up sweep run when the App is installed or repos are added: open PRs for branches that
// already exist (and are ahead of base with no PR). Going forward, per-branch pushes cover the rest.
async function maybeOpenPrsForRepo(repo: string, config: PrMinderConfig, token: string, log: Logger): Promise<void> {
  if (!config.autoOpenPr.enabled) return;
  const base = config.autoOpenPr.targetBase || (await getDefaultBranch(repo, token, log));
  if (!base) { log.log(`${repo}: skip auto_open_pr sweep (no base branch)`); return; }
  const heads = await listBranchHeads(repo, token, log);
  // Build the SHA -> branch-name map once for the whole sweep so per-branch fork-point detection
  // is a single commits call each (not another branches listing). Skipped branches cost no call.
  const tips = buildTipMap(heads);
  log.log(`${repo}: auto_open_pr sweep over ${heads.length} branches`);
  for (const h of heads) {
    await maybeOpenPrForBranch(repo, h.name, base, config, token, log, tips);
  }
}

// Close EVERY open non-draft PR whose net diff against its base is empty (zero changed files),
// regardless of author. A 0-diff PR has nothing to review or merge and only wastes CI on each
// update, so it's closed; it doesn't matter how it became empty or who opened it — a human's empty
// PR is closed too (closing is reversible: they can reopen). Squash-merge orphans (ahead by commit
// *count*, zero net content) are the common case. This complements the open-time gate in
// maybeOpenPrForBranch, which stops pr-minder OPENING an empty PR but can't retract one that goes
// empty AFTER it was opened (its content lands in base another way, e.g. a sibling squash-merge).
// It closes only when compareCommits reports EXACTLY zero changed files; a null/unknown count
// (GitHub omitted the files array) is left alone — "unknown" must never be mistaken for "empty", the
// same fail-open rule the open gate uses. Gated on auto_open_pr.enabled + close_when_empty (both
// default-on), so it costs nothing where the feature is off. Wired to run where the base can have
// just advanced (push to the default branch) and on the install/backfill sweeps, mirroring where
// maybeOpenPrsForRepo runs.
export async function closeEmptyAutoPrs(repo: string, config: PrMinderConfig, token: string, env: Env, log: Logger): Promise<void> {
  if (!config.autoOpenPr.enabled || !config.autoOpenPr.closeWhenEmpty) return;
  const prs = await listOpenPulls(repo, token, log);
  const closeable = prs.filter((pr) => !pr.draft && pr.head?.ref && pr.base?.ref);
  if (closeable.length === 0) return;
  log.log(`${repo}: empty-PR sweep over ${closeable.length} open PR(s)`);
  for (const pr of closeable) {
    try {
      const cmp = await compareCommits(repo, pr.base.ref, pr.head.ref, token, log);
      if (!cmp || cmp.changed_files !== 0) continue; // compare failed, or unknown/non-empty diff -> keep
      log.log(`${repo}#${pr.number}: closing PR with no net diff vs ${pr.base.ref}`);
      await commentOnPr(repo, pr.number, `Auto-closing: this branch has no changes against \`${pr.base.ref}\` — its content is already in the base, so there is nothing to review.`, token, log);
      await closePull(repo, pr.number, token, log);
      // Optionally delete the now-closed branch (default off). Only a same-repo head: a fork PR's
      // head lives in the fork (head.repo.full_name !== repo), which we neither own nor can write to.
      // The branch has a zero net diff against its base, so deleting it loses nothing.
      if (config.autoOpenPr.deleteBranchWhenEmpty && pr.head.repo?.full_name === repo) {
        await deleteBranch(repo, pr.head.ref, token, log);
      }
    } catch (e) {
      log.log(`${repo}#${pr.number}: close-empty failed: ${(e as Error).message}`);
    }
  }
}

// Below this age (seconds) a brand-new commit with no workflow runs is treated as "too fresh to
// judge" rather than a zombie: its workflows may simply not have registered yet. ~1 minute.
const REVIVE_MIN_AGE_S = 60;

// Evaluate one PR and revive it if it's a GITHUB_TOKEN "zombie": author github-actions[bot] with
// no workflow runs for its head commit. Closing+reopening with our App token fires a fresh event
// that DOES run its workflows. Returns true iff it reopened.
//
// KV makes this check-once per commit: skip if we've already evaluated this PR at its current head
// SHA. The first commit we handle for a PR (no prior SHA recorded) is revived immediately — a bot
// PR is born with zero CI, so the reading is trustworthy. A *follow-up* commit with zero runs is
// only revived once it has aged past REVIVE_MIN_AGE_S (else it's left unrecorded for a later event),
// so pr-minder's own update-branch merge — which gets CI on its own — isn't close+reopened a second
// time. Bot-author-gated, so the hasWorkflowRuns/commit-age calls are spent only on PRs that can be
// a zombie. Degrades to "always check, never record" if the KV binding is somehow absent.
export async function reviveIfZombie(env: Env, repo: string, pr: any, token: string, log: Logger): Promise<boolean> {
  const sha = pr?.head?.sha;
  if (pr?.draft || !sha || !isActionsBotPr(pr)) return false;
  const prev = env.PR_STATE ? await checkedSha(env.PR_STATE, repo, pr.number) : null;
  if (prev === sha) return false;

  let reopened = false;
  if (!(await hasWorkflowRuns(repo, sha, token, log))) {
    // No runs. On the first commit we handle for this PR (prev === null), act immediately — a
    // github-actions[bot] PR is born with zero CI, so that reading is trustworthy right away. Once
    // we've already handled an earlier commit, a *new* commit with zero runs is ambiguous: it may
    // just be too fresh for its workflows to have registered. The prime example is pr-minder's own
    // update-branch merge, which triggers CI natively — close+reopening it would be a needless second
    // cycle. So for a follow-up commit we re-close/reopen only once it has aged past REVIVE_MIN_AGE_S
    // and still shows no runs; a still-fresh one is left (not recorded) for a later event to
    // re-evaluate, by which point its runs have registered and it won't be revived at all.
    let act = true;
    if (prev !== null) {
      const age = await commitAgeSeconds(repo, sha, token, log);
      act = age !== null && age >= REVIVE_MIN_AGE_S;
    }
    if (!act) {
      log.log(`${repo}#${pr.number}: no runs but follow-up commit too fresh; deferring revive`);
      // Don't record this SHA. Drop a reminder so the scheduled sweep re-evaluates it once it has
      // aged — webhooks won't re-fire on their own, and by then its runs have either registered
      // (so it won't be revived) or it's a genuine zombie (so it will).
      if (env.PR_STATE) await setRecheck(env.PR_STATE, repo, pr.number);
      return false;
    }
    log.log(`${repo}#${pr.number}: zombie PR with no workflow runs; re-triggering (close+reopen)`);
    await retriggerWorkflows(repo, pr.number, token, log);
    reopened = true;
  }
  // Recorded a verdict for this commit, so any pending reminder is now resolved.
  if (env.PR_STATE) {
    await markChecked(env.PR_STATE, repo, pr.number, sha);
    await clearRecheck(env.PR_STATE, repo, pr.number);
  }
  return reopened;
}

// Scheduled re-check sweep (the Worker's cron entry point). reviveIfZombie defers a follow-up commit
// that's too fresh to judge by leaving a `recheck:` reminder in KV; this drains those once they've
// aged. It reads only the reminders — when there are none it makes a single KV list and zero GitHub
// API calls, so the cron is nearly free at rest (not a poll over all PRs). For each pending PR it
// mints a token for that repo (cached per run), refetches the PR, and re-runs reviveIfZombie, which
// now either revives a still-CI-less commit or records it. Reminders for closed/missing PRs are
// cleared. No-ops without a KV binding.
export async function runRechecks(env: Env, log: Logger): Promise<void> {
  if (!env.PR_STATE) return;
  const pending = await listRechecks(env.PR_STATE);
  if (pending.length === 0) return;
  log.log(`recheck sweep: ${pending.length} pending PR(s)`);
  const tokenByRepo = new Map<string, string | null>();
  for (const { repo, num } of pending) {
    try {
      const token = await tokenForRepo(repo, tokenByRepo, env, log);
      if (!token) continue; // no token (repo uninstalled, or a transient error) — leave it; the TTL bounds it
      const pr = await getPull(repo, num, token, log);
      if (!pr) continue; // transient fetch failure — leave the reminder for the next sweep
      if (pr.state !== 'open') { await clearRecheck(env.PR_STATE, repo, num); continue; } // closed/merged — done
      // reviveIfZombie self-manages the reminder: it clears it on a verdict, or (if still somehow
      // too fresh) leaves a fresh one for the next sweep.
      await reviveIfZombie(env, repo, pr, token, log);
    } catch (e) {
      log.log(`recheck ${repo}#${num}: ${(e as Error).message}`);
    }
  }
}

// Mint (and cache per repo) an installation token for a repo, for the KV-reminder sweeps that know
// only the repo name (runRechecks, runConflictChecks). Returns null when the repo has no installation
// (uninstalled) or on a transient error, so the caller leaves the reminder for a later sweep. The
// cache also distinguishes "not yet looked up" (absent) from "looked up, no token" (present null).
async function tokenForRepo(repo: string, cache: Map<string, string | null>, env: Env, log: Logger): Promise<string | null> {
  if (!cache.has(repo)) {
    const instId = await repoInstallationId(repo, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
    cache.set(repo, instId === null ? null : await installToken(instId, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log));
  }
  return cache.get(repo) ?? null;
}

// ----- merge_conflict label: flag a PR when it has a merge conflict, clear the flag when it merges
// cleanly. GitHub computes mergeability asynchronously and emits no webhook with the result, so the
// flow is: a base/head move enqueues a check (KV reminder), and the answer is read (and the label
// applied) once GitHub has it — live on the PR's own events, and via the cron everywhere else. -----

// Names of all labels configured with mode "merge_conflict". Empty (the common case) means the
// feature is off for this repo, so every entry point gates on this being non-empty and costs nothing.
export function conflictLabelNames(config: PrMinderConfig): string[] {
  return Object.entries(config.labels).filter(([, o]) => o.mode === 'merge_conflict').map(([name]) => name);
}

// A PR's conflict state from GitHub's `mergeable`: true = no conflict (so remove the label), false =
// conflict (add the label), null/undefined = GitHub hasn't computed it yet (the read itself starts
// the background job) — caller defers. Mergeability reflects conflicts only, not required checks or
// reviews (those live in mergeable_state), so `mergeable === false` is exactly a merge conflict.
function conflictState(pr: any): boolean | null {
  if (pr?.mergeable === true) return false;
  if (pr?.mergeable === false) return true;
  return null;
}

// Add or remove the merge_conflict-mode label(s) to match the PR's current conflict state. Idempotent:
// only adds a missing label / removes a present one, so re-running on an already-correct PR is a no-op.
async function applyConflictLabels(repo: string, pr: any, names: string[], conflict: boolean, token: string, log: Logger): Promise<void> {
  const tag = `${repo}#${pr.number}`;
  const have = new Set<string>((pr.labels ?? []).map((l: any) => l.name));
  for (const name of names) {
    if (conflict && !have.has(name)) {
      log.log(`${tag}: addLabel "${name}" (merge conflict)`);
      await addLabelsToPr(repo, pr.number, [name], token, log);
    } else if (!conflict && have.has(name)) {
      log.log(`${tag}: removeLabel "${name}" (conflict resolved)`);
      await removeLabelFromPr(repo, pr.number, name, token, log);
    }
  }
}

// Evaluate one PR's merge-conflict label now, from a fresh read (the webhook payload's `mergeable` is
// unreliable). Used on the PR's own events. If GitHub has computed mergeability we apply the label and
// clear any pending reminder; if not (null), or the read failed transiently, we leave a conflict:
// reminder for the cron to settle once the answer is ready; a closed/draft PR just clears the reminder.
export async function evaluateMergeConflict(env: Env, repo: string, num: number, config: PrMinderConfig, token: string, log: Logger): Promise<void> {
  const names = conflictLabelNames(config);
  if (names.length === 0) return;
  const pr = await getPull(repo, num, token, log);
  if (!pr) { // transient fetch failure — defer to the cron
    if (env.PR_STATE) await setConflictCheck(env.PR_STATE, repo, num);
    return;
  }
  if (pr.state !== 'open' || pr.draft) { // not applicable — drop any pending reminder
    if (env.PR_STATE) await clearConflictCheck(env.PR_STATE, repo, num);
    return;
  }
  const conflict = conflictState(pr);
  if (conflict === null) { // GitHub hasn't computed mergeability yet — defer to the cron
    if (env.PR_STATE) await setConflictCheck(env.PR_STATE, repo, num);
    return;
  }
  await applyConflictLabels(repo, pr, names, conflict, token, log);
  if (env.PR_STATE) await clearConflictCheck(env.PR_STATE, repo, num);
}

// Flag every open, non-draft PR in `prs` for a merge-conflict re-check (a KV put each, no GitHub
// call). Used when something moved a base under many PRs at once (a default-branch push, the
// first-install backfill): the cron then settles each label once GitHub has recomputed mergeability.
async function enqueueConflictChecks(env: Env, prs: any[], repo: string, log: Logger): Promise<void> {
  if (!env.PR_STATE) return;
  let n = 0;
  for (const pr of prs) {
    if (pr.draft) continue;
    await setConflictCheck(env.PR_STATE, repo, pr.number);
    n++;
  }
  if (n) log.log(`${repo}: enqueued ${n} merge-conflict check(s)`);
}

// Backfill/install entry: when a merge_conflict label is configured, list the repo's open PRs and
// enqueue a check for each, so pre-existing PRs get their label set without waiting for an event.
// Gated on the feature being on, so it makes no GitHub call (no PR listing) for repos that don't use it.
async function enqueueConflictChecksForRepo(repo: string, config: PrMinderConfig, env: Env, token: string, log: Logger): Promise<void> {
  if (!env.PR_STATE || conflictLabelNames(config).length === 0) return;
  const prs = await listOpenPulls(repo, token, log);
  await enqueueConflictChecks(env, prs, repo, log);
}

// Scheduled merge-conflict sweep (a cron pass alongside runRechecks). Drains the conflict: reminders
// that base/head moves left behind, settling each PR's label once GitHub has computed mergeability.
// Reads only the reminders — with none pending it's a single KV list and zero GitHub calls. Per
// pending PR it mints a token for the repo (cached per run), loads that repo's config (cached per
// run) for the label names, reads the PR, and applies/clears. A still-uncomputed or transiently
// unreadable PR is left for the next sweep (TTL bounds it); a closed/draft/gone or feature-off PR has
// its reminder cleared. `budget.calls` bounds the GitHub calls so the cron stays under the subrequest
// cap; PRs not reached this tick are picked up on the next.
export async function runConflictChecks(env: Env, log: Logger, budget: { calls: number }): Promise<void> {
  if (!env.PR_STATE) return;
  const pending = await listConflictChecks(env.PR_STATE);
  if (pending.length === 0) return;
  log.log(`conflict sweep: ${pending.length} pending PR(s)`);
  const tokenByRepo = new Map<string, string | null>();
  const namesByRepo = new Map<string, string[]>();
  for (const { repo, num } of pending) {
    // budget.calls counts every GitHub call so the pass stays under the subrequest cap — and, since it
    // runs before reconcileAllInstalls in the same invocation, leaves that backstop room. Counts are
    // conservative (e.g. a label op is charged even when the label's already correct): over-counting
    // just processes a few fewer PRs this tick, never an overshoot. An exhausted budget stops here and
    // the rest wait for the next tick.
    if (budget.calls <= 0) { log.log(`conflict sweep: budget spent`); break; }
    try {
      if (!tokenByRepo.has(repo)) budget.calls -= 2; // repoInstallationId + installToken (first sight of repo)
      const token = await tokenForRepo(repo, tokenByRepo, env, log);
      if (!token) continue; // no token (uninstalled / transient) — leave it; the TTL bounds it
      if (!namesByRepo.has(repo)) {
        const [owner, name] = repo.split('/');
        budget.calls--; // loadConfig (memoized per owner/repo, but count one to be safe)
        namesByRepo.set(repo, conflictLabelNames(await loadConfig(owner, name, token, log)));
      }
      const names = namesByRepo.get(repo)!;
      if (names.length === 0) { await clearConflictCheck(env.PR_STATE, repo, num); continue; } // feature off now
      budget.calls -= 2; // getPull + a possible label op (charged unconditionally; safe over-count)
      const pr = await getPull(repo, num, token, log);
      if (!pr) continue; // transient — leave for the next sweep
      if (pr.state !== 'open' || pr.draft) { await clearConflictCheck(env.PR_STATE, repo, num); continue; }
      const conflict = conflictState(pr);
      if (conflict === null) continue; // GitHub still hasn't computed it — leave for the next sweep
      await applyConflictLabels(repo, pr, names, conflict, token, log);
      await clearConflictCheck(env.PR_STATE, repo, num);
    } catch (e) {
      log.log(`conflict ${repo}#${num}: ${(e as Error).message}`);
    }
  }
}

// ----- auto_describe_pr backfill: describe a PR that the live opened/synchronize path never did.
// auto_describe_pr is otherwise purely event-driven, so a PR opened before the feature existed (or
// before the App was installed), or whose opened-event hand-off failed with no synchronize since, is
// stuck with its branch name as the title forever. Like merge_conflict, the flow is enqueue-then-
// drain: the qualifying PRs are flagged with a `describe:` KV reminder (cheap), and the cron
// (runDescribeChecks) hands each off, budget-bounded. -----

// Whether a PR is a candidate for describe backfill: it must be bot-authored AND still show its
// branch name as the title. That title===branch test is the load-bearing safety: it's the exact
// signature of an auto-opened PR that never got an AI title/description (the old github.token
// workflow and pr-minder's own auto_open_pr both open with title = branch and a placeholder body),
// and it guarantees we never overwrite a title/description that was already curated — once a PR has a
// real title (a prior describe, or a human's edit) it no longer qualifies. Humans and dependabot are
// excluded too: a human PR with a real title fails the test, dependabot's "Bump ..." titles never
// equal the branch, and the bot-author gate covers the rest. botLogin is the App's own bot login (so
// pr-minder's own stuck PRs qualify); null when it couldn't be resolved (then only github-actions[bot]
// PRs match). Drafts never qualify (onPR skips drafts wholesale; the live path describes on
// ready_for_review).
function qualifiesForDescribeBackfill(pr: any, botLogin: string | null): boolean {
  if (!pr || pr.draft) return false;
  const branch = pr.head?.ref;
  if (!branch || pr.title !== branch) return false;
  return isActionsBotPr(pr) || (!!botLogin && pr.user?.login === botLogin);
}

// Flag every describe-backfill candidate in `prs` with a `describe:` reminder (a KV put each, no
// GitHub call). Used where a set of PRs is already in hand (a default-branch push), so the cron can
// hand each off. botLogin lets pr-minder's own stuck PRs qualify (see qualifiesForDescribeBackfill).
async function enqueueDescribeChecks(env: Env, prs: any[], repo: string, botLogin: string | null, log: Logger): Promise<void> {
  if (!env.PR_STATE) return;
  let n = 0;
  for (const pr of prs) {
    if (!qualifiesForDescribeBackfill(pr, botLogin)) continue;
    await setDescribeCheck(env.PR_STATE, repo, pr.number);
    n++;
  }
  if (n) log.log(`${repo}: enqueued ${n} describe backfill check(s)`);
}

// Backfill/install entry: when auto_describe_pr is enabled, list the repo's open PRs and enqueue a
// describe check for each candidate, so pre-existing undescribed PRs get a description without waiting
// for an event. Gated on the feature being on, so it makes no GitHub call (no PR listing) where it's off.
export async function enqueueDescribeChecksForRepo(repo: string, config: PrMinderConfig, env: Env, token: string, log: Logger): Promise<void> {
  if (!env.PR_STATE || !config.autoDescribePr.enabled) return;
  const prs = await listOpenPulls(repo, token, log);
  const botLogin = await appBotLogin(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
  await enqueueDescribeChecks(env, prs, repo, botLogin, log);
}

// Scheduled describe-backfill sweep (a cron pass alongside runConflictChecks). Drains the `describe:`
// reminders the enqueue points left behind, handing each PR off to the pr-describe webhook once.
// Reads only the reminders — with none pending it's a single KV list and zero GitHub calls. Per
// pending PR it mints a token (cached per run), loads the repo's config (cached per run), and — only
// for a PR that still has no `desc:` marker (never described) and still qualifies (bot-authored,
// title===branch) — calls describeSafely (which is itself idempotent: it dedups on the diff hash, so
// a race with the live path can't double-describe). A PR already described, retitled, closed, or now
// in a feature-off repo just has its reminder cleared; a transiently unreadable one is left for the
// next sweep (TTL bounds it). `budget.calls` bounds the GitHub/hook calls so the pass stays under the
// subrequest cap; PRs not reached this tick are picked up on the next.
export async function runDescribeChecks(env: Env, log: Logger, budget: { calls: number }): Promise<void> {
  if (!env.PR_STATE) return;
  const pending = await listDescribeChecks(env.PR_STATE);
  if (pending.length === 0) return;
  log.log(`describe sweep: ${pending.length} pending PR(s)`);
  const tokenByRepo = new Map<string, string | null>();
  const configByRepo = new Map<string, PrMinderConfig>();
  let botLogin: string | null | undefined; // the App's own bot login, resolved once lazily for the filter
  for (const { repo, num } of pending) {
    if (budget.calls <= 0) { log.log(`describe sweep: budget spent`); break; }
    try {
      if (!tokenByRepo.has(repo)) budget.calls -= 2; // repoInstallationId + installToken (first sight of repo)
      const token = await tokenForRepo(repo, tokenByRepo, env, log);
      if (!token) continue; // no token (uninstalled / transient) — leave it; the TTL bounds it
      if (!configByRepo.has(repo)) {
        const [owner, name] = repo.split('/');
        budget.calls--; // loadConfig (memoized per owner/repo, but count one to be safe)
        configByRepo.set(repo, await loadConfig(owner, name, token, log));
      }
      const config = configByRepo.get(repo)!;
      if (!config.autoDescribePr.enabled) { await clearDescribeCheck(env.PR_STATE, repo, num); continue; } // feature off now
      // Already described at least once -> the live path owns it from here; backfill only fixes the
      // never-described case. Cheap KV read, charged nothing, and it skips the diff fetch entirely.
      if ((await describedDiffHash(env.PR_STATE, repo, num)) !== null) { await clearDescribeCheck(env.PR_STATE, repo, num); continue; }
      budget.calls--; // getPull
      const pr = await getPull(repo, num, token, log);
      if (!pr) continue; // transient — leave for the next sweep
      if (pr.state !== 'open') { await clearDescribeCheck(env.PR_STATE, repo, num); continue; } // closed/merged — done
      if (botLogin === undefined) botLogin = await appBotLogin(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
      if (!qualifiesForDescribeBackfill(pr, botLogin)) { await clearDescribeCheck(env.PR_STATE, repo, num); continue; } // retitled/curated since, or not a bot PR
      budget.calls -= 3; // describeSafely: diff fetch + cancel + hook POST (conservative)
      await describeSafely(env, repo, pr, config, token, log);
      await clearDescribeCheck(env.PR_STATE, repo, num);
    } catch (e) {
      log.log(`describe ${repo}#${num}: ${(e as Error).message}`);
    }
  }
}

// Sweep a repo's open PRs through reviveIfZombie. Used by the install/repos-added handlers and the
// first-webhook backfill. listOpenPulls already carries each PR's author, so we pre-filter to
// bot-authored candidates (free) before reviveIfZombie spends a KV read / hasWorkflowRuns call —
// cost is ~1 API call per *bot-authored* open PR not yet checked at its current SHA, so a re-sweep
// of an already-checked repo is nearly free. Each PR is wrapped so one failure doesn't abort the rest.
async function maybeRetriggerZombiesForRepo(repo: string, config: PrMinderConfig, token: string, env: Env, log: Logger): Promise<void> {
  if (!config.autoTriggerWorkflows) return;
  const prs = await listOpenPulls(repo, token, log);
  const candidates = prs.filter((pr) => !pr.draft && isActionsBotPr(pr) && pr.head?.sha);
  log.log(`${repo}: zombie sweep over ${prs.length} open PRs (${candidates.length} bot-authored)`);
  for (const pr of candidates) {
    try {
      await reviveIfZombie(env, repo, pr, token, log);
    } catch (e) {
      log.log(`${repo}#${pr.number}: zombie retrigger failed: ${(e as Error).message}`);
    }
  }
}

// First-webhook backfill: the event-driven "check at least once" for repos that were already
// installed before this feature shipped (GitHub never re-sends their install event). The first time
// pr-minder sees any webhook from a repo, sweep its open PRs once; a KV flag makes it a one-time
// pass, so every later event costs a single KV read. No cron, no polling. Going forward, new and
// touched PRs are handled by the live opened/reopened/synchronize paths.
async function maybeBackfillRepo(fullName: string, installationId: number, env: Env, log: Logger): Promise<void> {
  if (!env.PR_STATE || (await wasBackfilled(env.PR_STATE, fullName))) return;
  try {
    const token = await installToken(installationId, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
    const [owner, name] = fullName.split('/');
    const config = await loadConfig(owner, name, token, log);
    await maybeRetriggerZombiesForRepo(fullName, config, token, env, log);
    await maybeOpenPrsForRepo(fullName, config, token, log);
    await enqueueConflictChecksForRepo(fullName, config, env, token, log);
    await enqueueDescribeChecksForRepo(fullName, config, env, token, log);
    await closeEmptyAutoPrs(fullName, config, token, env, log);
    await markBackfilled(env.PR_STATE, fullName);
  } catch (e) {
    log.log(`maybeBackfill: ${fullName}: ${(e as Error).message}`);
  }
}

async function onInstallation(p: any, env: Env, log: Logger): Promise<void> {
  const token = await installToken(p.installation.id, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
  const repos = await listInstallationRepos(token, log);
  log.log(`installation: sweeping ${repos.length} repos for label creation`);
  for (const fullName of repos) {
    const [owner, name] = fullName.split('/');
    try {
      const config = await loadConfig(owner, name, token, log);
      await createConfiguredLabels(fullName, config, token, log);
      await reconcileAutoMerge(fullName, config, token, log);
      await maybeRetriggerZombiesForRepo(fullName, config, token, env, log);
      await maybeOpenPrsForRepo(fullName, config, token, log);
      await enqueueConflictChecksForRepo(fullName, config, env, token, log);
      await enqueueDescribeChecksForRepo(fullName, config, env, token, log);
      await closeEmptyAutoPrs(fullName, config, token, env, log);
      if (env.PR_STATE) await markBackfilled(env.PR_STATE, fullName);
      labelCheckedAt.set(fullName, Date.now());
    } catch (e) {
      log.log(`installation: ${fullName}: ${(e as Error).message}`);
    }
  }
}

async function onReposAdded(p: any, env: Env, log: Logger): Promise<void> {
  const token = await installToken(p.installation.id, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
  const added: any[] = p.repositories_added ?? [];
  log.log(`installation_repositories: ${added.length} repos added`);
  for (const repo of added) {
    const [owner, name] = repo.full_name.split('/');
    try {
      const config = await loadConfig(owner, name, token, log);
      await createConfiguredLabels(repo.full_name, config, token, log);
      await reconcileAutoMerge(repo.full_name, config, token, log);
      await maybeRetriggerZombiesForRepo(repo.full_name, config, token, env, log);
      await maybeOpenPrsForRepo(repo.full_name, config, token, log);
      await enqueueConflictChecksForRepo(repo.full_name, config, env, token, log);
      await enqueueDescribeChecksForRepo(repo.full_name, config, env, token, log);
      await closeEmptyAutoPrs(repo.full_name, config, token, env, log);
      if (env.PR_STATE) await markBackfilled(env.PR_STATE, repo.full_name);
      labelCheckedAt.set(repo.full_name, Date.now());
    } catch (e) {
      log.log(`repos_added: ${repo.full_name}: ${(e as Error).message}`);
    }
  }
}

async function createConfiguredLabels(repo: string, config: PrMinderConfig, token: string, log: Logger): Promise<void> {
  for (const [name, opts] of Object.entries(config.labels)) {
    if (!opts.create_label_if_missing_in_repo) continue;
    try {
      await ensureLabel(repo, name, opts.color, token, log);
    } catch (e) {
      log.log(`ensureLabel "${name}" failed: ${(e as Error).message}`);
    }
  }
}

async function applyAutoAddLabels(repo: string, pr: any, config: PrMinderConfig, token: string, log: Logger): Promise<void> {
  const existing = new Set<string>((pr.labels ?? []).map((l: any) => l.name));
  const toAdd: string[] = [];
  for (const [name, opts] of Object.entries(config.labels)) {
    if (opts.auto_add === 'on_pr_creation' && !existing.has(name)) toAdd.push(name);
  }
  if (toAdd.length === 0) return;
  try {
    await addLabelsToPr(repo, pr.number, toAdd, token, log);
    // GitHub will fire a separate `labeled` webhook, but reflect the change locally
    // so the trigger evaluation in this same handler call sees the new labels.
    for (const name of toAdd) pr.labels.push({ name });
  } catch (e) {
    log.log(`applyAutoAddLabels ${repo}#${pr.number} failed: ${(e as Error).message}`);
  }
}

async function syncAutoMergeLabelEnabled(repo: string, pr: any, config: PrMinderConfig, token: string, log: Logger): Promise<void> {
  const tag = `${repo}#${pr.number}`;
  for (const [labelName, opts] of Object.entries(config.labels)) {
    if (opts.mode !== 'auto_merge') continue;
    if ((pr.labels ?? []).some((l: any) => l.name === labelName)) continue;
    log.log(`${tag}: addLabel "${labelName}" (auto_merge_enabled)`);
    await addLabelsToPr(repo, pr.number, [labelName], token, log);
    pr.labels.push({ name: labelName });
  }
}

async function syncAutoMergeLabelDisabled(repo: string, pr: any, config: PrMinderConfig, token: string, log: Logger): Promise<void> {
  const tag = `${repo}#${pr.number}`;
  for (const [labelName, opts] of Object.entries(config.labels)) {
    if (opts.mode !== 'auto_merge') continue;
    if (!(pr.labels ?? []).some((l: any) => l.name === labelName)) continue;
    log.log(`${tag}: removeLabel "${labelName}" (auto_merge_disabled)`);
    await removeLabelFromPr(repo, pr.number, labelName, token, log);
  }
}

// A PR authored by github-actions[bot] was created with the default GITHUB_TOKEN, whose
// events never trigger workflow runs (GitHub's recursion guard). That author is the precise
// signal that the PR's own CI never ran: PRs created via a PAT or another App token carry
// that account's identity instead and trigger workflows normally.
export function isActionsBotPr(pr: any): boolean {
  return pr?.user?.login === 'github-actions[bot]';
}

// Which pull_request actions may trigger a zombie revive. opened / reopened / synchronize all
// qualify (a new or touched PR may be a CI-less zombie); reviveIfZombie itself then decides whether
// to act — and the commit-age guard there, not the event sender, is what prevents pr-minder's own
// update-branch merge from being re-closed. The one event we drop here is a `reopened` we sent
// ourselves (Bot sender): that's our own close+reopen coming back, and skipping it is the loop guard.
export function shouldConsiderRevive(action: string, sender: any): boolean {
  if (!['opened', 'reopened', 'synchronize'].includes(action)) return false;
  if (action === 'reopened' && sender?.type === 'Bot') return false;
  return true;
}

async function prQualifies(pr: any, repo: string, config: PrMinderConfig, token: string, log: Logger): Promise<boolean> {
  let approvers: Set<string> | null = null;
  const getApprovers = async () => {
    if (approvers === null) approvers = await fetchApprovers(repo, pr.number, token, log);
    return approvers;
  };
  for (const condition of config.triggers) {
    if (await conditionMet(condition, pr, getApprovers)) return true;
  }
  return Object.entries(config.labels).some(
    ([name, opts]) => opts.mode === 'auto_update' && pr.labels.some((l: any) => l.name === name),
  );
}

export async function conditionMet(
  c: TriggerCondition,
  pr: any,
  getApprovers: () => Promise<Set<string>>,
): Promise<boolean> {
  if (c.label !== undefined && !pr.labels.some((l: any) => l.name === c.label)) return false;
  if (c.approved_by !== undefined || c.min_approvals !== undefined) {
    const approvers = await getApprovers();
    if (c.approved_by !== undefined && !c.approved_by.some((u) => approvers.has(u))) return false;
    if (c.min_approvals !== undefined && approvers.size < c.min_approvals) return false;
  }
  return true;
}
