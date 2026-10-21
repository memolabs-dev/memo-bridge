# Reader contract v1

Contract id: `memo-bridge.reader.v1`. Issue: memolabs-dev/memo-bridge#252.

This is the one interface a local reader uses to show what Memo Bridge coordinates on this machine:
the sessions (workspaces) of every conversation, their task leases, their jobs and the audit
journal, per project. Memo Orbit's Activity timeline is the first reader. A reader relies on this
contract alone: it never opens `coordinator.sqlite`, whose schema is private to
`server/coordinator/store.mjs` and whose opening runs migrations.

Memo Bridge stays the task coordinator. A reader shows; it never claims, renews, releases,
reconciles or decides anything.

## Starting a read-only process

Start the stdio server read-only, with either form:

```
node <plugin>/server/dist/index.mjs --read-only
MEMO_BRIDGE_READ_ONLY=1 node <plugin>/server/dist/index.mjs
```

`MEMO_BRIDGE_READ_ONLY` set to anything other than `""`, `"0"` or `"false"` means read-only; an
unexpected value also means read-only (fail closed). The choice is made once, at startup, by the
process; no tool argument can change it. `bridge_info` reports `read_only: true`,
`mode: "read-only"`, `reader_contract: "memo-bridge.reader.v1"` and the principal.

`MEMO_BRIDGE_STATE_DIR` selects the store as for the owner's process (default
`~/Library/Application Support/memo-bridge` on macOS). The store must already exist at the
current schema version; a read-only process never creates, re-modes or migrates it.

## What read-only guarantees

| Layer | Guarantee | Where |
|---|---|---|
| Principal | `reader:<OS user>`, capabilities `coordinator:read` and `coordinator:audit`, no write capability. A runtime started read-only refuses any principal holding one (`read_only_principal_writes`). The id is never `local:<OS user>`, so the reader owns no workspace and cannot act on a claim, worktree or job. | `server/coordinator/policy.mjs` `readerPrincipal`, `server/runtime.mjs` |
| Tools | Every tool whose policy capability is a write capability, and any tool without a policy entry except the fixed observation tools of `server/index.mjs` (`list_hosts`, `host_status`, `bridge_info`, `project_info`, `project_git_status`, `projects_audit`, `observe_*`, none of which touches the store), answers `{"ok": false, "error": "read_only"}` for any arguments, before validation, before the implicit workspace lookup and before the runtime is reached. The tools stay listed. | `server/tools/read-only.mjs` |
| Store | Opened with `SQLITE_OPEN_READONLY` and `PRAGMA query_only = ON`; a write transaction is refused before `BEGIN` (`state_read_only`), and SQLite refuses any write below that. | `server/coordinator/store.mjs` `openReadOnlyStore` |
| Trace | No audit row, not even for a refusal; no learning-review counter; no session rebind. | `server/runtime.mjs`, `server/coordinator/index.mjs`, `server/index.mjs` |
| Jobs | `jobs_list`, `job_status`, `job_events` and `job_results` read the recorded status and never reconcile it. Reconciliation stays with writers and the runner. | `server/runners/jobs.mjs` |
| Hub | A read-only runtime serves no other principal: `as()` throws and `principalFromHub` maps nothing. | `server/runtime.mjs` |

Audit choice for the reader: **no row at all**, refusals included. The alternative named in the
issue, one rate-limited row per session, was not taken: a row is a write, and the store is opened
read-only so that no code path can write. The owner's own process still journals as before
(writes always, reads only refusals).

What read-only does not cover: tools that read outside the store still do so. `task_status` asks
the lease ledger (a `gh` call, with a private scratch configuration directory under the state
directory); `host_status` probes the VPS over SSH; `github_*` read GitHub. None of them changes a
lease, an Issue or a host. The tests: `tests/read-only.test.mjs`.

## Tools

Both tools need `coordinator:audit`. They are local stdio only: they are not in
`server/registry.mjs`, so neither the hub nor the remote ChatGPT surface serves them, and a remote
principal never holds `coordinator:audit` anyway. They read in one read transaction, journal
nothing, and call no ledger, GitHub or host. They are also available to the owner's full process.

### `reader_activity`

Arguments, all optional:

| Argument | Type | Meaning |
|---|---|---|
| `project` | string, `^[a-z0-9][a-z0-9._-]{0,79}$` | Only this project. An unknown name gives empty lists. |
| `since` | ISO 8601 time with a zone (`Z` or `+02:00`), seconds and milliseconds optional | Keeps what changed at or after it, plus what is still live (see below). A time without a zone is refused. |
| `after_seq` | integer >= 0 | Audit cursor: the `next_after_seq` of the previous call. Default 0. |
| `limit` | integer 1 to 200 | Bound of each of `sessions`, `leases` and `jobs`. Default 50. |

Answer:

```json
{
  "ok": true,
  "contract": "memo-bridge.reader.v1",
  "at": "2026-10-21T15:40:00.000Z",
  "host": "mac",
  "scope": { "project": "drop", "since": null, "after_seq": 0 },
  "sessions": [ ... ],
  "leases": [ ... ],
  "jobs": [ ... ],
  "truncated": { "sessions": false, "leases": false, "jobs": false },
  "events": [ ... ],
  "next_after_seq": 1234,
  "more_events": false,
  "status_source": "recorded"
}
```

`sessions` (workspaces of every principal, newest change first):

| Field | Type | Notes |
|---|---|---|
| `workspace_id` | string | `ws_...` |
| `principal` | string | `local:<user>`, `hub:owner`, `oidc:<sub>` |
| `client_type`, `client_label` | string, string or null | |
| `session_tag` | string or null | Short tag of the conversation, as in `sessions_overview` |
| `project`, `host`, `branch` | string, string, string or null | |
| `status` | `active` or `closed` | |
| `created_at`, `updated_at`, `closed_at` | ISO or null | |
| `last_activity` | ISO | Latest of the workspace row, its claims and its last 20 jobs. Audit events are not counted. |
| `held_tasks` | string[] | Issues with a claimed, unexpired lease in the local mirror |
| `delegation_id` | string or null | Set for a delegated child workspace |

`leases` (claims recorded on this machine, newest change first):

| Field | Type | Notes |
|---|---|---|
| `issue` | string | `owner/repo#n` |
| `claim_id`, `workspace_id`, `project`, `principal` | string | |
| `state` | `claimed` or `released` | As recorded in the local mirror |
| `lease` | `held`, `expired` or `released` | `held` when claimed and `expires_at` is in the future |
| `epoch` | integer | |
| `expires_at` | ISO or null | Normalized to UTC |
| `outcome`, `summary` | string or null | `completed`, `cancelled`, `lost`...; the completion summary |
| `updated_at` | ISO | |
| `last_checkpoint` | object or null | `{branch, commit, durability, at}` |

The fence is never returned: a reader has no use for it. The local mirror is what this machine
recorded; `task_status` gives the ledger's view of one Issue.

`jobs` (newest first):

| Field | Type | Notes |
|---|---|---|
| `job_id`, `workspace_id`, `worktree_id`, `project`, `host`, `recipe` | string | |
| `principal`, `issue`, `claim_id` | string or null | |
| `status` | string | `queued`, `deferred`, `dispatched`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out`, `oom`, `budget_exceeded`, `interrupted` |
| `status_reason` | string or null | |
| `exit_code` | integer or null | |
| `created_at`, `started_at`, `ended_at` | ISO or null | |
| `summary` | string or null | At most 500 characters, control characters removed |

No local path (worktree path, log path) is ever returned.

`events` (audit journal, oldest first, at most 200 per call): the fields `audit_events` returns,
`{seq, at, principal, workspace_id, issue, op, outcome, code}`. With `project`, only events that
name one of that project's workspaces.

### `reader_job_events`

Arguments: `job_id` (required, `job_...`), `after_seq` (optional, default 0). Answer:
`{ok, contract, job_id, project, status, events: [{seq, at, kind, detail}], next_after_seq, more,
status_source}`, at most 200 events per call. Any principal's job.

## Rules

- **Timestamps** are ISO 8601 in UTC with milliseconds (`2026-10-21T15:40:00.000Z`), or `null`.
- **Pagination.** Audit events and job events page by cursor: pass the `next_after_seq` you got
  as `after_seq`; `more_events` (or `more`) says a full page of 200 came back, so the next page
  may be empty. When nothing new arrived, `next_after_seq` is the `after_seq` you sent. Sessions,
  leases and jobs are snapshots, bounded by `limit`, with `truncated` per list: sessions ordered
  by the workspace row's `updated_at` (not `last_activity`, so a cut list can leave out a session
  whose job ran recently: raise `limit` or filter by `project`), leases by `updated_at`, jobs by
  `created_at`, newest first.
- **`since`.** A session is kept when it is active or was created, updated or closed at or after
  `since`; a lease when it is claimed or was updated at or after it; a job when it is in an active
  status (`queued`, `deferred`, `dispatched`, `running`) or was created, started or ended at or
  after it; an audit event when its `at` is at or after it.
- **Status is as recorded.** `status_source: "recorded"`: nothing is reconciled on read. A job
  whose runner died shows its last recorded status until a writer or the runner reconciles it.
- **Errors** are `{ok: false, error, detail?}`. Stable codes: `read_only` (a write tool in a
  read-only process), `forbidden` (no `coordinator:audit`), `invalid_input` with `detail` naming
  the field, `unknown_job`, `store_unavailable` with `detail` `state_store_missing`,
  `state_schema_mismatch`, `state_dir_not_private` or `state_read_only`.

## Versioning

The contract id is in every answer. Within v1, fields may be added, never removed or changed in
meaning. A removal, a renamed field or a new meaning gives `memo-bridge.reader.v2`, documented
here next to v1.
