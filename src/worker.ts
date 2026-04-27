// MIT
// GitHub App must subscribe to: pull_request, pull_request_review, push
// Also handles: installation, installation_repositories (auto-delivered to all apps)
import { handle } from './handlers';
import { GhError } from './github';
import { Logger } from './logger';

export interface Env {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string; // PEM, PKCS8
  WEBHOOK_SECRET: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
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

export async function verifyWebhook(secret: string, sigHeader: string, body: string): Promise<boolean> {
  const expected = sigHeader.replace(/^sha256=/, '');
  if (expected.length !== 64) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const sigBytes = new Uint8Array(expected.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body));
}
