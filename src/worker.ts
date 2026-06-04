// MIT
// GitHub App must subscribe to: pull_request, pull_request_review, push
// Also handles: installation, installation_repositories (auto-delivered to all apps)
import { handle } from './handlers';
import { GhError } from './github';
import { Logger } from './logger';
import { verifyWebhook } from './webhook';
import indexHtml from './docs/index.html';
import llmsTxt from './docs/llms.txt';

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

// Public docs: HTML at `/`, llms.txt markdown at `/llms.txt`. Both are baked into the
// bundle at build time, so serving them is a static, allocation-free string response.
function serveDocs(req: Request): Response {
  const { pathname } = new URL(req.url);
  const cache = 'public, max-age=3600';
  if (pathname === '/') {
    return new Response(indexHtml, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': cache } });
  }
  if (pathname === '/llms.txt') {
    return new Response(llmsTxt, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': cache } });
  }
  return new Response('not found', { status: 404 });
}
