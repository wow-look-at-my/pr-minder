import type { Env } from './worker';
import { loadConfig, type PrMinderConfig, type TriggerCondition } from './config';
import { addLabelsToPr, removeLabelFromPr, ensureLabel, installToken, updateBranch, retriggerWorkflows, hasWorkflowRuns, enableAutoMerge, disableAutoMerge, fetchApprovers, listInstallationRepos, compareCommits, hasOpenPrForBranch, listBranches, listOpenPulls, getDefaultBranch, createPull, gh } from './github';
import { checkedSha, markChecked, wasBackfilled, markBackfilled } from './state';
import type { Logger } from './logger';

// Per-repo throttle for opportunistic label checks. Module-scope cache lives
// for the life of the isolate; a cold start just re-checks once, no harm.
const labelCheckedAt = new Map<string, number>();
const LABEL_CHECK_INTERVAL_MS = 15 * 60 * 1000;

export async function handle(event: string | null, p: any, env: Env, log: Logger): Promise<void> {
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

  if (event === 'pull_request' && ['opened', 'reopened', 'ready_for_review', 'labeled', 'unlabeled', 'synchronize', 'auto_merge_enabled', 'auto_merge_disabled'].includes(action)) {
    return onPR(p, env, log);
  }
  // Webhook payload uses lowercase state; REST API uses uppercase — different conventions.
  if (event === 'pull_request_review' && action === 'submitted' && p.review?.state === 'approved') {
    return onPR(p, env, log);
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

async function onPR(p: any, env: Env, log: Logger): Promise<void> {
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

  if (action === 'opened') {
    await applyAutoAddLabels(repo, pr, config, token, log);
  }

  // Revive a "zombie" PR — author github-actions[bot] with no workflow runs of its own (created
  // with the default GITHUB_TOKEN, whose events GitHub won't let trigger workflows). Closing+
  // reopening with our App token fires a fresh event that DOES run them. shouldConsiderRevive gates
  // which events qualify (see its comment) — in particular it ignores a `synchronize` that anyone
  // other than github-actions[bot] pushed, so pr-minder's own update-branch merge doesn't re-trigger
  // a revive. If we did reopen, return — the PR was just closed+reopened, and the fresh event drives
  // the rest.
  if (config.autoTriggerWorkflows && shouldConsiderRevive(action, p.sender)) {
    if (await reviveIfZombie(env, repo, pr, token, log)) return;
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
      log.log(`${tag}: updateBranch`);
      await updateBranch(repo, pr.number, token, log);
      log.log(`${tag}: updateBranch ok`);
    } catch (e) {
      log.log(`${tag}: updateBranch failed: ${(e as Error).message}`);
    }
  }
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

// The default branch and gh-pages are always skipped; the config can skip more.
export function shouldSkipBranch(branch: string, base: string, skipBranches: string[]): boolean {
  return new Set<string>(['gh-pages', base, ...skipBranches]).has(branch);
}

async function maybeOpenPrForBranch(repo: string, branch: string, base: string, config: PrMinderConfig, token: string, log: Logger): Promise<void> {
  const tag = `${repo}@${branch}`;
  if (shouldSkipBranch(branch, base, config.autoOpenPr.skipBranches)) {
    log.log(`${tag}: skip (excluded branch)`);
    return;
  }
  const cmp = await compareCommits(repo, base, branch, token, log);
  if (!cmp) { log.log(`${tag}: skip (compare failed)`); return; }
  if (cmp.ahead_by === 0) { log.log(`${tag}: skip (not ahead of ${base})`); return; }
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
  const branches = await listBranches(repo, token, log);
  log.log(`${repo}: auto_open_pr sweep over ${branches.length} branches`);
  for (const branch of branches) {
    await maybeOpenPrForBranch(repo, branch, base, config, token, log);
  }
}

// Evaluate one PR and revive it if it's a GITHUB_TOKEN "zombie": author github-actions[bot] with
// no workflow runs for its head commit. Closing+reopening with our App token fires a fresh event
// that DOES run its workflows. Returns true iff it reopened.
//
// KV makes this check-once: skip if we've already evaluated this PR at its current head SHA, and
// record the SHA afterwards — so a new commit (new SHA) is re-checked but an untouched PR never is.
// Bot-author-gated, so the one hasWorkflowRuns call is spent only on the PR kind that can be a
// zombie. (A bot PR always has zero runs until revived, which is exactly why zero runs is the right
// signal here even on a freshly opened/synchronized PR; non-bot PRs return immediately.) Degrades to
// "always check, never record" if the KV binding is somehow absent, so it never throws on missing KV.
export async function reviveIfZombie(env: Env, repo: string, pr: any, token: string, log: Logger): Promise<boolean> {
  const sha = pr?.head?.sha;
  if (pr?.draft || !sha || !isActionsBotPr(pr)) return false;
  if (env.PR_STATE && (await checkedSha(env.PR_STATE, repo, pr.number)) === sha) return false;

  let reopened = false;
  if (!(await hasWorkflowRuns(repo, sha, token, log))) {
    log.log(`${repo}#${pr.number}: zombie PR with no workflow runs; re-triggering (close+reopen)`);
    await retriggerWorkflows(repo, pr.number, token, log);
    reopened = true;
  }
  if (env.PR_STATE) await markChecked(env.PR_STATE, repo, pr.number, sha);
  return reopened;
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
      await maybeRetriggerZombiesForRepo(fullName, config, token, env, log);
      await maybeOpenPrsForRepo(fullName, config, token, log);
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
      await maybeRetriggerZombiesForRepo(repo.full_name, config, token, env, log);
      await maybeOpenPrsForRepo(repo.full_name, config, token, log);
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

// The actor behind the default GITHUB_TOKEN. Commits and PRs it creates never trigger their own
// workflows (GitHub's recursion guard), so it's the precise signal that a commit is a CI-less
// "zombie". Every other actor — a human, a third-party app, or pr-minder's own App installation
// token — triggers workflows normally.
const ACTIONS_BOT = 'github-actions[bot]';

// A PR authored by github-actions[bot] was created with the default GITHUB_TOKEN, whose
// events never trigger workflow runs (GitHub's recursion guard). That author is the precise
// signal that the PR's own CI never ran: PRs created via a PAT or another App token carry
// that account's identity instead and trigger workflows normally.
export function isActionsBotPr(pr: any): boolean {
  return pr?.user?.login === ACTIONS_BOT;
}

// Which pull_request actions may trigger a zombie revive, given the event's sender. Only
// github-actions[bot] produces CI-less commits, so it's the only actor a revive should react to:
//   opened     — a freshly created PR; reviveIfZombie's own isActionsBotPr gate then confirms author.
//   reopened   — eligible, UNLESS a Bot sent it: that's our own close+reopen coming back (loop guard).
//   synchronize— eligible ONLY when github-actions[bot] pushed the new commit. A synchronize from
//                anyone else — a human, a third-party app, or pr-minder's own update-branch merge —
//                is a commit that triggers CI natively, so re-reviving it is both pointless and the
//                cause of a spurious *second* close+reopen on an auto-updated bot PR: the update-branch
//                merge changes the head SHA (so KV hasn't deduped it) and its runs haven't registered
//                yet (so hasWorkflowRuns momentarily reads 0), which used to trip a needless revive.
export function shouldConsiderRevive(action: string, sender: any): boolean {
  if (!['opened', 'reopened', 'synchronize'].includes(action)) return false;
  if (action === 'reopened' && sender?.type === 'Bot') return false;
  if (action === 'synchronize' && sender?.login !== ACTIONS_BOT) return false;
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
