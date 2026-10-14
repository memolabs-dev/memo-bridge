# Phase 4 specification: VPS runner (Memo Labs OS)

**Status:** SPECIFICATION. It moves to PLANNED once the blocking unknowns in §11 are closed.
**Scope:** Memo Labs OS master plan, Phase 4.
**Written:** 2026-10-13, read-only. I changed no file and ran nothing on the VPS beyond the discovery reports.

## 0. Sources and how much to trust each claim

**Files read**
- `/Users/memo/.agents/skills/whole-project-protocol/SKILL.md`
- `/Users/memo/Vault/1-Projects/memo-labs-os.md`
- `~/memolabs/workspace/decisions/2026-10-13-vps-independent-execution.md` (success criteria and rules)
- `~/memolabs/workspace/decisions/2026-10-13-multi-client-coordination.md` (cases 7 and 10)
- `phase-3/docs/HUB_SECURITY.md` and `phase-3/docs/OIDC_RESOURCE.md`
- `phase-3/server/runners/{recipes,jobs,hosts,worktrees}.mjs`, located with grep
- `server/coordinator/issue-lease.mjs:11`: `LEASE_TTL.max=1800`
- `memolabs-org-gh/scripts/issue_lease.py:14,37-58` and `issue_preflight.py:49-85`

**Facts from the three discovery reports** (vps, lab-infra, code). Each fact keeps the command or path that report cited.

**Master plan scenarios E, G and H.** I did not find the master plan text on disk. I used the definitions given in the brief and checked them against the "Critères de réussite" in `vps-independent-execution.md` and against cases 7 and 10 in `multi-client-coordination.md`:
- **E.** The VPS is autonomous: with the Mac off, the VPS accepts and runs an authorized task.
- **G.** An unauthorized request is refused and audited. Product users cannot reach the runner.
- **H.** A build that exceeds its budget is deferred or stopped, and production stays up.

**Unverified.** The systemd property semantics in this spec come from the reports and from systemd being version 257. Nobody has read the systemd docs for that version yet, and no property has been exercised. TODO-P4-01 covers this.

## 1. Intent

**Goal.** An owner-authorized client asks the VPS for a dev task. The VPS claims the Issue, prepares a worktree, runs one recipe job under a dedicated unprivileged identity with hard budgets, and keeps the lease alive. The client collects the results later. None of this needs the Mac. Production keeps priority throughout, and nothing reachable by a product user or an unauthorized principal can trigger execution.

**Non-goals for Phase 4**
- Public exposure, OIDC, and ChatGPT access. These are Phase 5. The hub stays on loopback.
- Autonomous pickup of `agent:ready` Issues, a scheduler, or Memo Director.
- LLM or agent sessions inside jobs. Jobs are recipes only (`RECIPE_NAMES = ['test','build','lint']`, `recipes.mjs:13`), so no model access is needed.
- Re-slicing or re-limiting production containers and permanent agents. That is a later owner decision; Phase 4 makes dev yield instead.
- Swift and Xcode work on the VPS.
- Moving `issue_lease.py` out of `.github`.
- More than one concurrent dev job.

**User-visible outcome.** With the Mac shut down, a client on the VPS (Claude Code remote-control, or a CLI over loopback with the owner credential) runs this sequence:
1. `workspace_open{host:vps}`
2. `task_claim`
3. `worktree_create`
4. `jobs_submit{recipe:test}`, which returns `queued`

Later, the same client or another one reads `job_status`, `job_events` and `job_results`. A job that blows its budget ends `timed_out`, `budget_exceeded` or `oom`, or waits as `deferred`. Production probes stay green.

**Constraints**
- Priority on the VPS: production, then permanent agents, then dev. Concurrency is 1.
- Dev jobs get no Docker socket, no production DB, no runner secrets, no private networks.
- Everything is declared in lab-infra Ansible. Files under `ansible/` need manual review and merge by Guillaume (`scripts/private_merge_gate.py:21`).
- Reuse the phase-3 runtime, store, worktrees, jobs and job-runner. Build no new engine.
- The GitHub lease ledger stays the only coordination shared across machines. The hub stays stateless.
- Hub hard gate: "Do not enable write-capable MCP tools until it is isolated", meaning the root emargo runner (`HUB_SECURITY.md`).

**Completion sentence.** Phase 4 is complete when, with the Mac powered off, an owner-authorized client on the VPS claims a pilot Issue, runs one sandboxed recipe job longer than the lease TTL, and collects its results and checkpoint. In the same run, an unauthorized principal and every product-side surface are refused and journaled, and a job that exceeds its CPU, memory, task, duration or disk budget is deferred or stopped while production probes stay green. Every step must be declared in lab-infra, with evidence.

## 2. Design decisions

The vps, lab-infra and code reports disagreed on several points. These decisions settle them.

| ID | Decision | Why | Rejected alternative |
|---|---|---|---|
| D1 | **The runtime lives on the VPS, behind the existing transport** (the code report's hybrid). `memo-bridge-vps-agent` becomes `memo-bridge-runner.service`: the existing `agent-cli` in `MEMO_BRIDGE_AGENT_MODE=runtime`, running `createRuntime({host:'vps'})`. | The state must be on the VPS for E. The hub stays a stateless router. The phase-3 runtime is reused, so there is no new engine. | Hub-side state, which would make the hub a second coordinator. A polling VPS instance, which would be a scheduler. |
| D2 | **Three identities.** `memo-bridge` (exists, uid 986) runs only the hub. A new `memo-runner` system user runs the runtime, the store, the ledger, git fetch/push and the agent key. A new `memo-job` system user runs recipe code and holds no credentials. None of them is in `docker` or `sudo`. | Recipe code is not a sandbox (`recipes.mjs:5-10`). Under the same UID, a job could read `/proc/<pid>/environ` or `/run/credentials` of the runtime (inferred). The hub is exposed in Phase 5, so it must not hold GitHub tokens. | Two identities (lab-infra report): the job would share a UID with whatever holds the tokens. |
| D3 | **Privilege crossing goes through a spool plus a root dispatcher triggered by a path unit.** `memo-runner` writes `spool/queue/<id>.json` and `spool/cancel/<id>`. `memo-runner-dispatch.path` triggers a root oneshot that re-validates and runs `systemctl start --no-block memo-job@<id>.service` (or `stop`). | No polkit on the VPS. sudo is blocked by `NoNewPrivileges`. The spool survives a reboot. This reuses the guardian "one root script" pattern. | Socket launcher (code report): adds a synchronous protocol and is not needed at concurrency 1. sudoers: needs `NoNewPrivileges=false`. |
| D4 | **The queue is owned by the runtime store** (SQLite, `jobs.status='queued'`), FIFO, concurrency 1. The dispatcher enforces "at most 1 active `memo-job@*`" a second time. | One owner for the queue state. Defense in depth. | Using the spool directory itself as the queue. |
| D5 | **Final job status comes from systemd, not from job output.** `ExecStopPost=+/usr/local/lib/memo-runner/record-result %i` writes `jobs/<id>/status.json` (root-owned) from `$SERVICE_RESULT`, `$EXIT_CODE` and `$EXIT_STATUS`. | The job cannot forge its own result. Timeout, OOM and cancel map cleanly. Semantics to verify (U-P4-03). | Trusting `job-runner.mjs` to write its own status. |
| D6 | **Two GitHub credentials, both loaded with `LoadCredential=` into `memo-runner.service` only.** `ledger-gh` has Contents RW on `memolabs-dev/.github`. `push-gh` has Contents RW on the pilot repos. Jobs get neither. | The ledger only calls `repos/memolabs-dev/.github/git/{ref,refs,commits}` (`issue_lease.py:47-58`) and GET on public pilot repos and Issues (`issue_preflight.py:71,77`). | `/etc/github.env` (shared by builders and autodeploy). One token for both uses. |
| D7 | **Soft disk budget.** Admission refuses a job below a free-disk threshold. The supervisor runs `du` on the job worktree on a fixed interval, stops the job past its cap, and a gc timer cleans up. | ext4 root has no quota (`findmnt`). | A hard loop-image filesystem. It stays available as an owner decision (O-D2). |
| D8 | **Dev yields; production is not touched.** `memo-dev.slice` gets a low weight plus hard caps. Production and agents keep the default `CPUWeight` and `IOWeight` of 100 (inferred defaults). | No production unit changes in Phase 4. | Creating `prod.slice` and `agents.slice` now. |
| D9 | **Phase 4 principals.** The owner bearer (exists) has full capabilities. A new read-only test bearer gets `read` only. The hub maps credential to principal. OIDC arrives in Phase 5 through `oidc.mjs`. | G needs a real second principal to prove a refusal. | Waiting for OIDC. |
| D10 | **The "other client" when the Mac is off** is a VPS-local MCP client on loopback: Claude Code remote-control or a CLI using the owner bearer. | The hub is loopback-only until Phase 5 (`HUB_SECURITY.md`). | ChatGPT, which is Phase 5. |
| D11 | **Worktrees on the VPS use the phase-3 `worktrees.mjs`** (`git worktree add`, `GIT_SAFETY` hooksPath=/dev/null, `worktrees.mjs:137`) with `MEMO_BRIDGE_WORKTREES_ROOT=/var/lib/memo-runner/worktrees`. The job unit sees only its own worktree as writable. The gitdir is read-only to the job. | Reuse. | A new `worktree-vps.mjs` with `--separate-git-dir`. Only if the U-P4-04 spike fails. |

## 3. Target system map

```
Client on VPS (Claude Code RC / CLI) --bearer, loopback--> memo-bridge-hub.service  [user memo-bridge]
                                                            127.0.0.1:9443, stateless, op registry v2
                                                                 | wss loopback, Ed25519 v1 handshake + hello v2
Mac agent (optional, SSH tunnel) ----------------------------+    v
                                         memo-bridge-runner.service  [user memo-runner]
                                         agent-cli runtime mode: store, coordinator, ledger client,
                                         worktrees, jobs, supervisor (queue, admission, lease renew, du)
                                           | write spool/queue|cancel          ^ read jobs/<id>/status.json, logs
                                           v                                   |
                                         memo-runner-dispatch.path -> .service  [root, oneshot, flock]
                                           | systemctl start|stop memo-job@<id>
                                           v
                                         memo-job@<id>.service  [user memo-job, Slice=memo-dev.slice]
                                         job-runner.mjs -> recipe argv, cwd = worktree, no creds
GitHub <-- ledger-gh (refs on .github) / push-gh (pilot repos) -- memo-runner only
```

| Component | Host and path | Identity | Limits and hardening | Owner repo |
|---|---|---|---|---|
| Hub | `/opt/memo-bridge/app`, pinned sha | memo-bridge | As today: `MemoryMax=256M`, `TasksMax=64`, `ProtectSystem=strict`, loopback 9443 | memo-bridge code, lab-infra unit |
| Runner (runtime) | Same app. State in `/var/lib/memo-runner/state` (0700) | memo-runner | `MemoryMax=512M`, `TasksMax=128`, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=yes`, `ReadWritePaths=/var/lib/memo-runner`, `LoadCredential=agent-key,ledger-gh,push-gh`, `CapabilityBoundingSet=`. Network: loopback 9443 and the internet | memo-bridge, lab-infra |
| Governance checkout | `/var/lib/memo-runner/governance` at a pinned ref, read-only to memo-runner | root-owned | `MEMO_BRIDGE_GOVERNANCE_ROOT` (`server/...:33`) | lab-infra |
| Dispatcher | `/usr/local/lib/memo-runner/dispatch` (installed from `memo-bridge/deploy/`) | root | `Type=oneshot`, `NoNewPrivileges`, `PrivateTmp`, `ProtectHome`, `UMask=0077`, `flock -n` | memo-bridge script, lab-infra unit |
| Job | `memo-job@.service`. cwd `/var/lib/memo-runner/worktrees/<wt>` | memo-job | **Per job:** `RuntimeMaxSec` set to the job timeout (max 3600), `KillMode=control-group`, `TimeoutStopSec=30`.<br>**Filesystem:** `ProtectSystem=strict`, `ProtectHome=tmpfs`, `PrivateTmp`, `PrivateDevices`, `ReadWritePaths=<wt>` plus `jobs/<id>/out`, `InaccessiblePaths` covering the docker sockets, `/etc/github.env`, `/etc/credstore`, `/var/lib/memo-bridge`, `/var/lib/memo-runner/{state,spool,governance}`, `/opt/stacks`, `/opt/data`, `/opt/imports`, `/opt/memo-bridge-auth`, `/var/backups/lab`.<br>**Network:** `IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 fc00::/7`.<br>**Privileges:** no credentials, `CapabilityBoundingSet=`, `RestrictSUIDSGID`, `RestrictNamespaces`, `NoNewPrivileges`, `Nice=10`.<br>**Environment:** `HOME` and `TMPDIR` private, `GIT_TERMINAL_PROMPT=0` | memo-bridge (job-runner), lab-infra (unit) |
| `memo-dev.slice` | systemd | n/a | `CPUQuota=200%`, `CPUWeight=20`, `IOWeight=10`, `MemoryHigh=2G`, `MemoryMax=3G`, `MemorySwapMax=0`, `TasksMax=512` | lab-infra |
| gc | `memo-runner-gc.timer`, daily | root | Purges worktrees and jobs older than N days; reports `work/` above 20 GiB | lab-infra |

**Measured basis for the limits.** 8 vCPU (`nproc`). 7.5 GiB RAM available and 4.5 GiB swap in use (`free -m`). 178 GiB free on `/` (`df -h`). Psi IO full avg10 about 0.96. About 40 containers have no limit (`docker inspect`). The proposed values are starting points (inferred) and get calibrated in TODO-P4-41.

**Paths and modes** (`/var/lib/memo-runner`)

| Path | Owner | Mode | Purpose |
|---|---|---|---|
| `/var/lib/memo-runner` | root | 0755 | Root of the tree |
| `state/` | memo-runner | 0700 | Store |
| `repos/` | memo-runner | 0750 | Clones |
| `worktrees/` | memo-runner:memo-job | 2770 | Worktrees, umask 0007 (pending U-P4-04) |
| `spool/{queue,cancel}` | memo-runner:root | 0700 | Hand-off to the dispatcher. Root reads it |
| `jobs/<id>/` | root:memo-runner | 0750 | Contains `out/` (memo-job, 0750) and `status.json` (root, 0640) |
| `governance/` | root | 0755 | Pinned ledger checkout |
| `/etc/credstore/memo-runner.*` | root | 0600 | Credentials |
| `/etc/memo-bridge/runner.json` | root | 0644 | Pilot repos, recipes, limits, thresholds |

### Job state machine (store, extends phase-3)

```
queued -> (admission ok) dispatched -> running -> succeeded | failed | timed_out | oom | budget_exceeded | cancelled
queued -> deferred(reason) -> queued     (pressure, disk, host busy; re-evaluated every 30 s)
queued -> cancelled                      (job_cancel before start)
running -> interrupted                   (runtime restart finds unit gone without status, or reboot)
running -> cancelled                     (job_cancel or stale_lease)
```

### Key flows

**Flow E**
1. `workspace_open{host:vps}`
2. `task_claim`. The ledger on the VPS runs with `ledger-gh`.
3. `worktree_create` at the checkpoint commit.
4. `jobs_submit` returns `{job_id, status:queued}`.
5. The supervisor runs admission and dispatches. While the job is active it renews the lease whenever `expires_at - now < ttl/3`.
6. `job_status`, `job_events` (cursor `after_seq`) and `job_results` (tail of at most 12 KiB).
7. `worktree_commit`, then `worktree_push` (runner, `push-gh`), then `task_checkpoint{durability:remote}`, then `task_release`.

**Flow G**
1. The hub authenticates the bearer and maps it to a principal.
2. Registry check: is the op in both the hub registry and the agent's advertised `ops`?
3. Capability check, then forward with the principal.
4. The runtime calls `authorize()` again.
5. The dispatcher validates again.

Each refusal is journaled with ts, principal id, op and reason code. No arguments and no secrets are logged.

**Flow H**
- **Admission:** free disk at least 40 GiB, MemAvailable at least 4 GiB, PSI below thresholds. Otherwise `deferred`.
- **Runtime caps:** the slice and unit caps apply. Duration overrun gives `timed_out`. Memory overrun kills inside the cgroup and gives `oom`. Task overrun makes `fork` fail inside the job only. Disk overrun makes the supervisor stop the job with `budget_exceeded`.

## 4. Specification details

- **Errors.** New codes: `unsupported_op`, `agent_disconnected`, `host_offline`, `deferred_pressure`, `deferred_disk`, `budget_exceeded`, `oom`, `interrupted`, `dispatch_refused`, `invalid_agent_response`. Existing codes stay: `stale_lease`, `no_live_claim`, `forbidden`, `ledger_unavailable`.
- **Recovery**
  - Runtime restart: reconcile on start. For each `running` job, read `systemctl show memo-job@id`, which works read-only via D-Bus without polkit (inferred, to verify), and the root `status.json`.
  - Hub restart: the agent reconnects with backoff from 1 s to 60 s, with jitter.
  - Reboot: running jobs become `interrupted`. Queued jobs stay queued.
  - Ledger outage: fails closed with `ledger_unavailable` (phase-3 R8).
- **Concurrency and idempotency**
  - Mutating ops carry `client_request_id`. The hub derives `sha256(principal|op|id)`, and the store table `requests` returns the first result on retry.
  - The `queued` to `dispatched` transition is a compare-and-set.
  - The dispatcher holds `flock -n` and counts active units.
- **Compatibility**
  - The v1 handshake and `host_status` are unchanged.
  - The Mac keeps the local executor through a `{launch, alive, stop, show}` interface extracted from `jobs.mjs:100-111,157,406,417`, and phase-3 tests stay green.
  - Store `SCHEMA_V3` lands after phase-3 v2.
  - The `MEMO_BRIDGE_MAX_JOBS` vs `MEMO_BRIDGE_JOB_CONCURRENCY` split is resolved to the `hosts.mjs` source.
- **Privacy**
  - Journals hold ids, op, reason and timings only. No file contents and no tokens.
  - Logs stay on the VPS under 0750. No product data is reachable by jobs.
- **Observability**
  - `host_resources` reports PSI, memory, disk, queue depth, the active job and ledger reachability.
  - `dispatch --status` and `make memo-runner-status`.
  - Units go into the `watchdog/files/heartbeat.sh` `is-failed` loop, and the timers into its timer loop.
  - Every job leaves a context record: project, issue, commit, branch, host, unit, limits.
- **Deployment and rollback**
  - PR-A adopts the existing units byte-identically, and `make check` must show an empty diff.
  - PR-B adds the runner.
  - Immediate rollback: `systemctl disable --now memo-runner-dispatch.path memo-runner-gc.timer`, stop `memo-job@*`, then switch `memo-bridge-runner` back to `memo-bridge-vps-agent`.
  - Full rollback: revert the PR, remove the units and `/etc/credstore/memo-runner.*`, and revoke the PATs.
  - Code rollback: deploy the previous `memo_bridge_version`.

## 5. Requirements

| ID | Requirement | Scenario |
|---|---|---|
| REQ-P4-01 | `memo-bridge-runner.service` runs the phase-3 runtime for host `vps` as `memo-runner`, with state in `/var/lib/memo-runner/state`. It has no runtime dependency on the Mac, the Mac agent or the tunnel. | E |
| REQ-P4-02 | The hub and agent speak protocol v2: shared op registry, hello with advertised ops, per-op timeouts (ledger ops at least 130 s), immediate `agent_disconnected` flush, `unsupported_op` instead of silence, ping every 15 s, an in-flight cap of 8, and the 16 KiB frame with pagination. | E, G |
| REQ-P4-03 | The ledger runs on the VPS: a pinned governance checkout, `gh` authenticated only through the `ledger-gh` credential, and a private `GH_CONFIG_DIR`. Claim, renew, checkpoint and release succeed with the Mac off. | E |
| REQ-P4-04 | A persistent FIFO queue in the store with concurrency 1. A job outlives the client connection. A second submit gets `queued`, not `host_busy`, on the VPS. | E, H |
| REQ-P4-05 | The supervisor renews the lease of every claim bound to a queued or running job. `stale_lease` cancels the job. `release_on_finish` is honoured. | E |
| REQ-P4-06 | Results can be collected after the client returns: status, exit, timings, limits, paginated events, bounded log tail, and the context record. | E |
| REQ-P4-07 | Mutating ops are idempotent by `client_request_id`. | E |
| REQ-P4-08 | Restart and reboot recovery: reconcile on start, `interrupted` made visible, and no orphan unit or lease. | E |
| REQ-P4-09 | Every Phase 4 artifact on the VPS is declared in lab-infra: users, dirs, units, slice, credential paths, the pinned app and governance versions, and the Makefile targets. The hand deployment is adopted first. Rollback is documented. | E, G |
| REQ-P4-10 | Authorization in depth: hub credential to principal to capabilities, a runtime `authorize()` re-check, and every refusal journaled. A read-only principal can read status but not submit, cancel, claim or push. | G |
| REQ-P4-11 | Only the root dispatcher starts or stops job units. It accepts only an id matching `^[a-z0-9-]{8,64}$`, a recipe in the allowlist, a realpath cwd under the worktrees root with no symlink, and unit properties taken from root-owned `runner.json`. Anything else gets `dispatch_refused` plus a journal entry. | G |
| REQ-P4-12 | Job isolation: user `memo-job` with no credentials and no docker/sudo group. The docker socket, production data, runner state, credentials and the bridge keys are inaccessible. Writes are limited to its worktree and output dir. Loopback and private ranges are unreachable. The environment is clean, with no `GH_TOKEN`. | G |
| REQ-P4-13 | Secrets: runner credentials are root 0600 in the credstore, exposed only through `LoadCredential` to `memo-runner.service`. They never appear in environment files, logs, `/etc/github.env` or job units. | G |
| REQ-P4-14 | No product path to the runner: the hub stays on loopback with no Traefik route, no container on the host network can reach 127.0.0.1:9443, and no product repo CI runs as root on the VPS before write ops are enabled on the hub (the HUB_SECURITY gate). | G |
| REQ-P4-15 | `memo-dev.slice` hard caps as in §3. Production and agent units are unchanged. | H |
| REQ-P4-16 | Per-job duration cap: `RuntimeMaxSec` equals the job timeout. On overrun the whole cgroup is killed within `TimeoutStopSec` plus 5 s, with status `timed_out`. | H |
| REQ-P4-17 | Admission defers a job (`deferred_*`, retried every 30 s, visible in status) when free disk, MemAvailable or PSI is past its threshold. | H |
| REQ-P4-18 | Disk budget: the supervisor stops a job whose worktree plus output exceeds 20 GiB (`budget_exceeded`). gc purges old artifacts and reports overruns. | H |
| REQ-P4-19 | Production stays healthy while a job runs at full budget: production probes stay green, no OOM kill happens outside `memo-dev.slice`, and production latency stays within the agreed margin. | H |
| REQ-P4-20 | Cancellation: a queued job becomes `cancelled` without starting. A running job is stopped through the dispatcher, ends `cancelled` within 35 s, and leaves no process in the cgroup. | H, E |
| REQ-P4-21 | Health: hub, runner, dispatcher and gc appear in the watchdog heartbeat. `dispatch --status` and `host_resources` report runner health. | E, H |
| REQ-P4-22 | The Mac runner is unaffected: the executor seam keeps local behavior, and phase-3 tests and smoke pass. | (regression) |

## 6. Acceptance criteria

Verification methods: **A** = automated (`node --test` offline with fake-gh, or pytest). **R** = runtime on the VPS. **I** = inspection. **M** = manual by the owner. Evidence is pending for every row.

| AC | REQ | Given / When / Then | Verify |
|---|---|---|---|
| AC-P4-01 | 01 | Given the runner deployed and the Mac launchd jobs `dev.memolabs.memo-bridge-{tunnel,agent}` booted out, when `host_status(vps)` and `workspace_open{host:vps}` are called through the hub, then both succeed, and `host_status(mac)` returns `host_offline`. | R |
| AC-P4-02 | 02 | Covered by `tests/agent-protocol.test.mjs` and `tests/hub-dispatch.test.mjs`:<ul><li>an op outside the registry is denied even if advertised;</li><li>an unknown op gets `unsupported_op`;</li><li>a disconnect flushes pending requests with `agent_disconnected` in under 100 ms;</li><li>a 120 s ledger op completes;</li><li>an oversize frame is rejected;</li><li>the in-flight cap holds.</li></ul> | A |
| AC-P4-03 | 03 | On the VPS with the Mac off, claim, renew, checkpoint and release a pilot Issue. The ledger ref history (`star-lease-v1/*`) shows writes by the runner token. `env -i runuser -u memo-runner gh auth status` exits 1, so no ambient credential exists. | R |
| AC-P4-04 | 04 | Submit two jobs. The second is `queued`, then runs after the first finishes, in FIFO order. Tested in `tests/job-queue.test.mjs` and repeated on the VPS. | A, R |
| AC-P4-05 | 05 | A job running 45 min with a 1800 s TTL keeps its lease (ledger expiry advances). A forced takeover makes the next renew return `stale_lease`, and the job is cancelled. Tested in `tests/lease-supervisor.test.mjs`, plus one VPS run past the TTL. | A, R |
| AC-P4-06 | 06 | After the client disconnects mid-job, a new session reads `job_status`, all `job_events` pages and the `job_results` tail, and gets the full context record. | A, R |
| AC-P4-07 | 07 | Retrying `jobs_submit` with the same `client_request_id` returns the same `job_id`, and only one unit is started. | A |
| AC-P4-08 | 08 | Restarting the runner mid-job leaves the job running and reconciled to its final state. Restarting the hub leads the agent to reconnect within 60 s. Killing the job unit while the runner is down gives `interrupted` on the next start. No lease is left orphaned. | A, R |
| AC-P4-09 | 09 | After PR-A, `make check` shows an empty diff on the two adopted units. After PR-B, `make check` is clean. `grep -rl memo-bridge ansible/` matches. The rollback steps run in a dry run. | I, R |
| AC-P4-10 | 10 | With the read-only bearer, `jobs_submit`, `job_cancel`, `task_claim` and `worktree_push` are refused at the hub, and a forged request sent straight to the runtime is refused there too. Both refusals appear in the journal with principal and reason. A missing or bad token gets 401. | A, R |
| AC-P4-11 | 11 | `deploy/tests/test_dispatch.py` rejects: a bad id, a recipe not on the allowlist, a cwd escaping through `..` or a symlink, extra properties, and a malformed JSON spec. Each rejection writes `dispatch_refused` and starts no unit. | A |
| AC-P4-12 | 12 | An isolation probe recipe on a fixture repo shows **failures** on loopback :4000, :5000, :9443 and :4096, on 10.0.4.1, on `/run/docker.sock`, on reading `/var/lib/memo-bridge`, `/etc/credstore` and `/etc/github.env`, and on writing outside the worktree. It shows **success** on `github.com:443` and `registry.npmjs.org`. `env` contains no `GH_TOKEN` or `GITHUB_TOKEN`. `id` shows no docker group. `systemd-analyze security memo-job@probe` output is attached. | R |
| AC-P4-13 | 13 | `stat` shows credentials root 0600. `systemctl show memo-job@x -p LoadCredential` is empty. `grep` of the journal and the job logs for token prefixes (`github_pat_`, `ghp_`) returns 0 hits. | I, R |
| AC-P4-14 | 14 | `ss -ltnp` shows 9443 on 127.0.0.1 only. The Traefik dynamic configuration has no route to 9443 or 9444. `docker ps` lists no container with `NetworkMode=host`, or each one found is justified. emargo and drop runners: `systemctl show -p User` is not root, or the unit is disabled. Mutating hub ops stay disabled until this AC passes. | I, R |
| AC-P4-15 | 15 | `systemctl show memo-dev.slice` shows the caps. A diff of `systemctl show` for production units before and after deploy shows no change. | I |
| AC-P4-16 | 16 | A job with a 60 s timeout running `sleep 600` ends `timed_out` within 95 s, and the cgroup is empty afterwards. | R |
| AC-P4-17 | 17 | Injected PSI, disk and memory values give `deferred_*` (test). On the VPS, a temporary `runner.json` threshold set above the current value defers a job until it is restored. | A, R |
| AC-P4-18 | 18 | A job that writes 21 GiB (with the test cap lowered to 1 GiB on the VPS) is stopped as `budget_exceeded`. gc removes a backdated worktree. | A, R |
| AC-P4-19 | 19 | In the owner-approved window, a CPU-plus-memory stress job runs at its caps for 10 min. During the window:<ul><li>guardian and autodeploy probes stay green;</li><li>production HTTP checks every 5 s stay 2xx, with p95 latency rising by less than an owner-set margin;</li><li>`journalctl -k` shows OOM kills only inside `memo-dev.slice`;</li><li>a fork bomb stops at `TasksMax` and a memory hog is OOM-killed inside the unit.</li></ul> | R, M |
| AC-P4-20 | 20 | Cancelling a queued job gives `cancelled` with no unit started. Cancelling a running job gives `cancelled` within 35 s, and `systemd-cgls` shows the slice empty. | A, R |
| AC-P4-21 | 21 | `heartbeat.sh` reports on the new units. Killing the dispatcher service makes it go red. `make memo-runner-status` prints queue depth, the active job, free disk and the last result. | R |
| AC-P4-22 | 22 | Full memo-bridge `npm test` and `npm run smoke` pass on Node 22 and 24. A Mac job with the local executor behaves as in phase-3. | A |

## 7. Coverage matrix

| Category | Status | Covered by |
|---|---|---|
| Core behavior | APPLICABLE | 01-06 |
| UX | APPLICABLE (MCP responses only) | 02 (errors stated explicitly) |
| Loading, progress | APPLICABLE | queued, deferred and running statuses; events |
| Empty states | APPLICABLE | `jobs_list` empty; empty queue status |
| Error states | APPLICABLE | §4 codes |
| Cancellation | APPLICABLE | 20 |
| Retries | APPLICABLE | 07, agent backoff |
| Persistence | APPLICABLE | 04, store v3 |
| Data integrity | APPLICABLE | 05 (fencing), D5 (status from systemd) |
| State restoration | APPLICABLE | 08 |
| Concurrency | APPLICABLE | 04, dispatcher flock |
| Idempotency | APPLICABLE | 07 |
| Authentication | APPLICABLE | 10 (bearer), Ed25519 agent. OIDC: N/A (Phase 5) |
| Authorization | APPLICABLE | 10, 11 |
| Privacy | APPLICABLE | 13, journals without content |
| Security | APPLICABLE | 11-14 |
| Accessibility | NOT APPLICABLE | no UI |
| Performance and resources | APPLICABLE | 15-19 |
| Scalability | NOT APPLICABLE | concurrency 1 by decision |
| Offline | APPLICABLE | 01 (Mac off). VPS off: Mac keeps working, per the existing design |
| Observability | APPLICABLE | 21 |
| Deployment and rollback | APPLICABLE | 09 |
| Migration | APPLICABLE | store v3; adopting hand-deployed units |
| Backward compatibility | APPLICABLE | 22, v1 handshake |
| Documentation | APPLICABLE | TODO-P4-17, 28 |
| i18n | NOT APPLICABLE | none |
| Model or LLM access in jobs | NOT APPLICABLE | non-goal |

## 8. Work graph

"phase-3" means branch `feat/phase-3-mac-runner` merged. P0 items block E, G or H. P1 items are required for closure. P2 items are follow-ups.

| ID | P | Repo | Task | Depends | Files | Verify |
|---|---|---|---|---|---|---|
| TODO-P4-01 | P0 | docs + VPS ops | Read the systemd 257 man pages (`systemd.exec(5)`, `systemd.resource-control(5)`, `systemd.service(5)`, `systemd.unit(5)` on credentials). Then run a spike on a transient unit (owner approval O-7a) or a Debian 13 VM. Cover: `IPAddressDeny` (BPF), `LoadCredential` from `/etc/credstore`, `ExecStopPost=+` variables, `RuntimeMaxSec` result=timeout, `MemorySwapMax` on a slice, and an unprivileged `systemctl show`. | none | spike notes in evidence | Closes U-P4-03 |
| TODO-P4-02 | P0 | memo-bridge | Wait for phase-3 to merge. Freeze the job-runner entrypoint, the recipes and the worktrees API. Resolve the concurrency env mismatch (`jobs.mjs:113-116` vs `hosts.mjs:25-30`). | phase-3 | `server/runners/{jobs,hosts}.mjs` | CI green. Closes U-P4-02 |
| TODO-P4-03 | P0 | memo-bridge | Op registry and envelope v2, with hello and `unsupported_op`. | 02 | new `bridge/ops.mjs`, `bridge/protocol.mjs` | AC-02 |
| TODO-P4-04 | P0 | memo-bridge | Hub: registry dispatch, per-op timeouts, pending flush, schema result check, principal map (owner plus read-only bearer, D9). | 03 | `bridge/hub.mjs`, `bridge/hub-cli.mjs` | AC-02, AC-10 |
| TODO-P4-05 | P0 | memo-bridge | Agent: op dispatcher, ping/pong, backoff, in-flight cap. agent-cli runtime mode, reading keys and tokens from `$CREDENTIALS_DIRECTORY`. | 03 | `bridge/agent.mjs`, `bridge/agent-cli.mjs` | AC-01, AC-02 |
| TODO-P4-06 | P0 | memo-bridge | `runtime.as(principal)` and `principalFromHub`. Runtime re-authorizes. | 02 | `server/runtime.mjs`, `server/coordinator/policy.mjs` | AC-10 |
| TODO-P4-07 | P0 | memo-bridge | Executor seam: extract the local executor, add a systemd executor (spool write, status read, cancel file). | 02, 01 | `server/runners/executor{,-local,-systemd}.mjs`, `jobs.mjs` | AC-20, AC-22 |
| TODO-P4-08 | P0 | memo-bridge | Store `SCHEMA_V3`: `requests` table, job fields `claim_id`, `unit`, `limits_json`, `release_on_finish`, `principal`, plus the `deferred` and `interrupted` states. | 02 | `server/coordinator/store.mjs` | AC-07, AC-08 |
| TODO-P4-09 | P0 | memo-bridge | Supervisor: FIFO, concurrency 1, admission from `resources.mjs` (PSI, meminfo, statfs), lease renewal, `release_on_finish`, reconcile on start, `du` budget. | 07, 08 | `server/runners/{supervisor,resources}.mjs` | AC-04, 05, 08, 17, 18 |
| TODO-P4-10 | P0 | memo-bridge | Ledger client: pass `GH_TOKEN` from the `ledger-gh` credential and a private `GH_CONFIG_DIR` to the python child only. | 05 | `server/coordinator/issue-lease.mjs` | AC-03 |
| TODO-P4-11 | P1 | memo-bridge | Runner-side commit and push with `push-gh` through `GIT_ASKPASS` reading the credential, keeping `GIT_SAFETY`. Checkpoint flow. | 05, 02 | `server/runners/worktrees.mjs` | AC-03 (checkpoint `remote`) |
| TODO-P4-12 | P0 | memo-bridge | Dispatcher (`python3 -I`, no shell) and `record-result` (`ExecStopPost`), with `--status`. | 01, 02 | new `deploy/memo-runner-dispatch`, `deploy/record-result` | AC-11, AC-16 |
| TODO-P4-13 | P0 | memo-bridge | Test suite: `agent-protocol`, `hub-dispatch`, `runtime-principal`, `executor-systemd` (fake systemctl), `job-queue`, `lease-supervisor`, `worktree-hooks` (a hook is never run by the runner), `deploy/tests/test_dispatch.py`. Wire `test:runner` and CI. | 03-12 | `tests/*`, `package.json` | AC-02, 04, 05, 07, 10, 11, 17, 18, 20, 22 |
| TODO-P4-14 | P1 | memo-bridge | Isolation probe and stress fixture recipes. Test-only; recipes are not added to the production allowlist. | 12 | `tests/fixtures/runner-probe/` | AC-12, AC-19 |
| TODO-P4-15 | P1 | memo-bridge | Release artifact: a pinned sha plus checksum consumed by lab-infra. | 13 | `package.json` scripts | AC-09 |
| TODO-P4-16 | P1 | memo-bridge | `host_resources` and `bridge_info` generated from the registry. | 04, 09 | `server/runners/hosts.mjs` | AC-21 |
| TODO-P4-17 | P1 | memo-bridge | Docs: new `docs/RUNNER_VPS.md`; update `HUB_SECURITY.md` (protocol v2, write gate status). | 13 | docs | I |
| TODO-P4-20 | P0 | lab-infra | **PR-A, adopt only:** user memo-bridge, dirs, two units byte-identical to live, `/opt/memo-bridge/app` pinned. | none (U-P4-06) | `ansible/roles/memo-bridge/{tasks,templates,handlers}`, `playbook.yml` | AC-09: empty `make check` diff |
| TODO-P4-21 | P0 | lab-infra | **PR-B:** users memo-runner and memo-job; `/var/lib/memo-runner` tree; `memo-dev.slice`; `memo-job@.service`; dispatch `.path`/`.service`; `memo-bridge-runner.service` replacing vps-agent; credstore tasks with `no_log` and an assert; governance checkout pinned; `runner.json`; group_vars `memo_runner_*`. | 20, 12, 15, 01, 04-U | `ansible/roles/memo-bridge/**`, `group_vars/lab.yml`, `test_memo_runner.py` | `scripts/tests.sh`, AC-15 |
| TODO-P4-22 | P1 | lab-infra | gc script and timer. | 21 | `roles/memo-bridge/files/memo-runner-gc` | AC-18 |
| TODO-P4-23 | P1 | lab-infra | Makefile: `deploy-memo-bridge`, `memo-runner-status`. Pass `MEMO_RUNNER_{LEDGER,PUSH}_GH_TOKEN` from the keychain into `check` and `deploy`. | 21 | `Makefile` | `make check` passes |
| TODO-P4-24 | P1 | lab-infra | Watchdog heartbeat: add the units and timers. | 21 | `roles/watchdog/files/heartbeat.sh` | AC-21 |
| TODO-P4-25 | P0 | lab-infra | **#161:** move the emargo runner to `github-runner-emargo` (uid 1004) using the `github-runner` role. Disable or remove the dead root drop runner. Verify the other runners listed in the Vault. Production-adjacent. | U-P4-05, O-5 | `roles/github-runner`, `group_vars/lab.yml` | AC-14 |
| TODO-P4-26 | P2 | infrastructure-guardian | `probe.sh` `unit_status` gets the new units, upstream first, then copied. | 24 | upstream repo | I |
| TODO-P4-27 | P2 | lab-infra | `AGENTS.md.j2` note: `/etc/github.env` is root-only and memo-runner uses its own credential. | 21 | `roles/agent-context/templates/AGENTS.md.j2` | I |
| TODO-P4-28 | P1 | lab-infra | Docs: `runner-standard.md` row, `make map` §5/§6, remove memo-bridge from "not in this repo". | 21 | docs | I |
| TODO-P4-30 | P0 | VPS ops | Deploy PR-A (O-6). Verify the units are unchanged and the hub is healthy (`/health` 200, 401 paths). | 20, O-4 | n/a | AC-09 |
| TODO-P4-31 | P0 | VPS ops | Deploy PR-B, run a `noop`/probe smoke, then `systemd-analyze security` on the runner and job units. | 21, 30, O-1, O-2 | n/a | AC-12, AC-13, AC-15 |
| TODO-P4-32 | P0 | VPS ops | G probes, plus the product-reachability checks (Traefik, host-network containers). | 31, 25 | n/a | AC-10, 11, 12, 14 |
| TODO-P4-33 | P0 | VPS ops | H tests in the approved window: timeout, OOM, fork bomb, disk cap, admission deferral, cancel, production probes and latency. | 31, O-7 | n/a | AC-16 to 20 |
| TODO-P4-34 | P0 | VPS ops | E end-to-end: Mac booted out, pilot Issue, job longer than the TTL, results, push, checkpoint, release. | 31, 11, O-7 | n/a | AC-01, 03, 05, 06 |
| TODO-P4-35 | P1 | VPS ops | Resilience: runner restart mid-job, hub restart, simulated interruption. A real reboot only with O-7c. | 31 | n/a | AC-08 |
| TODO-P4-40 | P1 | all | Enable mutating hub ops for the owner principal only, after AC-14 passes. | 25, 32 | `runner.json` / hub config | AC-14 gate |
| TODO-P4-41 | P1 | VPS ops | Calibrate the thresholds against a 24 h PSI and memory baseline. Record the values. | 31 | `group_vars` | AC-17 |
| TODO-P4-42 | P1 | orchestrator | Evidence, `state.json`, Vault update through `vault-commit.sh`, manual acceptance checklist. | all P0/P1 | `.agent/project/phase-4/*`, `memo-labs-os.md` | completion checksum |

**Critical path:** 01 and 02 → 03 to 13 → 20 → 21 → 30 → 31 → (25) → 32, 33, 34 → 40 → 42.

## 9. Owner-only actions (one batch)

1. **O-1. Ledger token.** Create a fine-grained PAT `memo-runner-ledger`.
   - Resource owner: memolabs-dev. Repository access: `memolabs-dev/.github` only.
   - Permissions: Contents read/write. Metadata read is mandatory.
   - Expiry: 30 to 90 days.
   - Store it: `security add-generic-password -a memo -s memo-runner-ledger-gh -w '<token>' -U`.
   - Scope basis: `issue_lease.py:47-58` only touches `repos/memolabs-dev/.github/git/*`. Preflight only GETs public pilot repos (`issue_preflight.py:71-85`). Fine-grained PATs reading public repos without an explicit grant is still to be verified against GitHub docs (U-P4-09).
2. **O-2. Push token.** Create a fine-grained PAT `memo-runner-push`.
   - Repository access: the pilot repos only (decide O-D3).
   - Permissions: Contents read/write. No Workflows, Administration or Pull requests.
   - Keychain service `memo-runner-push-gh`.
3. **O-3. Rulesets.** Protect `main` on `memolabs-dev/.github` and on each pilot repo (PR required, no direct push), so a leaked runner token cannot rewrite the governance scripts or a default branch. Lease refs under `refs/heads/star-lease-v1/*` must stay writable. Check this against the current merge contract.
4. **O-4. Review and merge the lab-infra PRs** by hand, since `ansible/` is protected: PR-A (adopt), PR-B (runner), PR-C (#161 emargo/drop runners). For memo-bridge PRs, approve any that touch `.github/workflows` (contract: workflows stay under human review).
5. **O-5. Production-adjacent approval for #161:**
   - a maintenance window to move the emargo GitHub runner off root, with its rollback;
   - removal or disabling of the dead root `drop` runner;
   - confirmation of which runners in the Vault list (factura, relay, veilleur) still exist.
6. **O-6. Deploys to the production host:** run `make deploy-memo-bridge` (needs the keychain tokens), or explicitly authorize an agent to run it, for PR-A and then PR-B.
7. **O-7. Test windows on the production host:**
   - (a) systemd spike with transient units (TODO-01);
   - (b) H stress test, 10 min at caps, with the acceptable production latency margin set by you;
   - (c) optional real reboot test;
   - (d) Mac-off test: shut down the Mac or boot out the launchd jobs.
8. **O-8. Decisions**
   - O-D1: identity names `memo-runner` and `memo-job`.
   - O-D2: soft disk budget (default) or a hard loop image.
   - O-D3: pilot repos for VPS jobs, which must be a subset of the ledger allowlist (memo-bridge, cuesheet, uni?).
   - O-D4: PATs now, or a GitHub App.
   - O-D5: which VPS client counts as "the other client" for E (Claude Code remote-control or a CLI).
   - O-D6: whether to remove the `GH_TOKEN`/`GITHUB_TOKEN` exports from `/root/.bashrc`. Optional: systemd units do not source it, but root shells leak it to `runuser`.
   - O-D7: accept the residual risk that root agents (opencode, claude-remote-control) can read runner credentials, or schedule moving them off root.
9. **O-9. Read-only test bearer:** approve its creation (D9) and where it is stored.
10. **O-10. Token rotation:** a calendar entry before expiry, and the revoke procedure noted in `docs/RUNNER_VPS.md`.
11. **O-11. Final manual acceptance** (§12).

## 10. Risk register

| ID | Risk | Severity | Mitigation | Owner TODO |
|---|---|---|---|---|
| R-P4-01 | The emargo runner runs as root, so any emargo CI job has root and can reach the runner credentials and hub. | Critical | #161 before write ops (gate AC-14) | 25, 40 |
| R-P4-02 | A dev job starves production; about 40 containers are unlimited and swap is already at 4.5 GiB. | High | Slice caps, `MemorySwapMax=0`, low weights, admission, AC-19 | 21, 33, 41 |
| R-P4-03 | The lease expires during a job (3600 s > 1800 s TTL) and two workers end up on one Issue. | High | Supervisor renewal and `stale_lease` cancel | 09 |
| R-P4-04 | The ledger token could push to `main` of `.github` and rewrite governance. | High | O-3 rulesets, separate token, short expiry | O-1, O-3 |
| R-P4-05 | Repo-controlled hooks or config get executed by runner-side git. | High | `GIT_SAFETY` (`worktrees.mjs:137`), gitdir read-only to the job, test | 13 |
| R-P4-06 | Disk fill on the shared ext4 that also holds production data. | High | Admission at 40 GiB, `du` cap, gc. Hard limit as O-D2 | 09, 22 |
| R-P4-07 | Root agents (opencode, claude-remote-control) can read the credstore. | Medium (owner tools) | Token scope and expiry, O-D7 | O-8 |
| R-P4-08 | A compromised memo-runner writes a malicious spool spec. | Medium | Dispatcher re-validation, properties from root `runner.json` only | 12 |
| R-P4-09 | Egress exfiltration of source code by a repo script. | Medium | Jobs hold no secrets, pilot repos are owner-controlled. Egress allowlist as P2 | n/a |
| R-P4-10 | `IPAddressDeny` or credential semantics differ from assumptions. | Medium | TODO-01 spike before PR-B, AC-12 probes | 01 |
| R-P4-11 | Drift between the hand deployment and lab-infra. | Medium | PR-A with an empty diff first | 20 |
| R-P4-12 | Phase-3 is still moving (uncommitted edits by other agents), causing merge conflicts. | Medium | Start after phase-3 merges; schema v3 after v2 | 02 |
| R-P4-13 | Shared-group worktree permissions leak, or git's `safe.directory` breaks. | Medium | U-P4-04 spike, fallback D11 | 01 |
| R-P4-14 | The stress or reboot test itself disturbs production. | Medium | Owner windows (O-7), caps proven first on a noop | 33 |
| R-P4-15 | System node/gh/git upgrades change job behavior. | Low | Record versions in the job context, pin in `runner.json` | 09 |
| R-P4-16 | Result payloads exceed 16 KiB. | Low | Pagination | 03 |

The protocol forbids closing with any Critical or High risk still open. R-P4-01 to R-P4-06 must each be at Medium or below, with evidence, before READY_FOR_MANUAL_ACCEPTANCE.

## 11. Unknowns

| ID | Unknown | Blocking? | How to resolve |
|---|---|---|---|
| U-P4-01 | Exact master plan wording for E, G and H; not found on disk. | No | The orchestrator pastes the master plan text. Any wording change updates the §5 mapping only. |
| U-P4-02 | Final phase-3 shapes: job-runner entrypoint and arguments, executor seam points, recipe set, worktree API. | Yes, for 03-12 | Read the merged `feat/phase-3-mac-runner` and its `.agent/project` state. |
| U-P4-03 | systemd 257 semantics: `IPAddressDeny` (cgroup BPF), `LoadCredential` lookup in `/etc/credstore`, `ExecStopPost=+` variables, `RuntimeMaxSec` result, `MemorySwapMax` on a slice, unprivileged `systemctl show`. | Yes, for 07, 12, 21 | TODO-01: man pages for 257, then a spike (O-7a) or a Debian 13 VM. |
| U-P4-04 | Worktree ownership between memo-runner and memo-job: shared group plus setgid plus umask 0007, or chown by the dispatcher. Includes git `safe.directory` behavior. | Yes, for 21 | Spike with both options on a pilot repo; measure the chown cost on node_modules. |
| U-P4-05 | Which root runners actually exist. The Vault lists factura, relay, veilleur, emargo and drop; the VPS shows only emargo (active) and drop (dead). | Yes, for 25 and the G gate | Read-only: `systemctl list-unit-files 'actions.runner*'`, `ps -eo user,cmd \| grep Runner.Listener`, lab-infra #161 thread. |
| U-P4-06 | Live hub auth mode and environment: bearer only, or `MEMO_BRIDGE_OIDC_SETTINGS` set (`hub-cli.mjs:8`). Also the exact live unit text for the byte-identical adoption. | Yes, for 20 and 04 | `systemctl cat memo-bridge-hub`, environment variable names only. |
| U-P4-07 | Do the pilot recipes need network or an install step (`npm ci`) inside the job? Are node_modules expected in the worktree? | Yes, for 34 | Read the full `recipes.mjs` plus a trial run of `test` on each pilot repo in a sandboxed unit. |
| U-P4-08 | Is any container on host networking, and so able to reach 127.0.0.1:9443? | Yes, for AC-14 | Read-only `docker ps -q \| xargs docker inspect -f '{{.Name}} {{.HostConfig.NetworkMode}}'`. |
| U-P4-09 | Can a fine-grained PAT read public repo metadata and Issues without listing the repo? | Yes, for O-1 scope | GitHub docs on fine-grained PAT permissions. If not, add Issues: read on the pilot repos. |
| U-P4-10 | Production health signal and baseline for AC-19: guardian output location, which endpoints, the latency margin. | Yes, for 33 | Read the guardian and `agents-observe` outputs (decision 3, "read rather than probe"), and the owner margin from O-7b. |
| U-P4-11 | Admission threshold values. | No | TODO-41 baseline. |
| U-P4-12 | Does reading `systemctl show` need anything beyond `AF_UNIX` in the runner sandbox? | No (folded into U-P4-03) | Spike. |

## 12. Verification plan and manual acceptance

**Automated.** memo-bridge CI on Node 22 and 24 (`npm test`, `test:runner`, `npm run smoke`, pytest for the dispatcher) and lab-infra `scripts/tests.sh` plus `make check`.

**Runtime.** TODO-P4-30 to 35, with evidence:
- journal excerpts;
- `systemctl show` dumps;
- `job_events` exports;
- ledger ref history;
- `systemd-analyze security` output;
- production probe logs.

**Independent pass.** A separate reviewer looks for the mirror-vs-authority boundary failures (Vault lesson from #12) at three points: supervisor vs ledger, store vs systemd, and spool vs dispatcher.

**Manual acceptance checklist for Guillaume**
1. With the Mac off, ask Claude Code on the VPS to run the tests of a pilot Issue. You get a job id and later see its results and checkpoint.
2. With the read-only credential, try to submit a job. It is refused, and the refusal appears in the audit journal.
3. Watch `make memo-runner-status` during the stress window. Production sites stay responsive and the job ends `timed_out` or `oom` on its own.
4. Cancel a running job. It stops in under 35 s.
5. Run the rollback steps in your head against `docs/RUNNER_VPS.md`. They are clear enough to apply at 3 a.m.

## 13. Proposed state.json

```json
{"phase":"SPECIFICATION","scope":"Phase 4 VPS runner","requirements":{"total":22,"covered":22},"acceptance":{"total":22,"verified":0,"pending":22,"failed":0},"todos":{"p0_open":19,"p1_open":12,"p2_open":2},"risks":{"critical_open":1,"high_open":5},"unknowns":{"blocking_open":9,"non_blocking_open":3},"verification":{"status":"not_started"},"ready_for_manual_acceptance":false}
```

Suggested location for this spec (not written, read-only run): `/Users/memo/projects/memo-bridge/.agent/project/phase-4/02-spec.md`, with a pointer from `/Users/memo/Vault/1-Projects/memo-labs-os.md` (build order steps 4 and 5) added through `vault-commit.sh`.