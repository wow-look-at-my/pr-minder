// MIT
// GitHub App must subscribe to: pull_request, pull_request_review, push
// Also handles: installation, installation_repositories (auto-delivered to all apps)
import { handle, startupReconcile, runRechecks, runConflictChecks, reconcileAllInstalls } from './handlers';
import { GhError } from './github';
import { Logger } from './logger';
import { verifyWebhook } from './webhook';
import { handleDescribeResult } from './describe-result';
// Docs are gzipped at build time and served pre-compressed (see serveDocs).
import indexHtmlGz from './docs/index.html.gz';
import llmsTxtGz from './docs/llms.txt.gz';

export interface Env {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string; // PEM, PKCS8
  WEBHOOK_SECRET: string;
  PR_STATE: KVNamespace; // zombie-check state: per-PR "checked at SHA" + per-repo backfill flag + per-version startup flag
  // Cloudflare Version Metadata binding: { id, tag, timestamp }. `id` changes per deploy, so it
  // keys the once-per-deploy gate on the startup auto-merge reconcile. Optional so dev/tests without
  // the binding still typecheck (the gate then degrades to the per-isolate guard).
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
  // auto_describe_pr: the pr-describe webhook on the internal webhook-runner host, which does
  // the slow LLM call and PATCHes the PR (the model call outlives the Worker's ~30s
  // post-response grace, so it can't run here). DESCRIBE_HOOK_URL is the full hook URL
  // (e.g. https://hooks.example.com/hook/pr-describe; wrangler.toml [vars]) and
  // DESCRIBE_HOOK_API_KEY (a secret) its api_key. Without the URL the feature no-ops.
  DESCRIBE_HOOK_URL?: string;
  DESCRIBE_HOOK_API_KEY?: string;
  // The Worker's own public URL (e.g. https://pr-minder.pazer.workers.dev; wrangler.toml [vars]).
  // pr-minder passes "{this}/_describe-result" to the pr-describe webhook so a terminally failed
  // describe run is reported back and its "already described" marker cleared (the next event then
  // retries). Absent it, no callback is requested and a failed run stays recorded (original behavior).
  PR_MINDER_PUBLIC_URL?: string;
}

// Reconcile-on-startup, not poll. Each fresh isolate (e.g. after a deploy) runs the cross-repo
// auto-merge reconcile exactly once, on its first request, in the background via waitUntil — so a
// redeploy heals any PR whose auto-merge state drifted while an older version was running. Steady
// state is driven entirely by webhooks; this flag makes the sweep fire once per isolate, never per
// request.
let startupSwept = false;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!startupSwept) {
      startupSwept = true;
      ctx.waitUntil(startupReconcile(env, new Logger()).catch(() => {}));
    }
    // GitHub delivers webhooks via POST; GET serves the public documentation.
    if (req.method === 'GET' || req.method === 'HEAD') return serveDocs(req);
    if (req.method !== 'POST') return new Response('nope', { status: 405 });

    const body = await req.text();
    const log = new Logger();

    // The pr-describe webhook reports a terminally failed describe run here so the diff's
    // "already described" marker is cleared and the next event re-describes. Its own path (the
    // GitHub delivery POSTs to "/") and its own auth (shared api key, not the GitHub HMAC) — both
    // handled in handleDescribeResult, kept out of worker.ts so it stays testable.
    if (new URL(req.url).pathname === '/_describe-result') {
      return handleDescribeResult(env, req.headers.get('x-api-key') ?? '', body, log);
    }

    const sig = req.headers.get('x-hub-signature-256') ?? '';
    if (!(await verifyWebhook(env.WEBHOOK_SECRET, sig, body))) {
      return new Response('bad sig', { status: 401 });
    }

    const event = req.headers.get('x-github-event');
    const payload = JSON.parse(body);

    let status = 200;
    try {
      // The defer callback lets slow side work (the auto_describe_pr model call) run via
      // waitUntil, after this response: GitHub marks a delivery failed at 10s, so the webhook
      // acks fast and the deferred work gets the post-response grace window instead.
      await handle(event, payload, env, log, (work) => ctx.waitUntil(work));
    } catch (e) {
      log.log(`error: ${(e as Error).stack ?? (e as Error).message}`);
      status = e instanceof GhError ? e.status : 500;
    }
    return new Response(log.toString() || 'ok', { status, headers: { 'content-type': 'text/plain' } });
  },

  // Cron entry point ([triggers] crons in wrangler.toml). Three cheap passes:
  //  1) runRechecks — drains the `recheck:` reminders reviveIfZombie leaves for follow-up commits
  //     too fresh to judge when their webhook arrived. With no reminders it's a single KV list.
  //  2) runConflictChecks — drains the `conflict:` reminders that base/head moves left behind,
  //     settling each PR's merge_conflict label once GitHub has computed mergeability. Also a single
  //     KV list when nothing is pending; budget-bounded otherwise.
  //  3) reconcileAllInstalls — the auto-merge backstop: per installation, search for auto_merge-
  //     labeled PRs and arm/merge any the live webhook path dropped. Cost scales with labeled PRs
  //     (a search + a couple calls each), not repo count, and is budget-bounded so it stays well
  //     under the subrequest cap; owners not reached this tick are picked up on the next.
  // The budgets are sized so the three passes together stay under the ~50-subrequest cap of a single
  // invocation (runRechecks is self-limiting — only deferred fresh commits — so it has no fixed one).
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const log = new Logger();
    await runRechecks(env, log);
    await runConflictChecks(env, log, { calls: 15 });
    await reconcileAllInstalls(env, log, { calls: 30 });
  },
};

// Public docs: a human-readable HTML page at `/` (it fetches and renders /llms.txt) and the
// llms.txt source at `/llms.txt`. Both are gzipped into the bundle at build time.
function serveDocs(req: Request): Response {
  const { pathname } = new URL(req.url);
  if (pathname === '/') return docs(req, indexHtmlGz, 'text/html; charset=utf-8');
  if (pathname === '/llms.txt') return docs(req, llmsTxtGz, 'text/plain; charset=utf-8');
  return new Response('not found', { status: 404 });
}

// The docs are stored gzipped. For a client that accepts gzip (virtually all of them) we ship
// the bytes as-is -- `encodeBody: "manual"` tells the runtime the body is already gzip-encoded,
// so it isn't recompressed on every request. For a client that doesn't advertise gzip we
// decompress server-side and serve identity, so we never send an encoding it didn't ask for.
function docs(req: Request, gz: ArrayBuffer, contentType: string): Response {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'cache-control': 'public, max-age=3600',
    'vary': 'Accept-Encoding',
  };
  if ((req.headers.get('accept-encoding') ?? '').includes('gzip')) {
    return new Response(gz, { encodeBody: 'manual', headers: { ...headers, 'content-encoding': 'gzip' } });
  }
  const identity = new Response(gz).body!.pipeThrough(new DecompressionStream('gzip'));
  return new Response(identity, { headers });
}
