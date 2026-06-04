# pr-minder

Cloudflare Worker (TypeScript) that acts as a GitHub App webhook handler for keeping PRs up to date.

## Source layout

```
src/
  worker.ts     Entry point: Cloudflare Worker fetch handler. GET/HEAD -> serveDocs(); POST -> webhook
  webhook.ts    verifyWebhook(): HMAC-SHA256 check of x-hub-signature-256 (its own module so tests don't pull in worker.ts's baked-in docs)
  handlers.ts   Event dispatch: handle(), onPR(), onPushToDefault(), onPushToBranch(), onInstallation(), onReposAdded(), prQualifies(), isActionsBotPr(), needsWorkflowTrigger(), shouldSkipBranch()
  config.ts     Config loading: loadConfig(), PrMinderConfig type
  github.ts     GitHub API: auth (JWT/install token), REST helpers
  docs/         Doc sources: llms.txt (the content) and index.html (a self-contained page that fetches /llms.txt and renders it). *.gz are generated, git-ignored
  text-modules.d.ts   Ambient `*.gz` -> ArrayBuffer decl for the imported gzip blobs
scripts/
  build-docs.mjs          Build step: gzip the doc sources -> src/docs/*.gz (run via wrangler.toml [build].command)
schema/
  pr-minder.schema.json   JSON Schema for .github/pr-minder.jsonc config files
wrangler.toml             Worker name, compat date, [build] gzip step, [[rules]] Data for *.gz, plain vars (GITHUB_APP_ID)
```

## Docs serving

`worker.ts` serves public docs on GET/HEAD: `/` and `/llms.txt`. `llms.txt` is the single source of truth; `index.html` is a self-contained page that fetches `/llms.txt` and renders the Markdown. Both are **gzipped at build time** (`scripts/build-docs.mjs`, wired via `wrangler.toml [build].command`, output git-ignored) and imported as `*.gz` blobs (the `[[rules]] type = "Data"` makes them `ArrayBuffer`). They're served **pre-compressed**: `new Response(gz, { encodeBody: "manual", headers: { "content-encoding": "gzip" } })` — `encodeBody: "manual"` is required, else the runtime compresses the already-gzipped bytes again. Keep doc content in `docs/*` (the "no embedded docs in source files" rule); never inline it in a `.ts`. Install URL: `https://github.com/apps/pr-minder/installations/new`. Webhooks are POST, so they never collide with the GET docs routes. `verifyWebhook` lives in `webhook.ts` so the test suite doesn't pull `worker.ts`'s binary imports through vite.

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

`auto_trigger_workflows`: boolean (default false). Revives "zombie" PRs with no workflow runs by closing+reopening them (`retriggerWorkflows` in `github.ts`), so a fresh `pull_request.reopened` event triggers their CI. The zombie test (`needsWorkflowTrigger`) differs by event:
- `opened` — keys on the **author** (`isActionsBotPr`: `github-actions[bot]`, i.e. created with the default `GITHUB_TOKEN`). A fresh PR always has zero runs momentarily, so a run-count check can't tell a zombie from a healthy PR; the author can.
- `reopened` — keys on the PR having **zero workflow runs** for its head SHA (`hasWorkflowRuns` → `GET /actions/runs?head_sha=…`), any author. Catches zombies that predate installation.

Loop safety: our own close+reopen returns as a `reopened` event whose `sender.type` is `Bot`; reopens from any bot sender are skipped. `hasWorkflowRuns` fails safe to `true` (assume runs exist) on a query error, so transient failures never cause a spurious reopen.

`auto_open_pr`: `{ enabled, skip_branches[], target_base }` (default disabled). Root-cause fix for zombies: pr-minder itself opens PRs for forgotten branches, using its **App token** so they trigger CI natively (never zombies — complementary to the `auto_trigger_workflows` band-aid). A branch qualifies when it's ahead of base and has no open PR (`compareCommits` + `hasOpenPrForBranch` + `createPull` in `github.ts`; `shouldSkipBranch` always excludes the default branch + gh-pages). Two triggers: `onPushToBranch` (push to a non-default branch) and a sweep (`maybeOpenPrsForRepo`) on `installation`/`installation_repositories` for pre-existing branches. `target_base` defaults to the repo default branch. This replaces the "open PRs for branches missing one" reusable workflow in `wow-look-at-my/actions` (`pr-management.yml`), whose flaw was creating PRs with `github.token`.

There is no top-level `enabled`; "disable" means omitting the relevant label/mode, leaving `triggers` empty, or setting `auto_trigger_workflows: false`.

## Key invariants

- `update-branch` returns 422 when already up to date — this is not an error (handled in `github.ts`)
- Auto-merge (`enableAutoMerge`/`disableAutoMerge`) is **GraphQL-only** — there is no REST endpoint (`PUT/DELETE /repos/{repo}/pulls/{num}/automerge` returns 404). The mutations take the PR's `node_id` (from the webhook payload), not its number, and need contents:write + pull_requests:write. GraphQL logical failures arrive as HTTP 200 + an `errors[]` array (swallowed); only non-2xx transport failures throw.
- `pull_request_review` webhook sends `review.state` lowercase; the reviews REST API returns uppercase `APPROVED` — both cases are handled
- PRs created via a workflow's default `GITHUB_TOKEN` never trigger their own workflows (GitHub's recursion guard); the author is `github-actions[bot]`. `auto_trigger_workflows` fixes this by close+reopen using the App's installation token (a different credential), which GitHub *does* let trigger workflows. Close+reopen is two `PATCH /repos/{repo}/pulls/{num}` calls (`state: closed` then `state: open`); `closed` is intentionally not a handled action. The retrigger runs on `opened` and `reopened`; the loop guard is the `Bot` sender skip on `reopened` (our own reopen comes back bot-sent), not the event gate
- GitHub App must subscribe to `pull_request`, `pull_request_review`, and `push` events; `installation` and `installation_repositories` are auto-delivered
- `push` handling: default-branch pushes → `onPushToDefault` (update qualifying PRs); non-default branch pushes → `onPushToBranch` (`auto_open_pr`). Both gated on `ref` being `refs/heads/*` and `!p.deleted`, so tag pushes and branch deletions are ignored. A PR pr-minder opens is authored by the App's own bot, so it triggers CI natively and the `auto_trigger_workflows` zombie check (which keys on `github-actions[bot]`) correctly ignores it — no interaction between the two features
- JWT validity window is `iat - 60s` to `exp + 540s` (GitHub allows up to 10 min; we use 9)
