import type { Env } from './worker';
import { loadConfig, type PrMinderConfig, type TriggerCondition } from './config';
import { installToken, updateBranch, fetchApprovers, gh } from './github';

export async function handle(event: string | null, p: any, env: Env): Promise<void> {
  const repo = p.repository?.full_name;
  const action = p.action;
  const prNum = p.pull_request?.number;
  console.log(`event=${event} action=${action} repo=${repo} pr=${prNum}`);

  if (event === 'pull_request' && ['opened', 'reopened', 'ready_for_review', 'labeled', 'synchronize'].includes(action)) {
    return onPR(p, env);
  }
  // Webhook payload uses lowercase state; REST API uses uppercase — different conventions.
  if (event === 'pull_request_review' && action === 'submitted' && p.review?.state === 'approved') {
    return onPR(p, env);
  }
  if (event === 'push' && p.ref === `refs/heads/${p.repository.default_branch}`) {
    return onPushToDefault(p, env);
  }
  console.log(`skip: no handler matched (event=${event} action=${action})`);
}

async function onPR(p: any, env: Env): Promise<void> {
  const pr = p.pull_request;
  const repo = p.repository.full_name;
  const tag = `${repo}#${pr.number}`;

  if (pr.draft) {
    console.log(`${tag}: skip (draft)`);
    return;
  }
  // GitHub returns one priority-ordered mergeable_state. A PR that is behind AND blocked-by-review
  // reports 'blocked', masking the behind-ness. 'unknown' can also appear before GitHub finishes the
  // async mergeability compute. Treat these as "maybe behind" — updateBranch returns 422 if not.
  if (!['behind', 'blocked', 'unknown'].includes(pr.mergeable_state)) {
    console.log(`${tag}: skip (mergeable_state=${pr.mergeable_state})`);
    return;
  }

  const token = await installToken(p.installation.id, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const [owner, name] = repo.split('/');
  const config = await loadConfig(owner, name, token);
  console.log(`${tag}: config enabled=${config.enabled} triggers=${config.triggers.length}`);

  if (!config.enabled) return;
  if (!(await prQualifies(pr, repo, config, token))) {
    console.log(`${tag}: skip (no trigger matched; labels=${JSON.stringify(pr.labels?.map((l: any) => l.name))})`);
    return;
  }

  console.log(`${tag}: updateBranch`);
  await updateBranch(repo, pr.number, token);
  console.log(`${tag}: updateBranch ok`);
}

async function onPushToDefault(p: any, env: Env): Promise<void> {
  const repo = p.repository.full_name;
  const token = await installToken(p.installation.id, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const [owner, name] = repo.split('/');
  const config = await loadConfig(owner, name, token);
  console.log(`${repo} push: config enabled=${config.enabled} triggers=${config.triggers.length}`);
  if (!config.enabled) return;

  const r = await gh(`/repos/${owner}/${name}/pulls?state=open&per_page=100`, token);
  const prs: any[] = await r.json();
  console.log(`${repo} push: scanning ${prs.length} open PRs`);

  for (const pr of prs) {
    const tag = `${repo}#${pr.number}`;
    if (pr.draft) { console.log(`${tag}: skip (draft)`); continue; }
    if (!(await prQualifies(pr, repo, config, token))) {
      console.log(`${tag}: skip (no trigger matched)`);
      continue;
    }
    try {
      console.log(`${tag}: updateBranch`);
      await updateBranch(repo, pr.number, token);
      console.log(`${tag}: updateBranch ok`);
    } catch (e) {
      console.log(`${tag}: updateBranch failed: ${(e as Error).message}`);
    }
  }
}

async function prQualifies(pr: any, repo: string, config: PrMinderConfig, token: string): Promise<boolean> {
  let approvers: Set<string> | null = null;
  const getApprovers = async () => {
    if (approvers === null) approvers = await fetchApprovers(repo, pr.number, token);
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
