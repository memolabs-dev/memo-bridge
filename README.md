# Memo Bridge

Private open-source-ready MCP controller for Memo Labs, and the single MCP entry point of Memo Labs OS. It observes hosts and projects read-only and coordinates parallel AI sessions on **GitHub Issues**. Reservations use the shared Git-ref lease ledger of `memolabs-dev/.github`, so the Mac and the VPS see the same claims. It runs on the Mac, reaches the VPS via the existing `ssh lab` configuration, and does not touch current Sentinel X agents. Architecture and ownership: Vault `1-Projects/memo-labs-os.md`.

## What works now

- `list_hosts`: check reachability for `mac` and `vps`
- `host_status({host})`: bounded OS, load, CPU, disk, container-count inventory
- `bridge_info`: capabilities and limitations
- `projects_list`: read the canonical `~/projects/PROJECTS.md` register
- `project_info`: inspect a registered project and its verified local location
- `project_git_status`: read live Git branch, change count and worktree count
- `projects_audit`: report unregistered repository candidates without granting access
- Coordinator (`docs/COORDINATOR.md`):
  - workspaces: `workspace_open`, `workspace_status`, `workspace_list`, `workspace_close`
  - issues: `issue_status`, `issue_claim`, `issue_heartbeat`, `issue_release`, `issue_checkpoint`
  - audit: `coordinator_events`

There is no arbitrary shell, no arbitrary file reading, no project file writes, no merge, and no production control. All commands are hardcoded and executed without a local shell. The Coordinator writes only to its private store and, through the canonical ledger script, to lease refs in `memolabs-dev/.github` (see `SECURITY.md`). Pull requests land through the Memo Labs landing contract (`.github/workflows/land.yml`), never through an agent.

## Development

```sh
npm ci
npm test
npm run build
npm run smoke
```

The plugin package is under `plugin/`. It is a **local stdio plugin**, not a cloud-hosted ChatGPT MCP. Its runtime depends on local Node 22.16+ (for the built-in `node:sqlite`), `python3` and a logged-in `gh` for the lease ledger, and a working SSH alias `lab` with BatchMode and a pinned host key.

## Next architecture milestones

1. Reachability + protocol tests (this MVP).
2. Dedicated remote HTTPS MCP hub with OAuth 2.1, audit logs, per-host policy and securely enrolled outbound agents; no shell exposure.
3. Dedicated Mac and VPS agents, so the VPS can run independently of Mac uptime.
4. Narrow GitHub App integration and CI monitoring; operational writes require explicit policies and confirmations.

Existing Sentinel X configuration is untouched. No endpoints are exposed publicly.
