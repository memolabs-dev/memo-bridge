# Memo Bridge private hub: security

Sections below are dated. The first one is the current state (Phase 6, operator access); the Phase 5 and Phase 4 sections still describe the two listeners and the protocol; the later ones keep the v0.2 record, whose "exactly two identities" and "no arbitrary command execution" no longer hold.

## Phase 6: operator identities, signing key, freeze

Operator tools and their rules: `docs/OPERATOR.md`.

- **Identities.** Besides `mac` and `vps`, the hub accepts two optional agent keys,
  `operator-mac.pub` and `operator-vps.pub`, in its secrets directory (`bridge/hub-cli.mjs`). An
  operator identity serves only operator ops and `host_status`, and no other identity may serve
  an operator op. The probe and runtime agents are unchanged.
- **Signing key.** `operator-signing.key` (lab, `/var/lib/memo-bridge/secrets`, root:memo-bridge
  0640) signs every operator request. Its public half sits on each host
  (`/etc/memo-operator/operator-hub.pub` on lab, `~/.memo-operator/operator-hub.pub` on the Mac).
  Without the key the hub serves no operator op (`operator_disabled`).
- **9443.** The owner bearer (`hub:owner`) reaches the T0 operator tools; T1 to T3 only with
  `MEMO_BRIDGE_HUB_MUTATING_OPS=owner`. The read-only bearer reaches none.
- **Freeze.** The hub refuses every operator call above T0 while `/etc/memo-bridge/operator-FROZEN`
  exists (`MEMO_BRIDGE_OPERATOR_FREEZE_FILE`) or the owner sent `/freeze` to the Telegram bot.
- **Approvals.** `MEMO_BRIDGE_OPERATOR_APPROVAL` (default `dangerous` for both hosts) parks a
  dangerous call until the owner answers in Telegram (`MEMO_BRIDGE_TELEGRAM_CHAT_ID`, credential
  `telegram-bot`). Pending approvals live in memory.
- **Mac transport.** `operator-mac` is a third launchd job, `dev.memolabs.memo-operator-agent`,
  through the existing tunnel (`wss://127.0.0.1:9444/agent`, same pinned CA as the probe agent).
  No new port, no new route. Installed by `deploy/mac/install-operator-agent.sh`.

## Phase 5 (v0.6.0): two listeners, OAuth on the public one only

Status: code on branch `feat/phase-5-chatgpt-remote` (v0.6.0), **not merged and not deployed**. End-to-end description: `docs/REMOTE_CHATGPT.md`.

### Two listeners (decision D4)

| | 9443 (Phase 4, unchanged) | 9445 (Phase 5, public listener) |
|---|---|---|
| Bind | 127.0.0.1 | 127.0.0.1 or ::1 only; 9443 refused |
| Reached by | loopback clients, the Mac tunnel, agents | Traefik only (`bridge.memolabs.dev`, OpenAI Connectors CA client certificate, required by the hub for any credentialed call) |
| Credentials | owner bearer, read-only bearer | OAuth access tokens only (`bridge/oidc.mjs`) |
| Paths | `/mcp`, `/agent` (WebSocket), `/health` | `POST /mcp`, the two protected resource metadata paths; everything else 404, every upgrade 404 |
| Off switch | none | not configured unless `MEMO_BRIDGE_REMOTE_CONFIG` is set; `remote_enabled: false` answers 503 |

Traefik connects from 127.0.0.1, so loopback is no longer a trust signal: the separation is structural. `bridge/public-listener.mjs` imports neither the bearer check, nor the WebSocket server, nor `hub.mjs`, and refuses the bearer digests, agent keys and mutating-ops options. The only thing the public side takes from the hub is `requestAgent()`. The Phase 1 OIDC mode of 9443 is removed: `createHub` refuses the `oidc` options and `hub-cli` refuses `MEMO_BRIDGE_OIDC_SETTINGS`.

### Principals added

| Credential | Principal | Capabilities |
|---|---|---|
| Pocket ID access token of the owner, through an allowlisted client (9445) | `oidc:<owner sub>`, `client_type` from the client id | token scopes, capped by the ceiling; no write capability while the write gate is closed |

On the runner the grant of `oidc:<owner sub>` comes from the same `remote.json` (`MEMO_BRIDGE_REMOTE_CONFIG`): read while `remote_writes` is `disabled`, owner once `enabled`, and a remote principal loses every write capability while the file does not enable writes, whatever `MEMO_BRIDGE_HUB_PRINCIPALS` says. Without a readable `remote.json` the runner maps no remote principal at all (`unknown_principal`).

### Envelope additions (protocol v2, additive)

`principal.client_type` (a label checked against the known client kinds, it grants nothing) and `meta: {request_id, client_session}` set by the hub's forwarder. Capabilities still never travel. Tool handlers read `meta` as `extra.meta`, never from arguments; the runtime journal records `via`, `client_type` and `request_id`.

### Write gate, three layers (D7)

1. Remote write tools are listed only with `remote_writes: "enabled"`; an unlisted call is refused by the SDK and journaled by the listener (`remote_denied`, `write_gate_closed`).
2. With writes enabled, the hub does not start while any `actions.runner.*` unit runs, or would start at boot, as root, or when `systemctl` cannot tell (`bridge/write-gate.mjs`, `bridge/remote-boot.mjs`).
3. The runner's own grant, above.

Status on 2026-10-14: **closed** (`remote_writes: disabled` in lab-infra; lab-infra #161 open, the emargo runner is active as root).

### Settings added

| Setting | Default | Meaning |
|---|---|---|
| `MEMO_BRIDGE_REMOTE_CONFIG` (hub and runner) | unset | absolute path of `remote.json`; opens the public listener on the hub, sets the remote policy on the runner |

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
| OIDC token on 9443 | removed in Phase 5 (OAuth is served on 9445 only, see above) | none |

The hub forwards only the principal id. The runtime maps it again with its own grants (`MEMO_BRIDGE_HUB_PRINCIPALS`), which are the ceiling: a hub claim can only narrow them. Unset, those grants are read-only for every hub principal (`RUNTIME_DEFAULT_HUB_GRANTS`), so the write gate holds on the runner side as well: the memo-bridge uid holds the hub's TLS key, and could otherwise send mutating ops straight to the runner whatever `MEMO_BRIDGE_HUB_MUTATING_OPS` says. It then calls `authorize()` again before reading any argument (`runtime.as(principal)`). A refusal is journaled on both sides with principal, op and reason code, never the arguments. Mutating ops that carry `client_request_id` get a request key `sha256(principal|op|client_request_id)`, so a retry returns the first result.

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

Until then `MEMO_BRIDGE_HUB_MUTATING_OPS` stays unset on the hub and `MEMO_BRIDGE_HUB_PRINCIPALS` stays unset on the runner: through the hub, the owner can read runner state (`jobs_list`, `job_status`, `job_results`, `host_resources`, `workspace_list`...) but cannot claim, submit, push or cancel. Opening the gate (TODO-P4-40) sets both: `MEMO_BRIDGE_HUB_MUTATING_OPS=owner` on the hub and `MEMO_BRIDGE_HUB_PRINCIPALS={"hub:owner":"owner","hub:readonly":"read"}` on the runner. Status on 2026-10-14: **gate closed** (AC-P4-14 not verified, #161 open). The runner authorizes every op again on its side.

Known pre-Phase 4 exposure: on the VPS, `/var/lib/memo-bridge/agent/agent.key` is `root:memo-bridge 0640`, so the hub's user can read the VPS agent key (the legacy `memo-bridge-vps-agent` runs as memo-bridge and needs it). Once the runner replaces that agent, the key is only needed through `LoadCredential=` (root reads it); tightening the file is a lab-infra change on a live file, left to the owner (it must be undone if the immediate rollback brings the legacy agent back).

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

Rollback of this isolated deployment: stop and disable the two VPS memo-bridge systemd units, then stop the two Mac dev.memolabs.memo-bridge launchd jobs. Since Phase 6 the Mac also runs dev.memolabs.memo-operator-agent: `deploy/mac/install-operator-agent.sh --uninstall` stops it, and lab-infra `memo_operator_enabled: false` removes the lab side. Nothing depends on them yet; do not touch Sentinel X, Traefik, SSH or any other service.
Retired Coolify SSH key was removed earlier from VPS root and deploy, with backups and a reconnection test. Backup contains retired public entries only; treat as infrastructure state.

### Production owner authentication gap

A 256-bit static bearer token is sufficient for isolated localhost smoke tests but is NOT OAuth 2.1 and must not become an internet-facing ChatGPT auth solution. The current private plugin is still a local STDIO release. Next introduce a dedicated standards-based OAuth/OIDC provider with MFA and owner-only user binding; implement RFC 9728 protected-resource metadata, PKCE, issuer/audience, scoped short-lived access tokens, and negative tests. Open a public reverse-proxy route only after these pass, and keep /agent on a distinct restricted ingress or private encrypted overlay.

The separate privileged emargo GitHub runner under root remains a risk. Do not enable write-capable MCP tools until it is isolated.
