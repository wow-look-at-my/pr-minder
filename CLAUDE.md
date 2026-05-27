# pr-minder

Cloudflare Worker (TypeScript) that acts as a GitHub App webhook handler for keeping PRs up to date.

## Source layout

```
src/
  worker.ts     Entry point: Cloudflare Worker fetch handler + webhook HMAC verification
  handlers.ts   Event dispatch: handle(), onPR(), onPushToDefault(), onInstallation(), onReposAdded(), prQualifies()
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
npm run deploy      # wrangler deploy
npm run dev         # wrangler dev
```

There is no Go in this project — do not use `go-toolchain`.

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
- `mode: "auto_merge"` — bidirectionally syncs this label with GitHub's native auto-merge. Adding the label enables auto-merge; removing it disables auto-merge. `auto_merge_enabled`/`auto_merge_disabled` webhook events add/remove the label.
- `auto_merge_method` — `"merge"`, `"squash"` (default), or `"rebase"`. Only used when `mode` is `"auto_merge"`.

There is no top-level `enabled`; "disable" means omitting the relevant label/mode or leaving `triggers` empty.

## Key invariants

- `update-branch` returns 422 when already up to date — this is not an error (handled in `github.ts`)
- `pull_request_review` webhook sends `review.state` lowercase; the reviews REST API returns uppercase `APPROVED` — both cases are handled
- GitHub App must subscribe to `pull_request`, `pull_request_review`, and `push` events; `installation` and `installation_repositories` are auto-delivered
- JWT validity window is `iat - 60s` to `exp + 540s` (GitHub allows up to 10 min; we use 9)
