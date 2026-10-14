# Phase 4 evidence (VPS runner)

Spec: `spec.md` in this folder. State: `state.json`. Everything below was run on the owner's Mac (macOS 27, Node 24.21.0, Python 3.14) on 2026-10-14, branch `feat/phase-4-vps-runner`. Nothing was deployed. The VPS was only read (`systemctl --version`, `id`, `getent`, man pages, `ls`), by the module agents.

## What is verified locally, and how

| Evidence | Command | Result |
|---|---|---|
| EV-P4-1 full suite | `npm test` | 225 tests, 225 pass, 0 fail, 0 skipped |
| EV-P4-2 bundle | `npm run build` | `plugin/server/dist/index.mjs` and `job-runner.mjs` (unit mode included) |
| EV-P4-3 smoke | `npm run smoke` | `{"ok":true,"tools":48,"roundTrip":true,...}`; bridge_info 0.5.0, runner block `executor: local`, `queueing: false` |
| EV-P4-4 root helpers | `npm run test:deploy` (`python3 -I -B -m unittest discover -s deploy/tests`) | 110 run, OK |
| EV-P4-5 Phase 4 subset | `npm run test:runner` | 114 node tests pass + the 110 Python tests |
| EV-P4-6 hub subset | `npm run test:hub` | 23 pass |
| EV-P4-7 lab-infra (read-only run) | in `lab-infra/memo-bridge-role`: `python3 -B ansible/roles/memo-bridge/test_memo_runner.py`; `./scripts/tests.sh` | 48 OK; 111 green, 0 red; tree clean; commits `d218173` (PR-A) and `117ff83` (PR-B) present |
| EV-P4-8 integration mutations | each fix below removed, its test run, file restored | all caught: shared active statuses (worktrees), lab-infra runner.json shape, `agent.key` name, Mac `release_on_finish` refusal, unit argv allow-list gate, askpass copy, dispatcher lock folder |

Module agents' own evidence (their reports, re-run inside EV-P4-1/4/5): protocol 22/22, runtime 70/70, executor 62/62 + 25/25, dispatcher 107/107 (now 110 with the integration cases).

## Integration findings fixed by the integrator

Contract mismatches between the modules and lab-infra `117ff83`, each fixed on the memo-bridge side (lab-infra was not edited) and covered by a test:

1. **Drop-in name.** The dispatcher wrote `50-memo-dispatch.conf`; lab-infra's `memo-job@.service` asserts `50-dispatch.conf`, so every job unit would have refused to start. Renamed in `deploy/memo-runner-dispatch`, `deploy/record-result`, their tests and README.
2. **Job unit mode missing.** lab-infra runs `job-runner.mjs --executor=systemd %i`; nothing implemented it. New `server/runners/job-unit.mjs` (`tests/job-unit.test.mjs`): checks instance, drop-in values and cwd, re-detects the recipe, runs it only if allow-listed, clean env, log to `out/job.log` without following symlinks, ends by SIGTERM when stopped.
3. **Supervisor never started.** `bridge/agent-cli.mjs` runtime mode now starts it (`startSupervisorFromEnv`) and stops it on SIGTERM.
4. **Agent key name.** lab-infra loads `agent.key` and sets `MEMO_BRIDGE_AGENT_CONFIG=%d`; the runtime mode only read `agent-key`. Both accepted (`tests/hub-dispatch.test.mjs`, lab-infra layout run).
5. **Runner tree variables.** lab-infra sets `MEMO_BRIDGE_SPOOL_DIR` and `MEMO_BRIDGE_JOBS_DIR`; nothing read them. `runnerRootFromEnv` refuses any value other than `<root>/spool` and `<root>/jobs` (the dispatcher's only layout).
6. **runner.json shape.** lab-infra writes byte counts and flat PSI keys; the runtime silently used its defaults. `loadRunnerConfig` now reads both shapes, and the supervisor takes the retry and `du` intervals from it.
7. **Dispatcher lock folder.** lab-infra's dispatcher unit has no `RuntimeDirectory=`; the dispatcher now creates `/run/memo-runner-dispatch` (0700) and refuses an open one.
8. **Askpass not executable.** lab-infra copies `server/` with mode 0644; Git cannot run a non-executable `GIT_ASKPASS`. The runtime keeps a private 0700 copy under `<state>/bin`.
9. **Phase 4 statuses in Phase 3 code.** `worktree_remove`, `workspace_recover` and `host_resources` counted only `queued` and `running`; they now use the shared active statuses (`deferred`, `dispatched` included).
10. **Tool contract.** `jobs_submit` did not expose `client_request_id` or `release_on_finish`, so the hub registry (built from the tool schemas) could not pass them. Exposed; `release_on_finish` is refused on the Mac, where nothing would honour it.
11. **bridge_info** reports the runner block from `runnerInfo()` (TODO-P4-16).

## Acceptance status

| AC | Methods | Local evidence | Still needed |
|---|---|---|---|
| AC-P4-01 | R | runtime mode answers through the hub (`hub-dispatch` e2e) | VPS with the Mac booted out; hub unit needs `MEMO_BRIDGE_HUB_RUNTIME_HOST=vps` (lab-infra) |
| AC-P4-02 | A | **verified** (`agent-protocol`, `hub-dispatch`) | none |
| AC-P4-03 | R | offline: real `issue_lease.py` via fake gh, token only in the child (`credentials`) | VPS run with `ledger-gh`, `env -i runuser -u memo-runner gh auth status` |
| AC-P4-04 | A, R | A verified (`job-queue` AC-P4-04) | VPS repeat |
| AC-P4-05 | A, R | A verified (`lease-supervisor` AC-P4-05 x2) | VPS run past the TTL |
| AC-P4-06 | A, R | partial: status and log tail from `status.json`/log after the client is gone (`executor-systemd`, `job-queue` AC-P4-04) | all `job_events` pages from a new session; context record; VPS |
| AC-P4-07 | A | **verified** (`job-queue` AC-P4-07, dispatcher retried id, hub schema carries `client_request_id`) | none |
| AC-P4-08 | A, R | A verified (`job-queue` AC-P4-08) | runner and hub restarts on the VPS |
| AC-P4-09 | I, R | lab-infra byte identity tests; check-mode empty diff run by the lab-infra agent | `make check` after deploy |
| AC-P4-10 | A, R | A verified (hub and runtime refusals, journaled, 401) | VPS with the read-only bearer |
| AC-P4-11 | A | **verified** (`deploy/tests/test_dispatch.py`) | none |
| AC-P4-12 | R | probe fixture tested offline | VPS probe run, `systemd-analyze security` |
| AC-P4-13 | I, R | lab-infra declared-file tests; no token in git argv/env (`credentials`) | `stat`, `systemctl show`, journal grep on the VPS |
| AC-P4-14 | I, R | none | #161 and the reachability checks; gate closed |
| AC-P4-15 | I | lab-infra declared slice values | `systemctl show` on the VPS |
| AC-P4-16 | R | result mapping tested (dispatcher, executor) | 60 s job running `sleep 600` on the VPS |
| AC-P4-17 | A, R | A verified (`job-queue` AC-P4-17, lab-infra runner.json shape in `runner-integration`) | VPS threshold test |
| AC-P4-18 | A, R | A verified (`job-queue` AC-P4-18, lab-infra gc test) | VPS with the cap lowered |
| AC-P4-19 | R, M | stress fixture tested offline | owner window O-7b |
| AC-P4-20 | A, R | A verified (`job-queue`, `executor-systemd`, dispatcher) | VPS cancel timing, empty cgroup |
| AC-P4-21 | R | `--status` and `host_resources` tested; heartbeat declared | VPS |
| AC-P4-22 | A | Node 24: `npm test` 225/225 and smoke pass; Mac executor unchanged (Phase 3 tests green) | Node 22 in CI |

Fully verified: AC-P4-02, 07, 11. Automated part verified, runtime pending: 04, 05, 08, 10, 17, 18, 20, 22 (CI Node 22). Partial: 01, 03, 06, 09, 13, 15, 16, 21. Not started: 12, 14, 19.

## Not verified here, and why

- Anything that needs systemd 257 or the VPS (TODO-P4-01 spike, TODO-P4-30 to 35): owner windows O-6, O-7.
- Linux CI for the new tests: the branch is not pushed. The Python helpers have only run on macOS.
- Real GitHub tokens (O-1, O-2) and the write gate (#161, O-5).

## Verifier findings (second independent pass, 2026-10-14) and their fixes

Every fix has a regression test; each test was checked to fail with its fix removed (scratch mutation script, file restored after each run).

| Finding | Fix | Regression test |
|---|---|---|
| 1 HIGH: disk budget fails open (`du` timeout or partial reading ignored; no free-disk check while a job runs) | `supervisor.mjs` `checkBudgets`: a `du` that times out, fails or is partial is unmeasured; `max_unmeasured_readings` (default 3) in a row end the job `budget_exceeded`/`disk_unmeasurable`; a partial reading already over budget ends it at once; free disk on the runner tree below `min_free_disk_running_gib` (default 20 GiB, lab-infra `budgets.min_free_disk_running_bytes`) ends it on every tick (`disk_floor`) | `job-queue`: "AC-P4-18 fails closed", "AC-P4-18 free-disk floor" |
| 2 MEDIUM: `memo_runner_recipes` and `memo_runner_job_timeout_max_sec` had no effect | lab-infra `runner.json.j2` renders a `dispatch` section (root, users, `max_timeout_seconds`, `recipes`); the dispatcher accepts a list of recipe names; the runtime reads the narrowest recipes and ceiling and refuses at submit (`recipe_not_allowed`, `invalid_input`); template comments corrected (no `MemoryMax=`/`TasksMax=` in the drop-in) | `test_dispatch.py` `test_recipe_name_list_*`, `test_lab_infra_dispatch_section_lowers_the_timeout`; `job-queue` "verifier finding 2"; `runner-integration`; lab-infra `test_runner_json_dispatch_section_carries_the_limits` |
| 3 LOW: a job could make its own end look like an outside stop | `statusFromResult`: a signal ending (TERM counted clean by systemd, or KILL) is `failed` unless root's cancel marker says otherwise or the unit ended before the supervisor started (runner restart, reboot: `interrupted`, AC-P4-08); `record-result` writes `failed`/`stopped_by_signal` for success/killed | `executor-systemd` mapping test; `job-queue` "verifier finding 3" and AC-P4-08; `test_record_result.py` |
| 5 HIGH (plausible, confirmed by test): `.git` link swap between `locate()` and later Git calls | `locate()` returns the validated gitdir and common dir; every Git call of the op runs with `GIT_DIR`/`GIT_WORK_TREE` pinned; `worktree remove` runs from the validated common dir; `worktree_commit`/`worktree_push` refuse `job_active` while a VPS unit job waits or runs, before and after the ledger verify | `worktrees` "verifier finding 5" (a foreign clean filter never runs; the commit lands in the project repository) and the `job_active` test |
| 6 MEDIUM (plausible, confirmed by test): next dispatch while the previous unit is still deactivating fails as `host_busy` | `supervisor.mjs` `recentUnitBusy`: every recently ended unit must be seen inactive before a dispatch (`waiting_for_unit` in the status view) | `job-queue` "verifier finding 6" |
| 7 LOW: runtime granted `hub:owner` everything whatever the hub gate | `RUNTIME_DEFAULT_HUB_GRANTS` read-only for every hub principal; writes need `MEMO_BRIDGE_HUB_PRINCIPALS` on the runner as well as `MEMO_BRIDGE_HUB_MUTATING_OPS=owner` on the hub | `runtime-principal` "verifier finding 7" |
| 8 LOW: job network edges | lab-infra denies the host's public IPv4 and /64 to jobs; AF_UNIX kept (documented), the AC-P4-12 probe now reports listening abstract unix sockets (`/proc/net/unix`); read-only check on lab 2026-10-14: 0 abstract listeners, resolvers external | lab-infra `test_network_and_privileges`; `test_dispatch.py` probe tests |

Left open, with reason:
- `/var/lib/memo-bridge/agent/agent.key` readable by the hub user (finding 7, pre-Phase 4, live file adopted byte-identically by PR-A): owner decision, documented in `HUB_SECURITY.md` and lab-infra `docs/memo-runner.md`.
- Abstract-namespace unix sockets stay reachable in principle (finding 8): removing `AF_UNIX` would break Node, Python and Git; monitored by the probe.
- Integrator items not in the verifier's findings: hub `MEMO_BRIDGE_HUB_RUNTIME_HOST` (FU-1), pilot repositories on the VPS (FU-2), release checksum (FU-3), TODO-P4-01 spike.
