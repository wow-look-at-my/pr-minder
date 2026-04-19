// MIT
import { parse as parseYaml } from 'yaml';

interface Env {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string; // PEM, PKCS8
  WEBHOOK_SECRET: string;
  AUTOMERGE_LABEL: string; // fallback when no .github/pr-minder.yml is found
}

interface PrMinderConfig {
  enabled: boolean;
  trigger_label: string;         // "" = disabled
  trigger_approved_by: string[]; // any match fires; empty = disabled
  trigger_min_approvals: number; // 0 = disabled
}

// GitHub App must subscribe to: pull_request, pull_request_review, push
const CONFIG_FILE = '.github/pr-minder.yml';

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
  // Webhook payload uses lowercase state; REST API uses uppercase — different conventions.
  if (event === 'pull_request_review' && p.action === 'submitted' && p.review?.state === 'approved') {
    return onPR(p, env);
  }
  if (event === 'push' && p.ref === `refs/heads/${p.repository.default_branch}`) {
    return onPushToDefault(p, env);
  }
}

async function onPR(p: any, env: Env) {
  const pr = p.pull_request;
  if (pr.draft) return;
  if (pr.mergeable_state !== 'behind') return;

  const token = await installToken(p.installation.id, env);
  const [owner, repo] = p.repository.full_name.split('/');
  const config = await loadConfig(owner, repo, token, env);

  if (!config.enabled) return;
  if (!(await prQualifies(pr, p.repository.full_name, config, token))) return;

  await updateBranch(p.repository.full_name, pr.number, token);
}

async function onPushToDefault(p: any, env: Env) {
  const token = await installToken(p.installation.id, env);
  const [owner, repo] = p.repository.full_name.split('/');
  const config = await loadConfig(owner, repo, token, env);
  if (!config.enabled) return;

  const r = await gh(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`, token);
  const prs: any[] = await r.json();

  for (const pr of prs) {
    if (pr.draft) continue;
    if (!(await prQualifies(pr, p.repository.full_name, config, token))) continue;
    try {
      await updateBranch(p.repository.full_name, pr.number, token);
    } catch (e) {
      console.log(`skip ${owner}/${repo}#${pr.number}: ${(e as Error).message}`);
    }
  }
}

async function prQualifies(pr: any, repo: string, config: PrMinderConfig, token: string): Promise<boolean> {
  if (config.trigger_label && pr.labels.some((l: any) => l.name === config.trigger_label)) {
    return true;
  }
  if (config.trigger_approved_by.length > 0 || config.trigger_min_approvals > 0) {
    const approvers = await fetchApprovers(repo, pr.number, token);
    if (config.trigger_approved_by.length > 0 && config.trigger_approved_by.some((u) => approvers.has(u))) {
      return true;
    }
    if (config.trigger_min_approvals > 0 && approvers.size >= config.trigger_min_approvals) {
      return true;
    }
  }
  return false;
}

async function fetchApprovers(repo: string, num: number, token: string): Promise<Set<string>> {
  const r = await gh(`/repos/${repo}/pulls/${num}/reviews?per_page=100`, token);
  if (!r.ok) return new Set();
  const reviews: any[] = await r.json();
  // Latest non-pending review per user determines their standing vote
  const latest = new Map<string, string>();
  for (const rev of reviews) {
    if (rev.state !== 'PENDING') latest.set(rev.user.login, rev.state);
  }
  return new Set([...latest].filter(([, state]) => state === 'APPROVED').map(([u]) => u));
}

// Config loading -----------------------------------------------------------------

async function loadConfig(owner: string, repo: string, token: string, env: Env): Promise<PrMinderConfig> {
  const defaults: PrMinderConfig = {
    enabled: true,
    trigger_label: env.AUTOMERGE_LABEL,
    trigger_approved_by: [],
    trigger_min_approvals: 0,
  };

  try {
    const yaml = await fetchRepoFile(owner, repo, CONFIG_FILE, token);
    if (yaml !== null) return mergeConfig(defaults, parseYaml(yaml), null);
  } catch { /* fall through */ }

  try {
    const yaml = await fetchRepoFile(owner, '.github', 'pr-minder.yml', token);
    if (yaml !== null) {
      const parsed = parseYaml(yaml);
      return mergeConfig(defaults, parsed, parsed?.repos?.[repo]);
    }
  } catch { /* fall through */ }

  return defaults;
}

function mergeConfig(base: PrMinderConfig, top: any, override: any): PrMinderConfig {
  const result = { ...base };
  for (const src of [top, override]) {
    if (!src) continue;
    if (typeof src.enabled === 'boolean') result.enabled = src.enabled;
    if (typeof src.trigger_label === 'string') result.trigger_label = src.trigger_label;
    if (Array.isArray(src.trigger_approved_by)) result.trigger_approved_by = src.trigger_approved_by as string[];
    if (typeof src.trigger_min_approvals === 'number') result.trigger_min_approvals = src.trigger_min_approvals;
  }
  return result;
}

async function fetchRepoFile(owner: string, repo: string, path: string, token: string): Promise<string | null> {
  const r = await gh(`/repos/${owner}/${repo}/contents/${path}`, token);
  if (r.status === 404) return null;
  if (!r.ok) return null;
  const data: any = await r.json();
  if (data.encoding !== 'base64') return null;
  return atob(data.content.replace(/\s/g, ''));
}

// GitHub API helpers -------------------------------------------------------------

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
    'user-agent': 'pr-minder',
  };
}

async function installToken(installId: number, env: Env): Promise<string> {
  const jwt = await appJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const r = await fetch(`https://api.github.com/app/installations/${installId}/access_tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'pr-minder',
    },
  });
  if (!r.ok) throw new Error(`token: ${r.status} ${await r.text()}`);
  return ((await r.json()) as any).token;
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
