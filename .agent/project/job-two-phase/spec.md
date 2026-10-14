# Two-phase jobs on the VPS runner (install, then recipe without network)

Whole Project Protocol, short form. Branches: memo-bridge `feat/job-install-phase`,
lab-infra `feat/memo-job-private-network`. Started 2026-10-14 16:57 CEST.

## Intent

Make `test`, `build` and `lint` jobs work on the VPS runner. Evidence (job
`j1fe079aae9cc7a038bbd3560a6c0ada`, lab, 2026-10-14): no `node_modules` in a fresh worktree
(`ERR_MODULE_NOT_FOUND` for `ws`, `zod`), and loopback tests time out because the job unit
denies loopback on purpose (hub 9443 and 9445, Pocket ID, host services).

## Requirements and acceptance

| Id | Requirement | Acceptance | Evidence |
|---|---|---|---|
| R1 | Install only with a lockfile and no installed dependencies; fixed argv, never a shell | `detectInstall` table; skip on `node_modules` (dir or link), no lockfile, no package.json | tests/job-unit.test.mjs "install argv", mutations M1, M2 |
| R2 | pnpm when `packageManager` says pnpm or `pnpm-lock.yaml` exists, else `npm ci --ignore-scripts` | exact argv run by the unit | job-unit "install phase runs the fixed argv", M1, M9 |
| R3 | Install: internet as before, same user and write rule, bounded time, output in the job log, marked | install template network = old job unit; `TimeoutStartSec=600`; `[memo-bridge] phase install` lines | lab-infra InstallUnitTests, L4, L6; job-unit log asserts |
| R4 | Recipe in `PrivateNetwork=yes`, loopback works, no internet, no host service | template + drop-in `PrivateNetwork=yes`, `IPAddressDeny=any`, `IPAddressAllow=localhost`, slice without `localhost`; job-runner refuses unless only `lo` | test_dispatch private network, JobUnitTests, SliceTests, job-unit network test, M3, M4, L1, L2, L5 |
| R5 | Install failure is its own outcome | status `failed`, reason `install_failed` / `install_timeout`, unit `memo-job-install@` | test_record_result InstallPhaseTests, executor test, M5, M6 |
| R6 | Recipe never runs after a failed install | `Requires=` + `After=` on a oneshot install | JobUnitTests, L3, L6 |
| R7 | No writable state shared between jobs or users | corepack, pnpm store, npm cache, XDG folders in `jobs/<id>/cache` (memo-job 0750), writable in phase 1 only | job-unit env asserts, InstallUnitTests filesystem, M12 |
| R8 | The runtime follows both units | `show` merges both; deadline adds install bound; busy check, cancel and gc cover both | executor two-phase test, job-queue safety net, dispatch busy and stop tests, GcTests, M7, M8, M10, M11, L7 |
| R9 | Mac executor unchanged | no diff in `job-runner.mjs` Mac path, `sandbox.mjs`, `executor-local.mjs` | git diff |

## Work graph

All DONE with evidence above: T1 detectInstall, T2 job-unit phases and network check,
T3 executor/supervisor, T4 dispatcher, T5 record-result, T6 lab-infra templates and vars,
T7 gc, T8 docs, T9 mutation checks (memo-bridge 12/12, lab-infra 8/8 caught).
Open, outside this change: T10 deploy (owner), T11 runtime checks on lab (below).

## Risks

- Medium: phase 1 still runs repository-controlled package-manager configuration with the
  internet (`.npmrc`, `pnpm-workspace.yaml`, `.pnpmfile.cjs`). No wider than the single job
  unit before; `--ignore-pnpmfile` would narrow it but changes the agreed argv.
- Medium: inferred systemd behaviour not yet exercised on lab (list below).
- Low: one download of pnpm and the dependencies per job (no shared store, by choice).
- Low: each phase caps its own log, so `job.log` can reach twice `LOG_CAP_BYTES`.

## Runtime checks pending on lab

1. A test server on the recipe's private `127.0.0.1` answers; `/proc/self/net/dev` lists `lo` only.
2. The unit's `IPAddressAllow=localhost` is not overridden by `memo-dev.slice` once `localhost` is off it.
3. A failed install leaves `memo-job@<id>` with a `dependency` start failure, no ExecStopPost, and the status from `record-result --phase=install`.
4. `TimeoutStartSec=` overrun gives `SERVICE_RESULT=timeout`; a cancel during the install ends `cancelled`.
5. corepack fetches the pinned pnpm as memo-job into `jobs/<id>/cache/corepack`; `pnpm install` works under `SystemCallFilter=@system-service`.
6. The supervisor sees `dispatched -> running` when the install unit activates.

## Closure

READY_FOR_MANUAL_ACCEPTANCE once both branches are green; DONE after deploy and checks 1 to 6.
