# Memo Bridge

Private open-source-ready MCP controller for Memo Labs. MVP v0.1 is **strictly read-only**. It runs on the Mac, reaches the VPS via the existing `ssh lab` configuration, and does not touch current Sentinel X agents.

## What works now

- `list_hosts`: check reachability for `mac` and `vps`
- `host_status({host})`: bounded OS, load, CPU, disk, container-count inventory
- `bridge_info`: capabilities and limitations

There is no arbitrary shell, no file reading, no writes, no production control. All commands are hardcoded and executed without a local shell.

## Development

```sh
npm ci
npm test
npm run build
npm run smoke
```

The plugin package is under `plugin/`. It is a **local stdio plugin**, not a cloud-hosted ChatGPT MCP. Its runtime depends on local Node 22+ and a working SSH alias `lab` with BatchMode and a pinned host key.

## Next architecture milestones

1. Reachability + protocol tests (this MVP).
2. Dedicated remote HTTPS MCP hub with OAuth 2.1, audit logs, per-host policy and securely enrolled outbound agents; no shell exposure.
3. Dedicated Mac and VPS agents, so the VPS can run independently of Mac uptime.
4. Narrow GitHub App integration and CI monitoring; operational writes require explicit policies and confirmations.

Existing Sentinel X configuration is untouched. No endpoints are exposed publicly.
