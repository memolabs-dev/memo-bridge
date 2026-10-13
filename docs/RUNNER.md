# Memo Bridge Mac runner (Phase 3)

The runner lets an AI client do the work of a task on the machine running Memo Bridge: get an isolated checkout, read and edit files in it, run the repository's own tests, commit, push, and open a pull request. It sits on top of the Coordinator (`docs/COORDINATOR.md`): every repository write, job and pull request happens under a live claim on the task.

Version 0.4.0 runs it over the local stdio transport only. Nothing here is exposed on the hub (see "Not yet").

## What runs on the owner's machine

Be precise about this, because it is the main trust decision of Phase 3.

| Action | Runs | As whom |
|---|---|---|
| `worktree_create` | `git fetch --no-tags origin`, `git worktree add --no-track -b <branch> -- <path> <base sha>` in the registered repository | the owner's OS user, the owner's Git credentials |
| file reads and writes | Node file APIs inside the worktree only | the owner's OS user |
| `worktree_commit` | `git add -A`, `git commit` with the owner's own Git identity, nothing added to the message | the owner's OS user |
| `worktree_push` | `git push --porcelain --set-upstream origin refs/heads/<branch>:refs/heads/<branch>` (no `+`) | the owner's Git credentials |
| `jobs_submit` | a detached `node job-runner.mjs <stateDir> <jobId>`, which runs `nice -n 10 <recipe argv>` | **the owner's OS user, with the owner's file access** |
| `github_*` | `gh api` with fixed arguments | the owner's `gh` login |
| `host_capabilities` | `--version` probes of node, npm, python3, git, gh, swift, xcodebuild, docker, cargo, go, make; `gh auth status` | the owner's OS user |

A recipe runs the repository's own scripts (`package.json` scripts, a Makefile target, a test suite). Memo Bridge picks the command, never the model, but whoever can write files in the worktree and submit a job can make those scripts do anything the owner's user can do. **A job is not a sandbox.** That is why `jobs_submit` needs its own capability (`runner:execute`), an active workspace you own, and a live claim.

## Worktrees

- **Location.** `~/projects/_worktrees/<project>/<branch with / replaced by ->`, or under `MEMO_BRIDGE_WORKTREES_ROOT` (absolute). The path never leaves the server: tools return a `worktree_id` (`wt_` plus 16 characters), never a filesystem path.
- **Branch.** Default `agent/<issue number>-<workspace suffix>` (`agent/ws-<suffix>` without an issue). Base default `origin/<default branch>`, after a fetch. Refused: the default branch, `main`, `master`, a branch that exists locally or on origin, an existing path.
- **Project.** Only registered repositories of `PROJECTS.md` (`kind: repo`, available on this host). The workspace must be yours, active, and on this host.
- **Issue.** Pass the claimed issue to `worktree_create`. A worktree created without one is read-only: its writes fail with `no_live_claim`.
- **Status.** `worktree_status` reports branch, HEAD, ahead/behind against the base and against `origin/<branch>`, up to 200 uncommitted changes, the last 5 commits, and `external_edits`: HEAD moved, branch switched, files changed that Memo Bridge never wrote, files changed after Memo Bridge wrote them. The tracking data lives in `<stateDir>/worktrees/<id>.json`.
- **Removal.** `worktree_remove` refuses a worktree with modified or untracked files (`worktree_dirty`) or commits not on origin (`unpushed_commits`). It runs `git worktree remove` without `--force` and keeps the branch. It also works from a closed workspace.

## Files

| Tool | Limit |
|---|---|
| `worktree_list_files({worktree_id, path?, limit?})` | tracked files plus untracked files that are not ignored; default 500, at most 5000 |
| `worktree_read_file({worktree_id, path, offset?, limit?})` | UTF-8 text only, at most 256 KiB per call, `next_offset` to continue; binary files refused; control and bidi characters replaced with U+FFFD and counted |
| `worktree_write_file({worktree_id, path, content})` | at most 512 KiB; needs a live claim and the worktree still on its own branch; parent folders created inside the worktree; written atomically (temporary file, then rename) |
| `worktree_diff({worktree_id, staged?})` | at most 200 KiB, plus a stat and the untracked files; external diff programs and textconv disabled |

Every path is relative and normalized. `..`, absolute paths, anything under `.git` (any case) and symlinks that resolve outside the worktree are refused with `path_not_allowed` or `invalid_input`.

## Jobs

- **Recipes.** `test`, `build`, `lint`. The command is detected from the worktree, first match wins:

  | Recipe | npm | SwiftPM | Python | Cargo | Go | make |
  |---|---|---|---|---|---|---|
  | test | `npm test` | `swift test` | `python3 -m pytest -q` | `cargo test` | `go test ./...` | `make test` |
  | build | `npm run build` | `swift build` | | `cargo build` | `go build ./...` | `make build` |
  | lint | `npm run lint` | | | | | |

  An npm recipe needs a non-empty script of that name. Manifests are read only when they are regular files directly in the worktree (no symlinks, at most 1 MiB). A recipe that is not detected fails with `unknown_recipe`.
- **Submission.** `jobs_submit({workspace_id, worktree_id, recipe, timeout_seconds?})` re-checks the claim and counts active jobs in one transaction, creates `<stateDir>/jobs/<id>.log` (0600 in a 0700 folder), records the job as `queued`, and starts the runner detached. The job keeps running after the client disconnects.
- **Runner.** It re-detects the recipe and refuses a job whose command changed since submission (`recipe_changed`). It runs the command without a shell, in its own process group, at `nice 10`, with an environment that drops secret-looking variables (names containing TOKEN, SECRET, PASSWORD, API_KEY, AUTH, COOKIE, SESSION…, and prefixes GH_, GITHUB_, AWS_, SSH_, MEMO_BRIDGE_ and similar) and adds `CI=1`, `NO_COLOR=1`. This filtering is hygiene, not isolation.
- **Limits.** Timeout default 15 minutes, 1 second to 60 minutes. At most `MEMO_BRIDGE_MAX_JOBS` (default 2) queued or running jobs per host; beyond that `host_busy` (there is no queue yet). The log is capped at 5 MiB, then a truncation marker is written.
- **Statuses.** `queued`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out`, `interrupted`. A job whose processes are all gone without a recorded end is reported `interrupted` on the next read.
- **Reading.** `job_status` (status, exit code, times, last output lines), `job_events({job_id, after_seq?})` (submitted, started, timeout, cancelled, exit, interrupted, rejected, spawn_failed), `job_results({job_id, tail_lines?})` (default 100 lines, at most 400 lines and 64 KiB; ANSI escapes, control and bidi characters removed), `jobs_list`.
- **Cancelling.** `job_cancel` cancels a queued job at once; for a running job it sends SIGTERM to the job's process group, then SIGKILL after 5 seconds.
- **Packaging.** The runner is a second bundle, `plugin/server/dist/job-runner.mjs`, which the server starts from its own directory. `npm run build` emits it and `npm run install:local` installs it next to `index.mjs`. Without it, every job ends `interrupted`.

## Commit, push, pull request

1. `worktree_commit({worktree_id, message})`: the ledger verifies worker, claim and fence first. Then `git add -A` and a commit under the owner's own identity. Refused: an empty commit, control or bidi characters in the message, AI attribution trailers. Returns the commit SHA.
2. `worktree_push({worktree_id})`: the ledger verifies the claim first; protected branches are refused. A non-fast-forward comes back as `push_rejected`, never forced. Then a checkpoint is recorded under the claim (`task_checkpoint`), and its `durability` is returned (`remote` means another machine can resume). If the push succeeded but the checkpoint did not, the result is still `ok: true` with a `warning`: record it again with `task_checkpoint`.
3. `github_create_pr({workspace_id, worktree_id, title, body?, draft?})`: the workspace and worktree must be yours and active, on this host, with a live claim on the worktree's Issue; the repository must be the GitHub origin of the worktree's project; the branch must not be the default branch and must exist on origin. An open pull request for the branch is returned as is. The ledger verifies the claim just before the POST. `Closes #n` is appended when the Issue is in the same repository and the body has no closing keyword. A lost or conflicting response is recovered by looking up the open pull request for the branch (`recovered: true`). It never merges and never enables auto-merge: the landing contract of `memolabs-dev/.github` lands pull requests when CI is green.

## GitHub reads

`github_issues`, `github_pull_requests`, `github_workflows`, `github_checks` read only repositories that are the GitHub origin of a registered project, plus `memolabs-dev/.github`; anything else is `repo_not_registered`. Reads use `gh api -X GET`, first page only, at most 100 items, responses capped at 4 MB. Text from GitHub is cleaned of control and bidi characters and bounded.

## Hosts

- `host_capabilities({host})`: for this machine, OS, architecture, toolchain versions, whether `gh` is logged in, and which recipe kinds it is equipped for (cached 5 minutes). For the other machine, only its declared roles and `host_status` reachability; nothing new is probed. Every section says whether it is observed or declared. The VPS is declared unable to build Xcode projects.
- `host_resources({host})`: load, CPU count, memory, free disk for the state directory and the projects volume, and running/queued job counts against the enforced limit. VPS answers carry the production-first note.

## Safety rules, in one place

- Authorization first in every handler, then validation; every refusal is journaled as `denied`. Writes journal every outcome.
- The principal comes from the server (`local:<OS user>` over stdio), never from tool arguments.
- Repository writes, jobs and pull requests need a live claim (local mirror: state `claimed`, not expired). Commit, push and pull request creation also re-verify it with the ledger immediately before acting. After `task_complete` or `task_release`, writes fail with `no_live_claim`.
- No shell anywhere: `execFile`/`spawn` with fixed argument arrays. Read-only Git runs with `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`.
- Git hooks are disabled on every Git call (`core.hooksPath=/dev/null`, `core.fsmonitor=false`), because a hook path can point at a folder the model writes to. The owner's own pre-commit and pre-push hooks are skipped too; CI remains the gate.
- Never the default branch, never `main` or `master`, never a force-push, never a merge, never a deployment.
- Every output is bounded, and text returned to models has control and bidi characters stripped or replaced.

## Error codes

Beyond the Coordinator's codes: `invalid_input`, `invalid_configuration`, `unknown_worktree`, `worktree_removed`, `wrong_host`, `no_live_claim`, `project_not_a_repo`, `branch_exists`, `path_exists`, `protected_branch`, `branch_changed`, `path_not_allowed`, `not_found`, `binary_file` (oversized content is `invalid_input`), `nothing_to_commit`, `push_rejected`, `push_failed`, `worktree_dirty`, `unpushed_commits`, `git_failed`; jobs: `unknown_recipe`, `host_busy`, `runner_unavailable`, `worktree_unavailable`, `job_finished`, `store_unavailable`; GitHub: `repo_not_registered`, `claim_required`, `default_branch_refused`, `branch_not_pushed`, `github_unavailable`.

## Not yet

- No exposure on the hub: write tools stay local until the root CI runners on the VPS are isolated (Vault `1-Projects/memo-labs-os.md`).
- No VPS runner and no job queue (`host_busy` instead).
- Old job logs and stale `git worktree` entries are not cleaned up automatically.
