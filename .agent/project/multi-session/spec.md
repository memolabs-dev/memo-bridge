# Multi-session coordination: up to 10 ChatGPT conversations at once

Branch `feat/multi-session-coordination` (memo-bridge only). Started 2026-10-14 18:31 CEST.

## Intent

The owner opens up to 10 ChatGPT Chat conversations at the same time. They all reach the
remote MCP endpoint as the same principal (`oidc:<owner sub>`), on several projects, with
operator access. Each conversation must use Memo Bridge, know that the others exist, know
exactly what it works on, never work on the same thing as another one, and never "do
anything". This covers the dev flow (tasks, worktrees, pull requests) and operator actions
(files, commands, services on the Mac and the VPS).

Non-goals: deploying, lab-infra changes (listed for the owner below), Pocket ID, credentials,
a per-conversation principal (D6 of Phase 5 stays: OpenAI says not to use the session hint
for authorization), sandboxing operator commands (locks coordinate sessions, they are not a
security boundary: the host policy, the signatures and the approvals stay that boundary).

## What exists (read 2026-10-14, origin/main 254c151)

- Workspaces, claims mirror, events: `server/coordinator/store.mjs` (SQLite, schema v4,
  `workspaces.client_session`). Leases: the Git-ref ledger (`issue-lease.mjs`), fenced.
- `task_next` (`server/coordinator/index.mjs`) needs a `batch`: it only reads the Issues of one
  `agent:batch-<id>` label in the workspace project. `tasks_list` already ranks the
  `agent:ready` backlog of every remote-allowed project (p0, p1, p2, then oldest).
- D8 session binding: the forwarder (`bridge/forward.mjs clientSessionHash`) hashes
  `ctx.mcpReq._meta["openai/session"]` (sha256, 32 hex), never read from arguments; the hub puts
  it in the envelope `meta.client_session`; `workspace_open` stores it; modes `warn` (default)
  and `block` (`bridge/write-gate.mjs sessionBindingDecision`). An absent hint, or an unbound
  workspace, is never refused (U-P5-05 is still unmeasured). Checked on coordinator writes,
  worktree writes, jobs and `github_create_pr`; `workspace_recover` rebinds unconditionally.
- Operator calls leave the hub through `hub.requestOperator` only (signed per call). The hub
  has no store: approvals live in memory and a restart drops them (`operator-approvals.mjs`).
- Instructions: stdio `server/index.mjs`, remote `bridge/remote-surface.mjs INSTRUCTIONS`,
  plugin skill `plugin/skills/memo-bridge-operations/SKILL.md`.

## Decisions

| ID | Decision | Why | Rejected |
|---|---|---|---|
| D-MS1 | `sessions_overview`: a runtime coordinator read (`coordinator:read`, remote read list). It lists the caller principal's active workspaces, newest first, at most 20 (`truncated` beyond): id, client type and label, `session_tag`, project, held task with its local lease state (`held`, `expired`), last recorded activity, `you`. The hub adds the operator locks (per workspace and as a list) and `last_call_at` per session tag. | Workspaces live in the runtime store, locks in the hub: each side answers what it owns, in one call. Indexed queries only (no ledger, no GitHub): cheap. | A ledger call per task (slow, up to 20 Python calls). |
| D-MS2 | `session_tag` = `s` + 6 hex of sha256(`memo-bridge/session-tag|` + session hash). Never the hint, never the binding hash. | Short, stable, non-reversible; a model can quote it. | Showing the hash (it is the binding value). |
| D-MS3 | New `session_binding: "enforce"`, for remote principals only. Any coordinator call naming a workspace (reads included), worktree writes, jobs and `github_create_pr` from another conversation answer `workspace_other_session`; no hint answers `session_required` (fail safe), and so does `workspace_open` without a hint. An unbound workspace counts as another conversation's. `workspace_recover` rebinds only a workspace idle for 30 min (journaled `workspace_rebind`), otherwise `workspace_other_session`. `warn` and `block` are unchanged; stdio and the 9443 principals are unchanged in every mode. | The owner's rule: a workspace of one conversation cannot be used from another. Fail safe means no hint, no write. The idle rule keeps a way out if a refresh changes the hint (U-P5-05). | Rebinding on any recover (`block` does it: a confused chat can steal a workspace). Refusing reads too in `block` (would change existing behaviour). |
| D-MS4 | Operator locks in the hub (`bridge/operator-locks.mjs`), memory only: `operator_lock(host, kind: path|unit|container|global, target, ttl_seconds, reason, workspace_id)` and `operator_unlock`. TTL default 900 s, max 7200 s, renewable by locking again. Bound to a workspace and to the conversation (session hash) that took it; the hub checks the workspace with the runtime (`workspace_status` with the caller's session) before granting. Conflicts: path subtrees in either direction (case-folded on the Mac), same unit, same container, any lock against a global one. At most 8 per workspace, 32 in all (the overview then stays under the 24 KiB remote budget). | The hub is the only place both hosts' operator calls cross. No round trip per operator call: the lock carries its workspace and session. | Locks in the runtime store (a runtime round trip on every operator call, and the Mac operator agent does not depend on the VPS runtime). |
| D-MS5 | Remote principals must pass `workspace_id` on operator T1 to T3 calls (`workspace_required`) and hold a covering lock (`lock_required`): edit, upload init, move (src and dst), copy (dst), delete, chmod need a path lock; `operator_run` with `cwd` a path lock on it, without `cwd` or with `as_root` a global lock; `operator_script` a global lock; `operator_service` a unit lock. Upload chunks and completion stay with the workspace that started the upload. Another workspace's covering lock answers `locked_by_other_session` with its tag, workspace and reason. Non-remote callers (9443 `hub:owner`) keep working without a workspace when no lock covers the target. `workspace_id` is removed from the arguments before signing, so agents and approvals see what they saw before. | Ten parallel conversations share one principal: without a workspace nothing ties an operator action to a conversation, and the overview could not show it. Requiring the lock is what makes the rule hold whatever the model does, and what makes a memory-only table safe (below). | Advisory locks only (the instructions would be the only guard). |
| D-MS6 | Restart: a hub restart drops every lock (as it drops approvals). Because remote writes need a covering lock, the holder's next write answers `lock_required`; it takes the lock again, or gets `locked_by_other_session` if another conversation took it in between. No write ever happens under a lock the hub does not know. `sessions_overview` reports `locks_since` (hub start). | Fail safe without a new store or a lab-infra state directory. | A JSON file (needs a writable hub state dir from lab-infra, and a lock restored after a crash may belong to a dead conversation). |
| D-MS7 | `task_next` without `batch` takes the next task of the `agent:ready` backlog across every remote-allowed project (local: every catalog repository), p0 then p1 then p2, then oldest, optionally one `project`. Issues held by a live local claim or being claimed by a parallel call are skipped; the ledger decides the rest (a lost race moves on). A workspace that holds a live claim gets it back (`already_held`). When the chosen task is in another project and the workspace has no active worktree, the workspace moves to that project (journaled `workspace_retarget`). With `batch`, unchanged. | One sentence for the owner ("prends la prochaine tâche disponible") whatever the project. | One workspace per project per candidate (10 chats would open dozens). |
| D-MS8 | Every `task_next` answer (and `already_held`) carries `brief`: the task, the project, what the other conversations do on that project (tag, task), and the fixed rules. Fixed server text; nothing from the Issue. | The chat knows its job and its neighbours in the same answer. | |
| D-MS9 | Instructions (stdio, remote, plugin skill) state the start sequence and the stop codes; `docs/REMOTE_CHATGPT.md` gets the French worker sentence. | | |

| D-MS10 | Owner decision 2026-10-14 (relayed by the coordinator): `host` is optional on the operator tools. Without it the hub uses `mac` when `operator-mac` is connected, else `vps`. `as_root`, `operator_script`, any T3 call and any call on the dangerous list (`operator-dangerous.mjs dangerReason`) must name it: `host_required`, detail "Mac ou VPS ?". The hub stamps the resolved `host` on every operator result (refusals included) when the agent did not. | The owner works mainly on the Mac; a root or destructive action never lands on a host by default. | |

## Requirements and acceptance

| ID | Requirement | Acceptance | Evidence |
|---|---|---|---|
| MS-R1 | `sessions_overview` lists the principal's active workspaces with id, client, tag, project, task and lease state, last activity, `you`; bounded (20) and cheap (no ledger or GitHub call) | test: 3 sessions, content, `you`, no raw hint or hash, 25 workspaces give 20 + truncated, ledger and GitHub never called | `tests/multi-session.test.mjs` |
| MS-R2 | Operator locks appear in the overview (per workspace and list, with `you`) | hub test merges locks | same |
| MS-R3 | `enforce`: cross-session workspace use refused `workspace_other_session` on coordinator, worktree, job and PR paths; no hint `session_required`; recover rebinds only after 30 min idle; stdio and `warn`/`block` unchanged | tests | same, `tests/remote-session-binding.test.mjs` (unchanged, green) |
| MS-R4 | `remote.json` accepts `session_binding: "enforce"` | parse test | same |
| MS-R5 | `operator_lock`/`operator_unlock` with kinds, TTL default 900 max 7200, renew, bound to workspace and session, validated with the runtime | tests | same |
| MS-R6 | Another workspace's lock refuses edit, run (cwd), service (unit) with `locked_by_other_session` and the holder's tag and reason; allowed after unlock or TTL | tests | same |
| MS-R7 | Remote T1+ without `workspace_id` refused `workspace_required`, without a covering lock `lock_required`; 9443 without workspace passes when uncovered and is refused when covered | tests | same |
| MS-R8 | Restart drops locks; next remote write answers `lock_required` | test (new hub) | same |
| MS-R9 | `task_next` without batch: 10 concurrent sessions get 10 distinct tasks, never a leased one, by priority across projects; extra sessions get `done` | test with an atomic in-memory ledger | same |
| MS-R10 | `task_next` answer carries `brief` (task, project, others, rules) | test | same |
| MS-R11 | Instructions (remote and stdio) and the skill contain the start sequence and the stop codes; REMOTE_CHATGPT.md has the worker sentence | test on the strings | same |
| MS-R14 | Default host: Mac when connected, vps otherwise; `host_required` on root, script and dangerous calls without host; host in every result | hub tests with a fake operator-mac agent | `tests/multi-session.test.mjs` |
| MS-R12 | Existing suites green: `pnpm test`, `pnpm run build`, `pnpm run smoke` | runs | evidence below |
| MS-R13 | One mutation per rule is caught | mutation log | evidence below |

## Risks

| Risk | Level | Handling |
|---|---|---|
| ChatGPT sends no `openai/session` (U-P5-05 unmeasured): `enforce` refuses every remote workspace use | high if enforce is set blind | lab-infra keeps `warn` until `sessions_overview` shows a non-null `session_tag` for the owner's conversations (visible in warn mode); then `enforce`. Documented in REMOTE_CHATGPT.md. |
| The hint changes on page refresh (U-P5-05) | medium | refreshed chat gets `workspace_other_session`; after 30 min idle `workspace_recover` rebinds; or a new workspace, and the lease expires (300 s default) so `task_next` can retake the task |
| Locks compare paths lexically; a symlink or `~` alias escapes the comparison | medium | `~/` resolved with the configured home (Mac `/Users/memo`); a `~` path on a host without a home is covered by every lock of the host; documented: coordination, not a boundary |
| Remote operator writes now need `workspace_id` and a lock (behaviour change for Lot 2 callers) | low | instructions and error hints say how; 9443 unchanged |
| Rate limits are per principal: ten conversations share read 60, write 20, execute 6 per minute and 8 in flight | high for the 10-chat use | lab-infra raises `rate_limits` (proposal in the report: read 300, write 120, execute 30, in_flight 32); not changed in code |
| Retargeting a workspace's project | low | only with no live claim and no active worktree; journaled |
| Overview leaks another conversation's labels to a model | low | same principal (the owner's own chats); labels are cleaned at write (no control characters, 80 chars) |

## Work graph

| TODO | P | What | Depends | Status |
|---|---|---|---|---|
| MS-01 | P0 | spec, state.json | | DONE |
| MS-02 | P0 | write-gate: `enforce`, `sessionTag`, decision with `remote`; all call sites | 01 | DONE |
| MS-03 | P0 | `sessions_overview` (runtime, registry, policy, remote list) | 02 | DONE |
| MS-04 | P0 | `task_next` backlog mode, retarget, brief | 02 | DONE |
| MS-05 | P0 | operator locks module, hub enforcement, tool definitions, overview merge | 03 | DONE |
| MS-06 | P1 | instructions, skill, docs (REMOTE_CHATGPT, OPERATOR, COORDINATOR) | 03-05 | DONE |
| MS-07 | P0 | tests and mutation checks | 02-06 | DONE |
| MS-08 | P0 | full suite, build, smoke; self-review; state | 07 | DONE |

## lab-infra (owner, after merge and release)

- `remote.json`: keep `"session_binding": "warn"` at first deploy; switch to `"enforce"` once
  `sessions_overview` shows a `session_tag` for each open conversation. The value is parsed by
  both the hub and the runner, so deploy the new release before changing it (an older release
  refuses `enforce` as an unknown mode and stops).
- `projects`: every repository the 10 chats may work on, as `owner/repo`, each also in the
  ledger allowlist (`issue_preflight.py PUBLIC_ALLOWLIST`) and registered in the runner catalog.
- No new file, path or secret: locks live in the hub's memory.
