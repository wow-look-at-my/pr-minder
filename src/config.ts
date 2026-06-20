import stripJsonComments from 'strip-json-comments';
import { gh, GhError } from './github';
import type { Logger } from './logger';

function parseJsonc(text: string): any {
  return JSON.parse(stripJsonComments(text));
}

export type AutoAdd = 'on_pr_creation' | false;
export type AutoMergeMethod = 'merge' | 'squash' | 'rebase';
export type LabelMode = 'auto_merge' | 'auto_update' | 'merge_conflict';

export interface TriggerCondition {
  label?: string;
  approved_by?: string[];
  min_approvals?: number;
}

export interface LabelOptions {
  auto_add: AutoAdd;
  create_label_if_missing_in_repo: boolean;
  color: string; // 6-char hex, no leading '#'
  mode?: LabelMode; // 'auto_merge': sync with GitHub native auto-merge; 'auto_update': triggers branch updates; 'merge_conflict': applied when the PR has a merge conflict
  auto_merge_method: AutoMergeMethod; // merge method used when mode === 'auto_merge' (default: squash)
}

export interface PrMinderConfig {
  triggers: TriggerCondition[]; // ORed; keys within each object are ANDed
  labels: Record<string, LabelOptions>;
  // When true, re-trigger CI for PRs opened by github-actions[bot]. Such PRs are created
  // with the default GITHUB_TOKEN, which by design never triggers their own workflows;
  // pr-minder closes+reopens them with its App token so the workflows actually run.
  autoTriggerWorkflows: boolean;
  autoOpenPr: AutoOpenPr;
  autoDescribePr: AutoDescribePr;
}

export interface AutoOpenPr {
  enabled: boolean;
  skipBranches: string[]; // extra branches to skip (exact names); default branch and gh-pages always skipped
  skipBranchPatterns: string[]; // extra branches to skip, as regex patterns (e.g. version branches)
  targetBase: string; // fallback base branch for opened PRs; '' means the repo's default branch
  // When true, the base for a branch is detected from its fork point (the branch it was created
  // from) instead of always using targetBase: the nearest ancestor commit that is another branch's
  // HEAD picks the base, falling back to targetBase when none qualifies.
  baseFromForkPoint: boolean;
  // Which detected fork-point branches may be used as a base, as regex patterns. The repo's default
  // branch always qualifies; a non-default branch qualifies only if it matches one of these.
  baseBranchPatterns: string[];
  // When true (default), close any open non-draft PR whose net diff against its base is zero (no
  // changed files), regardless of who opened it. A 0-diff PR has nothing to review or merge and only
  // wastes CI on each update, so it's closed; squash-merge orphans (ahead by commit count, no net
  // content) are the common case, but it doesn't matter how the PR went empty or who authored it — a
  // human's empty PR is closed too (closing is reversible). Only an EXACTLY-zero changed-files count
  // closes a PR; an unknown count (GitHub omitted the file list) is left alone.
  closeWhenEmpty: boolean;
  // When true, also delete the head branch of a PR that close_when_empty closes. The branch is, by
  // definition, content-identical to its base (zero net diff), so deleting it loses nothing and stops
  // closed-but-undeleted branches from piling up. Only ever deletes a branch in this repo — a fork
  // PR's head lives in the fork, which pr-minder neither owns nor can write to. Off by default
  // (deleting a branch is the one part of the empty-PR cleanup that isn't trivially reversible).
  // No effect unless close_when_empty is also on.
  deleteBranchWhenEmpty: boolean;
}

// AI-generated PR titles/descriptions from the full PR diff (src/describe.ts). The slow model
// call runs in the pr-describe webhook on the internal webhook-runner host (Worker-level
// DESCRIBE_HOOK_URL var + DESCRIBE_HOOK_API_KEY secret); the model endpoint/key live with that
// webhook. Config only opts a repo in and optionally picks a different model alias.
export interface AutoDescribePr {
  enabled: boolean;
  model: string; // '' means the webhook's default model (its AI_MODEL env)
}

// Repo-relative path of the config file. The SAME path is read in two places: the per-repo file at
// {owner}/{repo}/<CONFIG_PATH>, and the org default at the same path in the owner's `.github` repo.
// One constant so the two can never drift apart. (For the `.github` repo itself the two reads
// coincide — the per-repo read finds the org file and uses it directly, which is harmless.)
const CONFIG_PATH = '.github/config/pr-minder/pr-minder.jsonc';

export const DEFAULT_LABEL_COLOR = '00FF00';

const DISABLED: PrMinderConfig = { triggers: [], labels: {}, autoTriggerWorkflows: false, autoOpenPr: { enabled: false, skipBranches: [], skipBranchPatterns: [], targetBase: '', baseFromForkPoint: false, baseBranchPatterns: [], closeWhenEmpty: true, deleteBranchWhenEmpty: false }, autoDescribePr: { enabled: false, model: '' } };

// Per-isolate config cache. loadConfig runs on essentially every webhook event (onPR,
// onPushToDefault, onPushToBranch, the sweeps), and each resolution costs up to two GitHub
// Contents API calls — the per-repo file, then (the common case, a 404) the org `.github` file.
// Config changes rarely, so we memoize the resolved result for CONFIG_CACHE_TTL_MS keyed on
// `owner/repo`. The cache lives for the life of the isolate, exactly like handlers.ts's
// labelCheckedAt: a cold start just re-resolves once, and a config edit propagates within the TTL.
// Keyed on owner/repo only because the resolved config is identical regardless of which
// installation token reads it.
const CONFIG_CACHE_TTL_MS = 60_000;
const configCache = new Map<string, { config: PrMinderConfig; expires: number }>();

// Per-isolate cache of the *org-level* config file, keyed on `owner` alone. The org `.github` file
// (at CONFIG_PATH) is identical for every repo in an org, but the resolved-config cache above is keyed
// on `owner/repo`, so a sweep across an org's repos would otherwise re-fetch that one shared file
// once per repo (the dominant cost of a cross-repo reconcile). Memoizing the parsed org JSON by
// owner collapses that to a single fetch per owner per TTL. Stores the parsed JSON (or null when the
// file is definitively absent/malformed); a transient fetch failure is NOT stored (so it retries).
const orgConfigCache = new Map<string, { parsed: any; expires: number }>();

// Drop all cached config. Exists so tests can isolate cases; there is no production caller.
export function resetConfigCache(): void {
  configCache.clear();
  orgConfigCache.clear();
}

export async function loadConfig(owner: string, repo: string, token: string, log: Logger): Promise<PrMinderConfig> {
  const key = `${owner}/${repo}`;
  const now = Date.now();
  const hit = configCache.get(key);
  if (hit && hit.expires > now) {
    log.log(`config: cache hit ${key}`);
    return hit.config;
  }

  const { config, cacheable } = await resolveConfig(owner, repo, token, log);
  // Only cache a definitive resolution. A transient fetch failure (5xx, network, throttling)
  // resolves to DISABLED here, and caching that would make pr-minder ignore the repo for a whole
  // TTL window; leaving it uncached means the next event retries instead.
  if (cacheable) configCache.set(key, { config, expires: now + CONFIG_CACHE_TTL_MS });
  return config;
}

// The owner-level (org `.github`) config, with no per-repo file or per-repo override applied. The
// auto-merge backstop (reconcileInstall) uses this to learn which labels are auto_merge-mode so it
// can search the whole installation for them — a per-repo resolution would defeat the point. Reads
// the owner-cached org file (so it's a single fetch per owner per TTL), and degrades to DISABLED when
// the org file is absent or unreadable. Per-repo label overrides aren't reflected here; the live
// event path still applies them, this is only the org-wide backstop's view.
export async function loadOwnerConfig(owner: string, token: string, log: Logger): Promise<PrMinderConfig> {
  const { parsed } = await loadOrgConfig(owner, token, log);
  return parsed ? mergeConfig(parsed, null) : DISABLED;
}

async function resolveConfig(owner: string, repo: string, token: string, log: Logger): Promise<{ config: PrMinderConfig; cacheable: boolean }> {
  // A fetch that couldn't reach a definitive answer (anything other than a clean 200/404) makes the
  // whole resolution non-cacheable: the per-repo file we failed to read might exist, so any result
  // we fall back to could be wrong. A malformed-JSON file is NOT a fetch failure — it's a definitive
  // (if broken) state that won't change within the TTL, so it stays cacheable.
  let cacheable = true;

  let perRepo: string | null = null;
  try {
    perRepo = await fetchRepoFile(owner, repo, CONFIG_PATH, token, log);
  } catch (e) {
    log.log(`config: per-repo fetch failed: ${(e as Error).message}`);
    cacheable = false;
  }
  if (perRepo !== null) {
    try {
      const config = mergeConfig(parseJsonc(perRepo), null);
      log.log(`config: per-repo ${owner}/${repo}/${CONFIG_PATH}`);
      return { config, cacheable };
    } catch (e) {
      log.log(`config: per-repo parse failed: ${(e as Error).message}`);
    }
  }

  const { parsed, ok } = await loadOrgConfig(owner, token, log);
  if (!ok) cacheable = false;
  if (parsed !== null) {
    log.log(`config: org-level ${owner}/.github`);
    return { config: mergeConfig(parsed, parsed?.repos?.[repo]), cacheable };
  }

  log.log(`config: none found, disabled`);
  return { config: DISABLED, cacheable };
}

// Fetch + parse the org-level config file for `owner`, memoized by owner (see orgConfigCache). The
// org file is shared by every repo in the owner, so this is what lets a cross-repo sweep read it
// once instead of once per repo. Returns { parsed, ok }: `parsed` is the parsed JSON or null (file
// absent or malformed — both definitive, so they're cached); `ok` is false only on a transient
// fetch failure (not cached, and signals the caller to treat the whole resolution as non-cacheable).
async function loadOrgConfig(owner: string, token: string, log: Logger): Promise<{ parsed: any; ok: boolean }> {
  const now = Date.now();
  const hit = orgConfigCache.get(owner);
  if (hit && hit.expires > now) {
    log.log(`config: org cache hit ${owner}`);
    return { parsed: hit.parsed, ok: true };
  }

  let orgJson: string | null;
  try {
    orgJson = await fetchRepoFile(owner, '.github', CONFIG_PATH, token, log);
  } catch (e) {
    log.log(`config: org fetch failed: ${(e as Error).message}`);
    return { parsed: null, ok: false }; // transient — don't cache, force a retry next event
  }

  let parsed: any = null;
  if (orgJson !== null) {
    try {
      parsed = parseJsonc(orgJson);
    } catch (e) {
      log.log(`config: org parse failed: ${(e as Error).message}`);
      parsed = null; // malformed is definitive (won't change within the TTL) — cache as "no config"
    }
  }
  orgConfigCache.set(owner, { parsed, expires: now + CONFIG_CACHE_TTL_MS });
  return { parsed, ok: true };
}

function defaultLabel(): LabelOptions {
  return { auto_add: false, create_label_if_missing_in_repo: false, color: DEFAULT_LABEL_COLOR, auto_merge_method: 'squash' };
}

export function mergeConfig(top: any, override: any): PrMinderConfig {
  const result: PrMinderConfig = { triggers: [], labels: {}, autoTriggerWorkflows: false, autoOpenPr: { enabled: false, skipBranches: [], skipBranchPatterns: [], targetBase: '', baseFromForkPoint: false, baseBranchPatterns: [], closeWhenEmpty: true, deleteBranchWhenEmpty: false }, autoDescribePr: { enabled: false, model: '' } };
  for (const src of [top, override]) {
    if (!src) continue;
    if (src.auto_update_pr && Array.isArray(src.auto_update_pr.triggers)) {
      result.triggers = src.auto_update_pr.triggers as TriggerCondition[];
    }
    if (typeof src.auto_trigger_workflows === 'boolean') {
      result.autoTriggerWorkflows = src.auto_trigger_workflows;
    }
    if (src.auto_open_pr && typeof src.auto_open_pr === 'object') {
      const a = src.auto_open_pr;
      if (typeof a.enabled === 'boolean') result.autoOpenPr.enabled = a.enabled;
      if (Array.isArray(a.skip_branches)) {
        result.autoOpenPr.skipBranches = a.skip_branches.filter((x: unknown) => typeof x === 'string');
      }
      if (Array.isArray(a.skip_branch_patterns)) {
        result.autoOpenPr.skipBranchPatterns = a.skip_branch_patterns.filter((x: unknown) => typeof x === 'string');
      }
      if (typeof a.target_base === 'string') result.autoOpenPr.targetBase = a.target_base;
      if (typeof a.base_from_fork_point === 'boolean') result.autoOpenPr.baseFromForkPoint = a.base_from_fork_point;
      if (Array.isArray(a.base_branch_patterns)) {
        result.autoOpenPr.baseBranchPatterns = a.base_branch_patterns.filter((x: unknown) => typeof x === 'string');
      }
      if (typeof a.close_when_empty === 'boolean') result.autoOpenPr.closeWhenEmpty = a.close_when_empty;
      if (typeof a.delete_branch_when_empty === 'boolean') result.autoOpenPr.deleteBranchWhenEmpty = a.delete_branch_when_empty;
    }
    if (src.auto_describe_pr && typeof src.auto_describe_pr === 'object') {
      const d = src.auto_describe_pr;
      if (typeof d.enabled === 'boolean') result.autoDescribePr.enabled = d.enabled;
      if (typeof d.model === 'string') result.autoDescribePr.model = d.model;
    }
    if (src.auto_label_pr && typeof src.auto_label_pr === 'object') {
      for (const [name, raw] of Object.entries(src.auto_label_pr as Record<string, any>)) {
        if (!raw || typeof raw !== 'object') continue;
        const opts = result.labels[name] ?? defaultLabel();
        if (raw.auto_add === 'on_pr_creation' || raw.auto_add === false) {
          opts.auto_add = raw.auto_add;
        }
        if (typeof raw.create_label_if_missing_in_repo === 'boolean') {
          opts.create_label_if_missing_in_repo = raw.create_label_if_missing_in_repo;
        }
        if (typeof raw.color === 'string') {
          opts.color = raw.color.replace(/^#/, '');
        }
        if (raw.mode === 'auto_merge' || raw.mode === 'auto_update' || raw.mode === 'merge_conflict') {
          opts.mode = raw.mode;
        }
        if (raw.auto_merge_method === 'merge' || raw.auto_merge_method === 'squash' || raw.auto_merge_method === 'rebase') {
          opts.auto_merge_method = raw.auto_merge_method;
        }
        result.labels[name] = opts;
      }
    }
  }
  return result;
}

// Returns the file's decoded content, or null when it definitively doesn't exist (404).
// Any other non-2xx is a transient failure (5xx, throttling, auth blip) — throw so the caller
// treats the resolution as non-cacheable and retries on the next event, rather than mistaking it
// for "no config".
async function fetchRepoFile(owner: string, repo: string, path: string, token: string, log: Logger): Promise<string | null> {
  const r = await gh(`/repos/${owner}/${repo}/contents/${path}`, token, log);
  if (r.status === 404) return null;
  if (!r.ok) throw new GhError(r.status, await r.text());
  const data: any = await r.json();
  if (data.encoding !== 'base64') return null;
  return atob(data.content.replace(/\s/g, ''));
}
