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

## GitHub reconciliation — #108

`source_reconcile({ project, limit? })` is an **explicit, scoped write** to the private append-only Coordinator observations, never a GitHub write or a merge. It requires `coordinator:write`, a canonical registered non-snapshot repository, and the existing remote project allowlist (remote writes must be enabled for remote callers). The supplied project name is not a repository URL or path; the GitHub origin is resolved from the trusted checkout.

One reconciliation pass reads up to 30 already registered Source Engine changes and up to 100 recent GitHub pull requests (including closed). A PR is eligible as evidence only with a matching branch, matching known PR number when present, exact same-repository head origin and a valid 40-byte hexadecimal SHA. The adapter fetches checks **for that exact head** and requires the checks API SHA to match. Missing, stale, truncated or inconclusive CI is recorded as `unknown`, never `success`. A remote PR marked `merged` is recorded as `landed`; a closed-but-unmerged PR as `closed`. A changed head is explicitly marked `blocked` so no stale review can be inferred valid. All updates use the existing immutable identity, optimistic revision checks and append-only history. Repeating the same observation without changed data writes nothing.

**Safety and rollout limits:** no branches, PRs, approvals or deployments are modified. No PR is inferred closed simply because it is absent from the limited result page. This release reconciles **existing tracked changes only**: it does not infer Issue identities from arbitrary PR titles, create new change records or run on a background timer. Install an operator-managed, allowlisted scheduler separately before describing this as continuous autonomous reconciliation. The authoritative landing policy (#88/#86) must fetch fresh target base, required reviews, checks and exact head SHA independently; Source Engine state is advisory.

To verify locally, run `npm test`, then build and run the MCP smoke test. The scoped regressions live in `tests/source-reconcile.test.mjs`. GitHub App read permissions on the target repository are required in production.

## Optional autonomous polling (#122)

The new host-owned, **disabled-by-default** source poller uses exact remote Coordinator checkpoints to discover trustworthy PRs and then reuses the #108 reconciliation adapter. It never merges, deploys or expands GitHub permissions. See [SOURCE_POLL.md](SOURCE_POLL.md) for the operator canary, 0600 private policy, overlap lock, systemd timer templates, backoff and rollback instructions. A merged code change does **not** mean the timer has been installed or enabled.
