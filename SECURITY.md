# Security policy

Memo Bridge is a local proof of concept. It is not designed for exposure to the public internet.
- No merges, no deployment, no admin operations. Since v0.4 the runner writes files, commits and pushes through its tools, only inside its own worktrees and under a live task claim, and runs the repository's own test/build/lint scripts as jobs inside a macOS sandbox (see below: a job is code a model can write, and the sandbox is what bounds it).
- Project metadata is read only from the local canonical register; project IDs and resolved paths are validated.
- The local stdio plugin assumes a trusted OS user. These tools must not be exposed remotely until strong user authentication, per-tool authorization and audit logs are implemented.
- No credentials in the repository, logs, test fixtures, or plugin archive.
- VPS access uses the operator's existing SSH alias and host-key trust; do not distribute SSH keys.
- Report vulnerabilities privately to the maintainers before publishing exploit details.
- Future remote deployment requires OAuth 2.1, explicit per-host authorization, audit logs, TLS, and rate limiting.

## Coordinator writes (v0.3)

Up to v0.3, the Coordinator (`docs/COORDINATOR.md`) was the only component that wrote. The owner approved this on 2026-10-13. It writes in exactly two places:

- **Its private SQLite store.** A 0700 directory and a 0600 file. Opening is refused for relative paths, Git repositories (bare ones included), iCloud (`Mobile Documents`), `~/Library/CloudStorage`, and any existing directory readable by others. A folder that a third-party tool syncs silently cannot be detected, so do not point `MEMO_BRIDGE_STATE_DIR` there.
- **Lease refs in `memolabs-dev/.github`** (`refs/heads/star-lease-v1/*`). They are written only by running the canonical `scripts/issue_lease.py`, with fixed arguments and no shell, under the operator's `gh` login.
  - The ledger stores no Issue titles or bodies, only a digest.
  - It never closes Issues and never deploys.

Further rules:
- **Identity.** The principal is derived by the server (`local:<OS user>` over stdio), and the ledger worker is derived from the workspace. Neither ever comes from tool arguments. Every operation requires a capability. Authorization runs before validation, so every refusal is journaled.
- **Checkpoints.** They use fixed, read-only `git` invocations: no fetch, no push.
- **Audit journal.** It holds identifiers, operation names and result codes, never tool payloads or secrets.
- **No remote exposure.** These tools are not on the hub. Exposing them requires the OIDC validation of `bridge/oidc.mjs`, a capability mapping per scope, and isolation of the root CI runners on the VPS.

## Runner writes and execution (v0.4)

Phase 3 adds a Mac runner (`docs/RUNNER.md`). It runs over the local stdio transport only and is not on the hub. It brings three new capabilities, separate from `coordinator:*` so a future remote principal can be granted reading without them:

| Capability | Allows | Tools |
|---|---|---|
| `repo:write` | Create a worktree of a registered repository on a new branch; write files inside it; commit under the owner's own Git identity; push that branch to origin; remove a clean, pushed worktree. | `worktree_create`, `worktree_write_file`, `worktree_commit`, `worktree_push`, `worktree_remove` |
| `runner:execute` | Run the `test`, `build` or `lint` recipe the repository itself declares, in one of its worktrees; cancel such a job. | `jobs_submit`, `job_cancel` |
| `github:write` | Open a pull request from a pushed worktree branch. | `github_create_pr` |

The local owner principal (`local:<OS user>`) holds all of them. Reads of worktrees, files, jobs, hosts, GitHub and the journal need `coordinator:read`.

What the file and Git tools never do (these guarantees hold for the tools themselves; jobs are covered below):
- **No shell.** Every process Memo Bridge starts is started with `execFile`/`spawn` and a fixed argument array. The model chooses a recipe name, never a command; the command comes from the repository's manifests (`server/runners/recipes.mjs`).
- **No merge, no deployment, no service change.** Pull requests are opened, never merged and never set to auto-merge; the landing contract of `memolabs-dev/.github` lands them.
- **No write to a default branch, no force-push.** `main`, `master`, the local `origin/HEAD` and the remote's own default branch (read with `git ls-remote --symref` before creating and before pushing) are refused, all compared without case: on APFS `refs/heads/Main` is the file `refs/heads/main`. A new branch may not match any local or remote branch without case either. A push uses an explicit refspec without `+`, and only creates the remote branch or moves it from a commit this worktree pushed itself (`push_rejected` otherwise).
- **No file access outside the worktrees.** Paths are relative, normalized and checked after `realpath`; `..`, absolute paths, `.git` and symlink escapes are refused, and reads never block on a FIFO. Before any Git command, the worktree's `.git` link must still point at the project's repository (`worktree_link_changed`). Filesystem paths are never returned to models.

Controls:
- **Claim gate.** Every repository write, job and pull request needs a live claim on the worktree's Issue in the local mirror. Commit, push, pull request creation and job submission also re-verify worker, claim and fence with the shared ledger immediately before acting, and refuse on any failure. Jobs are tied to the claim: `task_release`, `task_complete` and `workspace_close` cancel them, and the runner stops a job by itself within seconds once its claim expired or its workspace or worktree is gone. `worktree_remove` is refused while a job runs in the worktree.
- **Git hooks are disabled** on every Git call (`core.hooksPath=/dev/null`, `core.fsmonitor=false`). A hook path can point at a folder the model writes to, so running hooks would be arbitrary execution. The owner's own hooks are skipped too; CI is the gate.
- **Commit messages** with control or bidi characters, or with any AI attribution (a trailer such as `Co-authored-by`/`Assisted-by` naming an assistant, or prose such as "Written by Claude", "Made with Claude Code", "AI-generated"), are refused.
- **Removal keeps data.** `worktree_remove` is refused with uncommitted, untracked or unpushed work, and lists ignored files (`.env`, `node_modules`, build output) instead of deleting them unless the caller passes `discard_ignored: true`.
- **Bounds.** File reads 256 KiB per call, writes 512 KiB, diffs 200 KiB, job logs 5 MiB, job results 64 KiB, at most `MEMO_BRIDGE_MAX_JOBS` (default 2) jobs per host, job timeout at most 60 minutes. Text returned to models has control and bidi characters stripped or replaced.
- **Audit.** Every write and job submission journals its outcome (ok, denied, error) with workspace and Issue ids; every refusal is journaled.

### Jobs: the sandbox

A recipe runs the repository's own scripts, and a model can write those scripts with `worktree_write_file`. Combined, `runner:execute` and `repo:write` mean running code a model wrote. On macOS every job therefore runs inside a Seatbelt profile (`/usr/bin/sandbox-exec`, `server/runners/sandbox.mjs`):

- **Writes** only to the worktree (never its `.git` link) and to a private per-job folder that is its `HOME` and `TMPDIR` and is deleted afterwards. The repository's `.git`, other worktrees, the state directory and everything else are read-only or unreadable.
- **No reading** of the contents of the private state directory (store, journal, job logs), other worktrees and the other repositories next to the project, `~/.agent`, `~/Vault` (and its iCloud target), iCloud and cloud storage, `~/Documents`, `~/Desktop`, `~/Downloads`, and credential stores: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.docker`, `~/.kube`, `~/.netrc`, `~/.git-credentials`, `~/.gitconfig`, `~/.npmrc`, `~/.claude`, `~/.codex`, `~/Library/Keychains`, `~/Library/Application Support` and other app data. File metadata stays readable, because toolchains resolve paths through those folders.
- **Network**: loopback only (tests may start local servers); no remote address, no DNS.
- **Nothing started outside the sandbox**: no launchd jobs, no Launch Services (`open`), no Apple Events; no keychain service and no pasteboard.
- **Environment**: an allow-list (`PATH`, locale, terminal, user, toolchain locations). Every other variable is dropped, including secrets whose names do not look secret, such as `DATABASE_URL`. Git runs without the owner's global and system configuration, so no credential helper and no identity.
- **Lifetime**: the runner follows every process the job starts, including ones that leave its process group, and stops them on cancel, timeout, claim loss and when the job ends. It handles `SIGTERM` by stopping the job first. A job past its timeout plus 35 seconds is killed by the next read even if the runner died. Signals sent from outside the runner check the group leader's start time, so a reused process group id is never signalled.

There is no sandbox on Linux yet: jobs are refused there (`sandbox_unavailable`). **`MEMO_BRIDGE_JOB_SANDBOX=off`** runs jobs without the sandbox, on any platform. That is the owner's explicit choice, and a job is then **owner-equivalent**: it can do anything the owner's OS user can do, including pushing with the owner's credentials. Grant `runner:execute` with that switch only to principals you would let run code as yourself.

Residual risks, with the sandbox on:
- Process tracking polls `ps` every 250 ms. A process that leaves the job's group and whose parent exits between two polls can survive the job. It stays inside the sandbox (no network, no writes outside the worktree, no private data), but it no longer counts against `MEMO_BRIDGE_MAX_JOBS`.
- A job can read what the sandbox does not list: system files, toolchains, and the owner's other files under the home folder that are not in the list above. It can only show them to the model through its own log, which goes back to the session that submitted it.
- A job can modify anything inside its worktree, including files a later commit picks up; `worktree_status` reports edits Memo Bridge did not make (`external_edits`).
- Seatbelt (`sandbox-exec`) is deprecated by Apple, though present and working on macOS 27.
- File writes check the claim in the local mirror only (the mirror expires with the lease); commit, push, pull request creation and job submission ask the ledger.

Before any remote exposure, jobs need stronger isolation (a dedicated user or a VM), and the root CI runners on the VPS must be isolated first.
