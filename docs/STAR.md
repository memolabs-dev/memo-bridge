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

## Cycle 3 — OIDC resource guard and provider staging (2026-10-13)
Situation — Existing private hub uses a loopback static token and cannot be safely published.
Task — Add owner-only access-token validation and deploy a staged private identity provider.
Action — Built JWT issuer/audience/subject/scope/time validation and protected-resource discovery; staged Pocket ID on VPS localhost 1411.
Result — PASSED JWT/MCP test suite (7/7); Pocket ID discovery HTTP 200 with S256. The live MCP hub is unchanged. BLOCKED on owner passkey enrollment and OAuth authorization-server configuration for ChatGPT.
Next — Finish owner passkey setup, authorization server/client registration, resource-audience tokens and a negative-tested TLS public route before exposing anything.

## Cycle 4: one live claim per workspace (2026-10-18)

Situation: the C03 golden prompt took task_next's first pick (#69), then pivoted to the named #192 and never gave #69 back. Its claim stayed `claimed` for the full 30 minute lease, so one workspace held two tasks at once and one of the two open p0s stayed locked by a conversation that had moved on (anomaly A028, issue #195).

Task: a pivot gives the abandoned lease back, and reports it, so one workspace holds one task.

Action: after recording the new claim, task_claim reads the workspace's other live claims, releases each through the lease ledger with outcome `cancelled`, reconciles the local mirror, cancels their jobs, and returns them in `released` (with `lost` and `unreleased` when the ledger says so). Same shape as workspace_close. The tool description and docs/COORDINATOR.md now say so.

Result: PASSED, red first then green. New test `task_claim gives back the lease of the task it leaves behind` failed on the old code and passes now; full suite 822 pass, 0 fail, 1 skipped on the Mac. Not deployed: this reaches the VPS with the next pin bump.

Next: #196, the selector proposing a task whose merged PR already carried the change.

## Cycle 5: task_next says when a merged pull request already carried the change (2026-10-18)

Situation: #69 stayed open with `agent:ready` and `priority:p0` although lab-infra#232, merged 2026-10-16, carried its rollout. task_next therefore proposed delivered work and beat the fresh canary of the golden prompts (anomaly A027, issue #196).

Task: say the doubt on the task the agent is about to work, and still never drop it silently, because a merged pull request can carry a part of an Issue rather than all of it.

Action: after a successful claim, task_next runs one search for merged pull requests naming the Issue (its reference as a quoted phrase plus `is:pr is:merged`) through the same credential path tasks_list uses, and attaches the first three as `merged_references`. The check is failure tolerant: an error or an odd answer leaves the field out and the task stays.

Result: PASSED, red first then green. The new test `task_next flags a task whose change a merged pull request already carried` failed on the old code and passes now. Against the live API the query returns lab-infra#232 for #69 and nothing for the fresh canary #194. Full suite 823 pass, 0 fail, 1 skipped on the Mac. Not deployed: this reaches the VPS with the next pin bump.

Next: #196 closes with this PR. The lab-infra side (A025 copy shape, A026 operator restarts) still waits for the deployment protocol.
