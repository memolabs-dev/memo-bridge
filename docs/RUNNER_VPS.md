# Memo Bridge VPS runner (Phase 4)

The VPS runner lets an owner-authorized client run a claimed task on the VPS while the Mac is off. The client goes through the private hub, and every step is the same tool as on the Mac: `workspace_open`, `task_claim`, `worktree_create`, `jobs_submit`, `job_status` / `job_events` / `job_results`, `worktree_commit`, `worktree_push`, `task_checkpoint`, `task_release`.

Specification: `.agent/project/phase-4/spec.md` (decisions D1 to D11, requirements REQ-P4-xx, acceptance AC-P4-xx). Deployment: lab-infra role `memo-bridge` (`docs/memo-runner.md` there). Root helpers: `deploy/README.md`.

**Status (v0.5.0).** The code is complete and tested offline. Nothing is deployed. The runner ships switched off in lab-infra (`memo_runner_enabled: false`). Whatever needs a real systemd, a real GitHub token or the VPS is listed under "Still to verify on the VPS" below.

## What runs where

```
Client on the VPS (Claude Code remote control or a CLI, owner bearer, loopback)
  -> memo-bridge-hub.service      user memo-bridge   127.0.0.1:9443, stateless router, protocol v2
  -> memo-bridge-runner.service   user memo-runner   agent-cli in runtime mode: store, coordinator,
                                                     ledger client, worktrees, job queue, supervisor
       writes spool/queue/<id>.json, spool/cancel/<id>; reads jobs/<id>/status.json and out/job.log
  -> memo-runner-dispatch.path -> .service   root, oneshot: re-validates, writes the drop-in,
                                             systemctl start|stop --no-block memo-job@<id>
  -> memo-job@<id>.service        user memo-job      job-runner.mjs --executor=systemd <id>,
                                                     memo-dev.slice, no credentials
GitHub <- installation tokens of the GitHub App memo-labs-automation, minted on demand from
          the app-key credential, one repository and the minimal permissions each (ledger on
          memolabs-dev/.github, push and pull requests on the pilot repos); fallback PATs
          ledger-gh and push-gh: memo-runner only
```

| Identity | Holds | Never |
|---|---|---|
| `memo-bridge` (hub) | TLS key, owner and read-only bearer digests, enrolled agent public keys | GitHub tokens, the store, any job |
| `memo-runner` (runtime) | the store (`/var/lib/memo-runner/state`), the agent key, the App key `app-key`, the fallback PATs `ledger-gh` and `push-gh` when present (all through `LoadCredential=`) | runs recipe code, starts units |
| root (dispatcher, `record-result`) | `systemctl start/stop` of `memo-job@*` only, job folders, drop-ins | reads tokens, runs recipe code |
| `memo-job` (job) | its worktree (write), its `out/` folder (write) | credentials, docker, sudo, loopback, private networks, runner state |

## Job lifecycle on the VPS

```
queued -> dispatched -> running -> succeeded | failed | timed_out | oom | budget_exceeded | cancelled | interrupted
queued <-> deferred (deferred_disk, deferred_pressure; re-admitted every retry interval)
queued | deferred -> cancelled (job_cancel before start: nothing is started)
```

1. `jobs_submit` refuses a recipe outside `runner.json` (`recipe_not_allowed`) and a timeout above its ceiling, then writes the job `queued` in the store and returns at once. It never answers `host_busy` on the VPS: jobs wait in a FIFO, one runs at a time (concurrency 1, `server/runners/hosts.mjs`). `client_request_id` makes a retry return the first job (store table `requests`). The hub derives `sha256(principal|op|client_request_id)` the same way.
2. The supervisor (`server/runners/supervisor.mjs`, in the runner process) admits the head of the queue only when free disk, MemAvailable and PSI are within `runner.json` limits (`server/runners/resources.mjs`). Otherwise the job is `deferred` with a reason. It also waits until systemd reports every recently ended job unit inactive: a unit still deactivating after its status was recorded would make the dispatcher refuse the next job as `host_busy`.
3. On admission it writes `spool/queue/<id>.json` atomically (`server/runners/executor-systemd.mjs`). `<id>` is the dispatch id, `j` plus 31 hex characters of `sha256(job id)`.
4. The root dispatcher re-checks everything (id, strict schema, owner, worktree path without symlink, recipe in the allow-list and timeout under the ceiling of the `runner.json` `dispatch` section, at most one active job unit) and starts `memo-job@<id>.service` with a runtime drop-in `50-dispatch.conf` (`deploy/memo-runner-dispatch`).
5. Inside the unit, `job-runner.mjs --executor=systemd <id>` (`server/runners/job-unit.mjs`) checks the drop-in values against its instance and working directory, re-detects the recipe argv and runs it only if it is one of the shapes the dispatcher allowed. It runs it without a shell and with an allow-listed environment, and writes the output to `jobs/<id>/out/job.log`. It decides no status.
6. When the unit ends, `ExecStopPost=+record-result` writes `jobs/<id>/status.json` as root from systemd's `$SERVICE_RESULT`, `$EXIT_CODE` and `$EXIT_STATUS` (decision D5). The supervisor reads it only when it is a root-owned, non-writable regular file. Output written by the job never sets a status.
7. While a job waits or runs, the supervisor renews its claim's lease once less than a third of the TTL is left. `stale_lease` cancels the claim's jobs. With `release_on_finish: true` the claim is released when its last job ends: `completed` on success, `cancelled` for cancelled or interrupted, `failed` otherwise.
8. The supervisor measures the worktree plus `out/` with `du` every `du_interval` and stops the job as `budget_exceeded` past the disk budget (`disk_budget`). The budget fails closed: the job owns what it writes and can make it unreadable to memo-runner or too slow to walk, so a `du` that times out, fails or is partial counts as unmeasured, and `max_unmeasured_readings` (default 3) in a row stop the job (`disk_unmeasurable`). Independently, on every tick, free disk on the runner tree below `min_free_disk_running_gib` (default 20 GiB) stops the running job (`disk_floor`): a `statfs(2)` the job cannot influence, so production keeps room whatever `du` says.
9. On start the supervisor reconciles: a unit that ended while the runner was down is settled from `status.json`, and one that vanished without a status becomes `interrupted`.

Status mapping (`statusFromResult`): `success` with exit 0 gives `succeeded`; `exit-code` gives `failed` with the exit code; `timeout` gives `timed_out`; `oom-kill` gives `oom`; root's cancel marker gives `cancelled` or `budget_exceeded`; a refused spool request gives `failed` (`dispatch_refused`), or `cancelled` when it was withdrawn before start. A job can end itself by any signal, including TERM (which systemd counts as a clean `success`) and KILL, so a signal ending gives `failed` (`signal_<NAME>`). The exception is a unit that ended by HUP, INT, TERM, PIPE or KILL while no supervisor was watching: root's `ended_at` is before the runner's supervisor started, so it was a runner restart or a reboot, and the job is `interrupted` (AC-P4-08). A job cannot choose when the runner is down.

## Authorization in depth (flow G)

1. The hub authenticates the bearer: the owner bearer maps to `hub:owner`, the optional read-only bearer to `hub:readonly`. A missing or bad token gets 401.
2. The op must be in the hub registry (`bridge/ops.mjs`) and advertised by the agent in its hello, or the answer is `unsupported_op`.
3. The hub checks the capability. Mutating ops are forwarded only with `MEMO_BRIDGE_HUB_MUTATING_OPS=owner`, which stays unset until the write gate passes (`docs/HUB_SECURITY.md`).
4. The runtime maps the principal id again with its own grants (`MEMO_BRIDGE_HUB_PRINCIPALS`) and calls `authorize()` again before reading the arguments (`bridge/agent.mjs`, `runtime.as(principal)`). Unset, the grants are read-only for both `hub:owner` and `hub:readonly` (`RUNTIME_DEFAULT_HUB_GRANTS`): the write gate is enforced on the runner too, so whoever holds the hub's TLS key cannot send mutating ops straight to the runner. Enabling writes (TODO-P4-40) takes both `MEMO_BRIDGE_HUB_MUTATING_OPS=owner` on the hub and `MEMO_BRIDGE_HUB_PRINCIPALS={"hub:owner":"owner","hub:readonly":"read"}` on the runner.
5. The dispatcher validates the spool request again (`deploy/memo-runner-dispatch`).

Every refusal is journaled with time, principal, op and reason code, never arguments or secrets.

## Configuration

`memo-bridge-runner.service` (lab-infra template) sets:

| Variable | Value | Read by |
|---|---|---|
| `MEMO_BRIDGE_AGENT_MODE` | `runtime` | `bridge/agent-cli.mjs` |
| `MEMO_BRIDGE_HOST` | `vps` | agent-cli (runtime mode is refused elsewhere) |
| `MEMO_BRIDGE_AGENT_CONFIG` | `%d` (the credentials directory) | agent-cli: `hub-ca.crt` |
| `MEMO_BRIDGE_JOB_EXECUTOR` | `systemd` | `executor.mjs`; starts the supervisor; refused off Linux |
| `MEMO_BRIDGE_RUNNER_CONFIG` | `/etc/memo-bridge/runner.json` | `resources.mjs` (admission, budgets, intervals) |
| `MEMO_BRIDGE_RUNNER_ROOT` | unset (default `/var/lib/memo-runner`) | executor and supervisor |
| `MEMO_BRIDGE_SPOOL_DIR`, `MEMO_BRIDGE_JOBS_DIR` | `<root>/spool`, `<root>/jobs` | checked only: any other value refuses to start, since the dispatcher knows only that layout |
| `MEMO_BRIDGE_STATE_DIR` | `<root>/state` | the store, the ledger's and pull requests' private `GH_CONFIG_DIR` (`ledger-gh/`, `gh-pr/`), the askpass copy (`bin/`), per-call App token files for Git (`askpass/`) |
| `MEMO_BRIDGE_GITHUB_APP_ID` | `5298579` | `server/integrations/github-app.mjs`: JWT issuer, checked against `GET /app` |
| `MEMO_BRIDGE_GITHUB_APP_INSTALLATION_ID` | `170927025` (installation on `memolabs-dev`) | the token endpoint |
| `MEMO_BRIDGE_GITHUB_APP_CLIENT_ID` | optional | JWT issuer instead of the App id (GitHub's recommendation), checked against `GET /app` |
| `MEMO_BRIDGE_GITHUB_APP_OWNER` | unset (default `memolabs-dev`) | tokens are only requested for repositories of this owner |
| `MEMO_BRIDGE_PROJECTS_ROOT`, `MEMO_BRIDGE_WORKTREES_ROOT`, `MEMO_BRIDGE_GOVERNANCE_ROOT` | `<root>/repos`, `<root>/worktrees`, `<root>/governance` | catalog, worktrees, ledger |
| `MEMO_BRIDGE_HUB_PRINCIPALS` | unset until the write gate passes (every hub principal read-only), then `{"hub:owner":"owner","hub:readonly":"read"}` | runtime grants (JSON); the runner side of the write gate |

Credentials (`LoadCredential=`, systemd.exec(5), systemd 257):

| Name | Content | Use |
|---|---|---|
| `agent-key` or `agent.key` | Ed25519 private key of the `vps` agent identity | hub handshake. lab-infra loads it as `agent.key`; both names are accepted |
| `app-key` | PEM private key of the GitHub App `memo-labs-automation` | with the App settings above, the source of every GitHub write token (next section). Present but unusable (bad PEM, missing settings): logged as `github_app_unusable` and the PATs are used; without `ledger-gh` the runner refuses to start |
| `ledger-gh` | fallback: fine-grained PAT, Contents RW on `memolabs-dev/.github` | used when the App is not configured or a mint fails. Read on each ledger call and given only to the `issue_lease.py` child as `GH_TOKEN`, with a fresh private `GH_CONFIG_DIR`. The runner refuses to start without either a usable App or a valid `ledger-gh` |
| `push-gh` | fallback, optional: fine-grained PAT, Contents RW on the pilot repos | Git fetch, ls-remote and push only, through `GIT_ASKPASS` reading the file path, with every other credential helper off. Neither App nor `push-gh`: `credential_unavailable` on create and push |

### GitHub App installation tokens

`server/integrations/github-app.mjs` mints, per call site, a token for one repository with the minimal permissions:

| Purpose | Repository | Permissions | Fallback |
|---|---|---|---|
| ledger (`issue_lease.py` child) | `memolabs-dev/.github` | `contents: write` | `ledger-gh` |
| Git fetch, ls-remote, push | the worktree's origin | `contents: write` | `push-gh` |
| `github_create_pr` (default branch, open PR lookup, POST) | the worktree's origin | `contents: write`, `pull_requests: write` | none: gh runs as before (no token) |

The flow follows GitHub's documentation (read 2026-10-14): an RS256 JWT with `iat` 60 seconds in the past, `exp` 9 minutes ahead (the limit is 10), `iss` the App id or the client id ([Generating a JWT for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)); `GET /app` once per process to check the App id; then `POST /app/installations/{installation_id}/access_tokens` with `repositories: [<name>]` and `permissions`, which answers a token valid one hour ([Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)). The answer is refused unless every requested permission is granted at that level, no other write or admin permission is, the repository list (when present) is exactly that repository, and at least 5 minutes are left. Tokens are cached in memory per (repository, permissions) until 5 minutes before expiry, and concurrent requests share one mint. It is the same flow as `os/integrations/github/scripts/with-app-token.py`, validated live on 2026-10-13.

Where a token goes:

- ledger: `GH_TOKEN` of the python child only, as with the PAT;
- Git: the askpass helper answers `x-access-token` and the token ([installation tokens over HTTPS](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)); the token is written for the call to `<state>/askpass/tok-<random>` (0600, directory 0700) and removed when the operation's network calls end, a leftover older than two hours is removed on the next write;
- pull requests: `GH_TOKEN` of each gh child of the flow, with a private `GH_CONFIG_DIR` under `<state>/gh-pr/` removed after the call. `process.env` never holds a token.

GitHub mints stateless `ghs_` tokens shaped like a JWT (two dots, about 520 characters) since 2026-04-27 ([changelog](https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header)); the token pattern accepts dots and dashes, up to 2048 characters.

Errors are short codes, never GitHub's text: `app_key_missing`, `app_key_invalid`, `app_config_invalid`, `app_repo_invalid`, `app_repo_not_allowed`, `app_identity_mismatch`, `app_token_http_<status>` (422: the repository is not in the installation), `app_token_network`, `app_token_invalid_response`, `app_token_scope_mismatch`, `app_token_expiry_invalid`, surfaced as `ledger_unavailable` or `credential_unavailable` with detail `app-key <code>`. The journal gets `app_token_minted` (repository, permissions, seconds left), `app_token_failed` and `app_token_fallback` (purpose, repository, code): never a token, a JWT or key material.

The App reads the Issue metadata of the pilot repositories through `issue_preflight.py` with the ledger token, which is narrowed to `memolabs-dev/.github`. The pilot repositories are public (the preflight refuses others), and public data reads with any token; this is an inference from GitHub's REST behavior, to confirm on the first live claim (see "Still to verify on the VPS").

lab-infra installs `server/` with mode 0644, so `git-askpass.mjs` is not executable where it is installed. The runtime then keeps a private executable copy in `<state>/bin/` (0700) and refreshes it when a release changes the helper.

The hub (`memo-bridge-hub.service`) needs, for the runner to be reachable:

| Setting | Value | Effect |
|---|---|---|
| `MEMO_BRIDGE_HUB_RUNTIME_HOST` | `vps` | forwards the runtime tools to the `vps` agent (read ops) |
| `MEMO_BRIDGE_HUB_MUTATING_OPS` | unset until the write gate passes, then `owner` | forwards mutating ops for the owner only |
| `readonly.token` in `MEMO_BRIDGE_SECRETS` | optional | enables the read-only bearer (O-9) |

`runner.json` (root-owned, written by lab-infra): the dispatcher reads only its `dispatch` section (all defaults when absent); lab-infra renders it from the same variables as the rest (`recipes` from `memo_runner_recipes`, `max_timeout_seconds` from `memo_runner_job_timeout_max_sec`), so removing a recipe or lowering the ceiling takes effect at the dispatcher. The runtime reads the same recipe list and ceiling (the narrowest of `dispatch` and the top-level `recipes` / `job_unit.timeout_max_sec`) to refuse at submit, plus the admission floors and PSI ceilings, the disk budget, the running free-disk floor, the retry and `du` intervals, in either lab-infra's shape (`admission.min_free_disk_bytes`, `admission.psi_cpu_some_avg10_max`, `admission.retry_sec`, `budgets.disk_bytes`, `budgets.du_interval_sec`, `budgets.min_free_disk_running_bytes`) or the canonical one (`admission.min_free_disk_gib`, `admission.max_psi`, `disk_budget_gib`, `min_free_disk_running_gib`, `max_unmeasured_readings`). An invalid value falls back to the default and its key name is logged once at start (`runner_config_errors`).

## Release and deployment

lab-infra pins a full commit sha (`memo_bridge_version`). For that commit:

```
pnpm run release:manifest     # clean tree required
```

writes `dist/release/SHA256SUMS` (the files lab-infra copies: `bridge/`, `server/`, `package.json`, `pnpm-lock.yaml`, `deploy/memo-runner-dispatch`, `deploy/record-result`) and `dist/release/memo-bridge-release.json` with `commit` and `sums_sha256`, the sha256 of `SHA256SUMS`. Record both values in lab-infra next to `memo_bridge_version`. lab-infra does not check `sums_sha256` yet (follow-up below).

memo-bridge uses pnpm (`packageManager` in `package.json`) and ships `pnpm-lock.yaml` instead of `package-lock.json`. Before lab-infra pins a commit that has no `package-lock.json`, its role must copy `pnpm-lock.yaml` (`memo_bridge_app_files`) and install the production dependencies with `pnpm install --frozen-lockfile --prod --ignore-scripts` in place of `npm ci --omit=dev --ignore-scripts`, with pnpm installed on the VPS.

Then the lab-infra order: PR-A (adopt, empty `make check` diff), PR-B with `memo_runner_enabled: true`, the new `memo_bridge_version`, the App key on the Mac (or the fallback PATs in the keychain), after the TODO-P4-01 spike.

## Observing it

- `host_resources{host:vps}`: load, memory with MemAvailable, PSI, disk, job counts per status, and the supervisor's view (queue depth, active job, last admission, last result, ledger reachability, dispatcher stall).
- `bridge_info`: version and the runner block (executor, queueing, concurrency, statuses).
- `/usr/local/lib/memo-runner/dispatch --status` and `make memo-runner-status` (lab-infra): queue depth, active unit, free disk, last result.
- Journals: `journalctl -u memo-bridge-runner -u memo-runner-dispatch -u 'memo-job@*'`. Lines hold ids, ops, reason codes and timings only.
- The watchdog heartbeat lists the runner, dispatcher and gc units.

## Rollback

**Immediate** (no code change): set `memo_runner_enabled: false` in lab-infra and deploy. That stops the dispatcher path and gc timer, stops running `memo-job@*` units, stops `memo-bridge-runner` and starts `memo-bridge-vps-agent` again (same `vps` identity, `Conflicts=`). By hand on the VPS, in this order:

```
systemctl disable --now memo-runner-dispatch.path memo-runner-gc.timer
systemctl stop 'memo-job@*.service'
systemctl start memo-bridge-vps-agent.service     # stops memo-bridge-runner (Conflicts=)
```

**Hub write tools only:** unset `MEMO_BRIDGE_HUB_MUTATING_OPS` and restart the hub. Read tools keep working.

**Code:** deploy the previous `memo_bridge_version`. The release before v0.5.0 on the VPS (`9bc7ac0`) has no runtime, so a code rollback there goes with the immediate rollback above. The store (schema v3) stays in `<root>/state` for the next attempt.

**Full:** revert the lab-infra PR, remove the units, `/etc/credstore/memo-runner.*` and `/var/lib/memo-runner`, and revoke both PATs.

## Tokens: rotation and revocation (O-10)

With the App there is nothing to rotate by hand: installation tokens last one hour and are minted again on demand. The App key is rotated in the App settings (generate a new private key, replace the PEM on the Mac at `~/.config/memolabs/secrets/github-app/memo-labs-automation.private-key.pem`, deploy, then delete the old key in GitHub). On suspected leak of a token: wait for its expiry or suspend the installation; of the key: delete it in the App settings first (minting fails closed with `app_token_http_401`), then generate a new one.

The fallback PATs, when used, expire within 30 to 90 days. Before expiry: create the new PAT with the same scope, update the keychain entry (`memo-runner-ledger-gh` or `memo-runner-push-gh`), run `make deploy-memo-bridge` (it rewrites `/etc/credstore/memo-runner.*`), make sure `memo-bridge-runner` restarted so `LoadCredential=` copies the new file, check `task_status` on a pilot Issue, then revoke the old PAT in GitHub settings. On suspected leak: revoke first in GitHub (the runner fails closed with `ledger_unavailable` or `credential_unavailable`), then rotate.

## Runner-side Git and running jobs

The worktree is shared with memo-job (setgid 2770, `UMask=0007`), so a running job can rewrite anything in it, the `.git` link file included. Runner-side Git therefore reads that link once: `locate()` (`server/runners/worktrees.mjs`) checks it points at `<project>/.git/worktrees/<name>`, then every Git call of the operation runs with `GIT_DIR` and `GIT_WORK_TREE` pinned to the validated real paths, so a link swapped later cannot point Git at a configuration the job wrote (filters, aliases). The gitdir and common dir live under `repos/`, read-only to the job. `worktree_commit` and `worktree_push` also refuse with `job_active` while a VPS job unit waits or runs in the worktree, before and after the ledger check. `GIT_SAFETY` (hooks and fsmonitor off) stays on every call.

## Job network sandbox: residual edges

`memo-job@.service` denies loopback, link-local, multicast, the private and CGNAT ranges, and the VPS's own public addresses (`memo_runner_job_deny_host_addresses` in lab-infra: the IPv4 address and the server's /64), so a service published on the host is not reachable through its public address either. `AF_UNIX` stays allowed, since Node, Python and Git need local sockets. Path sockets are covered by `InaccessiblePaths=`; abstract-namespace sockets are not, because the job shares the host network namespace (it needs the internet, so no `PrivateNetwork=`). On 2026-10-14 no abstract unix socket listened on lab (`ss -xl`); the AC-P4-12 probe re-checks it.

## Still to verify on the VPS

Inferred from the systemd 257 man pages or the code, not yet exercised (TODO-P4-01 spike, TODO-P4-31 to 35):

- `RuntimeMaxSec=` overrun reported as `SERVICE_RESULT=timeout`; a stop past `TimeoutStopSec=` likewise.
- `oom-kill` with the default `OOMPolicy`; `MemorySwapMax=0` on a slice; `IPAddressDeny=` failing with `EPERM` inside the job.
- An unprivileged `systemctl show memo-job@<id>` from the runner sandbox.
- A fresh instance picking up its `/run` drop-in without `daemon-reload` (the dispatcher checks `DropInPaths` and reloads once otherwise).
- `%d` expanded in `Environment=` (the runner's `MEMO_BRIDGE_AGENT_CONFIG`).
- Git 2.47.3 (VPS) with `-c credential.helper=` and `GIT_ASKPASS` under `GIT_TERMINAL_PROMPT=0` (checked with git 2.54 locally).
- A live App mint from the runner (only the Mac helper `with-app-token.py` has minted live, 2026-10-13), a push and a pull request with the installation token, and the ledger preflight reading a pilot repository's Issue with a token narrowed to `memolabs-dev/.github`.
- Worktree ownership between memo-runner and memo-job (setgid group, `safe.directory`, U-P4-04), and node plus the recipes under `SystemCallFilter=@system-service`.

## Known gaps (integration, owner or lab-infra follow-ups)

- **Hub unit.** The adopted `memo-bridge-hub.service` sets neither `MEMO_BRIDGE_HUB_RUNTIME_HOST=vps` nor a read-only token. Without the first, the hub lists no runtime tool and flow E cannot start (AC-P4-01). lab-infra PR-B must add it.
- **Pilot repositories on the VPS.** `workspace_open` needs a registry (`<root>/repos/PROJECTS.md`) and clones of the pilot repositories under `<root>/repos`, owned by memo-runner. lab-infra does not create them yet.
- **Project discovery through the hub.** `projects_list` and the `observe_*` tools are not forwarded, so a hub client must know the project name (the pilot list in `runner.json`).
- **Release checksum.** lab-infra pins the sha but does not verify `sums_sha256` yet.
- **Idempotency.** `client_request_id` exists on `jobs_submit` only. Other mutating ops do not take it yet.
- **Lease fence after renewal.** A renewal changes the fence. `job_status` returns the current one under `context.lease`; a client that kept its original fence gets `stale_lease` on `task_checkpoint` or `task_release` and must read it again.
