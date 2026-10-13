# Memo Coordinator, contract v1

The Coordinator is the part of Memo Bridge that lets several AI sessions work in parallel without overlapping. It is an internal module, not a second MCP server.

It follows the ownership decided on 2026-10-13 (Vault `1-Projects/memo-labs-os.md`):

| Concern | Owner | Memo Bridge's role |
|---|---|---|
| Work items | GitHub Issues | exposes them |
| Reservation shared by every machine | Git-ref lease ledger in `memolabs-dev/.github` (`scripts/issue_lease.py`, `docs/star-issue-lease-v1.md`) | runs it; never reimplements it |
| Which session works, under which identity | this module | workspaces; the worker identity is derived by the server |
| Proof that work can be resumed elsewhere | this module | Git-verified checkpoints |
| Who did what | this module | append-only audit journal |
| Merge | `memolabs-dev/.github` landing contract | none: agents never merge |

## Flow for a client

1. `projects_list` to find the canonical project name.
2. `workspace_open({project, client_type, client_label})`. Keep `workspace_id` for the whole session. MCP is stateless, so the workspace is always passed explicitly.
3. Pick an open GitHub Issue of that project, labelled `agent:ready` with exactly one `priority:*` label.
4. `issue_claim({workspace_id, issue: "owner/repo#n"})`. It returns `claim_id`, `fence`, `epoch` and `expires_at`.
5. Work in your own branch or worktree. Call `issue_heartbeat` before `expires_at`. Each heartbeat returns a new fence: always send the latest one.
6. Push, then `issue_checkpoint({..., branch, commit})`. Only `durability: "remote"` lets another machine resume.
7. `issue_release({..., outcome})` with `completed`, `blocked`, `failed` or `cancelled`. Then `workspace_close`.

## Guarantees and their source

- **One holder per Issue, across every machine.** The ledger creates the lease ref atomically and advances it only by fast-forward. Two racing claims cannot both succeed. Tested with eight processes in `tests/coordinator-concurrency.test.mjs`, and against the real GitHub API in `memolabs-dev/.github` (`docs/star-issue-lease-live-proof-20261013.md`).
- **Stale writers are refused.** Heartbeat, checkpoint and release require the same worker, the same claim, the current fence and an unexpired lease. Any mismatch returns `stale_lease`, including when nobody has taken the Issue over. The fence is not a secret, since `issue_status` shows it. It detects stale views; the protection against other sessions is the worker identity, which the server derives.
- **The worker identity comes from the server.** It is `mb.<host>.<workspace_id>`, never a tool argument. Another workspace, even of the same principal, cannot act on the claim: it gets `unknown_claim` locally and a refusal from the ledger.
- **Governance gates are the ledger's.** They cover the public repository allowlist, the open Issue with `agent:ready` and one priority, no blocking label (`status:blocked`, `needs:human`, `type:epic`, `agent:working`), and an Issue that has not changed since the claim. When the workspace project's Git origin is known, Memo Bridge also refuses an Issue from another repository (`project_mismatch`). Otherwise the claim reports `project_origin_verified: false`.
- **Checkpoints are a write boundary.** The Git checks run first. The ledger then re-verifies the claim, and the checkpoint is recorded right after.
- **Uncertain outcomes are reconciled, never ignored.** When a claim, heartbeat or release may have reached GitHub without its result coming back (timeout, crash), Memo Bridge reads the lease status and adopts its own lease. This applies to a claim it holds without having seen the result, and to a fence it never saw. The ledger runs in its own process group, so a timeout kills `gh` too and nothing can land afterwards.
- **Closing is safe to repeat.** `workspace_close` closes the workspace first, so no new claim can be recorded for it. It then releases every claim still recorded as held. Each claim is reported as `released`, `lost` (no longer ours) or `unreleased` (ledger unreachable: call `workspace_close` again or `issue_release` later). `issue_release` also works on a closed workspace.
- **Leases are cooperative.** They do not stop an IDE or a plain `git` command. That is why checkpoints check the commit in Git rather than trusting the client.

## Identity and authorization

The principal comes from the entry point, never from tool arguments.

| Entry point | Principal | Capabilities |
|---|---|---|
| Local stdio plugin | `local:<OS user>` | `coordinator:read`, `coordinator:write`, `coordinator:audit` |
| Hub (later) | derived from the verified OIDC `sub` and its scopes | mapped per scope |

Authorization is checked before argument validation, so every refusal is journaled. A workspace can only be read or used by its principal. `coordinator_events` returns only the caller's events unless the caller holds `coordinator:audit`.

## Errors

Every result is `{ ok: true, ... }` or `{ ok: false, error, detail? }`.

| Code | Meaning |
|---|---|
| `invalid_input` | A field is out of bounds; `detail` names it |
| `unknown_project`, `unknown_workspace`, `unknown_claim` | Not found, or not recorded by this workspace |
| `forbidden` | Capability missing, or the workspace belongs to another principal |
| `workspace_closed` | The workspace is closed |
| `project_mismatch` | The Issue is not in the repository of the workspace project's Git origin |
| `lease_held` | Another worker holds an active lease |
| `lease_race_lost` | The ledger saw a concurrent change while advancing the lease; retry |
| `stale_lease` | The fence, worker or expiry does not match the current lease |
| `issue_not_ready` | The Issue is closed, not `agent:ready`, blocked, or has no single priority label |
| `issue_changed` | The Issue was edited after the claim; re-plan before writing |
| `repo_not_allowed` | The repository is not in the ledger's public allowlist |
| `ledger_unavailable` | The ledger or GitHub cannot be reached. For a claim, the lease status was checked and nothing is held |
| `ledger_outcome_unknown` | A claim, heartbeat or release may or may not have landed, and the status could not be read; check `issue_status` |
| `lease_denied` | Another ledger refusal; `detail` carries its fixed message |
| `commit_not_found` | The commit does not exist in the project repository |
| `store_unavailable` | The local private store cannot be opened or written. If this happens after a successful claim, the claim is given back first (`detail`) |

## Checkpoint durability

| Value | Meaning |
|---|---|
| `remote` | The commit is an ancestor of the local `refs/remotes/origin/<branch>`; it can be resumed elsewhere after a fetch |
| `local_only` | The commit exists only locally; the response carries a warning |
| `unverified` | The project repository is not available on this host |

Memo Bridge never fetches, pushes or writes to the repository. Uncommitted files are never transferred.

## Local state

The local store holds workspaces, a mirror of the claims held here, checkpoints and the audit journal. It never holds the lease itself, and `workspace_status` shows this mirror. Use `issue_status` for the authoritative state. All access to it goes through `server/coordinator/store.mjs`. The contract tests in `tests/coordinator-store-contract.test.mjs` are written per engine, so a Postgres adapter can follow when the hub owns this state.

- **Engine.** The built-in `node:sqlite`, with no added dependency. WAL journal, `busy_timeout` 5 s. Writes use `BEGIN IMMEDIATE`; reads use a deferred `BEGIN`.
- **Concurrent opening.** When many sessions open a brand-new store at once, the switch to WAL is retried.
- **Location.** Override it with `MEMO_BRIDGE_STATE_DIR`.

  | OS | Default location |
  |---|---|
  | macOS | `~/Library/Application Support/memo-bridge/coordinator.sqlite` |
  | Linux | `$XDG_STATE_HOME/memo-bridge/` or `~/.local/state/memo-bridge/` |

- **Opening is refused** for:
  - a relative path;
  - a Git repository, bare repositories included;
  - iCloud (`Mobile Documents`) and `~/Library/CloudStorage`;
  - an existing directory that other users can read.

  Comparisons ignore case and follow symlinks.
- **Permissions.** The directory is 0700 and the file 0600.

## Ledger location and requirements

- **Script.** The ledger script is read from `MEMO_BRIDGE_GOVERNANCE_ROOT`, by default `~/projects/memolabs-org-gh`, the local checkout of `memolabs-dev/.github`.
- **Requirements.** It needs `python3`, plus a `gh` CLI logged in with permission to write refs in `memolabs-dev/.github`.
- **CI.** CI checks out `main` of `memolabs-dev/.github` on purpose: Memo Bridge must keep working with the ledger as it evolves, and a breaking ledger change should turn this CI red at once. The tests drive the ledger offline through `tests/helpers/fake-gh`, which reproduces exclusive ref creation and fast-forward-only updates.

## Limits of v1

- **Public allowlist only.** The ledger covers only the public repositories on its allowlist; private repositories (emargo, kollio) are not covered yet. Adding a repository is a change to `scripts/issue_preflight.py` in `memolabs-dev/.github`.
- **No degraded mode.** If GitHub is unreachable, nothing can be claimed. The Mac and the VPS keep working with plain Git; coordination resumes when GitHub returns.
- **No hub exposure yet.** The hub does not expose these tools. They stay local until the root CI runners on the VPS are isolated (lab-infra #161).
- **Not covered here.** Runners, worktree creation and job execution are separate milestones.
- **No retention policy.** The audit journal has no retention policy yet.
