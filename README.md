# pr-minder

A Cloudflare Worker GitHub App that keeps pull requests up to date with their base branch automatically. Reacts to webhooks in ~1s, works across every repo in the org without per-repo setup.

**Install:** https://github.com/apps/pr-minder/installations/new

The deployed Worker also serves its own public docs: a human-readable page at `/` (which fetches and renders `/llms.txt`) and the LLM-friendly `/llms.txt` itself. Both are gzipped at build time and served pre-compressed.

## How it works

1. A GitHub App webhook fires on `pull_request`, `pull_request_review`, `push`, `installation`, or `installation_repositories` events
2. The worker verifies the signature, mints an installation token, and calls GitHub's [update-branch API](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch) — skipping the merge when the branch already contains the base's changes, so it avoids leaving empty "Merge branch ..." commits on PRs that are already up to date in content
3. On `installation.created` or `installation.new_permissions_accepted`, sweeps all repos to create any configured labels
4. Primarily event-driven (reacts to webhooks in ~1s). A small every-5-min cron runs only three cheap, bounded KV-reminder drains (deferred zombie re-checks, the `merge_conflict` label, and the `auto_describe_pr` backfill). The slow, **fleet-wide** reconciliation — the cross-installation auto-merge backstop, the `auto_open_pr` catch-up that re-opens PRs for orphaned branches, close-empty, and the comprehensive `merge_conflict`/describe sweeps — runs in a separate scheduled [`pr-minder-reconcile`](https://github.com/wow-look-at-my/webhooks) hook on [webhook-runner](https://github.com/wow-look-at-my/webhook-runner) (a container with no Cloudflare subrequest cap), authenticating as the same GitHub App

A PR is updated when **any** configured trigger is satisfied:

| Trigger key | Description |
|-------------|-------------|
| `label` | PR has the specified label |
| `approved_by` | PR approved by any user in the list |
| `min_approvals` | PR has at least N approvals from any users |

Keys within one trigger object are **ANDed**; multiple objects in the `triggers` array are **ORed**.

## GitHub App setup

Create a GitHub App with:

**Permissions:**
- Contents: Read & write
- Issues: Read & write (for label creation)
- Pull requests: Read & write
- Metadata: Read (required)

**Subscribe to events:** `pull_request`, `pull_request_review`, `push`

`installation` and `installation_repositories` events are delivered automatically to all GitHub Apps.

**Installation:** All repositories (or selected repos as needed)

Set the webhook URL to your deployed worker URL after deploying.

## Deploy

```sh
npm install

# Set secrets
wrangler secret put WEBHOOK_SECRET
wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste the full PKCS8 PEM
wrangler secret put DESCRIBE_HOOK_API_KEY   # only needed for auto_describe_pr (the pr-describe webhook's api_key)

# Update wrangler.toml with your real app ID
# Edit GITHUB_APP_ID under [vars]
```

Deploys are automatic via Cloudflare's Git integration: every PR branch gets a preview Worker, and merging to `master` deploys production. Don't run `wrangler deploy` by hand.

## Configuration

Per-repo config at `.github/config/pr-minder/pr-minder.jsonc` overrides the org-level config at the same path (`.github/config/pr-minder/pr-minder.jsonc`) in the org's `.github` repo. **If no config file is found, all behavior is disabled** — pr-minder is opt-in.

Config files are **JSONC** — `//` and `/* */` comments are supported.

Top-level sections:

- `auto_update_pr.triggers` — array of condition objects. Keys within one object are ANDed; multiple objects are ORed.
- `auto_label_pr` — map of label name to per-label settings.
- `auto_trigger_workflows` — boolean. Re-trigger CI for PRs opened by `github-actions[bot]` (see [Re-triggering CI for bot-created PRs](#re-triggering-ci-for-bot-created-prs)). Defaults to `false`.
- `auto_open_pr` — object. Open PRs for forgotten branches, born with CI already running (see [Auto-opening PRs for forgotten branches](#auto-opening-prs-for-forgotten-branches)). Defaults to disabled.
- `auto_describe_pr` — object. Generate the PR title/description from the PR's full diff with an AI model (see [AI-generated titles and descriptions](#ai-generated-titles-and-descriptions)). Defaults to disabled.

**Per-repo** (`.github/config/pr-minder/pr-minder.jsonc`):
```jsonc
{
  "$schema": "https://raw.githubusercontent.com/wow-look-at-my/pr-minder/master/schema/pr-minder.schema.json",
  "auto_update_pr": {
    "triggers": [
      // fire if labeled "automerge"
      { "label": "automerge" },
      // OR if alice/bob approved AND there are at least 2 approvals
      { "approved_by": ["alice", "bob"], "min_approvals": 2 }
    ]
  },
  "auto_label_pr": {
    "automerge": {
      // Currently only "on_pr_creation" or false/unset.
      "auto_add": "on_pr_creation",
      "create_label_if_missing_in_repo": true,
      "color": "00ff00"
    }
  }
}
```

**Org-level** (in the `{org}/.github` repo, at `.github/config/pr-minder/pr-minder.jsonc`) with per-repo overrides:
```jsonc
{
  "$schema": "https://raw.githubusercontent.com/wow-look-at-my/pr-minder/master/schema/pr-minder.schema.json",
  "auto_update_pr": {
    "triggers": [{ "label": "automerge" }]
  },
  "repos": {
    "special-repo": {
      "auto_update_pr": {
        "triggers": [{ "label": "ready-to-merge" }]
      }
    },
    "opt-out-repo": {
      // Override with empty triggers to disable updates for this repo.
      "auto_update_pr": { "triggers": [] }
    }
  }
}
```

In overrides, `auto_update_pr` replaces the parent's `auto_update_pr` entirely. `auto_label_pr` is merged per-label.

The JSON Schema at [`schema/pr-minder.schema.json`](schema/pr-minder.schema.json) provides IDE validation and autocomplete when referenced via `$schema`.

## Merging PRs

By default this worker only keeps branches **fresh** (`auto_update_pr` and `mode: "auto_update"`) and does not merge. To have it merge, give a label `mode: "auto_merge"` in `auto_label_pr`: adding that label arms [GitHub's native auto-merge](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request) so the PR merges once CI and required reviews pass. Whenever GitHub won't arm native auto-merge, the worker merges the PR directly instead, using the label's `auto_merge_method` (`squash` by default). This happens when the PR is **already mergeable** (GitHub reports "clean status" — nothing left to wait on) **and also when the repository hasn't enabled "Allow auto-merge"** in its settings, so the label still merges your PRs even if you never toggled that setting. Branch protection still gates every merge (an unmergeable PR is simply left alone).

Day to day, this is driven by the `labeled` webhook — adding the label acts immediately. As a safety net, the worker also re-scans every installed repo's open PRs **once on startup** (i.e. after each redeploy) and **when it's installed / repos are added**, arming auto-merge on any labeled PR that isn't armed yet. So if a PR was labeled while an older/buggy version was running and never got picked up, a redeploy heals it — without polling the API on every event.

> **Tip:** In a repo where you have *not* enabled "Allow auto-merge", labeling a PR whose required checks are still running won't merge it later on its own — the worker doesn't listen for check-completion events. Enable "Allow auto-merge" in **Settings → Pull Requests** for that wait-for-checks behavior; the worker uses native auto-merge whenever the repo allows it.

## Flagging merge conflicts

Give a label `mode: "merge_conflict"` in `auto_label_pr` and pr-minder keeps that label in sync with the PR's mergeability: it **adds the label when the PR has a merge conflict** with its base, and **removes it once the conflict is resolved**. The label is fully managed by pr-minder — don't add or remove it by hand.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/wow-look-at-my/pr-minder/master/schema/pr-minder.schema.json",
  "auto_label_pr": {
    "merge-conflict": {
      "mode": "merge_conflict",
      "create_label_if_missing_in_repo": true,
      "color": "d73a4a"
    }
  }
}
```

A PR can become conflicted two ways, and both are covered:

- **Its own head changes** (`opened` / `reopened` / `synchronize`) — re-checked immediately on the event.
- **Its base advances** (someone merges another PR to the default branch) — every open PR is flagged for a re-check, since any of them may now conflict.

GitHub computes mergeability **asynchronously** and sends no webhook with the result, so a fresh push usually reports "unknown" for a moment. pr-minder handles this by flagging the PR and settling the label from a small periodic sweep once GitHub has the answer (typically within a few minutes) — so the label may lag a base change slightly, but it always converges. On install (and the first time it sees an already-installed repo) it flags the existing open PRs too, so they get labeled without waiting for an event.

Notes:
- **Opt-in**, off by default — there is no `merge_conflict` label unless you configure one.
- Set `create_label_if_missing_in_repo: true` (with a `color`) to have pr-minder create the label in the repo; otherwise create it yourself.
- Mergeability reflects **conflicts only**, not failing checks or missing reviews — so the label means "this needs a rebase/merge", nothing else. Draft PRs are not labeled.

## Re-triggering CI for bot-created PRs

When a GitHub Actions workflow opens a pull request using the default `GITHUB_TOKEN`, GitHub [deliberately suppresses the PR's own workflows](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow#triggering-a-workflow-from-a-workflow) — "events triggered by the `GITHUB_TOKEN` will not create a new workflow run" — to prevent recursive runs. The result is a **"zombie" PR**: it's open, but none of its required `pull_request` checks ever ran, so it can never go green or merge.

GitHub's documented fix is to act with a credential other than `GITHUB_TOKEN`. pr-minder already authenticates as a GitHub App, so when `auto_trigger_workflows` is enabled it **closes and immediately reopens** the zombie. The reopen fires a fresh `pull_request.reopened` event (a default activity type) attributed to the App rather than `GITHUB_TOKEN`, which runs the PR's workflows for real.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/wow-look-at-my/pr-minder/master/schema/pr-minder.schema.json",
  // Revive zombie PRs that have no CI runs so their workflows actually run.
  "auto_trigger_workflows": true
}
```

It listens on both the `opened` and `reopened` webhooks, but the test for "is this a zombie?" differs by event, because of a timing subtlety:

- **On `opened`** it keys on the **author** being `github-actions[bot]`. A brand-new PR always has zero runs for an instant (runs register asynchronously), so "no runs yet" can't tell a zombie from a healthy PR — but the author can: `github-actions[bot]` is exactly the set of PRs created with `GITHUB_TOKEN`, whose workflows are suppressed. PRs created via a PAT or another App token carry that account's identity and trigger CI normally, so they're left untouched (as are Dependabot PRs).
- **On `reopened`** it keys on the PR actually having **zero workflow runs** for its head commit (`GET /actions/runs?head_sha=…`), regardless of author. A reopened PR isn't fresh, so an empty run list is trustworthy. This also catches zombies that predate the App's installation.

Notes:
- **Opt-in**, off by default.
- **No loop.** The close+reopen we perform comes back as a `reopened` event whose `sender` is the App's own bot; reopens from any bot sender are skipped, so it can't cycle. If a query for existing runs fails, pr-minder assumes runs exist and does nothing — a transient error never causes a spurious reopen.
- No extra permissions are needed — close/reopen uses the same `pull_requests: write` the App already requires.

## Auto-opening PRs for forgotten branches

The cleanest way to avoid zombie PRs is to never create one. A common source is a CI job that opens PRs for branches using the workflow's default `GITHUB_TOKEN` — every such PR is born a zombie. `auto_open_pr` moves that job into pr-minder, which opens the PR with its **App credentials** instead, so the PR triggers its workflows normally from the start. No close/reopen required.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/wow-look-at-my/pr-minder/master/schema/pr-minder.schema.json",
  "auto_open_pr": {
    "enabled": true,
    // Optional: branches to never open PRs for (the default branch and gh-pages are always skipped).
    "skip_branches": ["staging"],
    // Optional: base branch for opened PRs (defaults to the repo's default branch).
    "target_base": "",
    // Optional: also delete the head branch when an empty PR is closed (default off).
    "delete_branch_when_empty": false
  }
}
```

When a branch is ahead of its base and has no open PR, pr-minder opens one (`head` = the branch, `base` = `target_base` or the default branch — or, with `base_branch_patterns` configured, the eligible branch it was forked from — title = the branch name). It runs on two triggers:

- **On a push to a non-default branch** — opens the PR the moment the branch gets a commit, going forward.
- **On install / repos-added** — sweeps existing branches once, so branches that predate the App also get PRs.

Notes:
- **Opt-in**, off by default. The default branch and `gh-pages` are always skipped; add more via `skip_branches`.
- **The base is the default branch by default.** With no `base_branch_patterns` configured, every PR opens into `target_base` (the repo's default branch unless set) — a branch forked off another working branch is *not* opened into that working branch, and no fork-point lookups are made. **Non-default bases are an explicit opt-in via `base_branch_patterns`**: with patterns set, fork-point detection (`base_from_fork_point`, on by default) opens each branch back into the eligible branch it was forked from — only the default branch or a pattern-matching branch can be chosen (the nearest fork point wins; a tie at the same commit prefers the default branch), falling back to `target_base` when no qualifying fork point is found. It still finds the parent **even if that branch has moved on since you forked** — gained commits after the fork, so the fork commit is no longer its tip — by checking the parent's recent history, not just its tip. This suits a version-branch layout (keep the patterns focused on the long-lived branches in a very large repo). Set `"base_from_fork_point": false` to always open into `target_base` even with patterns configured.
- The PR is opened by the App, so its author is the App's bot (not `github-actions[bot]`) and `auto_trigger_workflows` correctly leaves it alone — it isn't a zombie.
- Branches with no commits ahead of base, or that already have an open PR, are skipped. A branch ahead only by squash-merged commits (no net diff) is skipped too — opening it would just create an empty PR. Fork branches aren't opened (the head must be in this repo).
- **Empty PRs are cleaned up** (`close_when_empty`, default on). A PR opened with real changes can go content-empty later — its content lands in the base another way (a sibling branch squash-merges the same change) — and that can't be prevented at open time. pr-minder closes such PRs (with a one-line comment) once their net diff against the base is empty. It closes **any** open non-draft PR with a zero net diff, regardless of who opened it — a human's empty PR is closed too (closing is reversible: it can be reopened) — and only on an exact zero-file diff (an unknown count is left alone). Set `"close_when_empty": false` to opt out.
- **Closed branches can be deleted too** (`delete_branch_when_empty`, default **off**). When `close_when_empty` closes a content-empty PR, pr-minder can also delete that PR's head branch, so closed branches don't pile up. The branch is content-identical to its base (zero net diff), so deleting it loses nothing. Only a branch **in this repository** is deleted — a fork PR's head branch (which lives in the fork, and which pr-minder can't write to) is never touched — and GitHub itself refuses to delete the default or a protected branch. No effect unless `close_when_empty` is also on. Set `"delete_branch_when_empty": true` to enable.
- Needs only the `pull_requests: write` / `contents: write` the App already has.

This replaces the "open PRs for branches missing one" job people often run as a GitHub Actions workflow — and fixes its core flaw (PRs opened with `GITHUB_TOKEN` never run their own CI).

## AI-generated titles and descriptions

`auto_describe_pr` keeps a PR's title and description in sync with what the PR actually does. Whenever a PR is opened (or marked ready for review) and on every new commit, the worker fetches the **entire** PR diff (base...head, not just the latest push), sends it to an OpenAI-compatible chat model at temperature 0, and edits the PR:

- The **description is rewritten** every time the diff changes. The existing description is passed to the model, which is instructed to carry forward any information that is still accurate — so human-written notes survive the rewrite.
- The **title is replaced only** when the model classifies the existing one as a missing/autogenerated placeholder (branch-name junk, "update", ticket-only titles, ...). A real, hand-written title is left alone.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/wow-look-at-my/pr-minder/master/schema/pr-minder.schema.json",
  "auto_describe_pr": {
    "enabled": true,
    // Optional: override the default model name for this repo/org.
    "model": ""
  }
}
```

The heavy lifting happens off-worker: real LLM calls outlive a Worker's time limits, so the worker hands the diff to the **pr-describe webhook** (the [webhooks](https://github.com/wow-look-at-my/webhooks) repo, served by [webhook-runner](https://github.com/wow-look-at-my/webhook-runner)) fire-and-forget, and the webhook calls the model and edits the PR. Configure `DESCRIBE_HOOK_URL` in `wrangler.toml` `[vars]` (the full `POST /hook/pr-describe` URL) and the `DESCRIBE_HOOK_API_KEY` secret (the hook's api_key) — without the URL the feature does nothing. The model endpoint and its key are configured on the webhook side.

Notes:
- **Opt-in**, off by default. Draft PRs are skipped until they're marked ready for review.
- The work is deduped on a hash of the diff (Workers KV): a new commit that doesn't change the PR's effective diff — most notably pr-minder's own "update branch" merges — costs no model call. The hash is only recorded once the run has been accepted by the webhook host (which retries transient model failures itself), so a failed hand-off retries on the PR's next event.
- The hand-off runs after the GitHub webhook has been acknowledged, so deliveries stay fast; a failed or unparseable model response is logged on the webhook side and the PR is left untouched.
- If new commits arrive while a describe run is still in flight, the stale run is cancelled before the new one is submitted, so an outdated description can never overwrite a fresh one.
- It cannot loop: editing the title/body fires `pull_request.edited`, which the worker doesn't handle.
- Very large diffs are truncated before being sent to the model; a diff GitHub refuses to render (HTTP 406) skips that PR.

## Local development

```sh
npm run dev        # wrangler dev — typechecks, then bundles (no real webhooks without a tunnel)
npm test           # tsc --noEmit && vitest  (tests can't pass with a type error)
npm run build      # tsc --noEmit && gzip the docs (the command wrangler runs on deploy)
npm run typecheck  # tsc --noEmit (standalone)
```

Typecheck is baked into both the `build` and `test` scripts, and into `wrangler.toml`'s `[build]` step, so it can't be bypassed: esbuild — what vitest and wrangler bundle with — strips types without checking them, so `tsc` is the only gate.
