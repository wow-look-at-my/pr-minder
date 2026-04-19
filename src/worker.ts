// MIT
interface Env {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string; // PEM, PKCS8
  WEBHOOK_SECRET: string;
  AUTOMERGE_LABEL: string; // e.g. "automerge"
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== 'POST') return new Response('nope', { status: 405 });

    const body = await req.text();
    const sig = req.headers.get('x-hub-signature-256') ?? '';
    if (!(await verifyWebhook(env.WEBHOOK_SECRET, sig, body))) {
      return new Response('bad sig', { status: 401 });
    }

    const event = req.headers.get('x-github-event');
    const payload = JSON.parse(body);

    // Ack fast, work async (GitHub times out at 10s)
    ctx.waitUntil(handle(event, payload, env).catch((e) => console.error(e)));
    return new Response('ok');
  },
};

async function handle(event: string | null, p: any, env: Env) {
  if (event === 'pull_request' && ['labeled', 'synchronize', 'reopened'].includes(p.action)) {
    return onPR(p, env);
  }
  if (event === 'push' && p.ref === `refs/heads/${p.repository.default_branch}`) {
    return onPushToDefault(p, env);
  }
}

async function onPR(p: any, env: Env) {
  const pr = p.pull_request;
  if (pr.draft) return;
  if (!pr.labels.some((l: any) => l.name === env.AUTOMERGE_LABEL)) return;
  if (pr.mergeable_state !== 'behind') return;

  const token = await installToken(p.installation.id, env);
  await updateBranch(p.repository.full_name, pr.number, token);
}

async function onPushToDefault(p: any, env: Env) {
  const token = await installToken(p.installation.id, env);
  const [owner, repo] = p.repository.full_name.split('/');

  const r = await gh(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`, token);
  const prs: any[] = await r.json();

  for (const pr of prs) {
    if (pr.draft) continue;
    if (!pr.labels.some((l: any) => l.name === env.AUTOMERGE_LABEL)) continue;
    // mergeable_state on list endpoint is often 'unknown'; let GitHub compute it.
    // update-branch is idempotent-ish: it returns 422 if already up-to-date.
    try {
      await updateBranch(p.repository.full_name, pr.number, token);
    } catch (e) {
      console.log(`skip ${owner}/${repo}#${pr.number}: ${(e as Error).message}`);
    }
  }
}

async function updateBranch(repo: string, num: number, token: string) {
  const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${num}/update-branch`, {
    method: 'PUT',
    headers: ghHeaders(token),
  });
  if (r.status === 422) return; // already up to date
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
}

function gh(path: string, token: string) {
  return fetch(`https://api.github.com${path}`, { headers: ghHeaders(token) });
}

function ghHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'automerge-worker',
  };
}

async function installToken(installId: number, env: Env): Promise<string> {
  const jwt = await appJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const r = await fetch(`https://api.github.com/app/installations/${installId}/access_tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'automerge-worker',
    },
  });
  if (!r.ok) throw new Error(`token: ${r.status} ${await r.text()}`);
  return (await r.json() as any).token;
}

async function appJWT(appId: string, pem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const key = await importPkcs8(pem);
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64urlBytes(new Uint8Array(sig))}`;
}

async function importPkcs8(pem: string): Promise<CryptoKey> {
  const b = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function verifyWebhook(secret: string, sigHeader: string, body: string): Promise<boolean> {
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

function b64url(s: string): string {
  return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlBytes(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
