import type { Env } from './worker';
import { loadConfig, type PrMinderConfig, type TriggerCondition } from './config';
import { installToken, updateBranch, fetchApprovers, gh } from './github';

export async function handle(event: string | null, p: any, env: Env): Promise<void> {
  if (event === 'pull_request' && ['opened', 'reopened', 'ready_for_review', 'labeled', 'synchronize'].includes(p.action)) {
    return onPR(p, env);
  }
  // Webhook payload uses lowercase state; REST API uses uppercase — different conventions.
  if (event === 'pull_request_review' && p.action === 'submitted' && p.review?.state === 'approved') {
    return onPR(p, env);
  }
  if (event === 'push' && p.ref === `refs/heads/${p.repository.default_branch}`) {
    return onPushToDefault(p, env);
  }
}

async function onPR(p: any, env: Env): Promise<void> {
  const pr = p.pull_request;
  if (pr.draft) return;
  // GitHub returns one priority-ordered mergeable_state. A PR that is behind AND blocked-by-review
  // reports 'blocked', masking the behind-ness. 'unknown' can also appear before GitHub finishes the
  // async mergeability compute. Treat these as "maybe behind" — updateBranch returns 422 if not.
  if (!['behind', 'blocked', 'unknown'].includes(pr.mergeable_state)) return;

  const token = await installToken(p.installation.id, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const [owner, repo] = p.repository.full_name.split('/');
  const config = await loadConfig(owner, repo, token);

  if (!config.enabled) return;
  if (!(await prQualifies(pr, p.repository.full_name, config, token))) return;

  await updateBranch(p.repository.full_name, pr.number, token);
}

async function onPushToDefault(p: any, env: Env): Promise<void> {
  const token = await installToken(p.installation.id, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const [owner, repo] = p.repository.full_name.split('/');
  const config = await loadConfig(owner, repo, token);
  if (!config.enabled) return;

  const r = await gh(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`, token);
  const prs: any[] = await r.json();

  for (const pr of prs) {
    if (pr.draft) continue;
    if (!(await prQualifies(pr, p.repository.full_name, config, token))) continue;
    try {
      await updateBranch(p.repository.full_name, pr.number, token);
    } catch (e) {
      console.log(`skip ${owner}/${repo}#${pr.number}: ${(e as Error).message}`);
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
