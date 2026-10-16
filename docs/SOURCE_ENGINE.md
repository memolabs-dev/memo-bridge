# Memo Source Engine V0 — change registry

First slice of [#85](https://github.com/memolabs-dev/memo-bridge/issues/85), in the existing Coordinator SQLite state. **No Git replacement, no merge powers, no network polling yet.** GitHub and the canonical Git-ref lease ledger remain authoritative.

## Persistence

Schema v8 adds `source_changes` (current bounded metadata + revision) and `source_change_events` (append-only revision snapshots). Both live in the private `coordinator.sqlite` with the existing WAL, 0700 directory and 0600 file, and use the same transaction queue and cross-process SQLite locking.

Fields are deliberately structured: project ID, Issue reference, optional worktree ID, branch, base/head SHA, PR number, CI state, landing state and observation timestamp. **Never store diff content, commands, arbitrary messages, credentials or tokens.** Project ID and Issue must refer to an authorized project in the future MCP adapter; this internal store alone does not authorize untrusted clients.

## Domain API

Import `recordSourceChange`, `sourceChange` or `sourceHistory` from `server/source-engine/changes.mjs`.

- `recordSourceChange(store, { id, patch, event_id?, expected_revision?, observed_at?, at? })` returns a new snapshot, an unchanged result or a refusal code.
- A new change requires `project_id`, `issue_ref`, `branch`. IDs must be stable, independent of a local directory path.
- `expected_revision` implements optimistic concurrency; every accepted changed observation increments the revision.
- `event_id` gives repeat-safe event ingestion and refuses reuse with mismatched payloads.
- `observed_at` is the upstream observation timestamp. Older or equal observations are refused as `stale_observation` unless replayed by the original `event_id`. Pass only comparable timestamps from the same canonical source.
- Lifecycle states: CI `unknown | pending | success | failed`; landing `open | queued | blocked | landed | closed`. Terminal landing states cannot revert.
- `sourceHistory(store, id, {after_seq, limit})` exposes an ascending, paginated audit trail. `sourceChange(store, id)` returns the current snapshot.

The registry **observes** landing status; it does not approve, request or perform a merge. Issue [#86](https://github.com/memolabs-dev/memo-bridge/issues/86) handles safe landing, and [#87](https://github.com/memolabs-dev/memo-bridge/issues/87) handles allowlisted read-only MCP queries and GitHub reconciliation.

## Recovery and validation

Migrating from schema v7 creates only the new tables, without altering legacy data. Never reset `PRAGMA user_version` in production. A future reconciliation adapter should identify records by canonical project/Issue/change ID, compare remote timestamps and head SHA, then publish discrete observations; read-only checks come first, and divergent state must be reported rather than silently overwritten.

Run `npm test` in an isolated worktree. `tests/source-engine.test.mjs` covers storage, persistence, migration, stale data, idempotency, concurrency, bounded history, immutable identity and terminal transitions. Existing Coordinator tests continue under schema v8.


## Read-only MCP query tools (issue #87)

Available through the same runtime registry on stdio and the authorized remote surface. No filesystem browsing, mutation, network write, merge or deployment is introduced:

- `source_changes_list({ project, issue?, limit?, offset? })`: metadata for one canonical registered repository project, with a maximum of 100 records per page and bounded offset 0–10000. Returns `next_offset` when the page is full.
- `source_change_status({ project, id })`: one change by stable identifier; an out-of-project identifier returns `not_found`.
- `source_change_history({ project, id, after_seq?, limit? })`: append-only revision snapshots, in ascending sequence. Use `next_after_seq` to request the next page.

All three tools require `coordinator:read`. For a remote user, the project must appear in the explicit remote project allowlist. Every request checks the canonical `PROJECTS.md` registry and resolves the registered GitHub origin before querying SQLite. A stored Issue whose owner/repo does not match that origin is omitted (or returns `not_found`). GitHub Issue, PR and commit-check URLs are constructed only from the verified origin; no arbitrary user-provided URL or local source path is returned.

The API reports **observed metadata** from Source Engine V0. Empty results mean no observations have been imported, *not* that a GitHub PR does not exist. Automatic GitHub ingestion/reconciliation is out of scope for issue #87 and must use authenticated read-only operations in a separate follow-up. Do not use these observations by themselves as permission to merge; the landing policy remains authoritative.
