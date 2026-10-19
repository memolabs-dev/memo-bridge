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

## 2026-10-18: repository-scoped reads (T-R5, owner-console T-A1b)

Measured before the change: from ChatGPT, `github_issues`, `github_pull_requests`, `github_workflows`
and `github_checks` answered `repo_not_registered` on `memolabs-dev/memo-founder-skills`, right after
the same conversation had pushed and opened a pull request there on the Mac (owner-console E-11).
`github_create_pr` worked: it carries a `worktree_id`, so the router follows the Mac route of its
workspace.

Why no repository to project map: `server/catalog-snapshot.mjs` whitelists `name, kind, status,
nature, stack` and states that paths, local availability, git origins and Vault references are never
exported. Exporting origins would put private origins on the VPS, which the CDKF rule refuses.

Implemented (`bridge/workspace-host-router.mjs`): `GITHUB_READ_TOOLS` and `REPO`; when the receiving
host answers `repo_not_registered` for one of those four reads with a well-formed `repo`, the router
asks the Mac once, journals `repo_scoped_read_routed_to_mac`, and returns the Mac's answer. A policy
refusal is never retried; a Mac that is offline or probe-only leaves the local refusal standing.

Verification (worktree `repo-read-mac-routing`, 2026-10-18): `tests/workspace-host-router.test.mjs`
18/18, full suite 821 tests with 820 pass, 0 fail, 1 skipped, `test:deploy` 124 ok, build ok, smoke
67 tools, `coordinator.test.mjs` 31/31 with `MEMO_BRIDGE_GOVERNANCE_ROOT` on the pinned 8a7f7ba, and
`remote:toolsize` unchanged (read 22 967, write 51 451, operator 92 722). Not deployed.
