import type { Logger } from './logger';

export async function gh(path: string, token: string, log: Logger) {
  const r = await fetch(`https://api.github.com${path}`, { headers: ghHeaders(token) });
  if (!r.ok && r.status !== 404) log.log(`gh ${path}: ${r.status}`);
  return r;
}

export function ghHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'automerge-worker',
  };
}

export async function installToken(installId: number, appId: string, privateKey: string, log: Logger): Promise<string> {
  const jwt = await appJWT(appId, privateKey);
  const r = await fetch(`https://api.github.com/app/installations/${installId}/access_tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'automerge-worker',
    },
  });
  if (!r.ok) {
    const body = await r.text();
    log.log(`installToken id=${installId}: ${r.status} ${body}`);
    throw new Error(`token: ${r.status} ${body}`);
  }
  return ((await r.json()) as any).token;
}

export async function updateBranch(repo: string, num: number, token: string, log: Logger): Promise<void> {
  const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${num}/update-branch`, {
    method: 'PUT',
    headers: ghHeaders(token),
  });
  if (r.ok) return;
  // 422 is GitHub's catch-all "Unprocessable Entity" — could be "not behind" (no-op),
  // but also merge conflict, blocked-by-protection, etc. Log the body so we can tell.
  const body = await r.text();
  log.log(`updateBranch ${repo}#${num}: ${r.status} ${body}`);
  if (r.status === 422 && /not behind|up.?to.?date|merge commit/i.test(body)) return;
  throw new Error(`${r.status}: ${body}`);
}

export async function fetchApprovers(repo: string, num: number, token: string, log: Logger): Promise<Set<string>> {
  const r = await gh(`/repos/${repo}/pulls/${num}/reviews?per_page=100`, token, log);
  if (!r.ok) return new Set();
  const reviews: any[] = await r.json();
  // Latest non-pending review per user determines their standing vote
  const latest = new Map<string, string>();
  for (const rev of reviews) {
    if (rev.state !== 'PENDING') latest.set(rev.user.login, rev.state);
  }
  return new Set([...latest].filter(([, state]) => state === 'APPROVED').map(([u]) => u));
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

function b64url(s: string): string {
  return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlBytes(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
