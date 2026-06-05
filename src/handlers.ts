import type { Env } from './worker';
import { loadConfig, type PrMinderConfig, type TriggerCondition } from './config';
import { addLabelsToPr, removeLabelFromPr, ensureLabel, installToken, updateBranch, retriggerWorkflows, hasWorkflowRuns, enableAutoMerge, disableAutoMerge, fetchApprovers, listInstallationRepos, compareCommits, hasOpenPrForBranch, listBranches, listOpenPulls, getDefaultBranch, createPull, gh } from './github';
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

  // Opportunistic label check on every event for the source repo, throttled per-repo.
  // Handlers below that already create labels (installation sweeps) bypass this.
  if (repo && p.installation?.id) {
    await maybeEnsureLabelsForRepo(repo, p.installation.id, env, log);
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

  // Revive a "zombie" PR — one with no workflow runs of its own. A PR created with the
  // default GITHUB_TOKEN (author github-actions[bot]) is the classic case: GitHub suppresses
  // its workflows to avoid recursion. Closing+reopening with our App token fires a fresh
  // `pull_request.reopened` event (a default activity type) that DOES run them.
  if (config.autoTriggerWorkflows && (action === 'opened' || action === 'reopened')) {
    if (await needsWorkflowTrigger(p, action, repo, pr, token, log)) {
      log.log(`${tag}: zombie PR with no workflow runs; re-triggering (close+reopen)`);
      await retriggerWorkflows(repo, pr.number, token, log);
      return;
    }
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

  // A push to the default branch is our ambient trigger for already-installed repos: sweep for
  // zombie PRs here too, not only at install/repos-added. GitHub never re-sends an install event
  // for a repo that's already onboarded, so without this an existing zombie (one that predates the
  // App) would sit dead until someone reopened it by hand. Gated on auto_trigger_workflows and
  // bot-author, and self-limiting — once a revived PR's CI runs it has runs, so the next push skips
  // it (no flapping in the normal case; a repo with no PR workflows at all is unfixable anyway).
  await maybeRetriggerZombiesForRepo(repo, config, token, log);

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

// Catch-up sweep run when the App is installed or repos are added: revive any pre-existing
// "zombie" PR — one a CI job opened with the default GITHUB_TOKEN (author github-actions[bot])
// before pr-minder was watching, so its workflows never fired. Closing+reopening with our App
// token fires a fresh `pull_request.reopened` event that runs them. Our own reopen returns
// Bot-sent and is skipped on the live `reopened` path, so the sweep can't loop. Runs BEFORE the
// auto_open_pr sweep so a PR we open this pass (App-authored, CI fires natively) is never mistaken
// for a zombie by its momentary zero runs.
//
// Rate-limit shape: listOpenPulls already carries each PR's author, so we gate on
// `isActionsBotPr` (free) and spend the one `hasWorkflowRuns` call ONLY on bot-authored PRs —
// the sole kind that can be a GITHUB_TOKEN zombie. Cost is ~1 API call per *bot-authored* open
// PR, not per open PR, which bounds the burst when a large installation is onboarded. (A human-
// or PAT-authored PR with zero runs means the repo has no PR CI, which a reopen can't fix; the
// live `reopened` path still handles any author when a human explicitly reopens a single PR.)
async function maybeRetriggerZombiesForRepo(repo: string, config: PrMinderConfig, token: string, log: Logger): Promise<void> {
  if (!config.autoTriggerWorkflows) return;
  const prs = await listOpenPulls(repo, token, log);
  const candidates = prs.filter((pr) => !pr.draft && isActionsBotPr(pr) && pr.head?.sha);
  log.log(`${repo}: zombie sweep over ${prs.length} open PRs (${candidates.length} bot-authored)`);
  for (const pr of candidates) {
    const tag = `${repo}#${pr.number}`;
    try {
      if (await hasWorkflowRuns(repo, pr.head.sha, token, log)) continue;
      log.log(`${tag}: zombie PR with no workflow runs; re-triggering (close+reopen)`);
      await retriggerWorkflows(repo, pr.number, token, log);
    } catch (e) {
      log.log(`${tag}: zombie retrigger failed: ${(e as Error).message}`);
    }
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
      await maybeRetriggerZombiesForRepo(fullName, config, token, log);
      await maybeOpenPrsForRepo(fullName, config, token, log);
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
      await maybeRetriggerZombiesForRepo(repo.full_name, config, token, log);
      await maybeOpenPrsForRepo(repo.full_name, config, token, log);
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

// Decide whether a just-opened or reopened PR needs its workflows kicked off.
//
// `opened`: the PR is brand new, so EVERY PR momentarily has zero runs — an empty run list
// can't tell a zombie from a healthy PR whose runs haven't registered yet. The only race-free
// signal is the author: github-actions[bot] means it was created with the default GITHUB_TOKEN,
// whose events GitHub refuses to let trigger workflows.
//
// `reopened`: the PR isn't fresh, so an empty run list is trustworthy — trigger any PR that
// still has no runs, whatever its author. Reopens performed by a bot (our own close+reopen, or
// another GITHUB_TOKEN actor) are skipped via the sender, so our reopen can't loop.
async function needsWorkflowTrigger(p: any, action: string, repo: string, pr: any, token: string, log: Logger): Promise<boolean> {
  if (action === 'opened') return isActionsBotPr(pr);
  if (p.sender?.type === 'Bot') return false;
  if (!pr.head?.sha) return false;
  return !(await hasWorkflowRuns(repo, pr.head.sha, token, log));
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
