# Delegation: child chats working under a parent's task (#47)

Branch `feat/workspace-delegation` from origin/main 5dc1c7d. Started 2026-10-14 22:04 CEST.

## Intent

Owner, 2026-10-14: sub-agents with the ChatGPT Plus subscription only. With Chat alone a sub-agent
is another chat the owner opens by hand and pastes one sentence into. A conversation that holds a
task splits part of it: `workspace_delegate` returns a delegation id and the sentence
"Avec Memo Bridge, rejoins la délégation d_xxxxxxxxxxxx."; the new chat calls `delegation_join`
and works under the parent's task, lease and fence, inside a scope it cannot widen. The parent
reads the children's results with `delegation_status`. Memo Bridge calls no model and never
launches a chat.

Non-goals: launching chats programmatically (OpenAI terms), any LLM call, a child's own lease, a
child commit, push or pull request (they stay with the parent), lab-infra changes.

## Decisions

| ID | Decision | Why | Rejected |
|---|---|---|---|
| D1 | Store schema v7: table `delegations` (id, principal, parent workspace, issue, parent claim id, worktree, scope mode and paths, brief, status open, joined or ended, child workspace, TTL, end reason, report) and `fence_moves`; column `workspaces.delegation_id`. A child is an ordinary workspace row (bound, listed, counted) that names its delegation. | One row per child, so session binding, overview and learning counters work unchanged. | A separate child table (every existing check would need a second path). |
| D2 | Ids `d_` + 12 hex (48 bits); the sentence is fixed server text, French. TTL default 3600 s, 300 to 14400. At most 5 live delegations per parent. | Short to paste, unguessable enough for one owner's own chats (same principal anyway). | |
| D3 | Binding: `delegation_join` creates the child workspace bound to the caller's session hash, and marks the delegation joined in one compare-and-set transaction (`status = 'open'`). A second join from the same conversation returns the same child (`rejoined`); from any other conversation `delegation_taken`; a remote join without a session hint `session_required` in every binding mode (the binding needs it); joining from the conversation bound to the parent `delegation_self`. A child workspace is never rebound by `workspace_recover` (no idle takeover, no warn rebind). | The issue: the delegation id is single use and bound to the first conversation that joins it; enforce keeps holding for the child workspace. | Rebind after 30 min idle as for ordinary workspaces (a pasted sentence could then be replayed into another chat). |
| D4 | Lease without the claim id: the delegation row keeps the parent's claim id server side. A child write (worktree file, job) resolves the parent workspace from the worktree, checks the parent's live local claim and, for jobs, asks the ledger with the parent's worker, claim and fence. The child never receives a claim id or fence and every task_* op from a child answers `child_cannot_claim`. When the parent's lease has less than 10 minutes left, a child write renews it (ledger heartbeat, TTL 1800, the parent's worker) and records the fence move in `fence_moves`; the parent's next task_renew, release, complete or checkpoint with the fence it last saw is accepted when that fence chains to the current one through recorded moves of the same claim. | The parent chat is idle while the owner talks to the children; a 30 min lease would stop them. Fencing still refuses a takeover (new claim id) and any fence the server did not move itself. | Children renewing through their own lease (forbidden by the issue). The owner reminding the parent to renew. |
| D5 | Scope: `read_only`, `paths` or `worktree`. `worktree` and relative `paths` need `worktree_id`, an active worktree of the parent on the delegated task. Relative paths are worktree prefixes; absolute (or `~/`) paths are operator path prefixes. Live delegations of one parent never overlap (`scope_overlap`): two children never write the same file. | The three forms of the issue; no overlap makes "two children at once" safe by construction. | |
| D6 | Who is a child: the workspace named by the call when it has a delegation, else the most recently created workspace bound to the caller's session when it has one. So a child conversation cannot act as its parent by omitting or swapping `workspace_id`: naming another workspace answers `outside_delegation_scope`, `workspace_open` and `batch_create` too while the delegation is live. | Fail safe whatever the model sends; works in warn, block and enforce. | Trusting `workspace_id` alone. |
| D7 | Enforcement points. Worktree tools take an optional `workspace_id` (the caller's own); a child reads only its delegated worktree, writes files only inside its scope (protected paths still refused), never creates, commits, pushes or removes a worktree (`outside_delegation_scope`). `jobs_submit` from a child runs on the delegated worktree under the parent's claim (not in `read_only`); the job row belongs to the parent workspace, so the parent's release or close cancels it. Operator: the hub learns a workspace's delegation from the runtime `workspace_status` (cached per workspace for non-children, checked on every call for children), refuses lock kinds other than `path` and paths outside the absolute scope paths, and records the parent as the lock's family: a child lock blocks other conversations as the parent's lock would and never blocks its own family. | Each place where a write happens checks the scope itself. | Checking scope only in the instructions. |
| D8 | Results flow back with `delegation_report` (child: handoff-shaped fields, the same bounds and filters as #39, `final` flag) and `delegation_status` (parent: every delegation, its state, child session tag, last activity, latest report as data; child: its own). | The parent reads results in one call; nothing from a report is ever treated as instructions. | |
| D9 | End: `delegation_end` (parent), the parent's task_release or task_complete of that claim, the parent's workspace_close, the child's own workspace_close, TTL. Ending closes the child workspace and records the reason; liveness is also checked at every use (claim no longer held, parent closed, TTL), so a missed end still stops the child. A child's next call answers `delegation_ended`. | | |
| D10 | `sessions_overview` nests children under their parent (`children`), each with its delegation id and scope; a child whose parent is not shown stays at the top level. The hub merges locks into nested children too. | The issue. | |
| D11 | Remote surface: `delegation_status` in the read list, `workspace_delegate`, `delegation_join`, `delegation_report`, `delegation_end` in the write list. Capabilities: status `coordinator:read`, the four others `coordinator:write`. No new OAuth scope. | Same scopes as workspace_open and task_claim. | |

## Acceptance

| ID | Criterion | Test (tests/delegation.test.mjs) |
|---|---|---|
| AC1 | A child refuses writes outside its scope (worktree file, job, operator lock and call) and refuses task_claim (all task_* ops) | AC1 tests |
| AC2 | Two children of the same parent work at once; overlapping scopes are refused | AC2 |
| AC3 | A child of parent A cannot touch parent B's work (worktree reads and writes, jobs, workspace ops) | AC3 |
| AC4 | Releasing or completing the parent's task, closing the parent, delegation_end and TTL end the children; their next call answers delegation_ended | AC4 |
| AC5 | Session binding enforce holds: the delegation id is bound to the conversation that joined it; recover never rebinds a child | AC5 |
| AC6 | sessions_overview shows children under their parent; locks merged | AC6 |
| AC7 | delegation_status returns the children's reports; reports bounded and filtered | AC7 |
| AC8 | Child writes run under the parent's lease without the claim id; the lease is renewed and the parent's old fence still works | AC8 |
| AC9 | Instructions, skill and docs carry the rule and the French sentence; remote lists the tools | AC9 |
| AC10 | One mutation check per rule caught | evidence.md |
| AC11 | Full suite, build and smoke green with the governance checkout | evidence.md |

## Risks

| Risk | Level | Handling |
|---|---|---|
| U-P5-05: no `openai/session` hint from ChatGPT: remote join answers session_required | high until measured | same sequencing as enforce: check session_tag in sessions_overview first; documented |
| Lease renewal by child writes moves the parent's fence | medium | fence chain accepted for the parent (D4); delegation_status shows the current fence |
| Child jobs keep running after a delegation_end or TTL end (the parent's claim still holds) | low | they stop with the parent's release or close; job_cancel by the parent |
| Operator scope paths compared as text (no symlink resolution) | low | same as locks: coordination, not a boundary |
| Schema v7 collides with a parallel schema bump at merge | low | renumber at merge |

## Work graph

| TODO | P | What | Depends | Status |
|---|---|---|---|---|
| DL-01 | P0 | spec, state.json | | DONE |
| DL-02 | P0 | store v7, delegation module (scope, liveness, end, caller-as-child, lease renewal, fence chain) | 01 | DONE |
| DL-03 | P0 | coordinator ops and guard, tools, policy, registry, hub codes and timeouts | 02 | DONE |
| DL-04 | P0 | worktree and job enforcement | 02 | DONE |
| DL-05 | P0 | hub: operator scope, lock families, overview merge | 03 | DONE |
| DL-06 | P1 | instructions (stdio and remote), skill, COORDINATOR.md, REMOTE_CHATGPT.md | 03 | DONE |
| DL-07 | P0 | tests/delegation.test.mjs, one mutation per rule | 02-06 | DONE |
| DL-08 | P0 | full suite, build, smoke with the governance checkout | 07 | DONE |
| DL-09 | P1 | push, pull request, CI (not done by instruction) | 08 | OPEN (main session) |
| DL-10 | P1 | live acceptance: two real ChatGPT chats join one parent (owner) | 09, deploy | OPEN (owner) |

## Residual limits (accepted, documented)

- Reads are scoped for worktrees only: `worktrees_list`, `jobs_list`, `job_status` and operator T0
  reads of a child are not narrowed beyond the principal (same owner; nothing is written).
- The hub remembers a workspace without delegation for 30 s per conversation: a conversation that
  joins a delegation during that window could still name its earlier workspace for operator calls
  until the window ends (coordinator, worktree and job paths check at every call).
- A child's job keeps running after `delegation_end` or the TTL while the parent's claim is held;
  the parent stops it with `job_cancel`, its release or its close.
- Under `enforce`, a remote operator call naming a workspace of another conversation now answers
  `workspace_other_session` (the hub asks the runtime); before, only lock sessions were compared.
