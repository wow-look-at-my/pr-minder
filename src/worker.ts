// MIT
// GitHub App must subscribe to: pull_request, pull_request_review, push
// Also handles: installation, installation_repositories (auto-delivered to all apps)
import { handle, runRechecks, runConflictChecks, runDescribeChecks } from './handlers';
import { GhError, configureApi } from './github';
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
  // Base URL for installation-token GitHub API calls (wrangler.toml [vars]). Defaults to
  // https://api.github.com; set to the github-state-mirror proxy
  // (https://github-state-mirror.pazer.io) to serve cached reads and transparently forward
  // everything else. App-level JWT calls and the auto-merge GraphQL mutations always go to GitHub
  // directly (see github.ts). When set, configureApi also wires the App credentials used to mint the
  // X-Mirror-Identity assertion so the mirror partitions our rotating install tokens into one bucket.
  GITHUB_API_BASE?: string;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Point the GitHub client at the mirror (if configured) and supply the App creds used to mint
    // the X-Mirror-Identity assertion. Must run before any API call (the webhook handlers and the
    // scheduled drains both go through it). The once-per-deploy startupReconcile kick that used to
    // run here moved to the pr-minder-reconcile hook along with the rest of fleet reconciliation.
    configureApi(env.GITHUB_API_BASE, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
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

  // Cron entry point ([triggers] crons in wrangler.toml). Three cheap, bounded KV-reminder drains —
  // each reads only its own reminders (a single KV list when none are pending, zero GitHub calls),
  // so the cron no longer fans out across the fleet or fights the 50-subrequest cap:
  //  1) runRechecks — drains the `recheck:` reminders reviveIfZombie leaves for follow-up commits too
  //     fresh to judge, plus the ones the backfill/install paths bulk-enqueue (a whole repo's zombie
  //     candidates at once), so it is budget-bounded like the others. Stays here: zombie revival is
  //     the Worker's, not the reconcile hook's, and it is coupled to the Worker's own KV markers.
  //  2) runConflictChecks — drains the `conflict:` reminders left by a PR's own events / a default
  //     push, settling each merge_conflict label once GitHub computed mergeability. Budget-bounded.
  //  3) runDescribeChecks — drains the `describe:` reminders the auto_describe_pr backfill left.
  //     Budget-bounded.
  // The FLEET-WIDE reconciliation that used to run here (reconcileAllInstalls — the cross-installation
  // auto-merge backstop — plus the once-per-deploy startupReconcile and the per-webhook backstop in
  // handle()) has MOVED to the pr-minder-reconcile webhook-runner hook (wow-look-at-my/webhooks): a
  // container with no subrequest cap, a multi-minute timeout, and durable retries. That hook also runs
  // the comprehensive auto_open_pr catch-up, close-empty, merge_conflict, and describe-backfill sweeps
  // fleet-wide; these bounded drains are the cheap, latency-bound complement the Worker keeps.
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    configureApi(env.GITHUB_API_BASE, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
    const log = new Logger();
    // Budgets count GitHub calls conservatively; worst case 15+12+10 external calls stays well
    // under the invocation's 50-subrequest cap. Unreached reminders persist to the next tick.
    await runRechecks(env, log, { calls: 15 });
    await runConflictChecks(env, log, { calls: 12 });
    await runDescribeChecks(env, log, { calls: 10 });
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
