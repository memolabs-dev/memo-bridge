# Memo Bridge private hub: security

Sections below are dated. The first one is the current state (v0.5.0, Phase 4); the later ones keep the v0.2 record.

## Phase 4 (v0.5.0): protocol v2, principals and the write gate

Status: code on branch `feat/phase-4-vps-runner` (v0.5.0), **not merged and not deployed**. The deployed hub is still the v0.2 release below.

### Protocol v2 (hub to agent)

- The v1 handshake is unchanged: Ed25519 signature over a one-time server nonce, subprotocol `memo-bridge-agent-v1`, exactly the enrolled `mac` and `vps` keys. A v1 agent (no hello) keeps working for `host_status`.
- After the handshake a v2 agent sends a hello listing the ops it serves (at most 128). The hub forwards an op only if it is in the hub registry (`bridge/ops.mjs`: the runtime ops of `OPERATION_CAPABILITY` plus `host_status`) **and** advertised by that agent. Anything else is answered `unsupported_op`, never silence.
- Frames are at most 16 KiB. Larger messages are split into parts and reassembled, up to 128 KiB for a request and 1 MiB for a result. An oversize frame closes the connection (1009).
- Per-op timeouts: 6 s for `host_status`, 30 s by default, 60 s for GitHub reads, 130 s for ops that make one ledger call, 250 s for ops that may chain several. On disconnect every pending request fails at once with `agent_disconnected`; a request past its timeout fails with `timeout`.
- Ping every 15 s; an agent that misses a pong is dropped. At most 8 requests in flight per agent, on both sides. The agent reconnects with backoff from 1 s to 60 s with jitter.
- Results are checked against the expected shape (`invalid_agent_response` otherwise). An offline host answers `host_offline`.
- Wire error codes: `unsupported_op`, `agent_disconnected`, `host_offline`, `agent_busy`, `timeout`, `invalid_request`, `invalid_arguments`, `invalid_agent_response`, `request_too_large`, `result_too_large`, `forbidden`, `mutating_disabled`, `runtime_disabled`, `unknown_principal`, `unsupported_version`, `internal_error`, `shutting_down`.

### Principals

| Credential | Principal | Capabilities |
|---|---|---|
| owner bearer (`owner.token`) | `hub:owner` | all |
| read-only bearer (`readonly.token`, optional, O-9) | `hub:readonly` | read |
| OIDC token (`MEMO_BRIDGE_OIDC_SETTINGS`, Phase 5) | mapped, but with no capability yet | none |

The hub forwards only the principal id. The runtime maps it again with its own grants (`MEMO_BRIDGE_HUB_PRINCIPALS`), which are the ceiling: a hub claim can only narrow them. It then calls `authorize()` again before reading any argument (`runtime.as(principal)`). A refusal is journaled on both sides with principal, op and reason code, never the arguments. Mutating ops that carry `client_request_id` get a request key `sha256(principal|op|client_request_id)`, so a retry returns the first result.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `MEMO_BRIDGE_HUB_RUNTIME_HOST` | unset | `vps` forwards the runtime tools (read ops) to the VPS runner. Unset: only the hub's own tools and `host_status` |
| `MEMO_BRIDGE_HUB_MUTATING_OPS` | unset | `owner` also forwards mutating ops, for `hub:owner` only. Any other value refuses to start |
| `readonly.token` | absent | enables the read-only bearer |

### Write gate status

The rule above still holds: **no write-capable tool on the hub until the root CI runners are isolated.** In Phase 4 that is acceptance AC-P4-14 and TODO-P4-40:

- the hub listens on 127.0.0.1:9443 only, with no Traefik route to 9443 or 9444;
- no container on host networking can reach it, or each one is justified;
- the emargo GitHub runner no longer runs as root and the dead root `drop` runner is disabled (lab-infra #161, TODO-P4-25, owner window O-5).

Until then `MEMO_BRIDGE_HUB_MUTATING_OPS` stays unset: through the hub, the owner can read runner state (`jobs_list`, `job_status`, `job_results`, `host_resources`, `workspace_list`...) but cannot claim, submit, push or cancel. Status on 2026-10-14: **gate closed** (AC-P4-14 not verified, #161 open). The runner itself (`memo-bridge-runner.service`) is ready for it, and authorizes every op again on its side.

Details of the runner: `docs/RUNNER_VPS.md`.

## v0.2 record (2026-10-13)

### Architecture

- Hub: authenticated MCP-over-HTTPS on VPS loopback address 127.0.0.1:9443, NOT internet facing.
- Agents: local VPS and Mac diagnostic agents use Ed25519-signed WebSocket handshakes (one-time server nonce).
- Mac agent connects to 127.0.0.1:9444 through an encrypted SSH tunnel to VPS localhost 9443, with a pinned TLS cert.
- Hub accepts exactly two enrolled public identities (mac and vps).
- Authenticated HTTP owner access is restricted by a separate random 256-bit bearer token and TLS.
- No arbitrary command execution, file access, production mutation or Docker admin exposure.
- Authentication is NOT OAuth: there is no public ChatGPT connection yet.

### Security and audit policy

Keys and tokens stay out of source control. Do not share or log secrets.
The hub uses cryptographically secure fresh challenges and constant-time bearer comparison.
Keep the service under a dedicated system account, bound only to loopback, and do not add public reverse-proxy routes until OAuth 2.1/PKCE + MFA and scope enforcement are deployed.
External ChatGPT client use will require OAuth protected-resource metadata (RFC 9728), issuer/audience validation and token revocation.
A self-hosted GitHub runner currently executes emargo builds under root; remediate before adding mutating operations.
Private hub logs only timestamp, host identity and action category.

### Verification

1. TLS pinning works; no-token/bad-token receives 401.
2. A forged agent signing key is denied.
3. A valid agent may only respond to a bounded host_status probe.
4. Unsupported host IDs/tools are denied.
5. Listening socket is loopback only and no Traefik route exists.
6. Rollback is systemctl stop/disable private units and launchctl bootout on Mac; existing Sentinel X remains untouched.

### Actual private deployment, verified 2026-10-13

Location: VPS /opt/memo-bridge/app; credentials under /var/lib/memo-bridge, mode-limited to root and the dedicated memo-bridge service user. Secrets are NOT in this repository.
Services: memo-bridge-hub.service and memo-bridge-vps-agent.service.
External exposure: none, VPS binds exactly to 127.0.0.1:9443; no DNS / Traefik route was created.
Mac launchd: dev.memolabs.memo-bridge-tunnel and dev.memolabs.memo-bridge-agent.
Mac runtime location: ~/.local/share/memo-bridge/runtime; private identity ~/.config/memo-bridge/agent.key.
Mac tunnel endpoint: 127.0.0.1:9444 to remote 127.0.0.1:9443, carried by SSH.
TLS validity: through February 10, 2027. Plan certificate rotation before then (mac trust copy update needed).
Verified from the live VPS server with TLS trust and private owner credential:
- /health -> HTTP 200
- /mcp without token -> HTTP 401
- /mcp with incorrect token -> HTTP 401
- authenticated MCP host_status(mac) -> Darwin, online true, CPU 10
- authenticated MCP host_status(vps) -> Linux, online true, CPU 8
- no hub errors in system journal at verification time
- service user memo-bridge, ProtectSystem=strict, ProtectHome=yes, NoNewPrivileges=yes
- GitHub PR #5 CI PASSED

Rollback of this isolated deployment: stop and disable the two VPS memo-bridge systemd units, then stop the two Mac dev.memolabs.memo-bridge launchd jobs. Nothing depends on them yet; do not touch Sentinel X, Traefik, SSH or any other service.
Retired Coolify SSH key was removed earlier from VPS root and deploy, with backups and a reconnection test. Backup contains retired public entries only; treat as infrastructure state.

### Production owner authentication gap

A 256-bit static bearer token is sufficient for isolated localhost smoke tests but is NOT OAuth 2.1 and must not become an internet-facing ChatGPT auth solution. The current private plugin is still a local STDIO release. Next introduce a dedicated standards-based OAuth/OIDC provider with MFA and owner-only user binding; implement RFC 9728 protected-resource metadata, PKCE, issuer/audience, scoped short-lived access tokens, and negative tests. Open a public reverse-proxy route only after these pass, and keep /agent on a distinct restricted ingress or private encrypted overlay.

The separate privileged emargo GitHub runner under root remains a risk. Do not enable write-capable MCP tools until it is isolated.
