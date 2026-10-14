# Phase 5 specification: ChatGPT Chat conversations on Memo Bridge (Memo Labs OS)

**Status:** SPECIFICATION. It moves to PLANNED once the blocking unknowns in §11 have answers. U-P5-01 (plan entitlement) was resolved positively on 2026-10-14.

**EV-P5-01 (2026-10-14).** Owner's ChatGPT Plus account. A throwaway MCP server with `probe_read` and `probe_note` was exposed through a cloudflared quick tunnel and added in Chat as a custom MCP server with no authentication. In the Chat tab, ChatGPT called `probe_note` then `probe_read`, the line landed in the server file, and the server log shows `openai-mcp/1.0.0`. ChatGPT asked for **no confirmation** before the write, so every write invariant (D7, D9) must hold on the server. The tunnel and the probe server were stopped, and the probe plugin was deleted from the account. The owner rule for driving ChatGPT: stay in Chat, and refuse any switch to Work or Codex.
**Proposed canonical path:** `memo-bridge/.agent/project/phase-5/spec.md`, next to phase-4. This run was read-only, so the file has not been written.
**Written:** 2026-10-14. I made no file changes, no commits, no restarts and ran nothing on the VPS. The VPS facts come from the three discovery reports, which used read-only `ssh lab` commands.

## 0. Sources and trust

**Files read for this spec**
- `/Users/memo/.agents/skills/whole-project-protocol/SKILL.md`
- `/Users/memo/Vault/1-Projects/memo-labs-os.md`. It records the owner decision: "ni Codex, ni Work. Seulement des conversations ChatGPT classiques".
- `~/memolabs/workspace/decisions/2026-10-13-{multi-client-coordination,vps-independent-execution,holistic-architecture}.md`
- `/Users/memo/projects/_worktrees/memo-bridge/phase-4/.agent/project/phase-4/spec.md`, which gives D1 to D11, REQ/AC/TODO-P4, O-1..O-11 and U-P4.
- `/Users/memo/projects/memo-bridge/bridge/oidc.mjs`, where `REQUIRED_SCOPE='hosts:read'`, `maxTokenAge:'20m'` and the audience must end in `/mcp`.
- `/Users/memo/projects/memo-bridge/docs/OIDC_RESOURCE.md`
- The tool names registered on main a499754, found by grep over `server/` and `bridge/`.

**Official documentation, as cited by the discovery reports.** I re-read none of it in this run.

| Key | URL |
|---|---|
| [A] | https://developers.openai.com/plugins/build/auth (the same content as /apps-sdk/build/auth) |
| [B] | https://developers.openai.com/api/docs/guides/custom-mcp-server |
| [C] | https://developers.openai.com/api/docs/guides/secure-mcp-tunnels |
| [D] | https://developers.openai.com/api/docs/guides/ip-addresses |
| [E] | https://developers.openai.com/plugins/build/mcp-server |
| [F] | https://developers.openai.com/plugins/reference |
| [G] | https://developers.openai.com/plugins/deploy/connect-chatgpt |
| [HC1] | https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt |
| [HC2] | https://help.openai.com/en/articles/20001256-plugins-in-chatgpt |
| [HC3] | https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt |
| [MCP] | https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization (and 2025-11-25/basic/{authorization,transports}) |
| [PID-API] | https://pocket-id.org/docs/guides/apis |
| [PID-CIMD] | https://pocket-id.org/docs/guides/client-id-metadata-documents |
| [PID-ENV] | https://pocket-id.org/docs/configuration/environment-variables |
| [PID-SRC] | github.com/pocket-id/pocket-id v2.18.0: `backend/internal/oidc/{provider.go,api_resource.go}`, `backend/internal/api/service.go` |
| [T-ST] | https://doc.traefik.io/traefik/reference/routing-configuration/http/load-balancing/serverstransport/ (v3.7 pages; the VPS runs 3.6.25) |
| [T-TLS] | https://doc.traefik.io/traefik/reference/routing-configuration/http/tls/tls-options/ |
| [T-RL] | https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/ratelimit/ |
| [SDK] | `/Users/memo/projects/memo-bridge/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts` (2.3.1) |

**Facts that drive this spec**
1. **Plans.** Write tools in Chat ("Full MCP") are a beta for Business, Enterprise and Edu. "Pro users can connect MCPs with read/fetch permissions in developer mode." Plus is not mentioned [HC1]. [B] does not restrict by plan. I do not know the owner's plan.
2. **Auth modes.** ChatGPT supports OAuth or no auth. It cannot present a static bearer, an API key or a customer-provided mTLS certificate [A][B]. It needs PKCE S256 and sends `resource` on both the authorize and the token request [A].
3. **Network.** The server must be reachable over public HTTPS or through the Secure MCP Tunnel [G][HC1]. The tunnel does not carry the authorization server [C].
4. **Write confirmation.** ChatGPT asks for confirmation on every tool that does not set `readOnlyHint:true`. Approval is remembered per conversation only [B][HC3]. Annotations change how the call is presented, not who is authorized; the server enforces authorization [E][F].
5. **Pocket ID v2.18.0 on the VPS:**
   - issuer `https://auth.memolabs.dev`, S256 supported, RFC 9207 `iss` supported, no DCR, no revocation endpoint;
   - CIMD is supported but switched off (`CIMD_URL_ALLOWLIST` is empty);
   - RFC 8707 `resource` maps to `aud` through the APIs feature [PID-SRC][PID-API];
   - **0 users, and `/setup` answers 200**;
   - `TRUST_PROXY=false`.
6. **Hub on the VPS.** It still uses the static owner bearer: there is no `oidc.mjs` in the deployed tree and no OIDC settings variable. It listens on `127.0.0.1:9443` with a self-signed certificate. Traefik 3.6.25 runs with `network_mode: host`.
7. **DNS.** Porkbun nameservers. A wildcard `*.memolabs.dev` A record points to 159.195.213.26. There is no Cloudflare. UFW allows only 22, 80 and 443.
8. **#161 is OPEN.** `actions.runner.guillaume-flambard-emargo` runs as root.
9. **Phase 4 conflict.** REQ-P4-14 and AC-P4-14 require "no Traefik route to 9443". Phase 5 adds an ingress route, so those two must be amended (TODO-P5-25).

**Scenario definitions.** These are **(inferred)**: I did not find the master-plan text on disk, and Phase 4 hit the same gap (U-P4-01). I built them from the validation cases in `multi-client-coordination.md` and from the Vault decision.
- **A, parallel work.** Two or more ChatGPT Chat conversations opened in parallel each open their own workspace on a different Issue. Each one claims, edits, tests, pushes its own branch and opens a PR, using only Memo Bridge tools, with no cross-effect. (Cases 2 and 3.)
- **C, conflict.** Two conversations try to claim the same Issue. Exactly one wins. The other is refused with the holder named, and neither changes the other's workspace. ("Le Coordinator empêche les conflits entre elles.")
- **D, recovery.** A conversation is abandoned mid-task. A new conversation recovers the workspace from its checkpoint without losing or overwriting committed work, or the lease expires visibly. (Case 5.)
- **G, refusal.** An unauthorized request is refused and audited, and product users cannot reach the runner. This is the Phase 4 G, extended to the public surface. (Case 7.)

## 1. Intent

**Goal.** The owner opens several ChatGPT Chat conversations. Each connects to Memo Bridge as the single MCP entry point and authenticates as the owner through Pocket ID. Each works in its own VPS workspace through Memo Bridge tools only. The Coordinator, running in the Phase 4 VPS runtime, is the single coordination owner. Nothing on the VPS becomes reachable or usable by product users or by any identity other than the owner.

**Non-goals**
- Codex, ChatGPT agent mode, Work and deep research: owner decision. [HC1] also says agent mode does not use custom apps.
- Mobile ChatGPT. MCP apps are web only [HC1].
- Mac-hosted workspaces driven remotely. `host:'mac'` is refused remotely and deferred to Phase 5b. Swift and Xcode work remains a Phase 4 non-goal.
- A conversation spawning other conversations. No public mechanism exists, per the Vault note.
- Public plugin submission, multiple users, DCR, a custom token broker, Memo Director, a scheduler.
- Exposing `observe_*`, `host_resources`, `worktree_remove`, `/agent` or `/health` to ChatGPT.

**User-visible outcome**
1. In ChatGPT on the web, the owner adds the custom MCP server `https://bridge.memolabs.dev/mcp` with OAuth and signs in once with a passkey.
2. In any number of chats, the owner selects Memo Bridge and says something like "take Issue #N on memo-bridge".
3. The chat calls `workspace_open`, `task_claim`, `worktree_create`, `worktree_write_file`, `jobs_submit{recipe:test}`, `worktree_commit`/`push`, `github_create_pr` and `task_complete`. ChatGPT asks for confirmation on each write [B].
4. A second chat on the same Issue is told the Issue is held.
5. A chat that is closed can be picked up by a new chat through `workspace_recover`.

**Constraints**
- Memo Bridge is the single MCP entry point and builds no new engine. The Coordinator is the single coordination owner.
- The VPS is private infrastructure. Product users must never reach the hub, the runner or the identity-provider admin.
- **No write tool is exposed remotely before lab-infra #161 is closed.** This is owner decision R-P4-01, and the gate is enforced in the hub, not only in Traefik.
- Everything that runs on the VPS is declared in lab-infra. `ansible/` changes are merged by hand by the owner.
- Secrets come from the keychain or the credstore and are never written to a repository. Commits carry no AI attribution (CLAUDE.md).

**Completion sentence.** Phase 5 is complete when the following holds, with evidence for each step:
- at least two ChatGPT Chat conversations, opened in parallel by the owner and connected to `https://bridge.memolabs.dev/mcp` through Pocket ID OAuth, each open their own VPS workspace and take a different Issue from claim to PR using Memo Bridge tools only (A);
- a conversation claiming an Issue that is already held is refused (C);
- an abandoned conversation's task is recovered by a new conversation from its checkpoint, with no loss (D);
- every unauthenticated, wrong-identity, wrong-audience, product-side, over-gate or over-budget request is refused and journaled (G);
- write tools appeared on the remote surface only after lab-infra #161 closed.

## 2. Design decisions

| ID | Decision | Why | Rejected alternatives |
|---|---|---|---|
| D1 | **Public HTTPS through the existing Traefik, with mandatory mTLS on the MCP host.**<ul><li>Host: `bridge.memolabs.dev`, file-provider route, exact paths only.</li><li>Client certificate verified against the OpenAI Connectors CA [A][D]. A file-provider route needs no Traefik restart.</li></ul> | Reuses what exists: Traefik on the host network, the opencode file-route precedent, and the existing DNS wildcard and ACME setup. mTLS means a caller without an OpenAI connector certificate never finishes TLS, so product users and scanners never reach the hub. A stolen token cannot be replayed from outside OpenAI's infrastructure (inferred). | **Secure MCP Tunnel [C]:** <ul><li>adds a daemon and an OpenAI Platform runtime API key;</li><li>eligibility for a personal workspace is not clearly documented;</li><li>120 s deadline, below the ≥130 s Phase 4 ledger ops;</li><li>the AS must be public anyway.</li></ul>It stays the fallback if U-P5-08 fails.<br>**Cloudflare Tunnel or Access:** Cloudflare is not in front today, and ChatGPT cannot present a Cloudflare Access credential [A] (inferred: edge TLS termination would hide OpenAI's client certificate from the origin).<br>**Binding the hub publicly:** no ACME, no shared rate limit. |
| D2 | **Pocket ID stays the authorization server.**<ul><li>Its APIs feature: resource `https://bridge.memolabs.dev/mcp` gives `aud`, and permission keys become scopes [PID-API][PID-SRC].</li><li>ChatGPT is registered through **CIMD**: `CIMD_URL_ALLOWLIST` set to the ChatGPT client URL [PID-CIMD][A].</li><li>Fallback: a predefined Pocket ID public client ("static credentials" [B]).</li></ul> | Already installed (v2.18.0, latest), with passkeys, S256, RFC 9207 and RFC 9068 JWTs. No new component. | **Token broker / custom AS:** a new engine, unnecessary if RFC 8707 works (U-P5-02).<br>**kollio-logto:** product identity; mixing it with private infrastructure breaks the separation.<br>**Static bearer:** ChatGPT cannot send one [A]. |
| D3 | **Hostname `bridge.memolabs.dev`**, canonical resource `https://bridge.memolabs.dev/mcp`. The same string is used in PRM `resource`, the Pocket ID API audience, the hub `audience` and the ChatGPT URL. | It is the name already in `docs/OIDC_RESOURCE.md`. The DNS wildcard already resolves it. | `mcp.memolabs.dev`: equivalent, but every document would have to change. The owner can still pick it (O5-02). |
| D4 | **A separate public listener.** The hub opens a second loopback listener, `127.0.0.1:9445` (port to confirm), that is OIDC-only and serves only `/mcp` and the PRM paths. `9443` keeps the Phase 4 loopback clients and `/agent`. Traefik targets 9445 only. | Traefik connects from 127.0.0.1, so "loopback" is no longer a trust signal. A distinct listener makes it structurally impossible for the static owner bearer or `/agent` to be reached through the public route. | A header set by Traefik to switch modes (forgeable from loopback, easy to misconfigure). Path filtering on 9443 alone. |
| D5 | **One registry, a remote allowlist and a forwarding adapter** (code-report D1). The hub serves `REMOTE_TOOLS`, a fixed subset of the registry, with the same names, schemas and annotations as stdio. Handlers forward to the VPS runtime over the Phase 4 v2 envelope. The hub executes nothing. | The two surfaces cannot drift. A small set keeps tool definitions small (U-P5-04) and limits what flows to OpenAI. | Re-declaring tools in the hub (drift). Exposing all 49 tools (size, privacy, attack surface). |
| D6 | **Principal = `oidc:<sub>`**, and `sub` must equal the configured owner sub.<ul><li>Capabilities = scopes ∩ server ceiling ∩ write gate.</li><li>`client_type` is derived from the token's `client_id` (allowlist), never from tool arguments.</li></ul> | `policy.mjs` already accepts `oidc:<uuid>`. Identity never comes from the model. | A principal per conversation from `_meta["openai/session"]`: OpenAI says not to use it for authorization [F]. |
| D7 | **Write gate in three layers** (code-report D6):<ol><li>write tools are not registered remotely unless `remote.json.remote_writes == "enabled"`;</li><li>the hub refuses to start with writes enabled while any `actions.runner.*` unit is active as `User=root`;</li><li>the runtime `authorize()` re-checks.</li></ol>Write scopes are added to `scopes_supported` only when the gate opens, and the owner then reconnects. | Enforces #161 in code. Requesting scopes up front at gate opening avoids depending on ChatGPT step-up, which is undocumented for per-scope upgrade (inferred). | 403 `insufficient_scope` step-up per call: unverified in ChatGPT, kept only as an error shape. Gating only in Traefik. |
| D8 | **Stateless per request, no `Mcp-Session-Id`.** Each conversation works through an explicit `workspace_id`. `_meta["openai/session"]` is recorded as a hash on `workspace_open`. A mismatch on a later write is refused when `session_binding=block`; the default is `warn` until U-P5-05 is measured. `workspace_recover` rebinds explicitly and is audited (this is D). | Matches the SDK stateless path [SDK] and MCP optional sessions [MCP]. Uses only an accidental-cross-talk guard, never an authorization signal. | Server sessions (ChatGPT's lifecycle is undocumented). Ignoring the session entirely (one conversation can then write into another's workspace after a prompt injection). |
| D9 | **Remote write invariants on the server, independent of the model:**<ul><li>project allowlist (Phase 4 pilot repos);</li><li>writes refused under `.github/workflows/**`, `.github/actions/**` and `.github/dependabot.yml`;</li><li>push only to the workspace's own branch, never force, never the default branch;</li><li>`github_create_pr` head must be the workspace branch;</li><li>no merge tool (the merge contract bot merges).</li></ul> | Prompt injection from Issues or repo content is expected. A workflow change on a same-repo PR branch runs on CI runners, which is exactly the #161 risk. | Relying on ChatGPT confirmation prompts (approval is remembered per conversation [HC3]) or on tool descriptions. |
| D10 | **Bounded and slow-op-safe responses.**<ul><li>Compact JSON, 24 KiB default budget, `result_too_large` instead of truncation, paging clamps (code-report §6).</li><li>A mutating op that passes the soft deadline returns `{status:'accepted', request_id}`; its outcome is read through `task_status`/`workspace_status`, with idempotency from REQ-P4-07.</li></ul> | No documented ChatGPT limit or timeout for direct connections [A][B][G]. Ledger ops can take ≥130 s (REQ-P4-02). | Silent truncation. Blocking until 130 s and hoping. |
| D11 | **No Cloudflare and no DNS change.** The wildcard A record already covers `bridge.` and `auth.`. HTTP-01 on `:80` already works. | Minimal, reuses what exists. | Explicit records or a Cloudflare proxy (adds a hop and breaks D1's mTLS). |

## 3. Target system map

```
Owner browser (chatgpt.com, web)                Owner browser (passkey)
   | ChatGPT Chat conversations 1..n              | authorize UI
   v                                              v
OpenAI connector infra --HTTPS + OpenAI client cert--> Traefik 3.6 (host net, :443)
   | token exchange (server-side) ------------------>   |  Host(auth.memolabs.dev): rateLimit [+ ipAllowList during enrollment]
   |                                                    |     -> Pocket ID container (network lab), issuer https://auth.memolabs.dev
   |                                                    |  Host(bridge.memolabs.dev) && Path(/mcp | PRM paths): TLS option chatgpt-mtls, rateLimit
   |                                                    |     -> serversTransport (pinned hub cert) -> https://127.0.0.1:9445
DNS: Porkbun, *.memolabs.dev A 159.195.213.26 (no Cloudflare)   UFW: 22/80/443 only
                                                        v
memo-bridge-hub.service [user memo-bridge]  (stateless, Phase 4 op registry v2)
   :9445 public listener: OIDC verifier (JWKS from auth host), remote surface (REMOTE_TOOLS, gate, budgets,
         rate limits, audit to journald). No /agent, no /health, no static bearer.
   :9443 loopback listener: Phase 4 clients (owner + read-only bearer), /agent WSS, /health
        | wss loopback, Ed25519 + hello v2
        v
memo-bridge-runner.service [memo-runner]  (Phase 4): Coordinator (single coordination owner),
   store SQLite (events + via/client_type/request_id, workspaces + client_session), ledger client (refs on .github),
   worktrees, jobs -> dispatcher (root) -> memo-job@<id> in memo-dev.slice
        | ledger-gh / push-gh (+ PR permission, O5-08)
        v
GitHub: Issues (tasks), star-lease-v1 refs (leases), agent branches, PRs -> merge contract (bot) -> autodeploy
Mac agent (optional): outbound SSH tunnel -> :9443 /agent only. Not routed publicly. Mac workspaces are not remote in Phase 5.
```

**Flow for one tool call.**
1. A ChatGPT conversation sends POST `/mcp` with a bearer token.
2. Traefik checks the OpenAI client certificate and the rate limit, then forwards to 9445.
3. The hub verifies the JWT: `iss`, `aud`, `typ`, `sub`, `client_id`, `exp` and scopes.
4. The hub maps the token to a principal, applies the gate and filters the tool. It forwards the envelope `{op, args, principal, request_id, client_session}` to the runner.
5. The runtime runs `as(principal)` and `authorize()`, then the Coordinator or the worktree/job code.
6. The SQLite event and the hub journald line share the same `request_id`. A bounded `structuredContent` goes back to ChatGPT.

**OAuth flow.**
1. ChatGPT calls `/mcp` without a token and gets `401` with `WWW-Authenticate: Bearer resource_metadata=…, scope=…`.
2. ChatGPT reads the PRM and then the AS discovery document.
3. It sends an authorize request with the CIMD `client_id`, `resource`, S256 and the redirect `https://chatgpt.com/connector_platform_oauth_redirect` [A].
4. The owner signs in with a passkey and consents.
5. ChatGPT sends the token request with `resource`.
6. Pocket ID returns an at+jwt with `aud` equal to the resource and the API permission scopes, plus a refresh token (`offline_access`) [PID-SRC][HC1].

## 4. Specification details

- **Error behaviour:**
  - Invalid, expired or wrong-`aud` token: `401` with `error="invalid_token"` and `resource_metadata`.
  - Missing scope: `403` with `error="insufficient_scope"`, `scope` and `resource_metadata` [MCP][A].
  - `Origin` present and not on the allowlist: 403.
  - GET or DELETE on `/mcp`: 405.
  - Body over 128 KiB: 413.
  - Gate closed: the tool is absent. A forged call gets `write_gate_closed`.
  - Rate limit: a tool result `rate_limited` with `retry_after_s`.
  - Mac workspace requested: `host_not_remote_enabled`. Runtime down: `agent_disconnected` (Phase 4).
- **Recovery:** a hub restart loses nothing; it is stateless and its rate-limit buckets reset. A runner restart follows REQ-P4-08. If ChatGPT loses access after the token lifetime, it refreshes with `offline_access`; when that is not granted, the owner reconnects (U-P5-11).
- **Concurrency:** parallel conversations share one principal. Separation comes from the workspace id, the ledger (one worker per Issue) and the session binding (D8). Duplicate submits are deduplicated by `client_request_id` (REQ-P4-07).
- **Compatibility:**
  - stdio clients (Claude Code, OpenCode) are unchanged;
  - Phase 4 loopback clients keep 9443;
  - `accepts()` stays as a wrapper so the existing tests still pass;
  - store `SCHEMA_V4` follows Phase 4's v3.
- **Privacy:** tool results go to OpenAI. The remote surface excludes `observe_*` (production and job data) and is limited to the project allowlist. Logs never contain arguments, tokens or file contents.
- **Deployment and rollback:**
  - Kill switch 1: `make memo-bridge-public-off` removes `/etc/traefik/dynamic/memo-bridge.yml` (watch, so immediate).
  - Kill switch 2: `remote.json.remote_enabled:false` makes 9445 answer 503.
  - Write rollback: set `remote_writes:"disabled"` and restart the hub.
  - Identity rollback: delete the user's sessions in Pocket ID (there is no revocation endpoint) and rotate the Pocket ID signing key as a last resort.

## 5. Requirements

| ID | Requirement | Scenario |
|---|---|---|
| REQ-P5-01 | `https://bridge.memolabs.dev` routes only `/mcp`, `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` to hub listener 9445. TLS requires a client certificate that chains to the OpenAI Connectors CA. Every other path and host returns 404. `/agent` and `/health` are not routed. | G |
| REQ-P5-02 | Listener 9445 accepts only Pocket ID JWTs with:<ul><li>`iss` = `https://auth.memolabs.dev`;</li><li>`aud` = `https://bridge.memolabs.dev/mcp`;</li><li>`typ` = `at+jwt`;</li><li>`sub` = the owner sub;</li><li>`client_id` on the allowlist;</li><li>a valid `exp`/`nbf`;</li><li>`maxTokenAge` from config, set to at least the measured token lifetime;</li><li>baseline scope `coordinator:read`.</li></ul>The static bearer is never accepted on 9445. | G |
| REQ-P5-03 | Error shapes and transport: 401 `invalid_token` with challenge, 403 `insufficient_scope`, 403 on a disallowed Origin, 405 on GET/DELETE with no `mcp-session-id`, 413 over 128 KiB. `MCP-Protocol-Version` is passed through. PRM is served at both paths, with `resource` = audience and `authorization_servers` = [issuer]. | G |
| REQ-P5-04 | `auth.memolabs.dev` is public over HTTPS with:<ul><li>signups disabled;</li><li>exactly one admin (the owner, with a passkey);</li><li>`/setup` closed;</li><li>rate limiting keyed on the real client IP (`TRUST_PROXY` set to the trusted gateway);</li><li>CIMD allowlisted only for the ChatGPT client URL(s);</li><li>an API resource `https://bridge.memolabs.dev/mcp` with its permissions;</li><li>image pinned by digest;</li><li>declared in lab-infra.</li></ul> | G |
| REQ-P5-05 | Before the first public route exists, the owner is enrolled behind a temporary `ipAllowList` limited to the owner's IP. No public state exists with 0 users. | G |
| REQ-P5-06 | The remote `tools/list` equals `REMOTE_TOOLS ∩ tools allowed for the principal`. Name, schema, description and annotations are byte-identical to stdio. Every remote tool has an `OPERATION_CAPABILITY` entry and explicit `readOnlyHint`, `destructiveHint` and `openWorldHint` values [F]. | A |
| REQ-P5-07 | Write gate (D7):<ul><li>with `remote_writes:"disabled"` (the default), no write tool is listed and a forged write call is refused by both the hub and the runtime;</li><li>the hub refuses to start with writes enabled while any `actions.runner.*` unit is active with `User=root`;</li><li>write scopes appear in `scopes_supported` only when the gate is open.</li></ul> | G |
| REQ-P5-08 | Principal `oidc:<sub>`. `client_type` comes from `client_id` (ChatGPT CIMD gives `chatgpt`). `args.client_type` is ignored for hub principals. Remote `workspace_open` defaults to `host:'vps'` and refuses `mac` with `host_not_remote_enabled`. | A, G |
| REQ-P5-09 | Remote operations are limited to the project allowlist in `remote.json` (a subset of the Phase 4 pilot repos, O-D3). | G |
| REQ-P5-10 | Remote write invariants (D9): no writes under `.github/workflows/**`, `.github/actions/**` or `.github/dependabot.yml`; push only to the workspace branch, never force, never the default branch; PR head = workspace branch, base = default branch; no merge tool. | A, G |
| REQ-P5-11 | Each conversation's work is isolated by workspace:<ul><li>`workspace_open` records `client_session` (a hash);</li><li>with `session_binding=block`, a write from a different present session is refused with `session_mismatch`;</li><li>with `warn`, it succeeds with a warning and an audit event;</li><li>`workspace_recover` rebinds and is audited.</li></ul> | A, D |
| REQ-P5-12 | Claim conflict: when Issue N is held by workspace W1, `task_claim(N)` from W2 returns a refusal naming the holder, and nothing in W1 changes. | C |
| REQ-P5-13 | Recovery: after a conversation is abandoned, a new conversation can `workspace_list`, `workspace_recover` and `task_status`, resume from the last checkpoint and finish. When the lease has expired, the state is visible as expired, never silently re-owned. | D |
| REQ-P5-14 | Response bounds (D10): compact JSON, 24 KiB default budget, `result_too_large` never truncation, paging clamps (`worktree_read_file`/`worktree_diff` 16 KiB per page with `next_offset`, `job_results` 200 lines/16 KiB, lists 50), `worktree_write_file` capped at 96 KiB remotely. Results go in `structuredContent` with a one-line `content`. | A |
| REQ-P5-15 | Slow mutating ops return `{status:'accepted', request_id}` past the soft deadline (default 40 s, tuned by U-P5-03). The final outcome is observable, and a retry with the same `client_request_id` creates nothing new. | A, D |
| REQ-P5-16 | Rate limits in the hub per `principal|class` (read 60/min, write 20/min, execute 6/min, 8 in flight), in Traefik per route, and a 401 flood limit per client IP. | G |
| REQ-P5-17 | Audit:<ul><li>one journald line per call or refusal, with `{at, request_id, principal, client_ref hash, op, outcome, code, ms, bytes}`;</li><li>runtime events carry `via`, `client_type` and `request_id`;</li><li>no arguments, tokens or content in either.</li></ul> | G |
| REQ-P5-18 | Kill switches (§4) work within 10 s and are documented. | G |
| REQ-P5-19 | Every Phase 5 artifact on the VPS is declared in lab-infra: the Pocket ID stack, the ingress role, the CA PEMs, the pinned hub cert copy, `remote.json`, the hub unit's OIDC settings and the Make targets. Phase 4 AC-P4-14 and `docs/architecture.md` ("Ce qui est réellement public") are amended to list exactly the two hosts. | G |
| REQ-P5-20 | ChatGPT Chat (web) connects with OAuth through CIMD (or the predefined-client fallback). The `client_id`, redirect URI, token claims and lifetime are recorded as evidence. | A |
| REQ-P5-21 | stdio and the Phase 4 loopback surfaces are unchanged: `npm test` and `npm run smoke` pass, and the Phase 4 ACs still pass. | regression |
| REQ-P5-22 | Docs: a new `docs/REMOTE_CHATGPT.md` covering setup, owner steps, the gate, the kill switches, revocation and the CA refresh. `OIDC_RESOURCE.md` and `HUB_SECURITY.md` reflect the deployed state. | (ops) |

## 6. Acceptance criteria

V = verification method: auto = `node --test` offline (jose local JWKS, fake-gh); rt = runtime on the VPS; man = owner in ChatGPT; insp = inspection.

| AC | REQ | Given / When / Then | V |
|---|---|---|---|
| AC-P5-01 | 01 | **Given** the route is deployed, **when** `curl https://bridge.memolabs.dev/mcp` runs from the Mac and from a product container, **then** TLS fails (no client certificate). `/agent`, `/health` and `/foo` on that host return 404 or a TLS failure. Unknown hosts keep the default 404. | rt |
| AC-P5-02 | 02 | **Given** minted tokens, **when** a token is sent with the wrong `aud`, `iss`, `sub` or `typ` (an ID token), an unlisted `client_id`, `exp` in the past, an age over the configured maximum, the static owner bearer, or no `coordinator:read`, **then** 401 (or 403 for scope). A valid owner token lists tools. | auto |
| AC-P5-03 | 03 | **Given** the hub, **when** GET/DELETE, a disallowed Origin, a 200 KiB body or a missing scope are sent, **then** 405 with no session header, 403, 413, and 403 `insufficient_scope` with `scope=` and `resource_metadata=`. `MCP-Protocol-Version` reaches the handler. Both PRM paths return the same JSON. | auto + rt (loopback 9445) |
| AC-P5-04 | 04 | **Given** enrollment is done, **when** `/setup` and signup are tried from a non-owner IP, **then** both are refused. Discovery shows `client_id_metadata_document_supported:true`. Pocket ID logs show distinct client IPs (not only the gateway). `docker inspect` shows a digest-pinned image. `make check` is clean. | rt + insp |
| AC-P5-05 | 05 | **Given** 0 users, **when** the auth router is first deployed, **then** a request from a non-allowlisted IP is 403, verified before the owner opens `/setup`. | rt |
| AC-P5-06 | 06 | **Given** a read principal, **when** `tools/list` is called over the hub, **then** it equals `REMOTE_TOOLS_READ`, matches the stdio snapshot for each tool, and every tool has the three hints set explicitly. | auto |
| AC-P5-07 | 07 | **Given** the gate is closed and a token carries the write scopes, **when** `tools/list` and a forged `tools/call task_claim` (hub) and a forged envelope (runtime) are sent, **then** there are no write tools, both calls are refused, and both refusals are journaled. **Given** `remote_writes:enabled` and a fixture `systemctl` that reports a root runner as active, **then** the hub exits non-zero at start. | auto + rt |
| AC-P5-08 | 08 | **When** `workspace_open{client_type:'codex', host:'mac'}` is called by a ChatGPT principal, **then** the call is refused (`host_not_remote_enabled`). With no host, `host=vps` and `client_type=chatgpt` are stored. | auto |
| AC-P5-09 | 09, 10 | **When** remote calls target a repo outside the allowlist, write `.github/workflows/x.yml`, push with force, push to `main`, or create a PR from a foreign head, **then** each call is refused with a distinct code and journaled. A normal push to the workspace branch succeeds (fake-gh). | auto |
| AC-P5-10 | 11 | **When** W1 is opened with session S1 and a write on W1 arrives with S2: with `block` it is refused (`session_mismatch`), with `warn` it succeeds with a warning and an event. `workspace_recover` from S2 rebinds and is audited. | auto |
| AC-P5-11 | 12 | **Given** two live ChatGPT conversations, **when** both claim Issue N on a pilot repo, **then** exactly one holds it, the other receives the holder, and the ledger ref history shows one worker. | man + rt (ledger) |
| AC-P5-12 | 13 | **Given** conversation 1 has claimed and checkpointed and its tab is closed, **when** a new conversation calls `workspace_list` and `workspace_recover`, then continues and completes, **then** there is no lost commit (branch history), events show the recovery, and with the lease expired the state shows expired before any re-claim. | man + rt |
| AC-P5-13 | 14 | A 300 KiB file is fully read through 16 KiB pages. A synthetic 40 KiB result gives `result_too_large`. JSON is compact. A 100 KiB remote write is refused. | auto |
| AC-P5-14 | 15 | **Given** a fake ledger that takes 130 s, **when** `task_claim` is called remotely, **then** `accepted` plus `request_id` comes back within the soft deadline. `task_status` later shows the claim. A retry with the same `client_request_id` creates no second claim. | auto |
| AC-P5-15 | 16 | Buckets per class, `rate_limited` carries `retry_after_s`, the 401 bucket is keyed on the trusted proxy header only, and the Traefik rateLimit returns 429 under a burst (loopback test on the Traefik router). | auto + rt |
| AC-P5-16 | 17 | The hub line and the runtime event share `request_id`. A grep of the journal for token prefixes (`eyJ`), argument markers and fixture file contents returns 0 hits. A gate refusal appears in the journal. | auto + rt |
| AC-P5-17 | 18 | `make memo-bridge-public-off` makes ChatGPT calls fail within 10 s, and `on` restores them. `remote_enabled:false` gives 503. | rt + man |
| AC-P5-18 | 19 | `make check` shows no drift. `grep -r bridge.memolabs.dev ansible/ stacks/` matches. The amended AC-P4-14 passes: the only route to the hub is `memo-bridge.yml`, targeting 9445 with the mTLS option. | insp + rt |
| AC-P5-19 | 20 | **Given** the owner connects in ChatGPT (read stage), **then** consent succeeds and `tools/list` is the read set. The hub logs (non-secret) the decoded `aud`, `scope`, `typ`, `client_id` and `exp−iat`, which are recorded in evidence. A call made 2× the token lifetime later still works (refresh). | man + rt |
| AC-P5-20 | A (06, 08, 10, 14) | **Given** the gate is open, **when** two conversations each take a different Issue, **then** both run claim, worktree, write, `jobs_submit test`, commit, push, PR and `task_complete`, using only Memo Bridge tools. Two PRs exist on separate branches, and each conversation's events reference only its own workspace. | man + rt |
| AC-P5-21 | 21 | Full `npm test` and `npm run smoke` pass on Node 22 and 24. The Phase 4 AC suite is re-run green. | auto |
| AC-P5-22 | 22 | The docs exist and match the deployed config (inspection against `remote.json` and the Traefik file). | insp |

## 7. Coverage matrix

| Category | Status | Where |
|---|---|---|
| Core behaviour | APPLICABLE | REQ-06..15 |
| UX (ChatGPT confirmation, error messages readable by the model) | APPLICABLE | REQ-03, 14; approval setting O5-12 |
| Loading / empty states | N/A | no UI of our own; ChatGPT renders |
| Error states | APPLICABLE | §4, REQ-03 |
| Cancellation | APPLICABLE | `job_cancel` (Phase 4 REQ-P4-20), write stage |
| Retries / idempotency | APPLICABLE | REQ-15 plus REQ-P4-07 |
| Persistence / data integrity | APPLICABLE | SCHEMA_V4 additive; ledger stays the only cross-machine state |
| State restoration | APPLICABLE | REQ-13 (D) |
| Concurrency | APPLICABLE | REQ-11, 12 |
| Authentication | APPLICABLE | REQ-02, 04, 05 |
| Authorization | APPLICABLE | REQ-07, 08, 09, 10 |
| Privacy | APPLICABLE | §4, REQ-17; data flows to OpenAI (R-P5-09) |
| Security | APPLICABLE | §10 |
| Accessibility | N/A | no UI surface owned by Memo Bridge |
| Performance | APPLICABLE | REQ-14, 15, 16; tool-definition size U-P5-04 |
| Networking | APPLICABLE | REQ-01, D1, D4 |
| Offline behaviour | APPLICABLE | VPS down: ChatGPT gets errors, stdio and the Mac keep working (decision doc) |
| Caching | N/A | stateless; JWKS caching by jose |
| Migrations | APPLICABLE | SCHEMA_V4; Pocket ID moved into lab-infra (adopt first) |
| Backward compatibility | APPLICABLE | REQ-21 |
| API contracts | APPLICABLE | REQ-06 (stdio parity), MCP versions (U-P5-13) |
| External integrations | APPLICABLE | ChatGPT, Pocket ID, GitHub |
| Logging / metrics / diagnostics | APPLICABLE | REQ-17; journald retention P2 |
| Unit / integration tests | APPLICABLE | §6 auto |
| End-to-end | APPLICABLE | AC-11, 12, 19, 20 (man + rt) |
| Build / packaging | APPLICABLE | Phase 4 TODO-P4-15 pinned release |
| Deployment / rollback | APPLICABLE | REQ-18, 19 |
| Documentation | APPLICABLE | REQ-22, TODO-P5-25 |
| Developer experience | APPLICABLE | `docs/REMOTE_CHATGPT.md`, loopback test path |
| User migration | N/A | single owner |
| Cleanup of obsolete behaviour | APPLICABLE | remove `hosts:read`, `makeMcp()` 3-tool surface, the Pocket ID hand deployment in `/opt/memo-bridge-auth` |
| ChatGPT plan entitlement | APPLICABLE | U-P5-01 resolved by observation on 2026-10-14 (EV-P5-01) |

## 8. Work graph

Stage R (read-only remote) has no dependency on #161. Stage W (writes) does.

| ID | P | Repo | Description | Deps | Files / systems | AC | Verification |
|---|---|---|---|---|---|---|---|
| TODO-P5-01 | P0 | docs | Close the doc unknowns: Traefik **v3.6** docs for `serversTransports.rootCAs`, `tls.options.clientAuth` and `rateLimit`; GHSA-qh6q-598w-w6m2 patched version; the GitHub fine-grained PAT "Workflows" permission for workflow-file pushes; the Pocket ID permission-key charset. Record each in the spec. | none | spec §0 | n/a | citations recorded |
| TODO-P5-02 | P0 | memo-bridge | `oidc.mjs` as an SDK `OAuthTokenVerifier` returning `AuthInfo`: `typ at+jwt`, `client_id` allowlist, configurable `maxTokenAge`, baseline `coordinator:read`, scopes mapped to capabilities, `accepts()` kept. New `bridge/scopes.mjs` (map, ceiling, `writeGateOpen`). | 01 | `bridge/oidc.mjs`, `bridge/scopes.mjs`, `tests/oidc-resource.test.mjs` | 02 | `npm test` |
| TODO-P5-03 | P0 | memo-bridge | Public listener 9445 (D4): `createMcpHandler(factory,{legacy:'stateless',responseMode:'json'})`, header passthrough, Origin/Host validation, 401/403 shapes, both PRM paths, 405, 128 KiB. `hub-cli` reads `remote.json`. Remove the 3-tool `makeMcp()`. | 02, P4-04 | `bridge/hub.mjs`, `bridge/hub-cli.mjs`, `tests/hub-oidc-http.test.mjs` | 02, 03 | `npm test` |
| TODO-P5-04 | P0 | memo-bridge | Registry plus remote surface (D5): `server/registry.mjs` (`TOOL_DEFS`, `REMOTE_TOOLS_READ/WRITE`), move the inline base/observer tools, forwarding adapter over the P4 envelope, `toolsFor(principal)`, explicit annotations, gate layers 1 and 2 plus the root-runner self-check. | 03, P4-03, P4-06 | `server/registry.mjs`, `server/tools/{base,observer}-tools.mjs`, `bridge/remote-surface.mjs`, `bridge/forward.mjs`, `tests/remote-surface.test.mjs` | 06, 07 | `npm test` |
| TODO-P5-05 | P0 | memo-bridge | Principal and policy: `READ` entries for the remote read tools, `makePrincipal(…,{client_type,via})`, `principalFromHub` accepts `oidc:`, `workspace_open` server-side `client_type`/host, project allowlist. | P4-06 | `server/coordinator/{policy,index}.mjs`, `tests/runtime-principal.test.mjs` | 08, 09 | `npm test` |
| TODO-P5-06 | P1 | memo-bridge | Bounds: compact JSON on the hub path, clamps, `result_too_large`, `max_bytes`. | 04 | tool modules, `bridge/remote-surface.mjs`, `tests/remote-bounds.test.mjs` | 13 | `npm test` |
| TODO-P5-07 | P1 | memo-bridge | Rate limits, hub audit lines, store `SCHEMA_V4` (`events.via/client_type/request_id`, `workspaces.client_session`). | 04, P4-08 | `bridge/ratelimit.mjs`, `server/coordinator/store.mjs`, `tests/remote-{ratelimit,audit}.test.mjs` | 15, 16 | `npm test` |
| TODO-P5-08 | P0 | memo-bridge | Remote write invariants (D9). First check what `worktrees.mjs` and `github-tools.mjs` already enforce on branch and force; add only the missing guards. | 04, 05 | `server/runners/worktrees.mjs`, `server/tools/github-tools.mjs`, `tests/remote-write-guard.test.mjs` | 09 | `npm test` |
| TODO-P5-09 | P1 | memo-bridge | Soft-deadline `accepted` path on top of the P4 `requests` table. Deadline from config. | 04, P4-08, U-P5-03 | `bridge/forward.mjs`, `server/coordinator/index.mjs`, test | 14 | `npm test` |
| TODO-P5-10 | P1 | memo-bridge | Session binding (D8) with `warn`/`block` config, plus rebind on `workspace_recover`. | 05, 07 | `server/coordinator/index.mjs`, test | 10 | `npm test` |
| TODO-P5-11 | P1 | memo-bridge | `remote_enabled` kill switch (503). Smoke over the hub with `@modelcontextprotocol/client` and a minted token. `scripts/remote-toolsize.mjs` reports the byte and approximate token size of `tools/list`. | 04 | `bridge/hub-cli.mjs`, `tests/mcp-smoke.mjs`, `scripts/` | 17, 21 | `npm test`, `npm run smoke` |
| TODO-P5-12 | P1 | memo-bridge | Docs: `REMOTE_CHATGPT.md`; update `OIDC_RESOURCE.md` (RFC 8707/CIMD exercised, with results) and `HUB_SECURITY.md` (two listeners, gate). | 11 | `docs/` | 22 | insp |
| TODO-P5-20 | P0 | lab-infra | **PR-A5, adopt only:** `stacks/memo-bridge-auth/compose.yml` byte-equivalent to `/opt/memo-bridge-auth` (image pinned by digest, secrets from the keychain/`.env` template, nothing in Git). | none | `stacks/memo-bridge-auth/`, Makefile | 18 | `make check` empty diff |
| TODO-P5-21 | P0 | lab-infra | **PR-B5:** network `lab`, Traefik labels for `auth.memolabs.dev`, rateLimit, a **temporary ipAllowList** variable, `/setup` blocked after enrollment, `TRUST_PROXY`, `ALLOW_USER_SIGNUPS=disabled`, `CIMD_URL_ALLOWLIST`. | 20, 01 | same | 04, 05 | `make check` |
| TODO-P5-22 | P0 | lab-infra | **PR-C5:** `roles/memo-bridge-ingress` templating `/etc/traefik/dynamic/memo-bridge.yml` (D1 recipe, target 9445), the OpenAI CA PEMs, the pinned hub cert copy, gated by `memo_bridge_public: false` by default; `make memo-bridge-public-{on,off}`. | 01, P4-20 | `ansible/roles/memo-bridge-ingress/`, Makefile | 01, 17 | `make check` |
| TODO-P5-23 | P0 | lab-infra | Hub unit: OIDC settings, `remote.json` template (issuer, audience, owner_sub, allowed_client_ids, projects, `remote_writes: disabled`, `session_binding`, budgets), second listener. | P4-20, 03 | `ansible/roles/memo-bridge/` | 02, 07 | `make check` |
| TODO-P5-25 | P0 | lab-infra + memo-bridge | Amend AC-P4-14/REQ-P4-14 and `docs/architecture.md` "Ce qui est réellement public" (exactly two hosts, the mTLS rule). | 22 | `docs/architecture.md`, phase-4 spec | 18 | insp |
| TODO-P5-26 | P2 | lab-infra | Pin Traefik by digest. Inspect by digest, never pull `:latest` (CLAUDE.md). | none | `group_vars/lab.yml` | n/a | `make check` |
| TODO-P5-27 | P2 | lab-infra | Journald retention for hub audit; monthly CA/IP-range recheck reminder. | 22 | watchdog / docs | n/a | insp |
| TODO-P5-30 | P0 | VPS ops | Deploy PR-A5 (no change), then PR-B5 with the allowlist at the owner IP. Negative test from another IP before enrollment. | 20, 21, O5-04, O5-07 | VPS | 05 | rt |
| TODO-P5-31 | P0 | VPS ops + owner | Owner enrollment (O5-05). Then remove the allowlist, close `/setup`, and verify signup refused, real IPs logged, discovery shows CIMD true. | 30 | Pocket ID | 04 | rt |
| TODO-P5-32 | P0 | VPS ops | Deploy hub OIDC read stage (PR for 23), then the ingress (`memo_bridge_public: true`). Run AC-01/02/03 on 9445 loopback and from outside. | 31, 03, 04, 05, 22, 23, P4-31 | VPS | 01, 03, 18 | rt |
| TODO-P5-33 | P0 | owner + VPS ops | Read-stage connection in ChatGPT (O5-06). Capture `client_id`, redirect and claims. Measure the tool-list fit (U-04), the timeout (U-03, with a delay-capable read-only probe op enabled only in this window), session stability (U-05) and refresh (U-11). | 32 | ChatGPT, journald | 19 | man + rt |
| TODO-P5-34 | P0 | all | **Write-stage gate:**<ul><li>#161 closed (TODO-P4-25);</li><li>amended AC-P4-14 passes;</li><li>TODO-P4-40 done;</li><li>U-P5-01 positive;</li><li>TODO-P5-08/09/10 done.</li></ul>Then the owner flips `remote_writes` (O5-10) and reconnects for the write scopes. | P4-25, P4-40, 08, 09, 10, 33, U-P5-01 | `remote.json` (lab-infra) | 07 | rt (self-check passes) |
| TODO-P5-35 | P0 | owner + VPS ops | Scenario runs A (AC-20), C (AC-11), D (AC-12), plus a G sweep with writes on: AC-01/02/07/09 live, a product container probe, journal grep. | 34, P4-34 | ChatGPT, VPS | 11, 12, 16, 20 | man + rt |
| TODO-P5-36 | P1 | owner + VPS ops | Kill-switch drill. | 32 | VPS | 17 | rt + man |
| TODO-P5-40 | P1 | orchestrator | Evidence, `state.json`, Vault update through `vault-commit.sh` and `memory-pointer.sh`, manual acceptance checklist. | all P0/P1 | `.agent/project/phase-5/*`, `memo-labs-os.md` | all | completion checksum |

Planning completeness check. If every TODO above were done, A, C, D and G would be provable, under two conditions:
- **U-P5-01 resolves positively.** If the owner's plan only allows read/fetch tools, no amount of engineering satisfies A, C or D in ChatGPT Chat.
- **#161 closes.** The graph cannot remove either dependency.

## 9. Owner-only actions (one batch)

1. **O5-01, plan and developer mode.** Say which ChatGPT plan you are on. On the web, open ChatGPT settings and check that developer mode is available [HC1]. If you are on Plus or Pro, decide between two options:
   - (a) a Business workspace, where you as owner or admin toggle developer mode [HC1];
   - (b) accepting a read-only ChatGPT, with writes coming from the other clients. Under (b), Phase 5 completion is re-scoped to read plus G.
2. **O5-02, hostname.** Confirm `bridge.memolabs.dev` (default) or pick `mcp.memolabs.dev`.
3. **O5-03, DNS.** No record is needed: the wildcard A record already resolves both hosts. Confirm that you want no change at Porkbun.
4. **O5-04, approve public exposure (D1).** Two public hosts: `auth.memolabs.dev` (passkey login) and `bridge.memolabs.dev` (mTLS to OpenAI, owner OAuth). Give your current public IP for the enrollment allowlist.
5. **O5-05, identity-provider admin, in the enrollment window:**
   - open `https://auth.memolabs.dev/setup` and create the admin with a passkey;
   - create the API with audience `https://bridge.memolabs.dev/mcp` and permissions `coordinator:read`, `coordinator:write`, `runner:execute`, `repo:write`, `github:write` (or the fallback names from TODO-P5-01);
   - enable CIMD access for that API with `coordinator:read` only at first, and allow `offline_access`;
   - read your user UUID (the `sub`) and hand it over. It is not a secret.
6. **O5-06, ChatGPT settings, read stage.** Go to chatgpt.com/plugins, then "+" and "Add custom MCP server" [B][G]. Enter URL `https://bridge.memolabs.dev/mcp` and choose OAuth. Accept the risk warning, then copy the exact redirect URI and client id the page shows. Consent with your passkey. Keep the permission level at "Always ask"; do not use "Allow all actions" [HC3].
7. **O5-07, reviews and deploys.** Review and merge lab-infra PR-A5, PR-B5, PR-C5 and the hub-unit PR by hand. Approve any memo-bridge PR that touches `.github/workflows`. Run the deploys yourself (`make …`) or explicitly authorize one.
8. **O5-08, GitHub token for PRs.** Extend Phase 4 `memo-runner-push` (O-2) with **Pull requests: write** on the pilot repos, or create a separate PR token. Keep **Workflows** unset.
9. **O5-09, #161.** The Phase 4 O-5 maintenance window: move emargo off root and remove the dead drop runner.
10. **O5-10, opening the write gate.** After TODO-P5-34's checks, set `remote_writes: enabled` in lab-infra, add the write permissions to the API's CIMD access, then reconnect the ChatGPT connector so it gets the new scopes.
11. **O5-11, decisions:**
    - session binding `warn` or `block` after the U-P5-05 data;
    - the project allowlist (a subset of O-D3);
    - whether `coordinator:write` (claims only) may open before #161 (default no).
12. **O5-12, manual acceptance.** Run the scenario script (TODO-P5-35) in two or three parallel chats, plus the kill-switch drill.

## 10. Risk register

| ID | Risk | Likelihood | Impact | Mitigation | TODO | Status |
|---|---|---|---|---|---|---|
| R-P5-01 | **Setup takeover.** `/setup` is open with 0 users, so a public auth route before enrollment hands over admin. | High if ordering slips | Critical | REQ-05 ipAllowList, AC-05 checked before `/setup`, signups disabled | 21, 30, 31 | open |
| R-P5-02 | **Public exposure of the hub.** Product users or scanners reach `/mcp`, `/agent`, or the static bearer. | Low | Critical | mTLS to the OpenAI CA, exact-path router, separate OIDC-only listener (D4), `/agent` and `/health` unrouted, AC-01 from outside and from a product container | 03, 22, 32 | open |
| R-P5-03 | **Write tools before #161.** A root runner turns any repo write or CI run into VPS root. | Medium | Critical | D7 three layers, start-up self-check, workflow-path refusal (D9), Workflows permission unset | 04, 08, 34 | open |
| R-P5-04 | **Token theft:**<ul><li>the ChatGPT-held refresh token (30 d) leaks;</li><li>a token is replayed elsewhere.</li></ul> | Low | High | Replay from outside OpenAI fails TLS (mTLS); `aud`/`typ`/`client_id`/owner-sub checks; short access-token age; revoke by deleting the Pocket ID sessions (no revocation endpoint); kill switch. Residual risk: an attacker inside OpenAI's connector path (inferred). | 02, 22, 36 | open |
| R-P5-05 | **Another ChatGPT user points a connector at bridge.memolabs.dev.** mTLS passes because the cert identifies OpenAI, not a user [D][A]. | Medium | Low | Owner-sub check, signups disabled, CIMD access limited per API; journald shows the 401 flood | 02, 04, 16 | open |
| R-P5-06 | **Prompt injection from Issues, PR comments or repo files** steers a conversation into harmful writes, cross-workspace writes or exfiltration through PR text. | High | High | D9 server invariants, project allowlist, no merge tool (contract bot plus human review for workflows/infra), session binding, ChatGPT confirmation on every write, write and execute rate limits, Phase 4 job sandbox (no creds, network deny) for recipe code the model can edit, results marked as data in the server `instructions` | 08, 10, 07 | open |
| R-P5-07 | **OpenAI policy changes:** plan gating (beta), developer mode, CIMD client id, CA rotation, IP ranges, annotation semantics. | Medium | Medium | Fail closed (CA change → TLS fails, not opens); doc dates recorded in §0; P2 monthly recheck; fallbacks (predefined client, tunnel) documented | 12, 27 | open |
| R-P5-08 | **Plan does not allow write tools in Chat** [HC1]. | Low (observed working on Plus, 2026-10-14) | Critical for A/C/D | EV-P5-01; re-run the probe after any OpenAI plan or connector change, since the behaviour is observed, not documented | 34 | mitigated (watch) |
| R-P5-09 | **Private code and state flow to OpenAI** through tool results. | Certain | Medium | Owner choice of ChatGPT; project allowlist; `observe_*` excluded; bounded results | 04, 05 | accepted with mitigation |
| R-P5-10 | **Single rate-limit bucket / lockout.** With `TRUST_PROXY=false`, all clients share the gateway IP. | High today | Medium | Set `TRUST_PROXY` after the move; verify distinct IPs in AC-04 | 21 | open |
| R-P5-11 | **Token-age mismatch causes 401 loops** (20 min hub versus about 1 h Pocket ID, inferred). | Medium | Medium | Measure in AC-19; set `maxTokenAge` ≥ lifetime | 02, 33 | open |
| R-P5-12 | **ChatGPT timeout below ledger latency**, so the claim happens but its result is lost. | Medium | Medium | D10 `accepted` path plus idempotency; measure (U-03) | 09 | open |
| R-P5-13 | **Tool definitions too large** for ChatGPT (community report, unverified). | Medium | Medium | `REMOTE_TOOLS` subset; size script; measure | 11, 33 | open |
| R-P5-14 | **Pocket ID vulnerability** on a now-public host (GHSA-qh6q-598w-w6m2 patch status unknown). | Low | High | TODO-01 check; digest pin; release watch; rate limit | 01, 20 | open |
| R-P5-15 | **Drift** between `/opt/memo-bridge-auth` and lab-infra; pinned hub cert expiry 2027-02-10. | Medium | Low | Adopt-first PR-A5; cert copy rotated with the hub cert, noted in the docs | 20, 22, 12 | open |
| R-P5-16 | **Phase 4 not merged** or its op registry changes shape. | Medium | Medium | Explicit dependencies on P4-03/04/06/08/20; start the memo-bridge TODOs after P4 lands | n/a | open |

## 11. Unknowns

| ID | Unknown | Blocking? | How to resolve |
|---|---|---|---|
| U-P5-01 | Does the owner's ChatGPT plan allow write tools in Chat? | Resolved | **Yes, observed.** Plus account, ChatGPT desktop 26.1007, Chat tab, custom MCP server by URL with no authentication. A probe write tool (`readOnlyHint:false`) ran with no confirmation prompt; the server logged user agent `openai-mcp/1.0.0` (EV-P5-01). A local stdio plugin is not offered in Chat; it runs only in Work, which the owner excludes. |
| U-P5-02 | Does Pocket ID v2.18.0, live, issue `aud`=resource, the expected `scope`/`scp`, `typ at+jwt`, a `client_id` equal to the CIMD URL, and what lifetime? Does CIMD accept ChatGPT's exact `client_id`, including the `…/{callback_id}/client.json` variant? | **Yes**, for TODO-P5-23 values and for AC-02 fixtures | Read the [PID-SRC] tests, then the TODO-P5-33 live connect with claim logging (read stage only, so safe). Fallback: a predefined public client. |
| U-P5-03 | ChatGPT tool-call timeout on direct connections. | Yes, for the TODO-P5-09 deadline value | Measure in the TODO-P5-33 window with a delay-capable read-only probe enabled only in that window. |
| U-P5-04 | ChatGPT limit on tool-definition size or count. | Yes, for the final `REMOTE_TOOLS` | `scripts/remote-toolsize.mjs` plus the TODO-P5-33 observation: are all listed tools visible after Refresh [G]? |
| U-P5-05 | Is `_meta["openai/session"]` present and stable for one conversation across page refreshes? | No (the default is `warn`) | Log hashes during TODO-P5-33 across three conversations and refreshes. |
| U-P5-06 | Exact master-plan wording for A, C, D and G. | No | The orchestrator pastes the master plan. Only the §0 mapping changes. |
| U-P5-07 | Pocket ID permission-key charset (`coordinator:read`). | Yes, for O5-05 | TODO-P5-01: read [PID-API] and the source validation. Fallback `coordinator.read`. |
| U-P5-08 | Does ChatGPT actually present the client certificate on every direct call, including the PRM fetch? Documented [A], not observed. | **Yes**, for D1 | Deploy the route first with `clientAuthType: VerifyClientCertIfGiven` plus `passTLSClientCert` logging during TODO-P5-33 (the read stage only exposes read tools). Switch to `RequireAndVerifyClientCert` only after seeing the cert. If it is absent: the IP allowlist from `chatgpt-connectors.json` [D], or the tunnel fallback. |
| U-P5-09 | Traefik 3.6.25 support for the fields used (docs read are v3.7). | Yes, for PR-C5 | TODO-P5-01: read the v3.6 docs; `make check` dry run. |
| U-P5-10 | Is GHSA-qh6q-598w-w6m2 / CVE-2026-28513 fixed in v2.18.0? | Yes, for the public auth route | TODO-P5-01: the advisory's patched-version field. |
| U-P5-11 | Is `offline_access` granted to CIMD clients, so ChatGPT can refresh? | No (the owner can reconnect) | The AC-19 refresh check. |
| U-P5-12 | Which ChatGPT MCP protocol version is negotiated (2025-11-25 or 2026-07-28)? | No | Log `MCP-Protocol-Version` in TODO-P5-33. |
| U-P5-13 | Do the existing `worktrees.mjs` and `github-tools.mjs` already enforce branch, force and default-branch rules? | No (it only sizes TODO-P5-08) | Read the phase-3/4 code at TODO-P5-08 start. |

## 12. Verification plan and manual acceptance

- **Automated (every PR):** `npm test` on Node 22 and 24, covering the new suites `oidc-resource`, `hub-oidc-http`, `remote-surface`, `runtime-principal`, `remote-bounds`, `remote-ratelimit`, `remote-audit` and `remote-write-guard`. Also `npm run smoke` over the hub, `make check` on lab-infra, and the Phase 4 AC re-run (AC-P5-21).
- **Runtime (owner windows):**
  - TODO-P5-30/31 (auth host, AC-04/05);
  - TODO-P5-32 (ingress negatives from the Mac and from a product container, AC-01/03/18);
  - TODO-P5-33 (read-stage connect, AC-19);
  - TODO-P5-35 (A, C, D, G live);
  - TODO-P5-36 (kill switch).
- **Evidence:** request ids that join hub journald lines to runtime events; ledger ref history; PR URLs; the decoded non-secret claim summary; `make check` output.
- **Manual checklist (owner):**
  1. Two chats on two Issues end with two PRs.
  2. A third chat on a held Issue is refused, with the holder named.
  3. A chat is closed mid-task, and a new chat recovers and completes.
  4. Each write showed a confirmation.
  5. The kill switch stops and restores access.
  6. Nothing answers at `bridge.memolabs.dev` from a normal browser.

## 13. Proposed state.json

```json
{"phase":"SPECIFICATION","scope":"Phase 5: ChatGPT Chat conversations on Memo Bridge (remote hub, Pocket ID OAuth, mTLS ingress, write gate on #161)","requirements":{"total":22,"covered":22},"acceptance":{"total":22,"verified":0,"failed":0,"pending":22},"todos":{"p0_open":17,"p1_open":8,"p2_open":2},"blocking_unknowns":["U-P5-02","U-P5-03","U-P5-04","U-P5-07","U-P5-08","U-P5-09","U-P5-10"],"external_dependencies":["phase-4 TODO-P4-03/04/06/08/20/31/34/40","lab-infra #161 (TODO-P4-25)"],"risks":{"critical_open":3,"high_open":4},"ready_for_manual_acceptance":false}
```

Counts: P0 = 01, 02, 03, 04, 05, 08, 20, 21, 22, 23, 25, 30, 31, 32, 33, 34, 35 (17). P1 = 06, 07, 09, 10, 11, 12, 36, 40 (8). P2 = 26, 27 (2).

**Files referenced:**
- `/Users/memo/projects/memo-bridge/bridge/oidc.mjs`
- `/Users/memo/projects/memo-bridge/bridge/hub.mjs`
- `/Users/memo/projects/memo-bridge/docs/OIDC_RESOURCE.md`
- `/Users/memo/projects/_worktrees/memo-bridge/phase-4/.agent/project/phase-4/spec.md`
- `/Users/memo/Vault/1-Projects/memo-labs-os.md`
- `/Users/memo/memolabs/workspace/decisions/2026-10-13-multi-client-coordination.md`
- `/Users/memo/memolabs/workspace/decisions/2026-10-13-vps-independent-execution.md`
- `/Users/memo/.agents/skills/whole-project-protocol/SKILL.md`