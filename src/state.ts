// Workers KV state for the zombie check. Three kinds of key:
//   pr:{repo}#{num}        -> the head SHA we last evaluated that PR at
//   backfill:{repo}        -> set once we've swept a repo's pre-existing PRs
//   recheck:{repo}#{num}   -> a self-set "re-check this PR later" reminder (see setRecheck)
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
  const out: Array<{ repo: string; num: number }> = [];
  let cursor: string | undefined;
  for (;;) {
    const res = await kv.list({ prefix: RECHECK_PREFIX, cursor });
    for (const k of res.keys) {
      const body = k.name.slice(RECHECK_PREFIX.length); // "{owner}/{name}#{num}"
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
