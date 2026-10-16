# First-class Mac runtime routing — CDKF acceptance contract

This document scopes issue #114. **The opt-in Mac agent runtime in this branch is not a completed cross-host router.** Never describe `projects_list.metadata_only` as an authorization grant.

## Required trust boundaries

1. The hub authenticates the **Mac agent identity** with its existing agent key. A catalog snapshot is only discovery metadata.
2. The Mac agent resolves CDKF from its own canonical `~/memolabs/PROJECTS.md`, verifies the Git origin, and applies the owner's remote project policy locally. No absolute Mac project paths enter the VPS snapshot.
3. Remote `workspace_open(project, host: 'mac')` may go to the authenticated Mac **runtime** only after both policy and live agent availability checks. If Mac is offline or running probe-only, refuse; never silently rewrite `mac` to `vps`.
4. A workspace must have durable, host-bound routing for all subsequent calls (task claim/renew, worktree, job, GitHub PR), even after hub restart. No lookup from a user-controlled project name or forge path can elevate authorization.
5. The Mac runtime uses its own state and executor; the VPS stores metadata/coordination but never reads the corpus or impersonates local Git.
6. Keep the existing lease, signed host/channel, OIDC session binding and GitHub repository allowlist gates. An unknown project, mismatched Git origin, wrong user, or stale host attestation fails closed.

## Staged delivery

- **Stage A (this branch)**: Mac agent runtime bootstrap explicitly gated by `MEMO_BRIDGE_MAC_RUNTIME_ENABLED=enabled`; existing credential and policy checks remain mandatory. Regression tests show opt-in defaults to off.
- **Stage B**: authenticated Mac runtime enrollment/deployment and fail-closed runtime capability checks. Do not replace the live probe agent until the production configuration is verified.
- **Stage C**: multi-host remote forwarding and durable workspace/worktree/job affinity. Add integration tests for Mac connected/offline, wrong origin, wrong OIDC principal, restart, and stale lease.
- **Stage D**: real CDKF `workspace_open` -> task -> Mac worktree -> `npm`/`python` tests -> PR, with no private corpus leaving the Mac.

## Mandatory acceptance

A passing `npm test` alone proves none of Stage B-D. Declare the feature complete only after an authenticated end-to-end Mac run succeeds.
