# VPS runner root helpers (Phase 4)

These are two small root programs between the unprivileged runtime (`memo-runner`) and systemd on the VPS. They implement design decisions D3 and D5 of `.agent/project/phase-4/spec.md` (TODO-P4-12). Both use only the Python 3 standard library and run with `python3 -I`. They never start a shell, and they log only ids and reason codes. The runtime side of the contract is `server/runners/executor-systemd.mjs` (TODO-P4-07).

| Source | Installed as | Owner, mode | Run by |
|---|---|---|---|
| `deploy/memo-runner-dispatch` | `/usr/local/lib/memo-runner/dispatch` | root:root 0755 | `memo-runner-dispatch.service` (a root oneshot started by `memo-runner-dispatch.path`), and `make memo-runner-status` with `--status` |
| `deploy/record-result` | `/usr/local/lib/memo-runner/record-result` | root:root 0755 | `ExecStopPost=+/usr/local/lib/memo-runner/record-result %i` in `memo-job@.service` |
| (config) | `/etc/memo-bridge/runner.json`, `"dispatch"` object | root:root 0644 | both |

lab-infra (TODO-P4-21) installs them from the pinned memo-bridge release and owns the units. memo-bridge deploys nothing itself.

## Flow

```
memo-runner (executor-systemd.mjs)           root                                   memo-job
----------------------------------           ----                                   --------
queue/.<id>.json.<pid>.<ms>.tmp, rename
  -> spool/queue/<id>.json      --path-->    dispatch: validate, busy check,
                                             jobs/<id>/{dispatch.json,out/},
                                             drop-in, systemctl start --no-block --> memo-job@<id>.service
                                             (refused: jobs/<id>/status.json,         job-runner: one of
                                              service_result dispatch_refused)        MEMO_JOB_ALLOWED_ARGV
unlink queue/<id>.json (if not taken),
write spool/cancel/<id>         --path-->    dispatch: cancel.json marker,
                                             systemctl stop --no-block ------------> SIGTERM, then SIGKILL
                                                                                     ExecStopPost=+record-result
read jobs/<id>/status.json  <--------------  record-result: status.json from $SERVICE_RESULT, $EXIT_CODE, $EXIT_STATUS
```

`<id>` is the **dispatch id**: `^[a-z0-9-]{8,64}$` (REQ-P4-11). The executor derives it as `j` plus 31 hex characters of `sha256(job id)`, because a phase-3 job id (`job_` plus base64url) has uppercase letters and `_`. The unit is `memo-job@<id>.service`, and the job folder is `jobs/<id>/`.

The runtime store stays the owner of the queue (D4). It writes a start request only after it has decided to dispatch, and only one at a time. The dispatcher checks everything again, as if memo-runner were compromised (risk R-P4-08).

## Spool contract

**Start request** `spool/queue/<id>.json`. It is at most 4 KiB, owned by memo-runner, with one link, and has exactly these keys:

```json
{"version": 1, "id": "j0f3c...", "job_id": "job_AbCdEfGh12345678", "recipe": "test",
 "worktree": "/var/lib/memo-runner/worktrees/memo-bridge/agent-12-abcd", "timeout_seconds": 900}
```

| Key | Rule | Refusal reason |
|---|---|---|
| file name | `<id>.json`, with `<id>` matching `[a-z0-9][a-z0-9-]{7,63}` (the REQ-P4-11 pattern without a leading `-`) | `invalid_name` |
| entry | a regular file (no symlink, FIFO, socket or folder), owned by memo-runner, `st_nlink == 1`, at most 4 KiB | `not_regular_file`, `bad_owner`, `hardlinked`, `too_large` |
| body | a strict JSON object: UTF-8, no duplicate key, no NaN, exactly the six keys. An `argv` key, unit properties or environment count as extra keys | `malformed_json`, `invalid_schema` |
| `version` | the integer 1 | `unsupported_version` |
| `id` | equal to the id in the file name | `id_mismatch` |
| `job_id` | the phase-3 job id, `job_[A-Za-z0-9_-]{16}` | `invalid_job_id` |
| `recipe` | `test`, `build` or `lint`, with at least one allowlisted argv shape | `recipe_not_allowed` |
| `timeout_seconds` | an integer from 1 to `max_timeout_seconds` (at most 3600) | `invalid_timeout` |
| `worktree` | absolute and normalized; exactly `<root>/worktrees/<project>/<branch dir>`, each part matching `[A-Za-z0-9][A-Za-z0-9._-]{0,199}`; no symlink in any component (`realpath` equals the path); a folder owned by memo-runner that holds a `.git` file (a linked worktree) | `worktree_invalid_path`, `worktree_escape`, `worktree_outside_root`, `worktree_symlink`, `worktree_missing`, `worktree_bad_owner`, `worktree_not_linked`, `worktree_root_invalid` |

Other refusals:

- `host_busy`: a `memo-job@*.service` is active, activating, deactivating or reloading, or has a pending job, or another one started earlier in the same run.
- `busy_check_failed`: systemctl could not answer, so the dispatcher fails closed.
- `already_dispatched`: a previous `dispatch.json` says `starting`, `started` or `cancelled_before_start`. A retry never starts a second unit.
- `dropin_not_loaded`, `start_failed`, `prepare_failed`.

**Temporary files.** The executor writes `.<name>.<pid>.<ms>.tmp` in the spool folder itself, then renames it. The dispatcher leaves such a file alone while it is younger than 60 s and waits up to 2 s for the rename before it exits. Without that wait, the path unit would start the service again at once until a start limit failed it. An older temporary file is refused as `invalid_name` and removed. Any other name that is not `<id>.json` is refused and removed as well.

**Cancel** `spool/cancel/<id>`. It is either empty (reason `cancelled`, which is what the executor writes) or at most 1 KiB of strict JSON `{"version":1,"id":"<id>","reason":"<reason>"}`. The reason is one of `cancelled`, `stale_lease`, `budget_exceeded`, `no_live_claim`, `workspace_closed`, `worktree_removed` or `runtime_shutdown`. Cancels are processed before start requests, so a cancel written together with its request wins. A cancel for an id the dispatcher never saw stops nothing (`cancel_unknown_job`). This is the usual case for a queued job, because the executor withdraws the request itself before it writes the cancel.

**The request carries no command.** The recipe name selects the allowlisted argv shapes, and the dispatcher pins them into the unit's environment (`MEMO_JOB_ALLOWED_ARGV`). The shapes are built in, and `runner.json` may narrow them but never widen them:

| Recipe | Shapes |
|---|---|
| test | `npm test`, `python3 -m pytest -q`, `cargo test`, `go test ./...`, `make test` |
| build | `npm run build`, `cargo build`, `go build ./...`, `make build` |
| lint | `npm run lint` |

This is the phase-3 table of `server/runners/recipes.mjs` without SwiftPM, since there is no Swift on the VPS. The job-runner inside the unit (`server/runners/job-unit.mjs`) runs `detectRecipes(worktree)[recipe]`, as in phase 3, and **refuses to run** (exit 2, nothing started) when the result is not one of the `MEMO_JOB_ALLOWED_ARGV` shapes (`tests/job-unit.test.mjs`). The test fixtures in `tests/fixtures/runner-probe/` are ordinary `npm test` repositories and add nothing to this table.

## What the dispatcher writes

All of this goes under `/var/lib/memo-runner/jobs/<id>/`, which the dispatcher creates as root:memo-runner **0751**, except the drop-in, which goes in `/run/systemd/system`.

| File | Owner, mode | Content |
|---|---|---|
| `dispatch.json` | root:memo-runner 0640 | `{"version":1,"id","job_id","unit","outcome","recipe","allowed_argv","worktree","timeout_seconds","at"}`. `outcome` is one of: `starting` (written just before `systemctl start`), `started`, `refused` (with `"error":"dispatch_refused","reason"`), or `cancelled_before_start` (with `"reason"`) |
| `status.json` | root:memo-runner 0640 | Written only when no unit was started: `{"version":1,"id","job_id","unit":null,"service_result":"dispatch_refused","exit_code":null,"exit_status":null,"status":"failed"` (or `"cancelled"`), `"reason","ended_at",...}`. The executor reads this as the end of the job. A later successful start of the same id removes it first. A duplicate request never writes it |
| `cancel.json` | root:memo-runner 0640 | `{"version":1,"id","reason","requested_at"}`, written before `systemctl stop`. The first reason is kept |
| `out/` | memo-job:memo-runner 0750 | The job's own output (`out/job.log` for the executor). The job writes it, and memo-runner reads it as untrusted data |
| `/run/systemd/system/memo-job@<id>.service.d/50-dispatch.conf` | root 0644 | See below. record-result removes it |

The drop-in carries the per-job settings that a template cannot express with `%i`:

```ini
[Service]
WorkingDirectory=<worktree>
ReadWritePaths=<worktree> /var/lib/memo-runner/jobs/<id>/out
RuntimeMaxSec=<timeout_seconds>
Environment=MEMO_JOB_ID=<job_id> MEMO_JOB_DISPATCH_ID=<id> MEMO_JOB_RECIPE=<recipe> MEMO_JOB_ALLOWED_ARGV=npm:test,make:test MEMO_JOB_WORKTREE=<worktree> MEMO_JOB_OUT=<out> MEMO_JOB_TIMEOUT_SECONDS=<n>
```

`MEMO_JOB_ALLOWED_ARGV` joins tokens with `:` and shapes with `,`. Every value is checked against `[A-Za-z0-9._/@-]`, so nothing needs quoting and no `%` specifier or `$` expansion can appear. The drop-in never sets `ExecStart=`, `User=` or any sandboxing option. Those live only in the lab-infra template.

Before it starts the unit, the dispatcher runs `systemctl show --property=DropInPaths --value memo-job@<id>.service` and checks that systemd sees the drop-in. If it does not, the dispatcher issues one `daemon-reload` and checks again. If systemd still does not see it, the request is refused as `dropin_not_loaded`.

**Deviation from spec §3:** `jobs/` and `jobs/<id>/` are 0751, not 0750. memo-job is not in the memo-runner group, and it must traverse both folders to reach `out/` by its exact path. The `x` bit for others allows that without letting it list them. `dispatch.json`, `cancel.json` and `status.json` stay 0640. The alternative is a `BindPaths=` of `out/` in the job template.

## record-result

The `+` prefix of `ExecStopPost=` runs it with full privileges and without the unit's filesystem namespacing. It runs after the main process and the whole control group are gone. It writes `jobs/<id>/status.json` atomically, as root:memo-runner 0640:

```json
{"version":1,"id":"j0f3c...","job_id":"job_AbCdEfGh12345678","unit":"memo-job@j0f3c....service",
 "service_result":"timeout","exit_code":"killed","exit_status":"TERM",
 "status":"timed_out","reason":"runtime_max_sec","cancel_reason":null,
 "invocation_id":"<32 hex>","started_at":null,"ended_at":"2026-10-14T00:00:00.000Z"}
```

The executor relies on `version`, `id`, `service_result`, `exit_code`, `exit_status` and `ended_at`, and maps them itself. An unknown `$SERVICE_RESULT` is written as `resources` (the documented catch-all). An unknown `$EXIT_CODE` or `$EXIT_STATUS` is written as `null`, so the executor never sees a value it would reject. `job_id` comes from `dispatch.json`. `status`, `reason` and `cancel_reason` are record-result's own reading, for operators and `--status`:

| Condition (first match wins) | `status` | `reason` |
|---|---|---|
| `SERVICE_RESULT=oom-kill` | `oom` | `oom_kill` |
| `cancel.json` present, reason `budget_exceeded` | `budget_exceeded` | `budget_exceeded` |
| `cancel.json` present, any other reason | `cancelled` | the reason |
| `SERVICE_RESULT=timeout` | `timed_out` | `runtime_max_sec` |
| `success`, `exited`, `0` | `succeeded` | null |
| `success`, `killed` (HUP, INT, TERM, PIPE) | `interrupted` | `stopped_externally` (an operator, a shutdown or a reboot) |
| `exit-code` | `failed` | `exit_status` |
| `signal`, `core-dump` | `failed` | `signal` |
| an unknown result | `failed` | `unknown_service_result` |
| anything else | `failed` | the result (`resources`, `protocol`, `watchdog`, `exec_condition`, `start_limit_hit`) |

The cancel marker matters because systemd counts a stop by `SIGTERM` as a clean exit. It wins over `timeout` because a stop that outlasts `TimeoutStopSec=` is also reported as `timeout` (inferred; still to verify). The job's output is never read.

## Configuration

`/etc/memo-bridge/runner.json` is shared with the runtime. The helpers read only its `"dispatch"` object, and the dispatcher refuses unknown keys in that object. The file must be owned by the user running the helper (root) and must not be writable by group or others.

```json
{
  "dispatch": {
    "root": "/var/lib/memo-runner",
    "runner_user": "memo-runner",
    "job_user": "memo-job",
    "max_timeout_seconds": 3600,
    "recipes": {"test": [["npm", "test"]], "lint": [["npm", "run", "lint"]], "build": []},
    "dropin_dir": "/run/systemd/system",
    "lock_path": "/run/memo-runner-dispatch/lock"
  }
}
```

All keys are optional. The values above are the defaults, except `recipes`, which defaults to the full built-in table. An empty list disables a recipe. When it runs as root, the dispatcher refuses a configuration where memo-runner or memo-job is root, or where both are the same user.

Before reading anything, the dispatcher checks the layout. If a check fails, it exits with status 2 and leaves the spool untouched:

- `root` and `jobs/` are owned by root and not writable by group or others.
- `spool/` is owned by root or memo-runner.
- `spool/queue` and `spool/cancel` are owned by memo-runner and not writable by group or others.
- None of them is a symlink.

All later opens go through directory file descriptors with `O_NOFOLLOW`.

## Units (lab-infra owns them: role `memo-bridge`, TODO-P4-21)

lab-infra declares the units (`ansible/roles/memo-bridge/templates/`, branch `feat/memo-bridge-role`, commit `117ff83`). What this code relies on in them:

| Unit | Line | Why |
|---|---|---|
| `memo-runner-dispatch.path` | `DirectoryNotEmpty=` on `spool/queue` and `spool/cancel` | wakes the dispatcher |
| `memo-runner-dispatch.service` | `ExecStart=/usr/bin/python3 -I /usr/local/lib/memo-runner/dispatch`, `Type=oneshot`, `ProtectSystem=full` | `/run` and `/var` stay writable for the drop-ins, the job folders and the lock. The unit has no `RuntimeDirectory=`, so the dispatcher creates `/run/memo-runner-dispatch` itself (0700, refused if it exists open to others) |
| `memo-job@.service` | `AssertPathExists=/run/systemd/system/memo-job@%i.service.d/50-dispatch.conf` | a unit without its drop-in never starts. `DROPIN_NAME` here must stay `50-dispatch.conf` |
| `memo-job@.service` | `ExecStart=/usr/bin/node /opt/memo-bridge/app/server/runners/job-runner.mjs --executor=systemd %i` | the unit mode of the job-runner (`server/runners/job-unit.mjs`): it checks the `MEMO_JOB_*` values against the instance and its working directory, re-detects the recipe and runs it only if it is one of `MEMO_JOB_ALLOWED_ARGV`, then appends the output to `jobs/<id>/out/job.log` itself (no `StandardOutput=append:`, which would write the same file twice) |
| `memo-job@.service` | `ExecStopPost=+/usr/local/lib/memo-runner/record-result %i`, `KillMode=control-group`, `TimeoutStopSec=30`, `RuntimeMaxSec=` (ceiling; the drop-in lowers it) | decision D5, REQ-P4-16 |
| `memo-bridge-runner.service` | `MEMO_BRIDGE_JOB_EXECUTOR=systemd`, `MEMO_BRIDGE_SPOOL_DIR=<root>/spool`, `MEMO_BRIDGE_JOBS_DIR=<root>/jobs` | the runtime refuses to start when these disagree with `<root>` (`MEMO_BRIDGE_RUNNER_ROOT`, default `/var/lib/memo-runner`), since the dispatcher only knows that layout |

Use `%i`, not `%I`, in the template, because `%I` would unescape `-` in a dispatch id into `/`.

The path unit checks its paths again whenever the service ends. While a folder is not empty, it starts the service again, and a start rate limit on the service then fails the path unit (systemd.path(5)). The dispatcher therefore removes every entry it processes, refused ones included. It handles up to 64 entries per folder per run, and the rest go on the next run, which starts at once. An entry it cannot remove, such as a non-empty folder planted in the spool, makes the path unit fail, and the watchdog heartbeat reports that.

## Journal

The helpers write stderr lines with a syslog priority prefix, for example `<4>memo-runner-dispatch: event=dispatch_refused kind=start id=j0f3c... reason=recipe_not_allowed`.

Dispatcher events:

- `job_started`
- `dispatch_refused`
- `job_stop_requested`
- `job_cancelled_before_start`
- `cancel_unknown_job`
- `dispatch_done` (counts, including `pending` temporary files)
- `dispatch_already_running`
- `dispatch_config_error`
- `spool_entry_stuck`
- `dispatch_internal_error`

record-result logs `job_result_recorded` and `job_result_not_recorded`.

An invalid name is logged as `id=invalid`, and any value outside `[A-Za-z0-9_.:@+-]` is replaced by a short hash. Request bodies, paths and command output are never logged.

## Status

```
/usr/local/lib/memo-runner/dispatch --status
```

This prints JSON and changes nothing. The fields are `queue_depth`, `cancel_pending`, `active_units`, `systemctl_ok`, `free_disk_bytes`, `last_result` (the newest `status.json`) and `last_dispatch` (the newest `dispatch.json`). It exits with status 1 when systemctl could not be asked. This is what `make memo-runner-status` should call over SSH.

## Tests

```
python3 -I -m unittest discover -s deploy/tests -v
```

`test_dispatch.py` and `test_record_result.py` use a temporary tree that stands in for `/var/lib/memo-runner`, `/run/systemd/system` and `runner.json`, and a fake `systemctl` first on `PATH` that records its argv. The current user plays root, memo-runner and memo-job, and ownership checks compare against the effective uid. No real unit is touched.

When `node` is installed, the tests also:

- drive the real `server/runners/executor-systemd.mjs` through launch, dispatch, record-result and `executor.result`, then stop and dispatch;
- check the fixtures in `tests/fixtures/runner-probe/`.

## systemd references and what is still to verify

These man pages were read on the VPS (systemd 257.13-1~deb13u1, Debian 13) on 2026-10-14:

- **systemd.exec(5), "Environment Variables Set or Propagated by the Service Manager".** `$SERVICE_RESULT` is one of `success`, `protocol`, `timeout`, `exit-code`, `signal`, `core-dump`, `watchdog`, `exec-condition`, `oom-kill`, `start-limit-hit` or `resources`. `$EXIT_CODE` is `exited`, `killed` or `dumped`. `$EXIT_STATUS` is a number or a signal name. All three are passed to `ExecStopPost=`.
- **systemd.service(5).**
  - The `+` executable prefix gives full privileges and no namespacing, but options that apply to the whole cgroup still apply.
  - `RuntimeMaxSec=`: the service is "terminated and put into a failure state".
  - `SuccessExitStatus=`: SIGHUP, SIGINT, SIGTERM and SIGPIPE count as clean exits.
- **systemd.unit(5).** Instance drop-in folders `foo@bar.service.d/` are read from `/run/systemd/system`, among other places.
- **systemd.exec(5), `ReadWritePaths=`.** Symlinks in the paths are resolved.
- **systemd.path(5).** The service is triggered again after it ends, and the start rate limit is propagated to the path unit.
- **systemctl(1).** `list-jobs [PATTERN...]`, `show`, `daemon-reload`.

To verify in the TODO-P4-01 spike before PR-B:

1. A never-loaded `memo-job@<id>` instance picks up a drop-in written just before `systemctl start` without a `daemon-reload`. This is inferred. The dispatcher checks `DropInPaths` and falls back to one `daemon-reload`.
2. A `RuntimeMaxSec=` overrun gives `SERVICE_RESULT=timeout`, and so does a stop that outlasts `TimeoutStopSec=`.
3. A cgroup OOM kill gives `SERVICE_RESULT=oom-kill` with the default `OOMPolicy=`.
4. `IPAddressDeny=` makes `connect()` fail with `EPERM`, which the isolation probe counts as a pass.
5. `systemctl` run from a `ProtectSystem=strict` oneshot reaches the manager, even though the socket lives on a read-only mount.
6. memo-runner owns the worktree and could swap it for a symlink between validation and the unit's namespace setup. `ReadWritePaths=` would then follow the symlink, and only memo-job's own file permissions would bound what it can write. Confirm on the spike that nothing writable by memo-job exists outside its worktree and `out/`.
