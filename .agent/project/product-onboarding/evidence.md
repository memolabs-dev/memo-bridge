# STAR — Rebuild Radar / Mobile Explorer onboarding gate (#83)

## Situation (2026-10-16)

- The owner created two private repositories: `memolabs-dev/rebuild-radar` and `memolabs-dev/mobile-explorer`.
- Both Mac canonical directories exist and their `main` checkout has only an initial README. Source code is on PR #1 (not yet landed).
- The Mac canonical registry includes both projects. The VPS Memo Bridge `projects_list` currently enumerates only `memo-bridge`, `cuesheet`, `uni-protocol`: those product checkouts are not yet remotely authorized.
- Separate catalog-transfer and runner/deployment work is already in progress. Do not modify another session's shared catalog, paths, governance or production deployment.

## Task

Add a small *read-only*, testable preflight and an explicit onboarding runbook that distinguishes metadata discovery from permission to run agent tasks, and clarifies all remaining cross-repository gates.

## Action

- `server/onboarding-readiness.mjs`: pure evaluator, validates canonical project identifiers and compares registered local checkout, Git origin and lease allowlist.
- `scripts/check-product-onboarding.mjs`: local CLI with bounded output; never mutates files or calls the GitHub API.
- `tests/onboarding-readiness.test.mjs`: checks success and critical refusals (missing checkout, metadata only, wrong origin, missing ledger grant, invalid names).
- `docs/PRODUCT_ONBOARDING.md`: operational plan, guarded checks and rollback.

## Result

Code review and tests in the PR provide the result. A green preflight verifies **only** the three coordinator prerequisites; it does not certify GitHub App installation, landing eligibility, Mac ↔ VPS registry synchronization or product code landing. Those remain separately auditable tasks.

## Next task

After the independent registry and allowlist PRs are merged, re-run the preflight on the VPS and verify App installation + exact-SHA landing policy. Then create a separate Rebuild Radar Issue for V0.2 and proceed with its code in its own reserved worktree.
