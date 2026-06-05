// Workers KV state for the zombie check. Two kinds of key:
//   pr:{repo}#{num}  -> the head SHA we last evaluated that PR at
//   backfill:{repo}  -> set once we've swept a repo's pre-existing PRs
// The per-PR marker is what makes the check "once per commit": a PR is evaluated only when its
// current head SHA differs from what's stored (new PR, or new commits = a "touched" PR), and the
// SHA is recorded afterwards. The backfill flag makes the first-webhook sweep of an already-
// installed repo a one-time pass. KV is eventually consistent, which is fine here: every consumer
// is idempotent (re-evaluating a PR, or re-sweeping a repo, only ever repeats harmless work).

const prKey = (repo: string, num: number) => `pr:${repo}#${num}`;
const backfillKey = (repo: string) => `backfill:${repo}`;

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
