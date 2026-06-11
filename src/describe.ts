// auto_describe_pr: generate a PR's title and description from its full diff with an
// OpenAI-compatible chat model. The model call routinely outlives the Worker's ~30s
// post-response grace, so the slow half lives in the pr-describe webhook on the internal
// webhook-runner host (the wow-look-at-my/webhooks repo): this module fetches the diff,
// dedups, and hands the work off fire-and-forget; the webhook calls the model (with its
// own retries — it has unbounded time) and PATCHes the PR itself. A newer diff supersedes
// any in-flight run for the same PR by cancelling it first, so a stale description can
// never land after a fresh one.
import type { Env } from './worker';
import type { Logger } from './logger';
import type { PrMinderConfig } from './config';
import { getPullDiff } from './github';
import { describedDiffHash, markDescribed, describeRunId, markDescribeRun } from './state';

// A diff larger than this is truncated before being handed off — enough for any PR a
// description meaningfully summarizes, and a guard against blowing the model's context
// window (the webhook forwards the diff to the model as-is).
const MAX_DIFF_CHARS = 200_000;
// The hand-off is a 202 from webhook-runner (it only spawns a container), so a short
// timeout keeps a wedged runner from pinning the invocation.
const HOOK_TIMEOUT_MS = 10_000;

// Which pull_request actions warrant (re)describing. opened = a new PR; synchronize = new
// commits (including pr-minder's own update-branch merge — the diff-hash dedup below makes
// that a no-op unless the effective diff actually changed); ready_for_review = a PR that was
// opened as a draft becoming real (drafts are skipped wholesale in onPR, so this is the first
// time we can see it). Our own zombie close+reopen comes back as `reopened`, which is
// deliberately not listed — the PR was already described from its original event.
export function shouldDescribe(action: string): boolean {
  return ['opened', 'ready_for_review', 'synchronize'].includes(action);
}

// Describe one PR: fetch its full diff, dedup on the diff's hash, cancel any in-flight
// describe run this one supersedes, and POST the work to the pr-describe webhook. Deduped
// on the SHA-256 of the diff via KV — a synchronize whose effective diff is unchanged (the
// common case for pr-minder's own update-branch merges) costs one GitHub call and no
// hand-off. The hash is recorded once the runner has *accepted* the run (202) — from there
// the webhook's internal retries own delivery — so a failed hand-off leaves the marker
// untouched and the next event retries. Throws on failure; the caller logs and swallows
// (a describe failure must never fail the webhook).
export async function maybeDescribePr(env: Env, repo: string, pr: any, config: PrMinderConfig, token: string, log: Logger): Promise<void> {
  const tag = `${repo}#${pr.number}`;
  if (!env.DESCRIBE_HOOK_URL) {
    log.log(`${tag}: skip describe (DESCRIBE_HOOK_URL not configured)`);
    return;
  }

  const fullDiff = await getPullDiff(repo, pr.number, token, log);
  if (!fullDiff || !fullDiff.trim()) {
    log.log(`${tag}: skip describe (no diff)`);
    return;
  }
  const diff = fullDiff.length > MAX_DIFF_CHARS
    ? `${fullDiff.slice(0, MAX_DIFF_CHARS)}\n... (diff truncated at ${MAX_DIFF_CHARS} characters)`
    : fullDiff;

  const hash = await sha256Hex(diff);
  if (env.PR_STATE && (await describedDiffHash(env.PR_STATE, repo, pr.number)) === hash) {
    log.log(`${tag}: skip describe (diff unchanged)`);
    return;
  }

  const hookUrl = env.DESCRIBE_HOOK_URL.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.DESCRIBE_HOOK_API_KEY) headers['x-api-key'] = env.DESCRIBE_HOOK_API_KEY;

  // Cancel the previous run for this PR if one may still be in flight: its diff is now
  // stale, and without the cancel its PATCH could land *after* the new run's. Best-effort —
  // a 409 (already finished) or 404 (evicted) is the common case and means nothing to do.
  if (env.PR_STATE) {
    const prev = await describeRunId(env.PR_STATE, repo, pr.number);
    if (prev) {
      try {
        const c = await fetch(`${hookUrl}/cancel/${prev}`, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
        });
        if (c.status === 202) log.log(`${tag}: cancelled superseded describe run ${prev}`);
      } catch (e) {
        log.log(`${tag}: cancel of describe run ${prev} failed: ${(e as Error).message}`);
      }
    }
  }

  const r = await fetch(hookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      repo,
      pr_number: pr.number,
      old_title: pr.title ?? '',
      old_body: pr.body ?? '',
      diff,
      model: config.autoDescribePr.model || '',
      github_token: token,
    }),
    signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`describe hook returned ${r.status}: ${body.slice(0, 300)}`);
  }
  const accepted: any = await r.json().catch(() => ({}));
  const runId = accepted?.run_id;
  log.log(`${tag}: describe handed off${typeof runId === 'string' && runId ? ` (run ${runId})` : ''}`);

  if (env.PR_STATE) {
    if (typeof runId === 'string' && runId) await markDescribeRun(env.PR_STATE, repo, pr.number, runId);
    await markDescribed(env.PR_STATE, repo, pr.number, hash);
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
