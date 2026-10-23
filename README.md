# Memo Bridge

**Agents: start with [`llms.txt`](llms.txt).** Work in the project's own checkout on a branch; the task flow below is used on request.

Private open-source-ready MCP controller for Memo Labs, and the single MCP entry point of Memo Labs OS. It observes hosts and projects read-only, coordinates parallel AI sessions on **GitHub Issues**, and, since v0.4, does the work of a claimed task on the Mac: isolated worktrees, file edits, the repository's own test/build/lint recipes, commit, push and pull request. Since v0.5 the same tools can run on the VPS behind the private hub, with jobs queued one at a time in an unprivileged systemd unit, so work continues with the Mac off (`docs/RUNNER_VPS.md`; deployed on lab, runner on, 2026-10-15). Since v0.6 ChatGPT Chat conversations can use a fixed subset of those tools through a public, OAuth-protected endpoint served by the hub (`docs/REMOTE_CHATGPT.md`; deployed on lab, ChatGPT connected, 2026-10-15). Reservations use the shared Git-ref lease ledger of `memolabs-dev/.github`, so the Mac and the VPS see the same claims. It runs on the Mac, reaches the VPS via the existing `ssh lab` configuration, and does not touch current Sentinel X agents. Architecture and ownership: Vault `1-Projects/memo-labs-os.md`.

## Tools (v0.6.0, 61 stdio tools)

`bridge_info` returns the same list, grouped, with the capability each group needs.

### Phase 1: observation (read-only)

- `list_hosts`: check reachability for `mac` and `vps`
- `host_status({host})`: bounded OS, load, CPU, disk, container-count inventory
- `bridge_info`: capabilities, registered tools and limits
- `projects_list`, `project_info`, `project_git_status`, `projects_audit`: the canonical `$MEMOLABS_ROOT/PROJECTS.md` register (default `~/memolabs`), a registered project's verified location and live Git state, unregistered candidates
- Observers, never a new probe; each returns its source, its age and a stale flag: `observe_guardian` (infrastructure-guardian audit), `observe_agents` (VPS agent workflows), `observe_live_state` (operational sections of LIVE-STATE only), `observe_focus` (the active Stasis bet)

### Phase 2: coordination on GitHub Issues (`docs/COORDINATOR.md`)

- Workspaces: `workspace_open`, `workspace_status`, `workspace_list`, `workspace_close`, `workspace_recover`
- Tasks (a task is a GitHub Issue): `tasks_list`, `task_status`, `task_claim`, `task_renew`, `task_checkpoint`, `task_release`, `task_complete`
- Batches for a conductor conversation (`docs/REMOTE_CHATGPT.md`): `batch_create`, `task_next`, `batch_status`
- New projects (owner only, Mac runtime): `project_create` makes `memolabs-dev/<name>` from `templates/project/` (published as `memolabs-dev/project-template`), its Mac clone and its `PROJECTS.md` row (`.agent/project/owner-console/spec.md` section 09)
- Audit journal: `audit_events`, `audit_operation`
- Optional GitHub Projects view: with `MEMO_BRIDGE_PROJECT=owner/number` set (for example `memolabs-dev/1`), task creation, claims, pull requests, completion and releases are mirrored one way onto that board (Status, Priorité, Agent, Lot), fire and forget; off by default (`docs/COORDINATOR.md`, "GitHub Projects view")

### Phase 3: the Mac runner (`docs/RUNNER.md`)

- Worktrees and files: `worktrees_list`, `worktree_create`, `worktree_status`, `worktree_list_files`, `worktree_read_file`, `worktree_write_file`, `worktree_diff`, `worktree_commit`, `worktree_push`, `worktree_remove`
- Jobs (detected `test`, `build`, `lint` recipes only, sandboxed on macOS): `jobs_submit`, `jobs_list`, `job_status`, `job_events`, `job_results`, `job_cancel`
- Hosts: `host_capabilities`, `host_resources`
- GitHub: `github_issues`, `github_pull_requests`, `github_workflows`, `github_checks` (reads of registered repositories), `github_create_pr` (opens a pull request from a pushed worktree branch)

### Phase 4: the VPS runner (`docs/RUNNER_VPS.md`, `docs/HUB_SECURITY.md`)

No new tool: the runtime tools above run on the VPS as `memo-bridge-runner.service` (user `memo-runner`) and are reached through the private hub (protocol v2, owner and read-only bearers). On the VPS:

- `jobs_submit` queues instead of answering `host_busy`: FIFO, one job at a time, `deferred` while disk, memory or pressure leave no room for it, `client_request_id` for safe retries, `release_on_finish` to release the claim when the job ends;
- each job runs as `memo-job@<id>.service` (user `memo-job`, `memo-dev.slice`, no credentials, no loopback or private network, only its worktree and output writable), started by a root dispatcher that re-validates every request (`deploy/`);
- the final status comes from systemd (`succeeded`, `failed`, `timed_out`, `oom`, `budget_exceeded`, `cancelled`, `interrupted`), never from the job's own output;
- the runner keeps the claim's lease alive while its job waits or runs, and stops the job when the lease is lost.
- GitHub writes (ledger, push, pull request) use short-lived installation tokens of the GitHub App `memo-labs-automation`, minted on demand from the `app-key` credential, each narrowed to one repository and the minimal permissions; fine-grained PATs (`ledger-gh`, `push-gh`) remain an optional fallback (`docs/RUNNER_VPS.md`, "GitHub App installation tokens").

Write tools stay off the hub until the root CI runners on the VPS are isolated (the write gate in `docs/HUB_SECURITY.md`). On 2026-10-15 no GitHub Actions runner on lab runs as root (lab-infra #161 closed 2026-10-14) and the hub forwards mutating ops for the owner.

### Phase 5: ChatGPT conversations (`docs/REMOTE_CHATGPT.md`)

No new tool: a fixed subset of the runtime tools (28 read tools, plus 21 write tools once the write gate opens, per `server/registry.mjs`) is served to ChatGPT Chat at `https://bridge.memolabs.dev/mcp`, through a separate, OAuth-only hub listener (Pocket ID tokens for the owner only, mTLS to OpenAI's connector certificate at Traefik). Every remote call runs on the VPS runner. The server enforces the write gate, the project allowlist, the protected CI paths, the branch rules, response bounds, rate limits and the per-conversation workspace binding, whatever the model sends. Configuration is one `remote.json` rendered by lab-infra. Deployed on lab (2026-10-15).

### What Memo Bridge never does

Through its own tools: no shell (every command is a fixed argument list), no file access outside its own worktrees and the canonical register, no write to a default branch (compared without case, and checked against the remote itself), no force-push, no merge, no deployment, no service change. Every repository write, job and pull request needs a live claim on the task, and commit, push, job submission and pull request creation re-verify that claim with the shared ledger first. Pull requests land through the Memo Labs landing contract (`.github/workflows/land.yml`), never through an agent.

Jobs are different: they run the repository's own scripts, which a model can edit, so they are code a model wrote. On macOS they run inside a sandbox: writes only to the worktree, no network beyond loopback (except a first dependency install, `npm ci`, `pnpm install` or `go mod download` with scripts off, which reaches HTTPS hosts but cannot read the owner's home), no access to the state directory, other repositories, `~/.agent`, `~/Vault` or credentials, an allow-listed environment, and every process stopped with the job. On the VPS runner they run as the unprivileged `memo-job` systemd unit described above. They are refused on other platforms. `MEMO_BRIDGE_JOB_SANDBOX=off` runs them unsandboxed, which makes a job owner-equivalent. Details and residual risks: `SECURITY.md`.

## Development

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run test:runner       # Phase 4 subset, including the root helpers (python3 -I unittest)
pnpm run build
pnpm run smoke
pnpm run smoke:remote      # Phase 5: an MCP client over HTTPS through the public listener to the runtime, offline
pnpm run remote:toolsize   # size of the remote tools/list (read and write stages)
pnpm run release:manifest  # VPS release: dist/release/SHA256SUMS + memo-bridge-release.json for lab-infra
pnpm run install:local     # stable copy for AI clients: ~/.local/share/memo-bridge/stdio/{index,job-runner}.mjs
```

pnpm is pinned by `packageManager` in `package.json`; `pnpm-workspace.yaml` holds the pnpm settings (only `esbuild` may run its install script). This repository's own commands use pnpm. The job recipes are a separate matter: they run each target repository's `npm test` / `npm run build` / `npm run lint` (`server/runners/recipes.mjs`), unchanged.

AI clients are configured from the shared MCP registry (Vault `4-Tools/mcp/mcp.json`, applied by `agents-mcp-sync --apply`). They run the installed copy, never this working tree.

The plugin package is under `plugin/`. It is a **local stdio plugin**, not a cloud-hosted ChatGPT MCP. The build emits two files, `plugin/server/dist/index.mjs` (the server) and `plugin/server/dist/job-runner.mjs` (the detached process that runs one job); both must ship together. Its runtime depends on local Node 22.16+ (for the built-in `node:sqlite`), `python3` and a logged-in `gh` for the lease ledger and pull requests, `git`, the toolchains of the recipes you run, and a working SSH alias `lab` with BatchMode and a pinned host key.

## Independent local MCP (Windows, Linux, macOS)

A separate **read-only** local stdio entry point can be installed per OS user without connecting
to the owner's Mac/VPS hub, its OAuth account or its GitHub Apps. It lists only user-configured
projects, observes this machine and detects GPUs without presuming NVIDIA. It does not execute
commands, run GPU jobs or offer remote ChatGPT access. See
[Standalone Windows installation](docs/STANDALONE_WINDOWS.md).

```sh
pnpm run build:standalone
pnpm run install:standalone
pnpm run smoke:standalone
```

A preliminary **personal, read-only OAuth resource server** lives separately from the owner hub; see\n[PERSONAL_REMOTE_MCP.md](docs/PERSONAL_REMOTE_MCP.md) for its security boundary and remaining\nmanual steps. No public endpoint or new user has been deployed.\n\nA public/remote MCP is a separate secured project (#74), and a safe GPU job runner follows
device/backend verification (#73). No collaborator should be enrolled on the owner-only
`bridge.memolabs.dev` hub.

## Next architecture milestones

1. Observation and project catalogue (done).
2. Coordination on GitHub Issues through the canonical lease ledger (done).
3. Mac runner: worktrees, file edits, recipes, commit, push, pull requests (done, v0.4, local stdio).
4. VPS runner behind the private hub: protocol v2, principals, job queue, systemd sandbox, lease renewal (v0.5, code done, deployment pending; write tools on the hub after the root CI runners are isolated).
5. ChatGPT conversations through a public, OAuth-protected endpoint, per-capability authorization, write gate and audit (v0.6, Phase 5, code done, deployment pending; write tools after the root CI runners are isolated).

Existing Sentinel X configuration is untouched. No endpoint is exposed publicly until the owner deploys the Phase 5 lab-infra roles.
