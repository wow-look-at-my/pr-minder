# pr-minder

Cloudflare Worker (TypeScript) that acts as a GitHub App webhook handler for keeping PRs up to date.

## Source layout

```
src/
  worker.ts     Entry point: Cloudflare Worker fetch handler + webhook HMAC verification
  handlers.ts   Event dispatch: handle(), onPR(), onPushToDefault(), onInstallation(), onReposAdded(), prQualifies(), isActionsBotPr()
  config.ts     Config loading: loadConfig(), PrMinderConfig type
  github.ts     GitHub API: auth (JWT/install token), REST helpers
schema/
  pr-minder.schema.json   JSON Schema for .github/pr-minder.jsonc config files
wrangler.toml             Worker name, compat date, plain vars (AUTOMERGE_LABEL, GITHUB_APP_ID)
```

## Build / typecheck

Do NOT run `tsc` or `wrangler` directly. Use:
```sh
npm run typecheck   # tsc --noEmit
npm run dev         # wrangler dev
```

There is no Go in this project — do not use `go-toolchain`.

## Deployment — NEVER deploy manually

It is **never** valid to deploy by hand. Do NOT run `npm run deploy`,
`wrangler deploy`, or any other deploy command — not even to "test" or "ship a
fix faster". Cloudflare's Git integration watches this repo and deploys
automatically: a preview Worker for every PR branch, and **production on merge to
`master`** (the repo's default branch). Manual deploys bypass that pipeline and are
never the right move — ship by merging the PR.

## Secrets (never committed)

Set via `wrangler secret put <NAME>`:
- `WEBHOOK_SECRET` — GitHub App webhook secret
- `GITHUB_APP_PRIVATE_KEY` — PKCS8 PEM for the GitHub App private key

## Config file loading order

1. `{repo}/.github/pr-minder.jsonc` — per-repo (highest priority)
2. `{org}/.github` repo, `.github/config/pr-minder/pr-minder.jsonc` → `repos.{repo}` field for per-repo overrides, top-level for org defaults
3. No config found → everything disabled (opt-in design; nothing fires by default)

## Config shape

`auto_update_pr.triggers`: approval-gate conditions; any one passing fires `update-branch`. Keys within a condition are ANDed; conditions are ORed. Supported keys: `label`, `approved_by`, `min_approvals`.

`auto_label_pr`: map of label name → `{ auto_add, create_label_if_missing_in_repo, color, mode, auto_merge_method }`.

- `auto_add: "on_pr_creation"` — apply label when a PR is opened.
- `create_label_if_missing_in_repo: true` — create the label in the repo (with `color`) if absent.
- `mode: "auto_update"` — when this label is present on a PR, keep the branch in sync with its base (complementary to `auto_update_pr.triggers`).
- `mode: "auto_merge"` — bidirectionally syncs this label with GitHub's native auto-merge. Adding the label enables auto-merge; removing it disables auto-merge. `auto_merge_enabled`/`auto_merge_disabled` webhook events add/remove the label. If the PR is **already mergeable**, GitHub refuses to arm auto-merge (`enablePullRequestAutoMerge` returns 200 + an `errors[]` entry whose message contains `"clean status"`); in that case `enableAutoMerge` falls back to merging the PR directly via `mergePullRequest` (REST `PUT .../merge`) with `auto_merge_method`. Branch protection still gates the merge.
- `auto_merge_method` — `"merge"`, `"squash"` (default), or `"rebase"`. Only used when `mode` is `"auto_merge"`.

`auto_trigger_workflows`: boolean (default false). Revives "zombie" PRs — ones opened by `github-actions[bot]` (created with the default `GITHUB_TOKEN`), whose own workflows GitHub suppresses. When true, `onPR` closes+reopens such a PR (`retriggerWorkflows` in `github.ts`) on the `opened` event so a fresh `pull_request.reopened` event triggers its CI. Gated to `opened` only, so the resulting `reopened` event can't loop.

There is no top-level `enabled`; "disable" means omitting the relevant label/mode, leaving `triggers` empty, or setting `auto_trigger_workflows: false`.

## Key invariants

- `update-branch` returns 422 when already up to date — this is not an error (handled in `github.ts`)
- Auto-merge (`enableAutoMerge`/`disableAutoMerge`) is **GraphQL-only** — there is no REST endpoint (`PUT/DELETE /repos/{repo}/pulls/{num}/automerge` returns 404). The mutations take the PR's `node_id` (from the webhook payload), not its number, and need contents:write + pull_requests:write. GraphQL logical failures arrive as HTTP 200 + an `errors[]` array (swallowed); only non-2xx transport failures throw.
- `pull_request_review` webhook sends `review.state` lowercase; the reviews REST API returns uppercase `APPROVED` — both cases are handled
- PRs created via a workflow's default `GITHUB_TOKEN` never trigger their own workflows (GitHub's recursion guard); the author is `github-actions[bot]`. `auto_trigger_workflows` fixes this by close+reopen using the App's installation token (a different credential), which GitHub *does* let trigger workflows. Close+reopen is two `PATCH /repos/{repo}/pulls/{num}` calls (`state: closed` then `state: open`); `closed` is intentionally not a handled action, and the retrigger is `opened`-gated, so it can't loop
- GitHub App must subscribe to `pull_request`, `pull_request_review`, and `push` events; `installation` and `installation_repositories` are auto-delivered
- JWT validity window is `iat - 60s` to `exp + 540s` (GitHub allows up to 10 min; we use 9)
