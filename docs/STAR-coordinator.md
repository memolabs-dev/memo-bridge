# STAR: Coordinator v1 on GitHub Issues (2026-10-13)

**Situation.**
- A holistic review found three competing coordination implementations:
  - session ownership in Cuesheet;
  - Issue leases and a SQLite write fence in `memolabs-dev/.github` (#37, #49);
  - a SQLite task registry in this repository (#10).
- The owner decided on the following model:
  - a task is a GitHub Issue;
  - a reservation is the Git-ref lease of `memolabs-dev/.github`;
  - Memo Bridge serves that lease model.
- The `.github` lease protocol was merged on 2026-10-13 (#37).

**Task.** Expose that model through Memo Bridge without a second implementation of the protocol.

**Action.**
- `server/coordinator/issue-lease.mjs` runs the canonical `scripts/issue_lease.py` (fixed arguments, no shell) and maps its receipts and denials.
- `server/coordinator/index.mjs` keeps only what the ledger does not own:
  - workspaces;
  - the server-derived worker identity;
  - Git-verified checkpoints, fenced by the ledger;
  - the audit journal.
- The task table of #10 is gone. Its private store, location guard, authorization and audit are reused.
- Tests drive the real ledger offline through a fake `gh` that reproduces GitHub ref atomicity.

**Result.** The evidence is in `.agent/project/README.md` and the PR CI.

**Next.**
- Allowlist memo-bridge in the ledger.
- Hub exposure after root runner isolation.
- Mac and VPS runners.
