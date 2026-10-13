# Spec: coordinator.v1

REQ-001 Private store: state dir default macOS `~/Library/Application Support/memo-bridge`,
Linux `$XDG_STATE_HOME/memo-bridge` or `~/.local/state/memo-bridge`; override
`MEMO_BRIDGE_STATE_DIR`. Dir 0700, db 0600. Refuse paths under iCloud `Mobile Documents`
or inside a git work tree.
REQ-002 Schema versioned via PRAGMA user_version; WAL; foreign keys; busy timeout 5 s;
all mutations in BEGIN IMMEDIATE transactions.
REQ-003 Exactly one active lease per task. Claim allowed only if no lease or lease expired
and task not completed/cancelled. Claim increments `lease_generation` (fencing token).
REQ-004 Every task write (renew, release, checkpoint, complete) requires
(workspace_id, fencing_token) equal to the current lease and not expired, else `stale_lease`.
REQ-005 TTL bounded 60..3600 s, default 900 s.
REQ-006 Principal derived by the server (`local:<os user>` in stdio). Authorization per op
via capabilities `coordinator:read` / `coordinator:write`. A workspace is usable only by its
principal. Denials return `forbidden` and append an audit event with outcome `denied`.
REQ-007 Every mutation and every denial appends an event (at, principal, workspace, task,
op, outcome, code). Events are append-only; no secrets, no free-form tool payloads beyond
bounded fields.
REQ-008 Project ids validated against PROJECTS.md via catalog.mjs; unknown -> `unknown_project`.
REQ-009 Checkpoint validates branch (git ref-safe regex) and 40/64-hex commit; when the
project repo is available, commit must exist (`git cat-file -e`), durability = `remote`
if ancestor of refs/remotes/origin/<branch>, else `local_only`; repo unavailable ->
`unverified`. No fetch, no writes to repo.
REQ-010 State survives process restart; completed tasks are never re-claimable.
REQ-011 Store contract isolated in store.mjs; other modules have no engine-specific SQL.
REQ-012 MCP tools: workspace_open/status/list/close, tasks_list, task_create/status/
claim/renew/release/checkpoint/complete, coordinator_events; bounded zod schemas;
annotations readOnlyHint false for writers, destructiveHint false, openWorldHint false.
REQ-013 Docs: COORDINATOR.md contract, SECURITY.md exception, README, skill, STAR.

Errors: `{ok:false,error:<code>,detail?}` codes: invalid_input, unknown_project,
unknown_workspace, unknown_task, workspace_closed, forbidden, lease_held, stale_lease,
task_closed, commit_not_found, store_unavailable.

Task states: open -> claimed (lease) -> open (release/expiry) | completed | cancelled(not exposed v1).
Workspace states: active -> closed (closing releases its leases).
Concurrency: SQLite file locks serialize writers across processes on one host.
Multi-host: out of scope; documented (hub will own the store).
