# Memo Coordinator, contract v1

The Coordinator is an internal module of Memo Bridge. It is not a second MCP server.
It gives several AI sessions a shared, durable picture of who works on what:

- **workspaces**: one work context per conversation or session, bound to one project;
- **tasks**: units of work per project, optionally linked to a GitHub issue;
- **leases**: exclusive, expiring reservations of a task by a workspace, with fencing tokens;
- **checkpoints**: branch + commit records, verified read-only against the project repository;
- **events**: an append-only audit journal of every write and every refusal.

Tracking issue: memolabs-dev/memo-bridge#8. Design source: `~/memolabs/workspace/decisions/2026-10-13-multi-client-coordination.md`.

## Flow for a client

1. `projects_list` to find the canonical project name.
2. `workspace_open({project, client_type, client_label})`. Keep the returned `workspace_id` for the whole session.
   MCP is stateless, so the workspace is always passed explicitly. It is never inferred from the connection.
3. `tasks_list({project, status: "open"})` or `task_create({project, title, issue_ref})`.
4. `task_claim({workspace_id, task_id, ttl_seconds})` returns `fencing_token`.
5. Work in your own branch or worktree. Call `task_renew` before `expires_at`.
6. Push, then `task_checkpoint({..., branch, commit})`. Only `durability: "remote"` lets another machine resume.
7. `task_complete` or `task_release`, then `workspace_close`.

## Leases and fencing

- A task has at most one active lease. A claim succeeds only when no lease is active and the task is not completed.
  It returns `lease_held` or `task_closed` otherwise.
- Each successful claim increments the task's `lease_generation`. The new value is the fencing token.
- `task_renew`, `task_release`, `task_checkpoint` and `task_complete` require the same workspace, the same token
  and an unexpired lease. Any mismatch returns `stale_lease`. This holds even when nobody else has claimed the
  task yet, so a client that lost its lease can never keep writing.
- Writes compare-and-set on `lease_generation` inside the transaction.
- TTL is 60 to 3600 seconds, 900 by default. Closing a workspace releases its leases.
- Leases are cooperative. They cannot stop an IDE or a plain `git` command. Checkpoints therefore verify the
  commit in Git rather than trusting the client.

## Identity and authorization

The principal comes from the entry point, never from tool arguments:

| Entry point | Principal | Capabilities |
|---|---|---|
| Local stdio plugin | `local:<OS user>` | `coordinator:read`, `coordinator:write`, `coordinator:audit` |
| Hub (future, PR #5/#6) | derived from the verified OIDC `sub` and scopes | mapped per scope |

- Reads (`*_status`, `*_list`, `coordinator_events`) need `coordinator:read`. Writes need `coordinator:write`.
- A workspace can only be read or used by its principal.
- Tasks are shared coordination data: any reader sees them and their lease holder.
- `coordinator_events` returns the caller's own events unless the caller holds `coordinator:audit`.
- Refusals return `forbidden` and are journaled with `outcome: "denied"`.

## Errors

Every result is `{ ok: true, ... }` or `{ ok: false, error, detail? }`.

| Code | Meaning |
|---|---|
| `invalid_input` | A field is out of bounds; `detail` names it |
| `unknown_project` | The project is not in `PROJECTS.md` |
| `unknown_workspace` | No workspace has this id |
| `unknown_task` | No task has this id |
| `forbidden` | Capability missing, or the workspace belongs to another principal |
| `workspace_closed` | The workspace is closed and cannot hold leases |
| `project_mismatch` | The task belongs to another project than the workspace |
| `lease_held` | Another workspace holds an active lease |
| `stale_lease` | The fencing token, workspace or expiry does not match the current lease |
| `task_closed` | The task is completed |
| `commit_not_found` | The commit does not exist in the project repository |
| `store_unavailable` | The private store cannot be opened or written; read-only tools keep working |

## Checkpoint durability

| Value | Meaning |
|---|---|
| `remote` | The commit is an ancestor of the local `refs/remotes/origin/<branch>`. It is resumable elsewhere after a fetch. |
| `local_only` | The commit exists only locally, or `origin/<branch>` does not contain it. The response carries a warning. |
| `unverified` | The project repository is not available on this host. |

Memo Bridge never fetches, pushes or writes to the repository. Uncommitted files are never transferred.

## Storage

The storage contract lives in `server/coordinator/store.mjs`. It is the only module that knows the engine.

Contract:
- `transaction(fn)` runs `fn(repo)` atomically. Calls are serialized within a process.
- Repository methods:
  - `insertWorkspace`, `getWorkspace`, `listWorkspaces`, `updateWorkspace`
  - `insertTask`, `getTask`, `listTasks`, `tasksLeasedBy`
  - `updateTask(id, patch, expectedGeneration)` returns the number of rows changed (0 or 1)
  - `insertCheckpoint`, `listCheckpoints`
  - `appendEvent`, `listEvents`
- `close()`

The contract tests in `tests/coordinator-store-contract.test.mjs` are parameterized by engine.

Current engine: SQLite through the Node built-in `node:sqlite`. No dependency is added.
- WAL journal, `busy_timeout` 5 s, `BEGIN IMMEDIATE` for every transaction.
- Schema version is held in `PRAGMA user_version` (currently 1). A newer schema refuses to open with older code.
- Several local stdio processes, one per client session, share the file safely through SQLite locking.
  The multi-process tests cover this.

Location (override with `MEMO_BRIDGE_STATE_DIR`):

| OS | Default directory |
|---|---|
| macOS | `~/Library/Application Support/memo-bridge/coordinator.sqlite` |
| Linux | `$XDG_STATE_HOME/memo-bridge/` or `~/.local/state/memo-bridge/` |

- Directory 0700, file 0600.
- Opening fails inside iCloud (`Mobile Documents`) or inside a Git working tree.
- Backup: copy the file with `sqlite3 coordinator.sqlite ".backup <dest>"` while idle. The journal holds no secrets.

## Limits of v1

- **Single machine.** The Mac and the VPS each have their own store. Cross-machine coordination arrives when the
  authenticated hub owns the store. A Postgres adapter is planned then, behind the same contract.
- **Not included yet:** worktree creation, job execution and runners.
- **No event retention policy yet.** The journal grows by one small row per write or refusal.
- **Local wall clock.** Expiry uses the clock of the machine that hosts the store.
