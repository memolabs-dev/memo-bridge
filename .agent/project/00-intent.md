# Intent: Coordinator core (cycle 1)

## Goal
Memo Bridge gains a durable, private, transactional Coordinator so several AI clients
(stdio sessions today, hub sessions later) can open separate workspaces, claim tasks
without double ownership, record durable checkpoints, and resume after a crash.

## Non-goals
Hub/OAuth merge (#5/#6), runners, worktree creation, job execution, Vault, GitHub API,
PROJECTS.md reconciliation (#9), Sentinel X, Postgres/pgvector (decided: later).

## User-visible outcome
From any MCP client connected to Memo Bridge: `workspace_open` -> `task_create` ->
`task_claim` -> `task_checkpoint` -> `task_complete`, with a second client refused while
the lease is held, and a stale client refused after takeover.

## Constraints
- Node built-in `node:sqlite` only, no new dependency; storage behind `store.mjs`.
- Database private (0700/0600), never in a repository or iCloud.
- Principal derived server-side; never from tool parameters.
- No project file writes, no exec except fixed read-only `git` calls.
- Owner decisions 2026-10-13: #7 merged; write tools on by default in local stdio.

## Completion sentence
This change is complete when the 13 coordinator tools work through the bundled MCP
server, multi-process claim races yield exactly one owner, stale fencing tokens are
always rejected, state survives restart, refusals are audited, and CI is green on a PR.
