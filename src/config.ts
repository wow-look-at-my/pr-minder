import stripJsonComments from 'strip-json-comments';
import { gh } from './github';
import type { Logger } from './logger';

function parseJsonc(text: string): any {
  return JSON.parse(stripJsonComments(text));
}

export type AutoAdd = 'on_pr_creation' | false;
export type AutoMergeMethod = 'merge' | 'squash' | 'rebase';
export type LabelMode = 'auto_merge' | 'auto_update';

export interface TriggerCondition {
  label?: string;
  approved_by?: string[];
  min_approvals?: number;
}

export interface LabelOptions {
  auto_add: AutoAdd;
  create_label_if_missing_in_repo: boolean;
  color: string; // 6-char hex, no leading '#'
  mode?: LabelMode; // 'auto_merge': sync with GitHub native auto-merge; 'auto_update': triggers branch updates
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
}

export interface AutoOpenPr {
  enabled: boolean;
  skipBranches: string[]; // extra branches to skip; default branch and gh-pages always skipped
  targetBase: string; // base branch for opened PRs; '' means the repo's default branch
}

const PER_REPO_CONFIG = '.github/pr-minder.jsonc';
const ORG_CONFIG = '.github/config/pr-minder/pr-minder.jsonc';

export const DEFAULT_LABEL_COLOR = '00FF00';

const DISABLED: PrMinderConfig = { triggers: [], labels: {}, autoTriggerWorkflows: false, autoOpenPr: { enabled: false, skipBranches: [], targetBase: '' } };

export async function loadConfig(owner: string, repo: string, token: string, log: Logger): Promise<PrMinderConfig> {
  try {
    const json = await fetchRepoFile(owner, repo, PER_REPO_CONFIG, token, log);
    if (json !== null) {
      log.log(`config: per-repo ${owner}/${repo}/${PER_REPO_CONFIG}`);
      return mergeConfig(parseJsonc(json), null);
    }
  } catch (e) { log.log(`config: per-repo fetch failed: ${(e as Error).message}`); }

  try {
    const json = await fetchRepoFile(owner, '.github', ORG_CONFIG, token, log);
    if (json !== null) {
      log.log(`config: org-level ${owner}/.github`);
      const parsed = parseJsonc(json);
      return mergeConfig(parsed, parsed?.repos?.[repo]);
    }
  } catch (e) { log.log(`config: org fetch failed: ${(e as Error).message}`); }

  log.log(`config: none found, disabled`);
  return DISABLED;
}

function defaultLabel(): LabelOptions {
  return { auto_add: false, create_label_if_missing_in_repo: false, color: DEFAULT_LABEL_COLOR, auto_merge_method: 'squash' };
}

export function mergeConfig(top: any, override: any): PrMinderConfig {
  const result: PrMinderConfig = { triggers: [], labels: {}, autoTriggerWorkflows: false, autoOpenPr: { enabled: false, skipBranches: [], targetBase: '' } };
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
      if (typeof a.target_base === 'string') result.autoOpenPr.targetBase = a.target_base;
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
        if (raw.mode === 'auto_merge' || raw.mode === 'auto_update') {
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

async function fetchRepoFile(owner: string, repo: string, path: string, token: string, log: Logger): Promise<string | null> {
  const r = await gh(`/repos/${owner}/${repo}/contents/${path}`, token, log);
  if (r.status === 404) return null;
  if (!r.ok) return null;
  const data: any = await r.json();
  if (data.encoding !== 'base64') return null;
  return atob(data.content.replace(/\s/g, ''));
}
