# Mac runtime routing: implementation checkpoint (issue #114)

## Implemented on branch agent/114-mac-project-routing

- Host-specific runtime agent boot remains opt-in: `MEMO_BRIDGE_MAC_RUNTIME_ENABLED=enabled`.
- The public remote surface supports an independent opt-in `mac_runtime_routing=enabled` in `remote.json`; disabled by default, preserving existing VPS behavior.
- The Mac `workspace_open` request is no longer rewritten to VPS in opt-in mode.
- `workspace_open` at the runtime accepts a remote principal ONLY when the requested host equals that authenticated runtime's actual host.
- `bridge/workspace-host-router.mjs` retains owner-scoped workspace, worktree, job and known-project placement in the private hub state as `workspace_routes.json` (atomic 0600 state document).
- When Mac is offline, a known Mac-owned workspace never falls back to VPS. Foreign OIDC principals cannot follow another owner's route.
- The existing OIDC grants, per-host project allowlist, lease and Git origin gates are retained, not bypassed.
- Tests include offline, owner mismatch, restart/durable state, wrong host, project-scoped task routing and the HTTPS/MCP path to a simulated Mac runtime.

## Before production activation

- The actual Mac agent is currently probe-only; configure its runtime credentials and remote policy and verify it advertises the runtime operations.
- Configure the hub's private persistent state directory and opt in to `mac_runtime_routing` in the deployed remote.json.
- Authorize CDKF from verified Mac-local origin. The Mac metadata snapshot alone is NOT sufficient. Avoid copying corpus, Vault paths or secrets to VPS.
- Exercise real CDKF workflow from ChatGPT: workspace -> issue/batch -> claim -> Mac worktree -> local tests -> PR, including host-offline and wrong-origin refusal.
- Do not mark issue #114 complete or merge a partial PR merely because the unit suite passes.
