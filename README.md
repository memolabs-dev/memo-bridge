# Memo Bridge

Private open-source-ready MCP controller for Memo Labs, and the single MCP entry point of Memo Labs OS. It observes hosts and projects read-only, coordinates parallel AI sessions on **GitHub Issues**, and, since v0.4, does the work of a claimed task on the Mac: isolated worktrees, file edits, the repository's own test/build/lint recipes, commit, push and pull request. Reservations use the shared Git-ref lease ledger of `memolabs-dev/.github`, so the Mac and the VPS see the same claims. It runs on the Mac, reaches the VPS via the existing `ssh lab` configuration, and does not touch current Sentinel X agents. Architecture and ownership: Vault `1-Projects/memo-labs-os.md`.

## Tools (v0.4.0, 48 tools)

`bridge_info` returns the same list, grouped, with the capability each group needs.

### Phase 1: observation (read-only)

- `list_hosts`: check reachability for `mac` and `vps`
- `host_status({host})`: bounded OS, load, CPU, disk, container-count inventory
- `bridge_info`: capabilities, registered tools and limits
- `projects_list`, `project_info`, `project_git_status`, `projects_audit`: the canonical `~/projects/PROJECTS.md` register, a registered project's verified location and live Git state, unregistered candidates
- Observers, never a new probe; each returns its source, its age and a stale flag: `observe_guardian` (infrastructure-guardian audit), `observe_agents` (VPS agent workflows), `observe_live_state` (operational sections of LIVE-STATE only), `observe_focus` (the active Stasis bet)

### Phase 2: coordination on GitHub Issues (`docs/COORDINATOR.md`)

- Workspaces: `workspace_open`, `workspace_status`, `workspace_list`, `workspace_close`, `workspace_recover`
- Tasks (a task is a GitHub Issue): `tasks_list`, `task_status`, `task_claim`, `task_renew`, `task_checkpoint`, `task_release`, `task_complete`
- Audit journal: `audit_events`, `audit_operation`

### Phase 3: the Mac runner (`docs/RUNNER.md`)

- Worktrees and files: `worktrees_list`, `worktree_create`, `worktree_status`, `worktree_list_files`, `worktree_read_file`, `worktree_write_file`, `worktree_diff`, `worktree_commit`, `worktree_push`, `worktree_remove`
- Jobs (detected `test`, `build`, `lint` recipes only): `jobs_submit`, `jobs_list`, `job_status`, `job_events`, `job_results`, `job_cancel`
- Hosts: `host_capabilities`, `host_resources`
- GitHub: `github_issues`, `github_pull_requests`, `github_workflows`, `github_checks` (reads of registered repositories), `github_create_pr` (opens a pull request from a pushed worktree branch)

### What Memo Bridge never does

No arbitrary shell: every command is a fixed argument list run without a shell, and jobs run only the recipe the repository itself declares. No file access outside its own worktrees and the canonical register. No write to a default branch, no force-push, no merge, no deployment, no service change. Every repository write, job and pull request needs a live claim on the task, and commit, push and pull request creation re-verify that claim with the shared ledger first. Pull requests land through the Memo Labs landing contract (`.github/workflows/land.yml`), never through an agent. Details: `SECURITY.md`.

## Development

```sh
npm ci
npm test
npm run build
npm run smoke
npm run install:local   # stable copy for AI clients: ~/.local/share/memo-bridge/stdio/{index,job-runner}.mjs
```

AI clients are configured from the shared MCP registry (Vault `4-Tools/mcp/mcp.json`, applied by `agents-mcp-sync --apply`). They run the installed copy, never this working tree.

The plugin package is under `plugin/`. It is a **local stdio plugin**, not a cloud-hosted ChatGPT MCP. The build emits two files, `plugin/server/dist/index.mjs` (the server) and `plugin/server/dist/job-runner.mjs` (the detached process that runs one job); both must ship together. Its runtime depends on local Node 22.16+ (for the built-in `node:sqlite`), `python3` and a logged-in `gh` for the lease ledger and pull requests, `git`, the toolchains of the recipes you run, and a working SSH alias `lab` with BatchMode and a pinned host key.

## Next architecture milestones

1. Observation and project catalogue (done).
2. Coordination on GitHub Issues through the canonical lease ledger (done).
3. Mac runner: worktrees, file edits, recipes, commit, push, pull requests (this version, local stdio only).
4. Remote HTTPS hub with OIDC, per-capability authorization and audit; write tools stay off the hub until the root CI runners on the VPS are isolated.
5. VPS runner and a job queue, so work continues without the Mac.

Existing Sentinel X configuration is untouched. No endpoints are exposed publicly.
