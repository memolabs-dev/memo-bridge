# Memo Coordinator, contract v2

The Coordinator is the part of Memo Bridge that lets several AI sessions work in parallel without overlapping. It is an internal module, not a second MCP server.

It follows the ownership decided on 2026-10-13 (Vault `1-Projects/memo-labs-os.md`):

| Concern | Owner | Memo Bridge's role |
|---|---|---|
| Work items (tasks) | GitHub Issues | exposes them |
| Reservation shared by every machine | Git-ref lease ledger in `memolabs-dev/.github` (`scripts/issue_lease.py`, `docs/star-issue-lease-v1.md`) | runs it; never reimplements it |
| Which session works, under which identity | this module | workspaces; the worker identity is derived by the server |
| Proof that work can be resumed elsewhere | this module | Git-verified checkpoints |
| Who did what | this module writes the journal; `audit_events` and `audit_operation` (`server/tools/audit-tools.mjs`) read it | append-only audit journal |
| Merge | `memolabs-dev/.github` landing contract | none: agents never merge |

The Mac runner that does the work of a claimed task (worktrees, files, jobs, push, pull requests) is described in `docs/RUNNER.md`.

**A task is a GitHub Issue.** Tools say "task"; the argument that names one stays `issue`, written `owner/repo#n` (for example `memolabs-dev/drop#7`).

## Tools

| Tool | Capability | Contract |
|---|---|---|
| `workspace_open({project, client_type?, client_label?, host?, branch?})` | `coordinator:write` | Opens a per-session work context for one registered project; returns `workspace_id` and the server-derived `worker`. |
| `workspace_status({workspace_id})` | `coordinator:read` | The workspace and the claims its local mirror records as held. |
| `workspace_list({status?, limit?})` | `coordinator:read` | Your workspaces, newest first (at most 200). |
| `workspace_close({workspace_id})` | `coordinator:write` | Closes the workspace, then releases its claims (outcome `cancelled`). Safe to repeat. |
| `workspace_recover({workspace_id})` | `coordinator:read` | Read-only resumption snapshot: claims reconciled with the ledger, active worktrees, last 10 checkpoints, recent jobs, next safe actions. |
| `tasks_list({project?, limit?})` | `coordinator:read` | Claimable tasks of registered and allowlisted repositories, ranked p0, p1, p2, then oldest first (default 30, at most 100). |
| `task_status({issue})` | `coordinator:read` | Shared lease state of one task (holder, expiry, current fence) and its checkpoints. |
| `task_claim({workspace_id, issue, ttl_seconds?})` | `coordinator:write` | Reserves the task through the ledger; returns `claim_id`, `fence`, `epoch`, `expires_at`. |
| `task_renew({workspace_id, issue, claim_id, fence, ttl_seconds?})` | `coordinator:write` | Extends the lease (60 to 1800 s, default 300); returns a new fence. |
| `task_checkpoint({workspace_id, issue, claim_id, fence, branch?, commit?, note?, handoff?})` | `coordinator:write` | Records a Git-verified checkpoint and/or a structured handoff under a live claim (branch and commit required unless a handoff is given). |
| `task_release({workspace_id, issue, claim_id, fence, outcome})` | `coordinator:write` | Releases with `completed`, `blocked`, `failed` or `cancelled`, also from a closed workspace. |
| `task_complete({workspace_id, issue, claim_id, fence, summary?})` | `coordinator:write` | `task_release` with outcome `completed` and an optional plain-text summary (at most 2000 characters) kept with the claim. |
| `memory_save({id?, base_revision?, scope?, title?, body? \| body_patch?, evidence?, tags?, project?, host?, issue?, archived?})` | `coordinator:write` | Saves one fact for later conversations; see "Memory across conversations". |
| `memory_search({query?, scope?, project?, tag?, host?, issue?, archived?, limit?})` | `coordinator:read` | Your entries matching every word (title, body, tags) and the filters, with snippets (default 10, at most 50). |
| `memory_get({id, revision?})` | `coordinator:read` | One entry in full, latest or one of the last 20 revisions. |
| `memory_list({scope?, project?, tag?, host?, issue?, archived?, limit?, offset?})` | `coordinator:read` | Your entries, newest first, titles only (default 20, at most 100). |

Every tool name is also the policy operation (`server/coordinator/policy.mjs`, `OPERATION_CAPABILITY`) and the `op` written to the audit journal. The pre-v2 names (`issue_status`, `issue_claim`, `issue_heartbeat`, `issue_release`, `issue_checkpoint`, `coordinator_events`) no longer exist and are never authorized.

## Flow for a client

1. `projects_list` to find the canonical project name.
2. `workspace_open({project, client_type, client_label})`. Keep `workspace_id` for the whole session. MCP is stateless, so the workspace is always passed explicitly.
3. `tasks_list({project})` to pick a task. It only lists open Issues the ledger would accept; the ledger still decides at claim time.
4. `task_claim({workspace_id, issue: "owner/repo#n"})`. It returns `claim_id`, `fence`, `epoch` and `expires_at`.
5. Work in your own branch or worktree. Call `task_renew` before `expires_at`. Each renewal returns a new fence: always send the latest one.
6. Push, then `task_checkpoint({..., branch, commit})`. Only `durability: "remote"` lets another machine resume.
7. `task_complete({..., summary})`, or `task_release({..., outcome})` with `blocked`, `failed` or `cancelled`. Then `workspace_close`.

A session that lost its context (compaction, crash, new conversation) calls `workspace_recover({workspace_id})` first. It never writes, not even to repair the local mirror.

## sessions_overview and task_next without a batch (multi-session)

- `sessions_overview({workspace_id?})` (read): the principal's active workspaces, newest first,
  at most 20, with `session_tag`, project, held task and its local lease state, last activity and
  `you`; through the hub, also the operator locks. Local store only.
- `task_next({workspace_id, project?})` without `batch`: the next `agent:ready` Issue across the
  allowed projects (remote: `remote.json` `projects`; local: every catalog repository), p0 first,
  then oldest, claimed through `task_claim`'s path. A workspace with no live claim and no active
  worktree moves to the task's project (`workspace_retarget` in the journal). Every answer carries
  `brief` (task, project, other conversations on the project, rules).
- `session_binding: "enforce"`: see `docs/REMOTE_CHATGPT.md`.

## tasks_list

- **Claimable** means what the ledger's preflight (`scripts/issue_preflight.py`) accepts: an open Issue (not a pull request), labelled `agent:ready`, with exactly one of `priority:p0`, `priority:p1`, `priority:p2`, and none of `status:blocked`, `needs:human`, `type:epic`, `agent:working`.
- **Repositories searched** are the intersection of two sets. The first is the GitHub origin (`git remote get-url origin`) of each registered project of `PROJECTS.md` available on this host. The second is the ledger allowlist, `PUBLIC_ALLOWLIST` in `<governance root>/scripts/issue_preflight.py`, read as text with a strict parser and never executed; any unexpected entry makes the whole read fail closed (`ledger_unavailable`). The result lists the repositories searched and, in `not_allowed`, registered projects whose origin is not allowlisted.
- **GitHub call.** `gh api -X GET search/issues` with a fixed query, `is:issue is:open label:"agent:ready" repo:<owner/repo> ...`, sorted by creation date ascending, 100 results per call, at most 10 repositories per call and 5 calls. The other filters and the ranking are applied by Memo Bridge. `truncated: true` means GitHub had more results than were read, or more tasks matched than `limit`.
- **Text from GitHub** (titles, labels) is stripped of control, zero-width and bidi characters and bounded (titles 200 characters) before it is returned.
- **Lease state is not included**: it costs one ledger call per Issue. `task_status` gives it for one task, and `task_claim` is the authority.

## workspace_recover

For each claim the local mirror records as held (the 10 most recent, newest first), the ledger status is read and compared with the worker and claim id of this workspace:

| State | Meaning | Safe action |
|---|---|---|
| `still_held` | The live lease is ours. `fence` and `expires_at` come from the ledger, and `local_fence` from the mirror: a renewal whose answer was lost shows up here | continue with the ledger `fence`, renew before `expires_at` |
| `expired` | Our lease, past its expiry | stop writing; `task_status`, then `task_claim` again if the Issue is still ready |
| `lost` | Released, or held by another worker | do not write; pick another task |
| `unknown` | The ledger could not be read | do not write until `task_status` confirms |

The snapshot also returns the active worktrees of the workspace, the 10 latest checkpoints of every task this workspace claimed (from any workspace, so a commit pushed from the other machine is visible), the 10 latest jobs, and `next_actions`: short sentences (at most 20, 300 characters each) derived from the above. Local paths (worktree path, job log) are never returned, and job summaries are sanitized and bounded.

## Guarantees and their source

- **One holder per Issue, across every machine.** The ledger creates the lease ref atomically and advances it only by fast-forward. Two racing claims cannot both succeed. Tested with eight processes in `tests/coordinator-concurrency.test.mjs`, and against the real GitHub API in `memolabs-dev/.github` (`docs/star-issue-lease-live-proof-20261013.md`).
- **Stale writers are refused.** Renewal, checkpoint and release require the same worker, the same claim, the current fence and an unexpired lease. Any mismatch returns `stale_lease`, including when nobody has taken the Issue over. The fence is not a secret, since `task_status` shows it. It detects stale views; the protection against other sessions is the worker identity, which the server derives.
- **The worker identity comes from the server.** It is `mb.<host>.<workspace_id>`, never a tool argument. Another workspace, even of the same principal, cannot act on the claim: it gets `unknown_claim` locally and a refusal from the ledger.
- **Governance gates are the ledger's.** They cover the public repository allowlist, the open Issue with `agent:ready` and one priority, no blocking label (`status:blocked`, `needs:human`, `type:epic`, `agent:working`), and an Issue that has not changed since the claim. When the workspace project's Git origin is known, Memo Bridge also refuses an Issue from another repository (`project_mismatch`). Otherwise the claim reports `project_origin_verified: false`.
- **Checkpoints are a write boundary.** The Git checks run first. The ledger then re-verifies the claim, and the checkpoint is recorded right after.
- **Uncertain outcomes are reconciled, never ignored.** When a claim, renewal or release may have reached GitHub without its result coming back (timeout, crash), Memo Bridge reads the lease status and adopts its own lease. This applies to a claim it holds without having seen the result, and to a fence it never saw. The ledger runs in its own process group, so a timeout kills `gh` too and nothing can land afterwards.
- **Closing is safe to repeat.** `workspace_close` closes the workspace first, so no new claim can be recorded for it. It then releases every claim still recorded as held. Each claim is reported as `released`, `lost` (no longer ours) or `unreleased` (ledger unreachable: call `workspace_close` again or `task_release` later). `task_release` and `task_complete` also work on a closed workspace.
- **Leases are cooperative.** They do not stop an IDE or a plain `git` command. That is why checkpoints check the commit in Git rather than trusting the client.

## Identity and authorization

The principal comes from the entry point, never from tool arguments.

| Entry point | Principal | Capabilities |
|---|---|---|
| Local stdio plugin | `local:<OS user>` | every capability of `policy.mjs` (`coordinator:*`, `runner:execute`, `repo:write`, `github:write`) |
| Hub (later) | derived from the verified OIDC `sub` and its scopes | mapped per scope |

Authorization is checked before argument validation, so every refusal is journaled. Write operations journal every outcome (`ok`, `denied`, `error`); read operations journal only refusals. A workspace can only be read or used by its principal. The journal is read with `audit_events` and `audit_operation`, which return only the caller's events unless the caller holds `coordinator:audit`.

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
| `repo_not_allowed` | The repository is not in the ledger's public allowlist (from `task_claim`, or `tasks_list` with a `project`) |
| `project_origin_unknown` | `tasks_list` with a `project` whose GitHub origin cannot be read on this host |
| `github_unavailable` | The GitHub search behind `tasks_list` failed (gh missing, not logged in, timeout, unexpected answer) |
| `catalog_unavailable` | `PROJECTS.md` cannot be read, so `tasks_list` has no project to search |
| `ledger_unavailable` | The ledger or GitHub cannot be reached. For a claim, the lease status was checked and nothing is held. For `tasks_list`, the allowlist could not be read |
| `ledger_outcome_unknown` | A claim, renewal or release may or may not have landed, and the status could not be read; check `task_status` |
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

## GitHub Projects view (optional)

The Coordinator can mirror its tasks onto a GitHub Projects (v2) board, for example the org project "Memo Labs OS" (`https://github.com/orgs/memolabs-dev/projects/1`). The sync is one-way: the Issues and the lease ledger stay the source of truth, the board is only a view, and Memo Bridge never reads it back to decide anything. Code: `server/integrations/project-sync.mjs`.

- **Off by default.** Set `MEMO_BRIDGE_PROJECT=owner/number` (for example `memolabs-dev/1`) in the environment of the Memo Bridge server to turn it on. An invalid value keeps it off, and `batch_status` then returns `project_sync_error: "invalid_project_spec"`.
- **Board fields.** `Status` (single select: Prêt, Réservé, En revue, Bloqué, Fait), `Priorité` (P0 to P3), `Agent` (ChatGPT, Claude Code, opencode, Runner VPS, Humain) and `Lot` (text). Field and option ids are read at runtime with GraphQL and cached for 10 minutes; names are matched without case. Ids are never hard-coded: a field or option recreated on the board under the same name is picked up on the next read.
- **Auth.** The same ambient `gh` login as the other GitHub calls (`server/integrations/github.mjs`, `gh api graphql`). Mutations need the `project` scope (`gh auth refresh -s project`).

| Coordinator event | Board update |
|---|---|
| `batch_create`, each Issue created | add the Issue, Status Prêt, Priorité from its `priority:` label, Lot = batch name and id (`Refonte export (a1b2c3d4e5)`) |
| `task_claim`, `task_next`, and the claim that takes over an expired lease | Status Réservé, Agent from the workspace `client_type` (chatgpt: ChatGPT, claude-code: Claude Code, opencode: opencode, runner: Runner VPS, anything else: Humain) |
| `github_create_pr` (opened or already open) | Status En revue on the task; the pull request is added with Status En revue |
| `task_complete` | Status Fait |
| `task_release` with outcome `blocked` | Status Bloqué |
| `task_release` with outcome `failed` or `cancelled`, `workspace_close` | Status Prêt |
| `batch_status` sees an expired lease (state `stale`) | Status Prêt, once per expired lease, only for a caller that may write |

`batch_status` also returns `project_url`, the board address, when the sync is on.

**GraphQL calls.** Per GitHub's "Using the API to manage Projects" (`https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects`): the fields come from `organization(login){projectV2(number){fields}}` (then `user(login)` when the owner is not an organization); the Issue or pull request node id from `repository{issueOrPullRequest(number)}`; `addProjectV2ItemById` adds it and returns the existing item when it is already on the board; then one `updateProjectV2ItemFieldValue` per field, since an item cannot be added and updated in the same call.

**Never in the way.** Every update is fire and forget: the operation answers without waiting, updates of one Issue apply in order, each one is stopped after 30 seconds (10 seconds per GraphQL call), and at most 200 run at once. A failure never changes the operation's result: it is one journal row, op `project_sync_failed`, outcome `error`, with a short fixed code (`github_scope_missing`, `github_auth_required`, `github_unavailable`, `project_not_found`, `project_field_missing`, `project_option_missing`, `project_sync_timeout`, ...). GitHub's own messages are never kept, so no token or other text it echoes can reach the journal. After a failed update the item and field ids are read again on the next event.

## Memory across conversations

Repatriated from SentinelX `context_*`, with the design rules of the Hermes Agent study (spec
`.agent/project/repatriate-tools/spec.md`, D4). Stored in the same SQLite store (schema v5,
tables `memories` and `memory_revisions`); on lab it is the runtime's store behind the hub, so
every ChatGPT conversation of the owner shares it. Stdio clients use their local store.

- **Scopes.** `owner`: facts about the owner and his preferences (no project or host).
  `environment`: facts about a project, or a host when no project applies. One fact lives in one
  entry: a live entry with the same title or body is refused (`duplicate_fact`, with its id).
- **Budgets.** Title plus body characters of the live entries: 8 KiB for `owner`, 24 KiB per
  project or host; 4 KiB per body. Over budget, `memory_full` returns the entries and the
  characters to free. Nothing is compacted or dropped automatically.
- **Facts, not orders.** Refused on save: an imperative opening line (`not_a_fact`: always,
  never, you must, toujours, jamais...), instructions to a model, role markers, exfiltration,
  `curl | sh` and SSH key shapes (`instruction_refused`), secrets (`secret_detected`: the
  operator redactor's patterns plus password, key and token assignments, bearer headers,
  Telegram bot tokens, passwords in URLs), control, zero-width and bidi characters. A claim that
  something does not work needs `evidence` (`evidence_required`). Refusals name the field and the
  kind, never the value.
- **Concurrency.** An update names `base_revision`; a stale one answers `revision_conflict` with
  the current revision. `body_patch: {old, new}` replaces one unique fragment and keeps the rest.
- **Reversible.** The last 20 revisions are kept and readable (`memory_get` with `revision`);
  `archived: true` takes an entry out of lists, search and budgets; `archived: false` restores
  it. There is no hard delete. Every save is journaled, refusals included.
- **Owner approval for edits** (a Hermes rule) is not applied: runtime tools do not pass through
  the hub's Telegram approval, which is bound to signed operator calls. Edits are journaled and
  reversible instead; approval can be added on top later.
- **Resuming.** `workspace_open` returns `memory_snapshot`: the `owner` entries and the
  project's, newest first, 240-character excerpts, at most 20 entries and 6 KiB, frozen for that
  conversation (later saves show at the next `workspace_open`). The brief of `task_next` (a new
  task, the one already held, or none left) lists up to 5 `related_memories`: the project's, and those about the
  task (`issue`, or the issue as a tag).
- **Ownership.** Entries belong to the principal that saved them. Every result says "Memory
  restores knowledge, not authorization".

## Handoff and learning review

After Hermes Agent's compression summary and periodic review (spec
`.agent/project/handoff-learning/spec.md`; Issues #39 and #38). Stored in the same SQLite store
(schema v6, tables `handoffs` and `learning_counters`). Memo Bridge calls no model.

- **Handoff.** `task_checkpoint` takes `handoff: {goal, constraints, done, in_progress, blocked,
  decisions, files, next_steps}`: goal one line of 500 characters, lists of at most 10 lines of 300
  characters (files: 30 of 200), 3000 characters in all (`handoff_too_large`). The memory filters
  apply to every line (`secret_detected`, `instruction_refused`), nothing is stored on a refusal.
  `branch` and `commit` are optional with a handoff; the claim is verified with the ledger either
  way. The latest handoff of a task, from any workspace, comes back in `workspace_recover`
  (`handoffs`, the two most recently claimed tasks), `task_status` (`handoff`) and the `task_next`
  brief (`handoff`). Older free-text checkpoints (`note`) are unchanged.
- **Learning review.** Per workspace: tool calls, and user turns estimated as a call at least
  90 s after the previous one (Memo Bridge sees no user turn). Every runtime tool naming the
  workspace counts (a remote call without one counts for the workspace bound to its
  conversation); operator calls do not reach the runtime and are not counted. A result carries the
  fixed `learning_review` block on the call that reaches `MEMO_BRIDGE_LEARNING_TURNS` (default 10)
  or `MEMO_BRIDGE_LEARNING_CALLS` (default 40), and on a successful `task_complete`,
  `task_release` or `workspace_close` when a call happened since the last memory write or block.
  `0` disables a counter, both `0` the block. Both counters reset on a `memory_save` naming the
  workspace (`workspace_id`) and when a block is returned. The block is server text (at most
  1536 bytes, reported by `pnpm run remote:toolsize`) asking the conversation to save facts with
  `memory_save`, to write skill fixes as Issue or PR text, or to say "nothing to save".

## Local state

The local store holds workspaces, a mirror of the claims held here, checkpoints and the audit journal. It never holds the lease itself, and `workspace_status` shows this mirror. Use `task_status` or `workspace_recover` for the authoritative state. A `task_complete` summary is stored in the claim's outcome column after the keyword (`completed: <summary>`) and returned split as `outcome` and `summary`. All access to it goes through `server/coordinator/store.mjs`. The contract tests in `tests/coordinator-store-contract.test.mjs` are written per engine, so a Postgres adapter can follow when the hub owns this state.

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
- **Not covered here.** Worktrees, files and jobs have their own tools (`worktree_*`, `jobs_*`); `workspace_recover` only reads their records.
- **No retention policy.** The audit journal has no retention policy yet.
- **Summary storage.** The completion summary shares the claim's `outcome` column until the store gets a dedicated column.
