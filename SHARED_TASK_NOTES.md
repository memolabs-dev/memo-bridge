# Shared task notes, memo-bridge

## Active work (2026-10-13)
- `feat/coordinator-core` (worktree `_worktrees/memo-bridge/coordinator-core`): Coordinator core for issue #8. Canonical state is in `.agent/project/state.json`.
- PR #5 and #6 (`feat/hub-auth`, `feat/oidc-resource`) are open and untouched. Do not open a second writer on them.

## Decisions
- PR #7 was merged on 2026-10-13 with the owner's approval.
- Coordinator write tools are enabled by default on local stdio, and the exception is documented in SECURITY.md.
- Storage is SQLite (`node:sqlite`) behind `store.mjs`. Postgres will come when the hub owns the store. pgvector is a separate decision that belongs to the Vault and Atlas search (phase 7), not to the Coordinator.

## Next
1. Merge the hub with a unified tool registry after its security review (#5, #6).
2. Reconcile PROJECTS.md (#9).
3. Mac runner (worktrees, predefined tests).
