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
import { getPullDiff, appBotLogin, updatePullTitle } from './github';
import { describedDiffHash, markDescribed, describeRunId, markDescribeRun } from './state';

// Title prefix stamped on a PR that has no net diff to describe. Exported so the test asserts the
// exact marker rather than a copied literal.
export const ZERO_DIFF_PREFIX = '[zero diff]';

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
    // Reaching this function at all means auto_describe_pr is *enabled* in config (the caller
    // gates on it). An enabled feature with no endpoint is a misconfiguration, not an opt-out:
    // throw so describeSafely logs it at error level — a silent info-level skip here once cost
    // a full debugging round of "did the webhook even arrive?".
    throw new Error(
      'auto_describe_pr is enabled in config, but the DESCRIBE_HOOK_URL var is not set on the pr-minder Worker (it belongs in wrangler.toml [vars] — dashboard-added vars are wiped on the next deploy)',
    );
  }
  if (!env.PR_MINDER_PUBLIC_URL) {
    // Same rule, same reason: the callback URL is where the webhook reports a failed run so the
    // next event retries. Without it a run that fails after acceptance would be suppressed forever
    // (the very bug this path exists to prevent) — so an enabled-but-unconfigured callback is a
    // loud misconfiguration, never a silent skip. PR_MINDER_PUBLIC_URL is a committed [vars] var.
    throw new Error(
      'auto_describe_pr is enabled in config, but the PR_MINDER_PUBLIC_URL var is not set on the pr-minder Worker (wrangler.toml [vars]) — it is the callback URL the pr-describe webhook reports a failed run to, so the next event retries instead of the run being suppressed forever',
    );
  }

  // The full base...head diff, never truncated: the pr-describe webhook summarizes an
  // oversized diff in parts (map-reduce) rather than the Worker capping it, so there is
  // no diff-size ceiling on what gets described. getPullDiff itself falls back to the
  // paginated files API when GitHub refuses to render the unified diff (406, very large).
  const diff = await getPullDiff(repo, pr.number, token, log);
  if (!diff || !diff.trim()) {
    // A 0-diff PR has nothing for the model to summarize. Rather than skip silently — which leaves
    // an auto-opened orphan sitting with its branch name as the title — give it a recognizable
    // "[zero diff]" title. markZeroDiff is a no-op for anything that isn't our own bot's PR.
    await markZeroDiff(env, repo, pr, token, log);
    return;
  }

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

  // Always tell the webhook where to report a terminally failed run (fail_callback_url) so the
  // marker recorded below — optimistically, on hand-off — gets cleared and the next event
  // re-describes; otherwise a run that fails after acceptance would leave the PR marked described
  // forever (the bug this path fixes). diff_hash lets the callback clear conditionally, so a stale
  // callback can't wipe a newer describe. PR_MINDER_PUBLIC_URL is required above, so it's set here.
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
      fail_callback_url: `${env.PR_MINDER_PUBLIC_URL.replace(/\/+$/, '')}/_describe-result`,
      fail_callback_key: env.DESCRIBE_HOOK_API_KEY ?? '',
      diff_hash: hash,
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

// A PR with no net diff can't be described — there's nothing to summarize. Instead of skipping
// silently (which leaves an auto-opened orphan stuck with its branch name as the title), stamp its
// title "[zero diff] <branch>" so it's instantly recognizable in the PR list. Scoped to pr-minder's
// OWN bot PRs — unlike closeEmptyAutoPrs (which CLOSES any author's empty PR), a title rewrite mutates
// content we may not own, so we only relabel PRs pr-minder itself opened; a human's title is left
// untouched. Idempotent (a title already starting with the marker isn't re-PATCHed, so repeated
// synchronizes are no-ops). This is the on-event label; auto_open_pr.close_when_empty (on by default)
// still closes these on the next base update, and a later non-empty diff re-describes via the webhook.
async function markZeroDiff(env: Env, repo: string, pr: any, token: string, log: Logger): Promise<void> {
  const tag = `${repo}#${pr.number}`;
  const botLogin = await appBotLogin(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, log);
  if (!botLogin || pr.user?.login !== botLogin) {
    log.log(`${tag}: skip describe (no diff)`); // not our bot's PR — leave its title untouched
    return;
  }
  if (typeof pr.title === 'string' && pr.title.startsWith(ZERO_DIFF_PREFIX)) {
    log.log(`${tag}: skip describe (no diff; already marked "${ZERO_DIFF_PREFIX}")`);
    return;
  }
  const branch = pr.head?.ref ?? pr.title ?? '';
  log.log(`${tag}: no diff — marking title "${ZERO_DIFF_PREFIX}"`);
  await updatePullTitle(
    repo,
    pr.number,
    `${ZERO_DIFF_PREFIX} ${branch}`.trim(),
    'pr-minder: this PR has no net diff against its base, so there is nothing to describe or review. ' +
      'It was auto-opened; `auto_open_pr.close_when_empty` (on by default) closes it on the next base update.',
    token,
    log,
  );
}

// maybeDescribePr that never rejects: any error — missing var while enabled, key mismatch,
// runner down — is logged at error level, which Workers Logs persists ([observability] is
// enabled). Errors stay in the operator's panes by design: Worker-side failures here, and
// everything that reaches the runner (denied keys, failed runs) on its dashboard — never as
// comments broadcast on the PR. Describing must never fail the webhook.
export async function describeSafely(env: Env, repo: string, pr: any, config: PrMinderConfig, token: string, log: Logger): Promise<void> {
  try {
    await maybeDescribePr(env, repo, pr, config, token, log);
  } catch (e) {
    log.error(`${repo}#${pr.number}: describe failed: ${(e as Error).message}`);
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
