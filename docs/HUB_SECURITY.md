# Memo Bridge v0.2 — private secure hub (staging)

## Architecture

- Hub: authenticated MCP-over-HTTPS on VPS loopback address 127.0.0.1:9443, NOT internet facing.
- Agents: local VPS and Mac diagnostic agents use Ed25519-signed WebSocket handshakes (one-time server nonce).
- Mac agent connects to 127.0.0.1:9444 through an encrypted SSH tunnel to VPS localhost 9443, with a pinned TLS cert.
- Hub accepts exactly two enrolled public identities (mac and vps).
- Authenticated HTTP owner access is restricted by a separate random 256-bit bearer token and TLS.
- No arbitrary command execution, file access, production mutation or Docker admin exposure.
- Authentication is NOT OAuth: there is no public ChatGPT connection yet.

## Security and audit policy

Keys and tokens stay out of source control. Do not share or log secrets.
The hub uses cryptographically secure fresh challenges and constant-time bearer comparison.
Keep the service under a dedicated system account, bound only to loopback, and do not add public reverse-proxy routes until OAuth 2.1/PKCE + MFA and scope enforcement are deployed.
External ChatGPT client use will require OAuth protected-resource metadata (RFC 9728), issuer/audience validation and token revocation.
A self-hosted GitHub runner currently executes emargo builds under root; remediate before adding mutating operations.
Private hub logs only timestamp, host identity and action category.

## Verification

1. TLS pinning works; no-token/bad-token receives 401.
2. A forged agent signing key is denied.
3. A valid agent may only respond to a bounded host_status probe.
4. Unsupported host IDs/tools are denied.
5. Listening socket is loopback only and no Traefik route exists.
6. Rollback is systemctl stop/disable private units and launchctl bootout on Mac; existing Sentinel X remains untouched.

## Actual private deployment — verified 2026-10-13

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

## Production owner authentication gap

A 256-bit static bearer token is sufficient for isolated localhost smoke tests but is NOT OAuth 2.1 and must not become an internet-facing ChatGPT auth solution. The current private plugin is still a local STDIO release. Next introduce a dedicated standards-based OAuth/OIDC provider with MFA and owner-only user binding; implement RFC 9728 protected-resource metadata, PKCE, issuer/audience, scoped short-lived access tokens, and negative tests. Open a public reverse-proxy route only after these pass, and keep /agent on a distinct restricted ingress or private encrypted overlay.

The separate privileged emargo GitHub runner under root remains a risk. Do not enable write-capable MCP tools until it is isolated.
