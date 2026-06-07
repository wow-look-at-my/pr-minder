# pr-minder

Cloudflare Worker (TypeScript) that acts as a GitHub App webhook handler for keeping PRs up to date.

## Source layout

```
src/
  worker.ts     Entry point: Cloudflare Worker fetch handler. GET/HEAD -> serveDocs(); POST -> webhook
  webhook.ts    verifyWebhook(): HMAC-SHA256 check of x-hub-signature-256 (its own module so tests don't pull in worker.ts's baked-in docs)
  handlers.ts   Event dispatch: handle(), onPR(), onPushToDefault(), onPushToBranch(), onInstallation(), onReposAdded(), prQualifies(), isActionsBotPr(), reviveIfZombie(), maybeBackfillRepo(), shouldSkipBranch()
  config.ts     Config loading: loadConfig(), PrMinderConfig type
  state.ts      Workers KV access for the zombie check: per-PR "checked at SHA" markers + per-repo backfill flag (checkedSha/markChecked, wasBackfilled/markBackfilled)
  github.ts     GitHub API: auth (JWT/install token), REST helpers
  docs/         Doc sources: llms.txt (the content) and index.html (a self-contained page that fetches /llms.txt and renders it). *.gz are generated, git-ignored
  text-modules.d.ts   Ambient `*.gz` -> ArrayBuffer decl for the imported gzip blobs
scripts/
  build-docs.mjs          Build step: gzip the doc sources -> src/docs/*.gz (run via wrangler.toml [build].command)
schema/
  pr-minder.schema.json   JSON Schema for .github/pr-minder.jsonc config files
wrangler.toml             Worker name, compat date, [build] gzip step, [[rules]] Data for *.gz, [[kv_namespaces]] PR_STATE, plain vars (GITHUB_APP_ID)
```

## Docs serving

`worker.ts` serves public docs on GET/HEAD: `/` and `/llms.txt`. `llms.txt` is the single source of truth; `index.html` is a self-contained page that fetches `/llms.txt` and renders the Markdown. Both are **gzipped at build time** (`scripts/build-docs.mjs`, wired via `wrangler.toml [build].command`, output git-ignored) and imported as `*.gz` blobs (the `[[rules]] type = "Data"` makes them `ArrayBuffer`). Serving negotiates on `Accept-Encoding` (and sets `Vary: Accept-Encoding`): clients that accept gzip get the blob as-is — `new Response(gz, { encodeBody: "manual", headers: { "content-encoding": "gzip" } })`, where `encodeBody: "manual"` is required else the runtime recompresses the already-gzipped bytes; clients that don't get the blob decompressed server-side via `DecompressionStream` and served identity. Keep doc content in `docs/*` (the "no embedded docs in source files" rule); never inline it in a `.ts`. Install URL: `https://github.com/apps/pr-minder/installations/new`. Webhooks are POST, so they never collide with the GET docs routes. `verifyWebhook` lives in `webhook.ts` so the test suite doesn't pull `worker.ts`'s binary imports through vite.

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
- `mode: "auto_merge"` — bidirectionally syncs this label with GitHub's native auto-merge. Adding the label enables auto-merge; removing it disables auto-merge. `auto_merge_enabled`/`auto_merge_disabled` webhook events add/remove the label. **Whenever GitHub refuses to *arm* native auto-merge** (`enablePullRequestAutoMerge` returns HTTP 200 + an `errors[]` array), `enableAutoMerge` falls back to merging the PR directly via `mergePullRequest` (REST `PUT .../merge`) with `auto_merge_method`. The two cases that hit this: the PR is **already mergeable** (`"clean status"` — nothing pending for auto-merge to wait on) and the repo has **not enabled "Allow auto-merge"** in its settings (`"Auto merge is not allowed for this repository"` — pr-minder has no `administration` permission, so it can't toggle that setting itself). The fallback is unconditional on logical-error responses precisely so the label means "merge this" even in repos without native auto-merge enabled; `mergePullRequest` is the final authority, so branch protection still gates the merge and a not-yet-mergeable PR comes back as a swallowed 4xx (never merged). When native auto-merge *can* be armed, the success path returns first, so pr-minder never pre-empts GitHub's wait-for-checks behavior. (Limitation: in a repo without native auto-merge, a labeled PR with pending required checks won't be merged later automatically — pr-minder isn't subscribed to check/status completion events — so enable "Allow auto-merge" on the repo if you want the wait-for-checks behavior.)
- `auto_merge_method` — `"merge"`, `"squash"` (default), or `"rebase"`. Only used when `mode` is `"auto_merge"`.

`auto_trigger_workflows`: boolean (default false). Revives "zombie" PRs — author `github-actions[bot]` (created with the default `GITHUB_TOKEN`, whose events GitHub won't let trigger workflows) and no workflow runs for their head commit — by closing+reopening with the App token (`retriggerWorkflows` in `github.ts`), which fires a fresh event that DOES run their CI. Gated on `auto_trigger_workflows` + bot-author throughout.

One core check, `reviveIfZombie(env, repo, pr, …)`, is shared by every trigger: bot-author-gated, it spends a `hasWorkflowRuns` call (`GET /actions/runs?head_sha=…`) and close+reopens if there are none. It is **check-once via Workers KV** (`state.ts`): keyed `pr:{repo}#{num}` → the head SHA last evaluated; if the current SHA matches it's skipped, else it's evaluated and the SHA recorded. A new commit changes the SHA, so a *touched* PR is re-checked while an untouched one never is. (A bot-authored PR has zero runs until revived — which is why zero-runs is the right signal even on a freshly `opened`/`synchronize`d PR, where runs haven't registered; non-bot PRs return immediately, so the old "fresh PR has momentary zero runs" ambiguity is moot.)

Triggers (no cron, no polling):
- Live `pull_request` **opened / reopened / synchronize** → `reviveIfZombie` on that PR (`synchronize` included so new commits get re-checked). Skips reopens we sent ourselves (`sender.type === 'Bot'`) so close+reopen can't loop; if it reopened, `onPR` returns and the fresh event drives the rest.
- **First webhook from a repo** → `maybeBackfillRepo` (run from the opportunistic per-event block in `handle()`): the event-driven "check at least once" for repos installed before the feature existed (GitHub never re-sends their install event). On a repo's first event of any kind it sweeps the repo's open PRs once and sets a `backfill:{repo}` KV flag; every later event is then a single KV read.
- `installation`/`installation_repositories` → the same `maybeRetriggerZombiesForRepo` sweep for the install's repos, then sets the backfill flag.

`maybeRetriggerZombiesForRepo` pre-filters open PRs to bot-authored ones (free, from `listOpenPulls`) before `reviveIfZombie` spends a KV read / API call, so re-sweeping an already-checked repo is nearly free; each PR is wrapped in try/catch. Cost is ~1 API call per *bot-authored* open PR not yet seen at its current SHA (App tokens get 5,000–12,500 req/hr).

Loop safety: our own close+reopen returns as a `reopened` event whose `sender.type` is `Bot` and is skipped — the reliable synchronous guard (KV is eventually consistent, so the loop guard does **not** rely on it). `hasWorkflowRuns` fails safe to `true` on a query error, so transient failures never cause a spurious reopen. If the KV binding is ever absent, `reviveIfZombie` degrades to "always check, never record" (still correct, just not deduped) and `maybeBackfillRepo` no-ops.

`auto_open_pr`: `{ enabled, skip_branches[], target_base }` (default disabled). Root-cause fix for zombies: pr-minder itself opens PRs for forgotten branches, using its **App token** so they trigger CI natively (never zombies — complementary to the `auto_trigger_workflows` band-aid). A branch qualifies when it's ahead of base and has no open PR (`compareCommits` + `hasOpenPrForBranch` + `createPull` in `github.ts`; `shouldSkipBranch` always excludes the default branch + gh-pages). Two triggers: `onPushToBranch` (push to a non-default branch) and a sweep (`maybeOpenPrsForRepo`) on `installation`/`installation_repositories` for pre-existing branches. `target_base` defaults to the repo default branch. This replaces the "open PRs for branches missing one" reusable workflow in `wow-look-at-my/actions` (`pr-management.yml`), whose flaw was creating PRs with `github.token`.

There is no top-level `enabled`; "disable" means omitting the relevant label/mode, leaving `triggers` empty, or setting `auto_trigger_workflows: false`.

## Key invariants

- `update-branch` returns 422 when already up to date — this is not an error (handled in `github.ts`)
- Auto-merge (`enableAutoMerge`/`disableAutoMerge`) is **GraphQL-only** — there is no REST endpoint (`PUT/DELETE /repos/{repo}/pulls/{num}/automerge` returns 404). The mutations take the PR's `node_id` (from the webhook payload), not its number, and need contents:write + pull_requests:write. GraphQL logical failures arrive as HTTP 200 + an `errors[]` array (swallowed); only non-2xx transport failures throw.
- `pull_request_review` webhook sends `review.state` lowercase; the reviews REST API returns uppercase `APPROVED` — both cases are handled
- PRs created via a workflow's default `GITHUB_TOKEN` never trigger their own workflows (GitHub's recursion guard); the author is `github-actions[bot]`. `auto_trigger_workflows` fixes this by close+reopen using the App's installation token (a different credential), which GitHub *does* let trigger workflows. Close+reopen is two `PATCH /repos/{repo}/pulls/{num}` calls (`state: closed` then `state: open`); `closed` is intentionally not a handled action. The retrigger runs on `opened`/`reopened`/`synchronize` (via `reviveIfZombie`) plus the first-webhook backfill and the install sweeps; it's deduped per-PR-per-commit by KV (`state.ts`), and the loop guard is the `Bot` sender skip on `reopened` (our own reopen comes back bot-sent), not the event gate and not the (eventually-consistent) KV state
- GitHub App must subscribe to `pull_request`, `pull_request_review`, and `push` events; `installation` and `installation_repositories` are auto-delivered
- `push` handling: default-branch pushes → `onPushToDefault` (update qualifying PRs); non-default branch pushes → `onPushToBranch` (`auto_open_pr`). (The zombie backfill for an already-installed repo rides the opportunistic per-event block in `handle()`, not `onPushToDefault` specifically, so *any* first webhook — push or otherwise — triggers it.) Both gated on `ref` being `refs/heads/*` and `!p.deleted`, so tag pushes and branch deletions are ignored. A PR pr-minder opens is authored by the App's own bot, so it triggers CI natively and the `auto_trigger_workflows` zombie check (which keys on `github-actions[bot]`) correctly ignores it — no interaction between the two features
- JWT validity window is `iat - 60s` to `exp + 540s` (GitHub allows up to 10 min; we use 9)
