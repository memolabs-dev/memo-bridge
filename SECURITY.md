# Security policy

Memo Bridge is a local proof of concept. It is not designed for exposure to the public internet.
- No arbitrary command execution, no merges, no deployment, no admin operations. Since v0.4 the runner writes files, commits and pushes, but only inside its own worktrees and under a live task claim (see below).
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

What still never happens:
- **No arbitrary shell.** Every process is started with `execFile`/`spawn` and a fixed argument array. The model chooses a recipe name, never a command; the command comes from the repository's manifests (`server/runners/recipes.mjs`).
- **No merge, no deployment, no service change.** Pull requests are opened, never merged and never set to auto-merge; the landing contract of `memolabs-dev/.github` lands them.
- **No write to a default branch, no force-push.** `main`, `master` and the repository's default branch are refused; pushes use an explicit refspec without `+`, so a non-fast-forward is rejected.
- **No file access outside the worktrees.** Paths are relative, normalized and checked after `realpath`; `..`, absolute paths, `.git` and symlink escapes are refused. Filesystem paths are never returned to models.

Controls:
- **Claim gate.** Every repository write, job and pull request needs a live claim on the worktree's Issue in the local mirror. Commit, push and pull request creation also re-verify worker, claim and fence with the shared ledger immediately before acting, and refuse on any failure.
- **Git hooks are disabled** on every Git call (`core.hooksPath=/dev/null`, `core.fsmonitor=false`). A hook path can point at a folder the model writes to, so running hooks would be arbitrary execution. The owner's own hooks are skipped too; CI is the gate.
- **Commit messages** with control or bidi characters, or with AI attribution trailers, are refused.
- **Job environment.** Variables whose names look like secrets (TOKEN, SECRET, PASSWORD, API_KEY, AUTH, COOKIE, SESSION…, prefixes GH_, GITHUB_, AWS_, SSH_, MEMO_BRIDGE_ and similar) are removed before a recipe starts.
- **Bounds.** File reads 256 KiB per call, writes 512 KiB, diffs 200 KiB, job logs 5 MiB, job results 64 KiB, at most `MEMO_BRIDGE_MAX_JOBS` (default 2) jobs per host, job timeout at most 60 minutes. Text returned to models has control and bidi characters stripped or replaced.
- **Audit.** Every write and job submission journals its outcome (ok, denied, error) with workspace and Issue ids; every refusal is journaled.

**A job is not a sandbox.** A recipe runs the repository's own scripts as the owner's OS user, with the owner's file access and network. Combined with `worktree_write_file`, `runner:execute` amounts to running code the model wrote on the owner's machine. The environment filtering is hygiene, not isolation. Grant `runner:execute` only to principals you would let run code as yourself. Before any remote exposure, jobs need a real sandbox (a dedicated user or container), and the root CI runners on the VPS must be isolated first.
