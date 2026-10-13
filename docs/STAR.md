# STAR relay — 2026-10-13

**Situation** — Sentinel X Free permits one active host. The Mac is connected; the Netcup VPS is reachable from the Mac via SSH. Existing lab infrastructure must remain untouched.

**Task** — Implement an independent, read-only MCP proof of concept that sees both machines from one connection.

**Action** — Implement Node MCP stdio plugin with official SDK v2 and bounded Python read-only machine probes.

**Result** — PASSED: npm test (3/3); npm run build; npm run smoke; both Mac and VPS returned valid host status. No Sentinel X configuration changed.

**Next** — Design separately deployed HTTPS hub with proper OAuth 2.1 and agents.

## Cycle 2 — Private secure hub (2026-10-13)

**Situation** — No existing OIDC provider; root/deploy retired Coolify key removed and SSH reconnect verified.

**Task** — Secure staging hub with read-only, authenticated multi-host agents, no public ingress.

**Action** — Implemented TLS hub, Ed25519 agent challenges, pinned-cert WebSockets, timing-safe bearer validation, bounded MCP tools, negative tests.

**Result** — Local tests PASSED 4/4, SDK build and local MCP smoke PASSED. Persistent host deployment is pending verification.

**Next** — Connect owner-only OAuth 2.1 + MFA, then independently verify Mac/VPS agents, and address privileged root runner before adding writes.

**Live Result (VPS + Mac deployment)** — PASSED: both systemd services running; Mac launchd tunnel and agent connected. TLS /health 200; unauthorized and wrong bearer requests 401; actual authenticated MCP calls returned online status for both machines. VPS bound only to 127.0.0.1:9443, service runs as memo-bridge without privileges. PR CI PASSED. No internet ingress. **OAuth and remote ChatGPT activation remain BLOCKED by design** pending standards-compliant owner-only authentication.
