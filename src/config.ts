import { gh } from './github';

export interface PrMinderConfig {
  enabled: boolean;
  trigger_label: string;         // "" = disabled
  trigger_approved_by: string[]; // any match fires; empty = disabled
  trigger_min_approvals: number; // 0 = disabled
}

const CONFIG_FILE = '.github/pr-minder.json';

export async function loadConfig(
  owner: string,
  repo: string,
  token: string,
  defaultLabel: string,
): Promise<PrMinderConfig> {
  const defaults: PrMinderConfig = {
    enabled: true,
    trigger_label: defaultLabel,
    trigger_approved_by: [],
    trigger_min_approvals: 0,
  };

  try {
    const json = await fetchRepoFile(owner, repo, CONFIG_FILE, token);
    if (json !== null) return mergeConfig(defaults, JSON.parse(json), null);
  } catch { /* fall through */ }

  try {
    const json = await fetchRepoFile(owner, '.github', 'pr-minder.json', token);
    if (json !== null) {
      const parsed = JSON.parse(json);
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
