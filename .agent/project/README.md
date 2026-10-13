# Memo Bridge: protocol state

Ownership and decisions: Vault `1-Projects/memo-labs-os.md`. Contracts: `docs/COORDINATOR.md` (Phase 2), `docs/RUNNER.md` (Phase 3), `SECURITY.md`.

## Phase 2 alignment and Phase 3 (Mac runner), branch `feat/phase-3-mac-runner`, v0.4.0

Intent: an AI client takes a claimed GitHub Issue from start to pull request on the Mac through Memo Bridge alone: worktree, file edits, the repository's own tests, commit, push, pull request, release. Every repository write, job and pull request happens under a live claim, with no arbitrary shell, no default-branch write, no force-push, no merge.

Non-goals: hub exposure of these tools, a VPS runner, a job queue, a job sandbox outside macOS, merging.

Completion sentence: Phase 3 is complete when the bundled server exposes the 48-tool contract, the full Issue-to-push round trip passes against the bundle, every module's refusal paths are tested, docs describe what runs on the owner's machine, CI is green on the pull request, and the owner has accepted one real run.

### Requirements and acceptance

| ID | Requirement | Acceptance | Evidence |
|---|---|---|---|
| P3-R1 | Phase 2 contract names: `task_*`, `tasks_list`, `workspace_recover`, `task_complete`; old names gone and never authorized | renamed tools behave as before; old names refused | `tests/coordinator.test.mjs` (EV-1) |
| P3-R2 | Store schema v2 (worktrees, jobs, job_events) and in-place upgrade of a v1 store | schema version 2; a v1 file upgrades without data loss | `tests/coordinator-store-contract.test.mjs` (EV-1) |
| P3-R3 | Worktrees: create on a new branch from origin, refuse default/main/master/existing branch or path (without case, remote default read with ls-remote); paths confined; hooks never run; `.git` link verified; removal keeps ignored files and waits for jobs | 19 tests incl. traversal, symlink escape, hooks, case variants, narrow refspec, FIFO, redirected link | `tests/worktrees.test.mjs` (EV-1, EV-6) |
| P3-R4 | Repository writes need a live claim; commit and push re-verify with the ledger; no force-push; a push never takes over a remote branch it did not push | stale ledger answer blocks commit and push; non-fast-forward and foreign remote branch are `push_rejected` | `tests/worktrees.test.mjs` (EV-1, EV-6) |
| P3-R5 | Jobs run only detected recipes, without shell, detached, bounded, cancellable, inside the macOS job sandbox, allow-listed environment, every process stopped, tied to the claim lifecycle | 21 job tests + 6 sandbox tests incl. pD/pF attacks blocked end to end, detached grandchild, runner SIGTERM, deadline, close/release/expiry, version skew | `tests/jobs.test.mjs`, `tests/job-sandbox.test.mjs` (EV-6) |
| P3-R6 | `github_*` reads limited to registered repositories; `github_create_pr` gated by claim, origin, default branch, pushed branch, ledger verify; never merges | 16 tests incl. 16 refusals and mutation checks | `tests/github.test.mjs` (EV-1) |
| P3-R7 | Host capabilities/resources and audit reads, authorization first, own events only without `coordinator:audit` | 17 tests | `tests/hosts-audit.test.mjs` (EV-1) |
| P3-R8 | Single entry point wiring through `getRuntime()`; `bridge_info` lists exactly the registered tools; version 0.4.0 everywhere | smoke asserts the exact sorted 48-tool list and `bridge_info.allowed_tools` | `npm run smoke` (EV-2) |
| P3-R9 | Bundled round trip: workspace_open, task_claim, worktree_create, worktree_write_file, jobs_submit test, job succeeded, worktree_commit, worktree_push (checkpoint `remote`), task_complete, worktree_remove, workspace_close; journal has every write | passes against `plugin/server/dist` | `npm run smoke` (EV-2) |
| P3-R10 | The job runner ships as a second bundle and is installed next to the server | build emits `dist/job-runner.mjs`; install copies both; smoke fails without it | EV-3, EV-4 |
| P3-R11 | No test touches real user state | every runtime in tests has a temporary stateDir; smoke uses temporary registry, state, worktrees, Git config and an offline GitHub | inspection (EV-5) |
| P3-R12 | Docs: README by phase, RUNNER.md, SECURITY.md capabilities, client skill flow; every guarantee scoped (tools vs jobs), sandbox and residual risks stated | written; a test refuses the old unconditional claims | inspection (EV-5), `tests/job-sandbox.test.mjs` finding 4 (EV-6) |
| P3-R13 | CI green on Node 22 and 24 with the real ledger offline | CI run on the pull request | **pending: branch not pushed** |
| P3-R14 | Owner runs one real Issue end to end through the installed bundle | manual acceptance | **pending: owner** |

### Evidence

- EV-1 (2026-10-13): `npm test` -> tests 114, pass 114, fail 0, skipped 0 (governance checkout present, so ledger tests ran).
- EV-2 (2026-10-13): `npm run smoke` -> `{"ok":true,"tools":48,"roundTrip":true,"githubCreatePr":"skipped: needs real GitHub"}`.
- EV-3 (2026-10-13): `npm run build` emits `plugin/server/dist/index.mjs` and `plugin/server/dist/job-runner.mjs`; `MEMO_BRIDGE_INSTALL_DIR=<scratch> node scripts/install-local.mjs` installed both plus `VERSION` 0.4.0.
- EV-4 (2026-10-13): mutation check, smoke with `dist/job-runner.mjs` removed fails on the job assertion (job not `succeeded`).
- EV-5: inspection of tests (`createRuntime` always with a temporary `stateDir`; git config sandboxed in worktree tests and smoke) and of the docs.
- Module mutation checks reported by the module agents: removing the claim-expiry check, the ledger verify or the default-branch refusal in `github_create_pr` fails tests; same for the blocking-label filter, expired-lease handling and `not_allowed` in `tasks_list`; removing the hooks setting fails the hooks test.

- EV-6 (2026-10-14): fixes for the adversarial review of 933e759 (section below). `npm test` -> tests 136, pass 136, fail 0, skipped 0 (macOS 27.0.1, sandbox on); `MEMO_BRIDGE_JOB_SANDBOX=off node --test tests/jobs.test.mjs` -> 21/21 (the Linux CI path); `npm run build` emits both bundles; `npm run smoke` -> `{"ok":true,"tools":48,"roundTrip":true,...}` with the job sandboxed. Mutation checks: removing each fix (case folding, remote HEAD check, foreign remote branch check, sandbox wrapping, process tracking, SIGTERM handler, deadline, close cancelling jobs, runner claim check, ignored-files check, prose attribution pattern, non-blocking open, `.git` link check, protocol check, ledger verify at submit) makes its regression test fail.

### Adversarial review of 933e759 (2026-10-13): disposition

| Finding | Fix | Regression test |
|---|---|---|
| 1 HIGH case-variant branch overwrites local main | branch names compared without case against main/master/defaults; any case-insensitive match with a local or remote ref refused; onOwnBranch too | `worktrees.test.mjs` finding 1 |
| 2 HIGH push fast-forwards remote default or foreign branch | `git ls-remote --symref` before create and push: remote HEAD refused, remote branches checked without case, an existing remote branch must be at a commit this worktree pushed | `worktrees.test.mjs` finding 2 |
| 3 HIGH job = owner code execution | Seatbelt job sandbox (`server/runners/sandbox.mjs`), allow-listed env, per-job HOME/TMPDIR, Git without owner config, refused where no sandbox exists; `MEMO_BRIDGE_JOB_SANDBOX=off` documented as owner-equivalent | `job-sandbox.test.mjs` finding 3 (two tests) |
| 4 MEDIUM security contract false | SECURITY.md, README, RUNNER.md, server instructions, bridge_info, plugin.json, skill, tool descriptions scoped and rewritten; residual risks listed | `job-sandbox.test.mjs` finding 4 |
| 5 MEDIUM job outlives cancel/timeout | runner tracks the process tree with `ps` (250 ms) and kills every tracked process and group on stop and at exit | `jobs.test.mjs` finding 5 (two tests) |
| 6 MEDIUM runner SIGTERM leaves job unbounded | SIGTERM handler stops the job (`interrupted`, `runner_terminated`); reads kill and time out a job past timeout + 35 s | `jobs.test.mjs` finding 6 (two tests) |
| 7 MEDIUM jobs not tied to claim/workspace | workspace_close, task_release, task_complete cancel jobs; runner re-checks claim/workspace/worktree every ~5 s; worktree_remove refuses with `job_active` | `jobs.test.mjs` finding 7 (three tests), `worktrees.test.mjs` finding 7 |
| 8 MEDIUM remove deletes ignored files | ignored files listed (`ignored_files`), deleted only with `discard_ignored: true` | `worktrees.test.mjs` finding 8 |
| 9 LOW narrow attribution filter | any trailer naming an assistant, prose forms ("Written by", "Made with", "AI-generated"), anthropic noreply | `worktrees.test.mjs` finding 9 |
| P: FIFO hang | non-blocking open + fstat in status and read_file | `worktrees.test.mjs` FIFO |
| P: pgid reuse | signals from the server check the leader's recorded start time | `job-sandbox.test.mjs` safeToSignalGroup, `jobs.test.mjs` finding 6 deadline |
| P: version skew | runner protocol argument; mismatched or old-style launches refused (`runner_version_mismatch`) | `jobs.test.mjs` version skew |
| P: local-mirror-only | jobs_submit verifies with the ledger (file writes stay on the mirror, documented) | `jobs.test.mjs` asks the ledger |
| P: creation without claim | **left open**: worktree_create without `issue` is the documented read-only mode (RUNNER.md "Issue"); making `issue` mandatory changes the contract, owner decision | none |
| extra: redirected `.git` link (found while fixing 3) | `.git` must be a file pointing into `<project>/.git/worktrees/`; sandbox denies writing it | `worktrees.test.mjs` redirected link |

### Open (P1, blocks closure)

- P3-R13: push the branch and get CI green (not pushed, by instruction).
- P3-R14: owner's manual acceptance (below).
- Independent re-verification of the fixes above by an agent that did not write them (the first adversarial review ran on 933e759).
- Owner decision: should `worktree_create` require `issue` (no claimless branch/worktree creation)?

### Deferred (P2)

- `github_create_pr` against real GitHub is covered by a recording `gh` stub and a fake `gh` script only; the smoke skips it.
- SIGKILL escalation of `job_cancel` is covered for a job ignoring SIGTERM by the review's probe pH only. The 5 MiB log cap is tested on the writer only. Only npm recipes were executed; swift, pytest, cargo, go and make are covered by detection tests.
- Store: no dedicated summary column (`task_complete` stores `completed: <summary>` in `claims.outcome`); `listEvents` has no op/outcome filter (audit_events scans the newest 5000 events); no claims lookup by issue.
- No cleanup of old job logs; `worktree_remove` does not run `git worktree prune` for folders deleted by hand.
- Git hooks are skipped for the owner's own hooks too (CI is the gate).
- Hub exposure, VPS runner, job queue (later phases). Codex plugin still on 0.1.1 and needs repackaging.

### Manual acceptance (owner)

1. `npm run install:local`, then restart one AI client registered on `~/.local/share/memo-bridge/stdio/index.mjs`.
2. `bridge_info`: version 0.4.0, 48 tools, `runner.job_sandbox: "seatbelt"`.
3. On a real `agent:ready` Issue of memo-bridge: `workspace_open`, `task_claim`, `worktree_create`, edit one file, `jobs_submit test` until `succeeded`, `worktree_commit`, `worktree_push` (checkpoint `remote`), `github_create_pr`.
4. Check the pull request on GitHub: right branch, `Closes #n`, commit under your name with no AI trailer; let the landing contract merge it.
5. `task_complete`, `worktree_remove`, `workspace_close`; `audit_events` for the Issue shows every step.

## History: Coordinator v1 (Phase 2, v0.3.0, merged as #12)

R1 to R11 of Coordinator v1 (one holder per Issue across processes, stale fences refused, server-derived identity, ledger governance gates, fenced Git-verified checkpoints, authorization before validation, private store, fail-closed ledger outage, bundled smoke, CI with the real ledger offline, no orphan lease on uncertain outcomes) were verified and merged. The adversarial review of #12 found four medium defects at the mirror/ledger boundary, all fixed with regression tests.
