// Handler for the pr-describe webhook's terminal-failure callback (POST /_describe-result).
//
// auto_describe_pr records a PR's diff as "described" optimistically, the moment the runner
// accepts the hand-off (202) — that dedup is what stops pr-minder's own update-branch-merge
// synchronize from re-describing an unchanged diff. But a run can fail *after* acceptance (model
// error, PATCH failure), and then the optimistic marker would suppress every future re-describe
// for that diff — forever. So the webhook reports a terminal failure here and pr-minder clears
// the marker, letting the next event retry.
//
// Lives in its own module (not worker.ts) so the test suite can import it without pulling
// worker.ts's gzipped-docs binary imports through vite — the same reason verifyWebhook is split out.
import { Logger } from './logger';
import { clearDescribedIfHash } from './state';

// Only the fields this handler needs, so it doesn't depend on worker.ts's full Env (a runtime
// import of which would drag in the *.gz blobs).
type DescribeResultEnv = { DESCRIBE_HOOK_API_KEY?: string; PR_STATE?: KVNamespace };

// Authenticate (shared pr-describe api key via x-api-key, not the GitHub HMAC) and, on a
// well-formed body, clear the PR's described-diff marker so the next event re-describes. The clear
// is conditional on the hash (clearDescribedIfHash), so a late callback from a superseded run
// can't wipe a newer, successful describe — a no-op in that case, which is still a 200 (the report
// was understood; there was simply nothing to undo).
export async function handleDescribeResult(env: DescribeResultEnv, apiKey: string, body: string, log: Logger): Promise<Response> {
  if (!env.DESCRIBE_HOOK_API_KEY || !timingSafeEqual(apiKey, env.DESCRIBE_HOOK_API_KEY)) {
    return new Response('unauthorized', { status: 401 });
  }
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const repo = data?.repo;
  const num = data?.pr_number;
  const hash = typeof data?.diff_hash === 'string' ? data.diff_hash : '';
  if (typeof repo !== 'string' || !Number.isInteger(num) || num <= 0) {
    return new Response('bad body', { status: 400 });
  }
  if (env.PR_STATE) await clearDescribedIfHash(env.PR_STATE, repo, num, hash);
  log.log(`${repo}#${num}: describe run reported failed; cleared the described-diff marker so the next event retries`);
  return new Response(log.toString() || 'ok', { headers: { 'content-type': 'text/plain' } });
}

// Constant-time string comparison for the shared api key, so a failed compare doesn't leak how
// many leading characters matched (a length mismatch is allowed to short-circuit).
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
