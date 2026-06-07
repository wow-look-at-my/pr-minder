import type { Logger } from './logger';

export class GhError extends Error {
  constructor(public status: number, public body: string) {
    super(`${status}: ${body}`);
    this.name = 'GhError';
  }
}

export async function gh(path: string, token: string, log: Logger) {
  const r = await fetch(`https://api.github.com${path}`, { headers: ghHeaders(token) });
  if (!r.ok && r.status !== 404) log.log(`gh ${path}: ${r.status}`);
  return r;
}

export function ghHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'pr-minder',
  };
}

export async function installToken(installId: number, appId: string, privateKey: string, log: Logger): Promise<string> {
  const jwt = await appJWT(appId, privateKey);
  const r = await fetch(`https://api.github.com/app/installations/${installId}/access_tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'pr-minder',
    },
  });
  if (!r.ok) {
    const body = await r.text();
    log.log(`installToken id=${installId}: ${r.status} ${body}`);
    throw new GhError(r.status, body);
  }
  return ((await r.json()) as any).token;
}

export async function updateBranch(repo: string, num: number, token: string, log: Logger): Promise<void> {
  const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${num}/update-branch`, {
    method: 'PUT',
    headers: ghHeaders(token),
  });
  if (r.ok) return;
  // 422 is GitHub's catch-all "Unprocessable Entity". The common no-op is the branch already
  // being current — GitHub phrases that as "There are no new commits on the base branch."
  // That is not an error. Genuine 422s (merge conflict, blocked-by-protection) are real, so
  // log the body either way and rethrow only the ones that aren't the already-current no-op.
  const body = await r.text();
  log.log(`updateBranch ${repo}#${num}: ${r.status} ${body}`);
  if (r.status === 422 && /not behind|up.?to.?date|merge commit|no new commits/i.test(body)) return;
  throw new GhError(r.status, body);
}

// Would updating this PR's branch with its base introduce no changes — i.e. would GitHub's
// update-branch leave an empty "Merge branch ..." commit on the PR? That happens when `head` is
// "behind" base by commit *count* yet already contains base's *content* (a branch that tracks base
// closely, e.g. an uprev/sync branch, or a head that already merged/superseded base's changes):
// GitHub merges anyway and the 3-way result equals head's tree, so the merge commit has a zero diff.
//
// We answer it from GitHub's own test-merge of the PR (`merge_commit_sha`, kept at refs/pull/N/merge
// = base merged with head). A clean 3-way merge's *tree* is independent of merge direction, so that
// tree is exactly what update-branch (base into head) would produce; the merge is empty precisely
// when it equals head's tree. We trust the test-merge only when it's provably current — its parents
// must be the PR's *current* head and the *current* base tip (`baseTipSha`). GitHub recomputes the
// test-merge asynchronously, so a just-moved base can briefly leave it stale; a stale (or absent)
// one fails the parent check and we return false, so update-branch still runs. Because we verify the
// parents, a "true" means the tree we compared really is the merge of these exact commits — a wrong
// skip (dropping a genuine update) is impossible; the worst case is a missed skip (a harmless extra
// merge), never a missed update.
export async function mergeWouldBeEmpty(repo: string, pr: any, baseTipSha: string | null, token: string, log: Logger): Promise<boolean> {
  const headSha: string | undefined = pr?.head?.sha;
  const mergeSha: string | undefined = pr?.merge_commit_sha;
  if (!headSha || !mergeSha || !baseTipSha) return false;
  const merge = await commitMeta(repo, mergeSha, token, log);
  if (!merge) return false;
  // Only trust a test-merge of the current head and base; otherwise it predates a move and is stale.
  if (!merge.parents.includes(headSha) || !merge.parents.includes(baseTipSha)) return false;
  const head = await commitMeta(repo, headSha, token, log);
  if (!head) return false;
  return merge.tree === head.tree;
}

// Tree SHA and parent SHAs of a commit, via the lightweight Git Data API (no file list, unlike
// /repos/.../commits/{sha}). Null on any error so callers fail safe.
async function commitMeta(repo: string, sha: string, token: string, log: Logger): Promise<{ tree: string; parents: string[] } | null> {
  const r = await gh(`/repos/${repo}/git/commits/${sha}`, token, log);
  if (!r.ok) return null;
  const data: any = await r.json();
  const tree = data?.tree?.sha;
  if (typeof tree !== 'string') return null;
  return { tree, parents: (data.parents ?? []).map((p: any) => p.sha) };
}

// A PR opened with the default GITHUB_TOKEN (author github-actions[bot]) never triggers
// its own workflows: GitHub suppresses runs from that token to prevent recursion. Closing
// and reopening the PR with a *different* credential — our App's installation token — fires
// a fresh `pull_request.reopened` event (a default activity type), which DOES run the
// `on: pull_request` workflows. This is GitHub's documented workaround for a "zombie" PR
// that has no CI, and needs only pull_requests:write (which the App already holds).
export async function retriggerWorkflows(repo: string, num: number, token: string, log: Logger): Promise<void> {
  await setPullState(repo, num, 'closed', token, log);
  await setPullState(repo, num, 'open', token, log);
  log.log(`retriggerWorkflows ${repo}#${num}: closed+reopened to trigger workflows`);
}

async function setPullState(repo: string, num: number, state: 'open' | 'closed', token: string, log: Logger): Promise<void> {
  const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${num}`, {
    method: 'PATCH',
    headers: { ...ghHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  if (r.ok) { log.log(`setPullState ${repo}#${num}: ${state}`); return; }
  const body = await r.text();
  log.log(`setPullState ${repo}#${num} -> ${state}: ${r.status} ${body}`);
  throw new GhError(r.status, body);
}

// Does the PR's head commit have any GitHub Actions workflow runs? Distinguishes a genuine
// "zombie" PR (created by a workflow's GITHUB_TOKEN, so its workflows never fired) from one
// whose CI has already run. On a query error we assume runs exist, so a transient failure
// can never trigger a spurious close+reopen.
export async function hasWorkflowRuns(repo: string, headSha: string, token: string, log: Logger): Promise<boolean> {
  const r = await gh(`/repos/${repo}/actions/runs?head_sha=${headSha}&per_page=1`, token, log);
  if (!r.ok) return true;
  const data: any = await r.json();
  return (data.total_count ?? 0) > 0;
}

// Age of a commit in seconds (now - committer date), or null if it can't be determined. Used to
// tell a genuinely CI-less "zombie" commit (old enough that its workflows would have registered by
// now) from one that's merely too fresh to judge — e.g. a commit pr-minder just created via
// update-branch, whose runs haven't appeared yet. Null on any error so the caller can fail safe.
export async function commitAgeSeconds(repo: string, sha: string, token: string, log: Logger): Promise<number | null> {
  const r = await gh(`/repos/${repo}/commits/${sha}`, token, log);
  if (!r.ok) return null;
  const data: any = await r.json();
  const dateStr: string | undefined = data?.commit?.committer?.date ?? data?.commit?.author?.date;
  const ms = dateStr ? Date.parse(dateStr) : NaN;
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 1000));
}

// `${base}...${head}` commit comparison. Returns null on error (caller skips). Branch names
// keep their slashes in the path; git ref rules forbid the characters that would need encoding.
export async function compareCommits(repo: string, base: string, head: string, token: string, log: Logger): Promise<{ ahead_by: number; behind_by: number } | null> {
  const r = await gh(`/repos/${repo}/compare/${base}...${head}`, token, log);
  if (!r.ok) return null;
  const data: any = await r.json();
  return { ahead_by: data.ahead_by ?? 0, behind_by: data.behind_by ?? 0 };
}

export async function hasOpenPrForBranch(repo: string, branch: string, token: string, log: Logger): Promise<boolean> {
  const [owner] = repo.split('/');
  const r = await gh(`/repos/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open&per_page=1`, token, log);
  // Fail safe to "exists" on error so a transient failure never opens a duplicate PR.
  if (!r.ok) return true;
  const data: any[] = await r.json();
  return data.length > 0;
}

export async function listBranches(repo: string, token: string, log: Logger): Promise<string[]> {
  const names: string[] = [];
  let page = 1;
  for (;;) {
    const r = await gh(`/repos/${repo}/branches?per_page=100&page=${page}`, token, log);
    if (!r.ok) break;
    const data: any[] = await r.json();
    for (const b of data) names.push(b.name);
    if (data.length < 100) break;
    page++;
  }
  return names;
}

// Every open PR in the repo, following pagination. Items are the raw GitHub PR objects
// (callers read .number, .draft, .head.sha). Returns [] on a query error, so a transient
// failure degrades to "nothing to sweep" instead of throwing.
export async function listOpenPulls(repo: string, token: string, log: Logger): Promise<any[]> {
  const pulls: any[] = [];
  let page = 1;
  for (;;) {
    const r = await gh(`/repos/${repo}/pulls?state=open&per_page=100&page=${page}`, token, log);
    if (!r.ok) break;
    const data: any[] = await r.json();
    for (const pr of data) pulls.push(pr);
    if (data.length < 100) break;
    page++;
  }
  return pulls;
}

export async function getDefaultBranch(repo: string, token: string, log: Logger): Promise<string | null> {
  const r = await gh(`/repos/${repo}`, token, log);
  if (!r.ok) return null;
  const data: any = await r.json();
  return data.default_branch ?? null;
}

// Opens a PR head->base. Returns the new PR number, or null when GitHub declines for a
// non-retryable reason (422: no commits between base and head, or a PR already exists).
export async function createPull(repo: string, head: string, base: string, title: string, body: string, token: string, log: Logger): Promise<number | null> {
  const r = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
    method: 'POST',
    headers: { ...ghHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ head, base, title, body }),
  });
  if (r.ok) {
    const data: any = await r.json();
    log.log(`createPull ${repo} ${head}->${base}: #${data.number}`);
    return data.number;
  }
  const text = await r.text();
  log.log(`createPull ${repo} ${head}->${base}: ${r.status} ${text}`);
  // 5xx is transient — throw so GitHub redelivers. 422/4xx are non-retryable — log and move on.
  if (r.status >= 500) throw new GhError(r.status, text);
  return null;
}

export async function addLabelsToPr(repo: string, num: number, labels: string[], token: string, log: Logger): Promise<void> {
  if (labels.length === 0) return;
  const r = await fetch(`https://api.github.com/repos/${repo}/issues/${num}/labels`, {
    method: 'POST',
    headers: { ...ghHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ labels }),
  });
  if (r.ok) {
    log.log(`addLabels ${repo}#${num}: [${labels.join(', ')}]`);
    return;
  }
  const body = await r.text();
  log.log(`addLabels ${repo}#${num}: ${r.status} ${body}`);
  // 422 typically means the label doesn't exist in the repo — permanent error,
  // retries won't help. Other failures (5xx, network) propagate so GitHub retries.
  if (r.status === 422) return;
  throw new GhError(r.status, body);
}

export async function ensureLabel(repo: string, name: string, color: string, token: string, log: Logger): Promise<void> {
  const r = await fetch(`https://api.github.com/repos/${repo}/labels`, {
    method: 'POST',
    headers: { ...ghHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ name, color }),
  });
  if (r.status === 201) {
    log.log(`createLabel ${repo} "${name}" #${color}`);
    return;
  }
  // 422 with "already_exists" is the steady state — label is present, nothing to do.
  if (r.status === 422) return;
  const body = await r.text();
  log.log(`createLabel ${repo} "${name}": ${r.status} ${body}`);
}

export async function fetchApprovers(repo: string, num: number, token: string, log: Logger): Promise<Set<string>> {
  const r = await gh(`/repos/${repo}/pulls/${num}/reviews?per_page=100`, token, log);
  if (!r.ok) return new Set();
  const reviews: any[] = await r.json();
  // Latest non-pending review per user determines their standing vote
  const latest = new Map<string, string>();
  for (const rev of reviews) {
    if (rev.state !== 'PENDING') latest.set(rev.user.login, rev.state);
  }
  return new Set([...latest].filter(([, state]) => state === 'APPROVED').map(([u]) => u));
}

// Every installation of the App, by id, following pagination. Authenticates as the App itself
// (JWT, not an installation token) since /app/installations is an App-level endpoint. Returns []
// on a query error so a startup sweep degrades to a no-op rather than throwing.
export async function listInstallations(appId: string, privateKey: string, log: Logger): Promise<number[]> {
  const jwt = await appJWT(appId, privateKey);
  const ids: number[] = [];
  let page = 1;
  for (;;) {
    const r = await fetch(`https://api.github.com/app/installations?per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'user-agent': 'pr-minder' },
    });
    if (!r.ok) { log.log(`listInstallations: ${r.status}`); break; }
    const data: any[] = await r.json();
    for (const inst of data) ids.push(inst.id);
    if (data.length < 100) break;
    page++;
  }
  return ids;
}

// The installation id covering a single repo, via GET /repos/{repo}/installation (an App-level
// endpoint, so JWT auth). Lets a context that only knows the repo — e.g. the scheduled re-check
// sweep reading reminders out of KV — mint an installation token for it. Null on error.
export async function repoInstallationId(repo: string, appId: string, privateKey: string, log: Logger): Promise<number | null> {
  const jwt = await appJWT(appId, privateKey);
  const r = await fetch(`https://api.github.com/repos/${repo}/installation`, {
    headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'user-agent': 'pr-minder' },
  });
  if (!r.ok) { log.log(`repoInstallationId ${repo}: ${r.status}`); return null; }
  const data: any = await r.json();
  return data.id ?? null;
}

// A single PR object (callers read .state, .draft, .head.sha, .user). Null on error or 404, so a
// caller can treat "gone" and "transient failure" alike (skip).
export async function getPull(repo: string, num: number, token: string, log: Logger): Promise<any | null> {
  const r = await gh(`/repos/${repo}/pulls/${num}`, token, log);
  if (!r.ok) return null;
  return r.json();
}

export async function listInstallationRepos(token: string, log: Logger): Promise<string[]> {
  const repos: string[] = [];
  let page = 1;
  for (;;) {
    const r = await gh(`/installation/repositories?per_page=100&page=${page}`, token, log);
    if (!r.ok) break;
    const data: any = await r.json();
    for (const repo of data.repositories) {
      repos.push(repo.full_name);
    }
    if (repos.length >= data.total_count) break;
    page++;
  }
  return repos;
}

// Per-PR auto-merge is exposed ONLY through the GraphQL API
// (enablePullRequestAutoMerge / disablePullRequestAutoMerge). There is NO REST endpoint:
// PUT/DELETE /repos/{repo}/pulls/{num}/automerge returns 404 ("Not Found"). Both mutations
// take the pull request's GraphQL node id (pull_request.node_id from the webhook), not its
// number. Requires the app to have contents:write + pull_requests:write, "Allow auto-merge"
// enabled in repo settings, and branch protection with at least one pending requirement.
const ENABLE_AUTO_MERGE = `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
    pullRequest { number }
  }
}`;

const DISABLE_AUTO_MERGE = `mutation($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
    pullRequest { number }
  }
}`;

async function graphql(
  query: string,
  variables: Record<string, unknown>,
  token: string,
): Promise<{ ok: boolean; status: number; errors: unknown; body: string }> {
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...ghHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.text();
  // GraphQL signals logical failures as HTTP 200 with a top-level `errors` array.
  let errors: unknown;
  try { errors = (JSON.parse(body) as { errors?: unknown }).errors; } catch { /* non-JSON body */ }
  return { ok: r.ok, status: r.status, errors, body };
}

export async function enableAutoMerge(repo: string, num: number, nodeId: string, method: string, token: string, log: Logger): Promise<void> {
  // mergeMethod is the PullRequestMergeMethod enum: MERGE | SQUASH | REBASE (uppercase).
  const mergeMethod = (method || 'squash').toUpperCase();
  const { ok, status, errors, body } = await graphql(ENABLE_AUTO_MERGE, { pullRequestId: nodeId, mergeMethod }, token);
  if (ok && !errors) { log.log(`enableAutoMerge ${repo}#${num}: ok`); return; }
  log.log(`enableAutoMerge ${repo}#${num}: ${status} ${body}`);
  // A non-2xx is a transport failure — throw so GitHub retries.
  if (!ok) throw new GhError(status, body);
  // HTTP 200 + errors[] means GitHub refused to *arm* native auto-merge. The label still means
  // "merge this PR", so fall back to a direct merge. The two reasons this happens are both ones
  // where merging directly is exactly right:
  //   - "Pull request is in clean status": nothing is pending, so there's nothing for native
  //     auto-merge to wait on — the PR is ready to merge now.
  //   - "...Auto merge is not allowed for this repository": the repo hasn't turned on
  //     Settings > Pull Requests > Allow auto-merge (which pr-minder can't toggle — it has no
  //     administration permission), so native auto-merge is simply unavailable there.
  // mergePullRequest is the final authority: branch protection still gates the merge and a PR that
  // isn't actually mergeable comes back as a swallowed 4xx, so this never merges something GitHub
  // wouldn't. (When native auto-merge *can* be armed, the success path above returns first, so we
  // never pre-empt GitHub's wait-for-checks behavior.)
  log.log(`enableAutoMerge ${repo}#${num}: native auto-merge unavailable, merging directly`);
  await mergePullRequest(repo, num, method, token, log);
}

// Direct merge via the REST endpoint (this one DOES exist, unlike per-PR auto-merge). Used as
// the fallback when a PR is already mergeable. merge_method is lowercase: merge | squash | rebase.
export async function mergePullRequest(repo: string, num: number, method: string, token: string, log: Logger): Promise<void> {
  const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${num}/merge`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ merge_method: method || 'squash' }),
  });
  if (r.ok) { log.log(`mergePullRequest ${repo}#${num}: merged (${method || 'squash'})`); return; }
  const body = await r.text();
  log.log(`mergePullRequest ${repo}#${num}: ${r.status} ${body}`);
  // 4xx = GitHub declined (405 not mergeable, 409 head moved, 422 validation, 403 forbidden):
  // branch protection still gates the merge, and none are retryable, so log and move on. 5xx is
  // transient — throw so GitHub redelivers the webhook.
  if (r.status >= 500) throw new GhError(r.status, body);
}

export async function disableAutoMerge(repo: string, num: number, nodeId: string, token: string, log: Logger): Promise<void> {
  const { ok, status, errors, body } = await graphql(DISABLE_AUTO_MERGE, { pullRequestId: nodeId }, token);
  if (ok && !errors) { log.log(`disableAutoMerge ${repo}#${num}: ok`); return; }
  log.log(`disableAutoMerge ${repo}#${num}: ${status} ${body}`);
  // HTTP 200 + errors[] = nothing to disable (auto-merge wasn't enabled) or similar — non-fatal.
  if (!ok) throw new GhError(status, body);
}

export async function removeLabelFromPr(repo: string, num: number, label: string, token: string, log: Logger): Promise<void> {
  const r = await fetch(`https://api.github.com/repos/${repo}/issues/${num}/labels/${encodeURIComponent(label)}`, {
    method: 'DELETE',
    headers: ghHeaders(token),
  });
  if (r.ok) { log.log(`removeLabel ${repo}#${num}: "${label}"`); return; }
  const body = await r.text();
  log.log(`removeLabel ${repo}#${num} "${label}": ${r.status} ${body}`);
  if (r.status === 404) return;
  throw new GhError(r.status, body);
}

async function appJWT(appId: string, pem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const key = await importPkcs8(pem);
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64urlBytes(new Uint8Array(sig))}`;
}

async function importPkcs8(pem: string): Promise<CryptoKey> {
  const b = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function b64url(s: string): string {
  return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlBytes(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
