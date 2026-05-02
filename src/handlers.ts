import type { Env } from './worker';
import { loadConfig, type PrMinderConfig, type TriggerCondition } from './config';
import { addLabels, ensureLabel, installToken, updateBranch, fetchApprovers, listInstallationRepos, gh } from './github';
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

  if (event === 'pull_request' && ['opened', 'reopened', 'ready_for_review', 'labeled', 'unlabeled', 'synchronize'].includes(action)) {
    return onPR(p, env, log);
  }
  // Webhook payload uses lowercase state; REST API uses uppercase — different conventions.
  if (event === 'pull_request_review' && action === 'submitted' && p.review?.state === 'approved') {
    return onPR(p, env, log);
  }
  if (event === 'push' && p.ref === `refs/heads/${p.repository.default_branch}`) {
    return onPushToDefault(p, env, log);
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
    if (!config.enabled) return;
    await ensureTriggerLabels(fullName, config, token, log);
  } catch (e) {
    log.log(`maybeEnsureLabels: ${fullName}: ${(e as Error).message}`);
  }
}

async function onPR(p: any, env: Env, log: Logger): Promise<void> {
  const pr = p.pull_request;
  const repo = p.repository.full_name;
  const tag = `${repo}#${pr.number}`;

  if (pr.draft) {
    log.log(`${tag}: skip (draft)`);
    return;
  }

  const token = await installToken(p.installation.id, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
  const [owner, name] = repo.split('/');
  const config = await loadConfig(owner, name, token, log);
  log.log(`${tag}: config enabled=${config.enabled} triggers=${config.triggers.length}`);

  if (!config.enabled) return;

  // Apply default labels on PR open. Only call the API for labels not already
  // present, then mirror them into pr.labels so trigger evaluation below sees
  // the post-add state. (GitHub fires a follow-up `labeled` event that will
  // re-evaluate; that's redundant but harmless since updateBranch is idempotent.)
  if (p.action === 'opened' && config.default_labels.length > 0) {
    const existing = new Set<string>((pr.labels ?? []).map((l: any) => l.name));
    const toAdd = config.default_labels.filter((l) => !existing.has(l));
    if (toAdd.length > 0) {
      await addLabels(repo, pr.number, toAdd, token, log);
      pr.labels = [...(pr.labels ?? []), ...toAdd.map((name) => ({ name }))];
    }
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
  log.log(`${repo} push: config enabled=${config.enabled} triggers=${config.triggers.length}`);
  if (!config.enabled) return;

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

async function onInstallation(p: any, env: Env, log: Logger): Promise<void> {
  const token = await installToken(p.installation.id, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
  const repos = await listInstallationRepos(token, log);
  log.log(`installation: sweeping ${repos.length} repos for label creation`);
  for (const fullName of repos) {
    const [owner, name] = fullName.split('/');
    try {
      const config = await loadConfig(owner, name, token, log);
      if (!config.enabled) continue;
      await ensureTriggerLabels(fullName, config, token, log);
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
      if (!config.enabled) continue;
      await ensureTriggerLabels(repo.full_name, config, token, log);
      labelCheckedAt.set(repo.full_name, Date.now());
    } catch (e) {
      log.log(`repos_added: ${repo.full_name}: ${(e as Error).message}`);
    }
  }
}

async function ensureTriggerLabels(repo: string, config: PrMinderConfig, token: string, log: Logger): Promise<void> {
  if (!config.labels.autocreate) return;
  const names = new Set<string>();
  for (const t of config.triggers) {
    if (t.label) names.add(t.label);
  }
  for (const l of config.default_labels) names.add(l);
  for (const name of names) {
    try {
      await ensureLabel(repo, name, config.labels.color, token, log);
    } catch (e) {
      log.log(`ensureLabel "${name}" failed: ${(e as Error).message}`);
    }
  }
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
  return false;
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
