# Memo Bridge: protocol state

Ownership and decisions: Vault `1-Projects/memo-labs-os.md`. Contracts: `docs/COORDINATOR.md` (Phase 2), `docs/RUNNER.md` (Phase 3), `SECURITY.md`.

## Phase 2 alignment and Phase 3 (Mac runner), branch `feat/phase-3-mac-runner`, v0.4.0

Intent: an AI client takes a claimed GitHub Issue from start to pull request on the Mac through Memo Bridge alone: worktree, file edits, the repository's own tests, commit, push, pull request, release. Every repository write, job and pull request happens under a live claim, with no arbitrary shell, no default-branch write, no force-push, no merge.

Non-goals: hub exposure of these tools, a VPS runner, a job queue, sandboxing of jobs (documented as not a sandbox), merging.

Completion sentence: Phase 3 is complete when the bundled server exposes the 48-tool contract, the full Issue-to-push round trip passes against the bundle, every module's refusal paths are tested, docs describe what runs on the owner's machine, CI is green on the pull request, and the owner has accepted one real run.

### Requirements and acceptance

| ID | Requirement | Acceptance | Evidence |
|---|---|---|---|
| P3-R1 | Phase 2 contract names: `task_*`, `tasks_list`, `workspace_recover`, `task_complete`; old names gone and never authorized | renamed tools behave as before; old names refused | `tests/coordinator.test.mjs` (EV-1) |
| P3-R2 | Store schema v2 (worktrees, jobs, job_events) and in-place upgrade of a v1 store | schema version 2; a v1 file upgrades without data loss | `tests/coordinator-store-contract.test.mjs` (EV-1) |
| P3-R3 | Worktrees: create on a new branch from origin, refuse default/main/master/existing branch or path; paths confined; hooks never run | 12 tests incl. traversal, symlink escape, hooks | `tests/worktrees.test.mjs` (EV-1) |
| P3-R4 | Repository writes need a live claim; commit and push re-verify with the ledger; no force-push | stale ledger answer blocks commit and push; non-fast-forward is `push_rejected` | `tests/worktrees.test.mjs` (EV-1) |
| P3-R5 | Jobs run only detected recipes, without shell, detached, bounded, cancellable, secrets filtered | 12 tests incl. cancel, timeout, interrupted, env filter, ownership | `tests/jobs.test.mjs` (EV-1) |
| P3-R6 | `github_*` reads limited to registered repositories; `github_create_pr` gated by claim, origin, default branch, pushed branch, ledger verify; never merges | 16 tests incl. 16 refusals and mutation checks | `tests/github.test.mjs` (EV-1) |
| P3-R7 | Host capabilities/resources and audit reads, authorization first, own events only without `coordinator:audit` | 17 tests | `tests/hosts-audit.test.mjs` (EV-1) |
| P3-R8 | Single entry point wiring through `getRuntime()`; `bridge_info` lists exactly the registered tools; version 0.4.0 everywhere | smoke asserts the exact sorted 48-tool list and `bridge_info.allowed_tools` | `npm run smoke` (EV-2) |
| P3-R9 | Bundled round trip: workspace_open, task_claim, worktree_create, worktree_write_file, jobs_submit test, job succeeded, worktree_commit, worktree_push (checkpoint `remote`), task_complete, worktree_remove, workspace_close; journal has every write | passes against `plugin/server/dist` | `npm run smoke` (EV-2) |
| P3-R10 | The job runner ships as a second bundle and is installed next to the server | build emits `dist/job-runner.mjs`; install copies both; smoke fails without it | EV-3, EV-4 |
| P3-R11 | No test touches real user state | every runtime in tests has a temporary stateDir; smoke uses temporary registry, state, worktrees, Git config and an offline GitHub | inspection (EV-5) |
| P3-R12 | Docs: README by phase, RUNNER.md, SECURITY.md capabilities, client skill flow | written | inspection (EV-5) |
| P3-R13 | CI green on Node 22 and 24 with the real ledger offline | CI run on the pull request | **pending: branch not pushed** |
| P3-R14 | Owner runs one real Issue end to end through the installed bundle | manual acceptance | **pending: owner** |

### Evidence

- EV-1 (2026-10-13): `npm test` -> tests 114, pass 114, fail 0, skipped 0 (governance checkout present, so ledger tests ran).
- EV-2 (2026-10-13): `npm run smoke` -> `{"ok":true,"tools":48,"roundTrip":true,"githubCreatePr":"skipped: needs real GitHub"}`.
- EV-3 (2026-10-13): `npm run build` emits `plugin/server/dist/index.mjs` and `plugin/server/dist/job-runner.mjs`; `MEMO_BRIDGE_INSTALL_DIR=<scratch> node scripts/install-local.mjs` installed both plus `VERSION` 0.4.0.
- EV-4 (2026-10-13): mutation check, smoke with `dist/job-runner.mjs` removed fails on the job assertion (job not `succeeded`).
- EV-5: inspection of tests (`createRuntime` always with a temporary `stateDir`; git config sandboxed in worktree tests and smoke) and of the docs.
- Module mutation checks reported by the module agents: removing the claim-expiry check, the ledger verify or the default-branch refusal in `github_create_pr` fails tests; same for the blocking-label filter, expired-lease handling and `not_allowed` in `tasks_list`; removing the hooks setting fails the hooks test.

### Open (P1, blocks closure)

- P3-R13: push the branch and get CI green (not pushed, by instruction).
- P3-R14: owner's manual acceptance (below).
- Independent adversarial review of the integrated branch by an agent that did not write it (the module agents tested their own modules; this integration pass was not independent).

### Deferred (P2)

- `github_create_pr` against real GitHub is covered by a recording `gh` stub and a fake `gh` script only; the smoke skips it.
- SIGKILL escalation of `job_cancel` and of the runner is untested (SIGTERM always sufficed). The 5 MiB log cap is tested on the writer only. Only npm recipes were executed; swift, pytest, cargo, go and make are covered by detection tests.
- Store: no dedicated summary column (`task_complete` stores `completed: <summary>` in `claims.outcome`); `listEvents` has no op/outcome filter (audit_events scans the newest 5000 events); no claims lookup by issue.
- No cleanup of old job logs; `worktree_remove` does not run `git worktree prune` for folders deleted by hand.
- Git hooks are skipped for the owner's own hooks too (CI is the gate).
- Hub exposure, VPS runner, job queue (later phases). Codex plugin still on 0.1.1 and needs repackaging.

### Manual acceptance (owner)

1. `npm run install:local`, then restart one AI client registered on `~/.local/share/memo-bridge/stdio/index.mjs`.
2. `bridge_info`: version 0.4.0, 48 tools.
3. On a real `agent:ready` Issue of memo-bridge: `workspace_open`, `task_claim`, `worktree_create`, edit one file, `jobs_submit test` until `succeeded`, `worktree_commit`, `worktree_push` (checkpoint `remote`), `github_create_pr`.
4. Check the pull request on GitHub: right branch, `Closes #n`, commit under your name with no AI trailer; let the landing contract merge it.
5. `task_complete`, `worktree_remove`, `workspace_close`; `audit_events` for the Issue shows every step.

## History: Coordinator v1 (Phase 2, v0.3.0, merged as #12)

R1 to R11 of Coordinator v1 (one holder per Issue across processes, stale fences refused, server-derived identity, ledger governance gates, fenced Git-verified checkpoints, authorization before validation, private store, fail-closed ledger outage, bundled smoke, CI with the real ledger offline, no orphan lease on uncertain outcomes) were verified and merged. The adversarial review of #12 found four medium defects at the mirror/ledger boundary, all fixed with regression tests.
