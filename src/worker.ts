// MIT
// GitHub App must subscribe to: pull_request, pull_request_review, push
// Also handles: installation, installation_repositories (auto-delivered to all apps)
import { handle } from './handlers';
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
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
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
};

// Public docs: a human-readable HTML page at `/` (it fetches and renders /llms.txt) and the
// llms.txt source at `/llms.txt`. Both are gzipped into the bundle at build time and served
// pre-compressed: `encodeBody: "manual"` tells the runtime the body is already gzip-encoded,
// so it ships the bytes as-is instead of compressing them again on every request.
function serveDocs(req: Request): Response {
  const { pathname } = new URL(req.url);
  if (pathname === '/') return gzip(indexHtmlGz, 'text/html; charset=utf-8');
  if (pathname === '/llms.txt') return gzip(llmsTxtGz, 'text/plain; charset=utf-8');
  return new Response('not found', { status: 404 });
}

function gzip(body: ArrayBuffer, contentType: string): Response {
  return new Response(body, {
    encodeBody: 'manual',
    headers: {
      'content-type': contentType,
      'content-encoding': 'gzip',
      'cache-control': 'public, max-age=3600',
    },
  });
}
