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
