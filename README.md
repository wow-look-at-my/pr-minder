# pr-minder

A Cloudflare Worker GitHub App that keeps pull requests up to date with their base branch automatically. Reacts to webhooks in ~1s, works across every repo in the org without per-repo setup.

## How it works

1. A GitHub App webhook fires on `pull_request`, `pull_request_review`, or `push` events
2. The worker verifies the signature, mints an installation token, and calls GitHub's [update-branch API](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch)
3. No state, no DB, no cron — purely event-driven

A PR is updated when **any** configured trigger is satisfied:

| Trigger | Config field | Description |
|---------|-------------|-------------|
| Label | `trigger_label` | PR has the specified label |
| Specific approvers | `trigger_approved_by` | PR approved by any user in the list |
| Approval count | `trigger_min_approvals` | PR has at least N approvals |

## GitHub App setup

Create a GitHub App with:

**Permissions:**
- Contents: Read & write
- Pull requests: Read & write
- Metadata: Read (required)

**Subscribe to events:** `pull_request`, `pull_request_review`, `push`

**Installation:** All repositories (or selected repos as needed)

Set the webhook URL to your deployed worker URL after deploying.

## Deploy

```sh
npm install

# Set secrets
wrangler secret put WEBHOOK_SECRET
wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste the full PKCS8 PEM

# Update wrangler.toml with your real app ID
# Edit GITHUB_APP_ID under [vars]

npm run deploy
```

## Configuration

Per-repo config at `.github/pr-minder.json` overrides the org-level config at `pr-minder.json` in the org's `.github` repo. The `AUTOMERGE_LABEL` worker var is the fallback if no config file is found.

Config files are **JSONC** — `//` and `/* */` comments are supported.

**Per-repo** (`.github/pr-minder.json`):
```json
{
  "$schema": "https://raw.githubusercontent.com/wow-look-at-my/pr-minder/master/schema/pr-minder.schema.json",
  "trigger_label": "automerge",
  "trigger_approved_by": ["alice", "bob"],
  "trigger_min_approvals": 2
}
```

**Org-level** (`{org}/.github/pr-minder.json`) with per-repo overrides:
```json
{
  "$schema": "https://raw.githubusercontent.com/wow-look-at-my/pr-minder/master/schema/pr-minder.schema.json",
  "trigger_label": "automerge",
  "repos": {
    "special-repo": {
      "trigger_label": "ready-to-merge"
    },
    "opt-out-repo": {
      "enabled": false
    }
  }
}
```

All config fields are optional. The JSON Schema at [`schema/pr-minder.schema.json`](schema/pr-minder.schema.json) provides IDE validation and autocomplete when referenced via `$schema`.

## Pairing with GitHub auto-merge

This worker only keeps branches **fresh** — it does not merge PRs. Pair it with [GitHub's native auto-merge](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request) (`gh pr merge --auto --squash`) so the actual merge happens once CI passes.

## Local development

```sh
npm run dev        # wrangler dev (no real webhooks without a tunnel)
npm run typecheck  # tsc --noEmit
```
