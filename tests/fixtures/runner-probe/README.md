# Runner probe fixtures (Phase 4, test-only)

Two throwaway repositories whose `test` recipe exercises a `memo-job@<id>.service` unit on the VPS. They are fixtures, not pilot repositories, and they add nothing to the recipe allowlist: both are ordinary `npm test` repositories (argv `["npm", "test"]`, already in `BUILTIN_RECIPES` of `deploy/memo-runner-dispatch`). What they run comes from their own files, which is exactly the trust model of a real job.

| Folder | `npm test` runs | Acceptance |
|---|---|---|
| `isolation/` | `probe.mjs`: tries loopback ports 4000, 5000, 9443, 4096 (IPv4 and `::1`), 10.0.4.1 and 172.17.0.1, the Docker sockets, reads of `/var/lib/memo-bridge`, `/etc/credstore`, `/etc/github.env`, the runner state, spool and governance and the other `InaccessiblePaths=` of spec §3, writes outside the worktree; expects TCP to `github.com:443` and `registry.npmjs.org:443`, a write in the worktree and in `$MEMO_JOB_OUT`, no secret-looking variable, no privileged group, `NoNewPrivs: 1` and an empty `CapEff` | AC-P4-12 |
| `stress/` | `stress.mjs`, mode from `stress.config.json`: `sleep`, `cpu`, `memory`, `fork`, `disk`, `mixed` | AC-P4-16, AC-P4-18, AC-P4-19 |

## Output

`probe.mjs` prints one JSON line per check, then a summary:

```
{"check":"tcp_loopback_9443","expect":"deny","outcome":"pass","detail":"EPERM"}
{"summary":{"pass":35,"fail":0,"inconclusive":0,"job_id":"job_..."},"ok":true}
```

- `pass`: the expectation holds. For a denied TCP connection only `EPERM`/`EACCES` counts, which is what the cgroup filter of `IPAddressDeny=` should return (to verify in the TODO-P4-01 spike).
- `fail`: it does not. `ECONNREFUSED` on a denied address is a failure, because the packet got through.
- `inconclusive`: the result proves nothing either way (a timeout, an unexpected error).

The exit status is 0 only when every check passes. The probe never prints what it read, nor environment values, only names and error codes. Files it manages to create are removed at once.

`node probe.mjs --plan` lists the checks without running any.

## Using them on the VPS

1. Create a private scratch repository, for example `memolabs-dev/runner-probe`, copy one folder into its root, and commit. Do not add these files to a pilot repository.
2. Register it as a project the runner may use, claim a scratch Issue, `worktree_create`, then `jobs_submit{recipe:"test"}`.
3. Read `job_results` (the probe output) and `job_status`. Attach the output and `systemd-analyze security memo-job@<id>.service` to the evidence of TODO-P4-31/32.

For `stress/`, edit `stress.config.json` in the worktree (`worktree_write_file`) before each run, inside the owner-approved window (O-7b):

| Run | Config | Expected end |
|---|---|---|
| Duration | `{"mode":"sleep","seconds":600}` with `timeout_seconds: 60` | `timed_out` within 95 s, cgroup empty |
| Duration, stubborn | `{"mode":"sleep","seconds":600,"ignore_sigterm":true}` with `timeout_seconds: 60` | `timed_out`, SIGKILL after `TimeoutStopSec` |
| Memory | `{"mode":"memory","target_mib":4096}` | `oom`, OOM kill only inside `memo-dev.slice` in `journalctl -k` |
| Tasks | `{"mode":"fork","max_processes":2000}` | spawns refused (`EAGAIN`) at `TasksMax`, job ends normally |
| Disk | `{"mode":"disk","total_mib":1536,"hold_seconds":600}` with the test cap at 1 GiB | `budget_exceeded` from the supervisor |
| Production | `{"mode":"mixed","workers":8,"seconds":600,"target_mib":2560}` | runs at the caps for 10 min while production probes stay green |

`stress.mjs` refuses to run outside a job unit (it needs Linux and `MEMO_JOB_ID`), so `npm test` in this folder on a laptop does nothing. `node stress.mjs --dry-run` validates the config and prints the plan. The disk mode writes `memo-stress-fill.bin` in the worktree and removes it at the end unless `keep_file` is true; a job stopped mid-run leaves it for gc.

The deploy tests (`deploy/tests/test_dispatch.py`) check that the dispatcher accepts these fixtures as ordinary `npm test` worktrees, that `probe.mjs --plan` covers every AC-P4-12 target, and that `stress.mjs` validates its config and refuses to run outside a job unit.
