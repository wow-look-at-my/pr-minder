// MIT
// GitHub App must subscribe to: pull_request, pull_request_review, push
// Also handles: installation, installation_repositories (auto-delivered to all apps)
import { handle, startupReconcile, runRechecks } from './handlers';
import { GhError } from './github';
import { Logger } from './logger';
import { verifyWebhook } from './webhook';
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
    const sig = req.headers.get('x-hub-signature-256') ?? '';
    if (!(await verifyWebhook(env.WEBHOOK_SECRET, sig, body))) {
      return new Response('bad sig', { status: 401 });
    }

    const event = req.headers.get('x-github-event');
    const payload = JSON.parse(body);

    const log = new Logger();
    let status = 200;
    try {
      await handle(event, payload, env, log);
    } catch (e) {
      log.log(`error: ${(e as Error).stack ?? (e as Error).message}`);
      status = e instanceof GhError ? e.status : 500;
    }
    return new Response(log.toString() || 'ok', { status, headers: { 'content-type': 'text/plain' } });
  },

  // Cron entry point. Drains the `recheck:` reminders reviveIfZombie leaves for follow-up commits
  // that were too fresh to judge when their webhook arrived (e.g. a zombie commit pushed to an
  // already-handled PR). This is NOT a poll over all PRs: with no reminders it's a single KV list
  // and no GitHub calls. Schedule in wrangler.toml ([triggers] crons).
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const log = new Logger();
    await runRechecks(env, log);
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
