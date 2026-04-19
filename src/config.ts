import stripJsonComments from 'strip-json-comments';
import { gh } from './github';

function parseJsonc(text: string): any {
  return JSON.parse(stripJsonComments(text));
}

export interface TriggerCondition {
  label?: string;
  approved_by?: string[];
  min_approvals?: number;
}

export interface PrMinderConfig {
  enabled: boolean;
  triggers: TriggerCondition[]; // ORed; keys within each object are ANDed
}

const CONFIG_FILE = '.github/pr-minder.json';

// Nothing fires without a config file — opt-in per repo or via org .github repo.
const DISABLED: PrMinderConfig = { enabled: false, triggers: [] };

export async function loadConfig(owner: string, repo: string, token: string): Promise<PrMinderConfig> {
  try {
    const json = await fetchRepoFile(owner, repo, CONFIG_FILE, token);
    if (json !== null) return mergeConfig(parseJsonc(json), null);
  } catch { /* fall through */ }

  try {
    const json = await fetchRepoFile(owner, '.github', 'pr-minder.json', token);
    if (json !== null) {
      const parsed = parseJsonc(json);
      return mergeConfig(parsed, parsed?.repos?.[repo]);
    }
  } catch { /* fall through */ }

  return DISABLED;
}

function mergeConfig(top: any, override: any): PrMinderConfig {
  const result: PrMinderConfig = { enabled: true, triggers: [] };
  for (const src of [top, override]) {
    if (!src) continue;
    if (typeof src.enabled === 'boolean') result.enabled = src.enabled;
    if (Array.isArray(src.triggers)) result.triggers = src.triggers as TriggerCondition[];
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
