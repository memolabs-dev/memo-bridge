# STAR relay — 2026-10-13

**Situation** — Sentinel X Free permits one active host. The Mac is connected; the Netcup VPS is reachable from the Mac via SSH. Existing lab infrastructure must remain untouched.

**Task** — Implement an independent, read-only MCP proof of concept that sees both machines from one connection.

**Action** — Implement Node MCP stdio plugin with official SDK v2 and bounded Python read-only machine probes.

**Result** — PASSED: npm test (3/3); npm run build; npm run smoke; both Mac and VPS returned valid host status. No Sentinel X configuration changed.

**Next** — Design separately deployed HTTPS hub with proper OAuth 2.1 and agents.
