// Workers KV state for the zombie check. Eight kinds of key:
//   pr:{repo}#{num}        -> the head SHA we last evaluated that PR at
//   backfill:{repo}        -> set once we've swept a repo's pre-existing PRs
//   recheck:{repo}#{num}   -> a self-set "re-check this PR later" reminder (see setRecheck)
//   conflict:{repo}#{num}  -> a self-set "re-check this PR's mergeability later" reminder, drained
//                             by the cron's runConflictChecks (see setConflictCheck) — GitHub
//                             computes mergeability asynchronously, so a base/head change is flagged
//                             here and the label settled once the answer is ready
//   describe:{repo}#{num}  -> a self-set "describe this PR later" reminder for the auto_describe_pr
//                             backfill, drained by the cron's runDescribeChecks (see
//                             setDescribeCheck) — catches a never-described PR (one opened before
//                             the feature/install, or whose opened-event hand-off failed) that no
//                             live synchronize will ever revisit
//   swept:{owner}          -> a short-lived per-owner cooldown for the auto-merge backstop, so it
//                             doesn't re-search on every webhook (see markSwept/recentlySwept)
//   desc:{repo}#{num}      -> SHA-256 of the PR diff the auto_describe_pr metadata was last
//                             generated from (see describedDiffHash/markDescribed)
//   descrun:{repo}#{num}   -> the webhook-runner run id of the last describe hand-off, so a
//                             newer diff can cancel a superseded in-flight run (see
//                             describeRunId/markDescribeRun)
// The per-PR marker is what makes the check "once per commit": a PR is evaluated only when its
// current head SHA differs from what's stored (new PR, or new commits = a "touched" PR), and the
// SHA is recorded afterwards. The backfill flag makes the first-webhook sweep of an already-
// installed repo a one-time pass. KV is eventually consistent, which is fine here: every consumer
// is idempotent (re-evaluating a PR, or re-sweeping a repo, only ever repeats harmless work).

const prKey = (repo: string, num: number) => `pr:${repo}#${num}`;
const backfillKey = (repo: string) => `backfill:${repo}`;
const RECHECK_PREFIX = 'recheck:';
const recheckKey = (repo: string, num: number) => `${RECHECK_PREFIX}${repo}#${num}`;
const RECHECK_TTL_S = 86400; // a reminder self-expires after a day if a sweep never clears it
const CONFLICT_PREFIX = 'conflict:';
const conflictKey = (repo: string, num: number) => `${CONFLICT_PREFIX}${repo}#${num}`;
const CONFLICT_TTL_S = 86400; // same safety net as recheck: a stale reminder can't linger past a day
const DESCRIBE_PREFIX = 'describe:';
const describeCheckKey = (repo: string, num: number) => `${DESCRIBE_PREFIX}${repo}#${num}`;
const DESCRIBE_TTL_S = 86400; // same safety net: a backfill reminder for a gone PR self-expires in a day
const sweptKey = (owner: string) => `swept:${owner}`;

export async function checkedSha(kv: KVNamespace, repo: string, num: number): Promise<string | null> {
  return kv.get(prKey(repo, num));
}

export async function markChecked(kv: KVNamespace, repo: string, num: number, sha: string): Promise<void> {
  await kv.put(prKey(repo, num), sha);
}

export async function wasBackfilled(kv: KVNamespace, repo: string): Promise<boolean> {
  return (await kv.get(backfillKey(repo))) !== null;
}

export async function markBackfilled(kv: KVNamespace, repo: string): Promise<void> {
  await kv.put(backfillKey(repo), new Date().toISOString());
}

// A "re-check this PR later" reminder. reviveIfZombie writes one when it sees a follow-up commit
// with no runs that's still too fresh to judge; the scheduled sweep (runRechecks) reads them back
// and re-evaluates each PR once it has aged. Keyed per PR so a newer commit just overwrites it. The
// TTL is a safety net so a reminder for a deleted/abandoned PR can't linger forever.
export async function setRecheck(kv: KVNamespace, repo: string, num: number): Promise<void> {
  await kv.put(recheckKey(repo, num), new Date().toISOString(), { expirationTtl: RECHECK_TTL_S });
}

export async function clearRecheck(kv: KVNamespace, repo: string, num: number): Promise<void> {
  await kv.delete(recheckKey(repo, num));
}

// Every pending re-check reminder as { repo, num }, following list pagination. The key encodes
// everything needed (recheck:{owner}/{name}#{num}), so reading the values is unnecessary — the
// sweep mints its own token per repo. Returns [] if there are none, so an empty sweep costs a
// single KV list and zero GitHub API calls.
export async function listRechecks(kv: KVNamespace): Promise<Array<{ repo: string; num: number }>> {
  return listReminders(kv, RECHECK_PREFIX);
}

// Shared list-and-parse for the per-PR reminder kinds (recheck:, conflict:). Each key is
// "{prefix}{owner}/{name}#{num}"; the key alone carries everything the sweep needs (it mints its own
// token per repo), so values are never read. Returns [] when none, so an empty sweep is a single KV
// list and zero GitHub calls.
async function listReminders(kv: KVNamespace, prefix: string): Promise<Array<{ repo: string; num: number }>> {
  const out: Array<{ repo: string; num: number }> = [];
  let cursor: string | undefined;
  for (;;) {
    const res = await kv.list({ prefix, cursor });
    for (const k of res.keys) {
      const body = k.name.slice(prefix.length); // "{owner}/{name}#{num}"
      const hash = body.lastIndexOf('#');
      if (hash < 0) continue;
      const repo = body.slice(0, hash);
      const num = Number(body.slice(hash + 1));
      if (repo && Number.isInteger(num)) out.push({ repo, num });
    }
    if (res.list_complete) break;
    cursor = res.cursor;
  }
  return out;
}

// A "re-check this PR's mergeability later" reminder, the merge_conflict-label analogue of setRecheck.
// GitHub computes a PR's mergeability asynchronously, and no webhook carries the result — so when a
// base or head move may have changed it, pr-minder flags the PR here and the cron (runConflictChecks)
// settles the label once the answer is ready. Keyed per PR so a later flag just overwrites it; the
// TTL bounds a reminder for a PR that's since gone away.
export async function setConflictCheck(kv: KVNamespace, repo: string, num: number): Promise<void> {
  await kv.put(conflictKey(repo, num), new Date().toISOString(), { expirationTtl: CONFLICT_TTL_S });
}

export async function clearConflictCheck(kv: KVNamespace, repo: string, num: number): Promise<void> {
  await kv.delete(conflictKey(repo, num));
}

export async function listConflictChecks(kv: KVNamespace): Promise<Array<{ repo: string; num: number }>> {
  return listReminders(kv, CONFLICT_PREFIX);
}

// A "describe this PR later" reminder for the auto_describe_pr backfill — the catch-up analogue of
// setConflictCheck. auto_describe_pr is otherwise purely live (opened/ready_for_review/synchronize),
// so a PR opened before the feature existed (or before the App was installed), or whose opened-event
// hand-off failed, never gets a description: no later event revisits it. The backfill enqueues such
// PRs here (on a default-branch push, the first-webhook backfill, and install sweeps) and the cron
// (runDescribeChecks) hands each off once. Keyed per PR; the TTL bounds a reminder for a PR that's
// since gone away or been described another way.
export async function setDescribeCheck(kv: KVNamespace, repo: string, num: number): Promise<void> {
  await kv.put(describeCheckKey(repo, num), new Date().toISOString(), { expirationTtl: DESCRIBE_TTL_S });
}

export async function clearDescribeCheck(kv: KVNamespace, repo: string, num: number): Promise<void> {
  await kv.delete(describeCheckKey(repo, num));
}

export async function listDescribeChecks(kv: KVNamespace): Promise<Array<{ repo: string; num: number }>> {
  return listReminders(kv, DESCRIBE_PREFIX);
}

// The diff fingerprint auto_describe_pr last generated metadata from, keyed per PR. A
// synchronize whose effective diff is unchanged (e.g. pr-minder's own update-branch merge) is
// skipped without a model call; recorded only after the PR edit lands, so a failed attempt
// retries on the next event. Eventual consistency just means a rare duplicate model call.
const descKey = (repo: string, num: number) => `desc:${repo}#${num}`;

export async function describedDiffHash(kv: KVNamespace, repo: string, num: number): Promise<string | null> {
  return kv.get(descKey(repo, num));
}

export async function markDescribed(kv: KVNamespace, repo: string, num: number, hash: string): Promise<void> {
  await kv.put(descKey(repo, num), hash);
}

// The webhook-runner run id of the last describe hand-off, keyed per PR. When a newer diff
// arrives, the previous run may still be mid-model-call with now-stale input; reading this id
// lets the new hand-off cancel it first (POST {hook}/cancel/{run}), so the runs can't finish
// out of order. Best-effort: runs end on their own, so the TTL just stops dead ids from
// accumulating — cancelling an already-finished run is a harmless 409.
const descRunKey = (repo: string, num: number) => `descrun:${repo}#${num}`;
const DESC_RUN_TTL_S = 86400;

export async function describeRunId(kv: KVNamespace, repo: string, num: number): Promise<string | null> {
  return kv.get(descRunKey(repo, num));
}

export async function markDescribeRun(kv: KVNamespace, repo: string, num: number, runId: string): Promise<void> {
  await kv.put(descRunKey(repo, num), runId, { expirationTtl: DESC_RUN_TTL_S });
}

// Drop a PR's described-diff marker after the pr-describe webhook reports its run terminally
// failed, so the next event re-describes. The marker is recorded optimistically on hand-off (the
// runner accepting the run), so without this a run that fails *after* acceptance would leave the
// PR marked described forever. Conditional on the hash: a late failure callback from a superseded
// run can't wipe a newer, successful describe — only clear when desc: still holds exactly that
// diff's hash. (descrun: is left to its TTL; the next hand-off cancels a stale id harmlessly.)
export async function clearDescribedIfHash(kv: KVNamespace, repo: string, num: number, hash: string): Promise<void> {
  if (!hash) return;
  if ((await kv.get(descKey(repo, num))) === hash) await kv.delete(descKey(repo, num));
}

// Per-owner cooldown for the auto-merge backstop (reconcileInstall). The backstop is cheap (a label
// search plus a handful of GitHub calls), but GitHub's search API is rate-limited (~30/min), so we
// don't want to run it on every webhook for a busy owner. markSwept records "owner just backstopped"
// with a TTL; recentlySwept gates the next webhook-driven run. The cron sweep ignores this (it's the
// reliable periodic pass). KV is eventually consistent, so two isolates may occasionally both run —
// harmless, since reconcileInstall is idempotent. A missing marker just means "go ahead and run".
export async function markSwept(kv: KVNamespace, owner: string, cooldownS: number): Promise<void> {
  await kv.put(sweptKey(owner), new Date().toISOString(), { expirationTtl: cooldownS });
}

export async function recentlySwept(kv: KVNamespace, owner: string): Promise<boolean> {
  return (await kv.get(sweptKey(owner))) !== null;
}
