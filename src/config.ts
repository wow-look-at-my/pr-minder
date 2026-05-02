import stripJsonComments from 'strip-json-comments';
import { gh } from './github';
import type { Logger } from './logger';

function parseJsonc(text: string): any {
  return JSON.parse(stripJsonComments(text));
}

export interface TriggerCondition {
  label?: string;
  approved_by?: string[];
  min_approvals?: number;
}

export interface LabelOptions {
  autocreate: boolean;
  color: string; // 6-char hex, no leading '#'
}

export interface PrMinderConfig {
  enabled: boolean;
  triggers: TriggerCondition[]; // ORed; keys within each object are ANDed
  labels: LabelOptions;
  default_labels: string[]; // applied to PRs on `opened`
}

const CONFIG_FILE = '.github/pr-minder.json';

export const DEFAULT_LABEL_COLOR = '00FF00';
const defaultLabels = (): LabelOptions => ({ autocreate: false, color: DEFAULT_LABEL_COLOR });

// Nothing fires without a config file — opt-in per repo or via org .github repo.
const DISABLED: PrMinderConfig = { enabled: false, triggers: [], labels: defaultLabels(), default_labels: [] };

export async function loadConfig(owner: string, repo: string, token: string, log: Logger): Promise<PrMinderConfig> {
  try {
    const json = await fetchRepoFile(owner, repo, CONFIG_FILE, token, log);
    if (json !== null) {
      log.log(`config: per-repo ${owner}/${repo}/${CONFIG_FILE}`);
      return mergeConfig(parseJsonc(json), null);
    }
  } catch (e) { log.log(`config: per-repo fetch failed: ${(e as Error).message}`); }

  try {
    const json = await fetchRepoFile(owner, '.github', '.github/config/pr-minder/pr-minder.json', token, log);
    if (json !== null) {
      log.log(`config: org-level ${owner}/.github`);
      const parsed = parseJsonc(json);
      return mergeConfig(parsed, parsed?.repos?.[repo]);
    }
  } catch (e) { log.log(`config: org fetch failed: ${(e as Error).message}`); }

  log.log(`config: none found, disabled`);
  return DISABLED;
}

export function mergeConfig(top: any, override: any): PrMinderConfig {
  const result: PrMinderConfig = { enabled: true, triggers: [], labels: defaultLabels(), default_labels: [] };
  for (const src of [top, override]) {
    if (!src) continue;
    if (typeof src.enabled === 'boolean') result.enabled = src.enabled;
    if (Array.isArray(src.triggers)) result.triggers = src.triggers as TriggerCondition[];
    if (Array.isArray(src.default_labels)) {
      const seen = new Set<string>();
      result.default_labels = [];
      for (const s of src.default_labels) {
        if (typeof s !== 'string' || seen.has(s)) continue;
        seen.add(s);
        result.default_labels.push(s);
      }
    }
    if (src.labels && typeof src.labels === 'object') {
      if (typeof src.labels.autocreate === 'boolean') result.labels.autocreate = src.labels.autocreate;
      if (typeof src.labels.color === 'string') result.labels.color = src.labels.color.replace(/^#/, '');
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
