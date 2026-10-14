# Memo Bridge Phase 5 design: the hub serves the shared tool registry to ChatGPT chat conversations

This was a read-only run. I changed no files. On the VPS I ran only read-only `ssh lab` commands, and I printed environment variable names only.

## 0. What the design starts from

**Code (`~/projects/memo-bridge` at `a499754`, main)**
- **The hub still serves its own three tools, not the registry.**
  - `bridge/hub.mjs:80` `makeMcp()` registers only `list_hosts`, `host_status` and `bridge_info`. The test asserts exactly 3 tools: `tests/hub-oidc-http.test.mjs`, `tools.length,3`.
  - The 49 stdio tools are registered separately. Some are inline in `server/index.mjs:56-160`, the rest go through `register*Tools(server, getRuntime)` at `server/index.mjs:163-168`.
- **Each request gets a new server, and some headers are dropped.**
  - The hub builds a new `McpServer` and a stateless transport per POST (`sessionIdGenerator:undefined`, `hub.mjs:98`).
  - The rebuilt `Request` keeps only `content-type` and `accept` (`hub.mjs:101`). `MCP-Protocol-Version` is lost.
  - `Origin` is checked only on `/agent` (`hub.mjs:127`). `/mcp` does not check it.
  - The request body is capped by `MAX_HTTP_BYTES=64 KiB` (`hub.mjs:12`).
- **`oidc.mjs` returns a yes/no, not an identity.**
  - `accepts()` returns a boolean (`bridge/oidc.mjs:27`). It drops `sub`, `scope` and `client_id`.
  - It requires all configured scopes, with `hosts:read` as the default (`oidc.mjs:33`).
  - It sets `maxTokenAge:'20m'` and does not check `typ` (`oidc.mjs:30`).
- **The principal is fixed for the whole process.**
  - `getRuntime()` is a process singleton with `localOwnerPrincipal()` (`server/runtime.mjs:14,40`).
  - `github-tools.mjs:57,153` calls `getRuntime()` without `await`.
  - Per-runtime services are cached by WeakMap or by a single slot: `worktree-tools.mjs`, `github-tools.mjs`, `job-tools.mjs`.
- **11 tools have no policy entry.**
  - `OPERATION_CAPABILITY` (`server/coordinator/policy.mjs`) has no entry for the base and observer tools: `list_hosts`, `host_status`, `bridge_info`, `projects_*`, `project_*`, `observe_*`.
  - These tools have no gate today. `authorize()` would refuse them, because an unknown op returns false.
- **`client_type` comes from the model today.**
  - `workspace_open` takes `client_type` from the arguments (`server/coordinator/index.mjs:414`).
  - `CLIENT_TYPES` already contains `'chatgpt'` (`index.mjs:22`).
- **Some responses are much larger than a chat turn can comfortably take.**
  - `worktree_read_file` returns up to 256 KiB and `worktree_diff` up to 200 KiB. `worktree_write_file` accepts 512 KiB (`server/runners/worktrees.mjs:35-46`).
  - `job_results` returns up to 64 KiB (`jobs.mjs:63`).
  - All results are pretty-printed with `JSON.stringify(data,null,2)`, in 7 places.
- **What Phase 4 already plans** (`_worktrees/memo-bridge/phase-4`, commit `1410e47`; only `.agent/project/phase-4/spec.md` is there, no code yet):
  - D1: the runtime runs on the VPS behind the hub, which stays stateless.
  - D9: credential to principal map, using a read-only bearer.
  - TODO-P4-03: op registry v2 in `bridge/ops.mjs` / `protocol.mjs`.
  - TODO-P4-06: `runtime.as(principal)` and `principalFromHub`.
  - REQ-P4-02: 16 KiB frames with pagination.
  - REQ-P4-07: `client_request_id` idempotency.
  - TODO-P4-40: the write gate.

**VPS (read-only, 2026-10-14)**
- `memo-bridge-hub` is active as `User=memo-bridge`. Its only environment variable is `MEMO_BRIDGE_SECRETS`, with no `MEMO_BRIDGE_OIDC_SETTINGS`, so the live hub is in bearer mode.
- 9443 and 1411 listen on 127.0.0.1 only.
- Pocket ID runs as `ghcr.io/pocket-id/pocket-id:v2.18.0`.
- `actions.runner.guillaume-flambard-emargo` is active with `User=root`, running `/root/actions-runner`.
- lab-infra #161 is **OPEN**.
- So the write gate is closed.

**Official docs (read, not executed)**
- **ChatGPT OAuth:** ChatGPT uses OAuth 2.1 code flow with PKCE S256. It identifies itself by CIMD (preferred), DCR or a predefined client. It sends `resource` on both the authorize and token requests. The server must return 401 with `WWW-Authenticate: Bearer resource_metadata=…` (developers.openai.com/apps-sdk/build/auth).
- **ChatGPT request metadata:** tool calls carry `_meta["openai/subject"]` ("anonymized user id … for rate limiting") and `_meta["openai/session"]` ("anonymized conversation id"). OpenAI says not to use them for authorization (developers.openai.com/plugins/reference.md).
- **Annotations:** they "only influence how ChatGPT … frames the tool call", so the server must enforce authorization itself (same page).
- **No documented size limit** for tool results. The only number is a forum report of truncation (community.openai.com/t/…/1383071), which is unverified.
- **MCP 2025-11-25:**
  - Sessions are optional (`MCP-Session-Id` MAY be assigned).
  - GET may return 405.
  - `Origin` MUST be validated when present.
  - 403 `insufficient_scope` is the step-up path.
  - Audience binding is required and token passthrough is forbidden.
  - Sources: modelcontextprotocol.io/specification/2025-11-25/basic/transports and …/authorization.
- **SDK `@modelcontextprotocol/server` 2.3.1 (installed):**
  - `createMcpHandler(factory, {legacy:'stateless'})` builds one server instance per HTTP request.
  - The factory receives `ctx.authInfo`. Legacy GET/DELETE get 405.
  - `verifyBearerToken` and `requireScopes` exist.
  - Source: `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts:3876-4165,774-812,2819`.
- **Pocket ID:**
  - The "APIs" feature (resource plus permissions, `aud` set to the resource) shipped in v2.10.0.
  - RFC 9068 access tokens and CIMD shipped in v2.13.0 (github.com/pocket-id/pocket-id/releases; pocket-id.org/docs/guides/apis).
  - `docs/OIDC_RESOURCE.md` says these "are not assumed". Since v2.18.0 is installed, they are now **documented but not exercised**.

## 1. Design decisions (P5-D*)

| ID | Decision | Basis |
|---|---|---|
| D1 | **One registry, three adapters.** Tool modules stay unchanged and register into an object that only needs `registerTool(name, def, handler)`.<ul><li>stdio passes the real `McpServer`.</li><li>The hub passes a *forwarding* adapter: same name, schema, description and annotations, but the handler calls `forward(host, op, args, ctx)`.</li><li>The runtime agent passes a *dispatch-table* adapter that captures the handlers and runs them under `rt.as(principal)`.</li></ul> | The hub must hold no state and no GitHub tokens (phase-4 D1/D2). It also prevents the two surfaces drifting apart. |
| D2 | **Principal = `oidc:<sub>`.** `sub` must equal the configured owner sub. Capabilities = token scopes ∩ server ceiling ∩ write gate. The client is recorded as a separate attribute and is never part of the principal. | `PRINCIPAL_RE` in `policy.mjs` accepts `oidc:<uuid>` but not a CIMD URL. |
| D3 | **Stateless per request, no `Mcp-Session-Id`.** Work continues across calls through the `workspace_id` passed explicitly, as stdio already does. Each ChatGPT conversation opens its own workspace. | MCP sessions are optional. The SDK legacy stateless path answers GET/DELETE with 405. ChatGPT's session lifecycle is not documented. |
| D4 | **The VPS runtime is the coordination owner for remote clients.** Coordinator, GitHub read and audit ops go to the VPS. Worktree and job ops go to the host of the workspace. Host tools go to the `host` argument. | The user's constraint, plus phase-4 D1. |
| D5 | **`client_type` comes from the server.** The hub maps `client_id` (an allowlist of ChatGPT CIMD URLs) to `chatgpt`. The runtime overrides `args.client_type` for hub principals. | Identity never comes from tool arguments (`policy.mjs` header comment). |
| D6 | **Write gate in three layers:**<ol><li>Tools whose capability is a write are *not registered* on the remote surface while the gate is closed.</li><li>The ceiling removes write capabilities from the principal.</li><li>The runtime `authorize()` checks again.</li></ol> | `HUB_SECURITY.md`: "Do not enable write-capable MCP tools until it is isolated". #161 is open. |
| D7 | **Bounded responses on the remote surface.** The hub refuses results over budget with `result_too_large`. It never cuts JSON silently. Remote-only paging limits are lower. | No documented ChatGPT limit, so the server owns the bound. |

## 2. File-level design

**New files**
- **`server/registry.mjs`**
  - `TOOL_DEFS`: the canonical list of tool names, with group, op and `served_by` (`vps` | `workspace_host` | `arg_host` | `hub`).
  - `registerAll(target, getRuntime, {include})`: calls each `register*Tools`.
  - `filteredTarget(target, allowed)`: an adapter whose `registerTool` skips names that are not allowed.
  - `bridge_info` and the smoke test read from it, replacing `ALL_TOOLS` in `index.mjs`.
- **`server/tools/base-tools.mjs`** and **`server/tools/observer-tools.mjs`**: the inline tools from `server/index.mjs:56-160` move here, unchanged.
- **`bridge/scopes.mjs`**
  - `SCOPE_TO_CAPABILITY` (§3).
  - `principalFromClaims({sub,scope,client_id}, cfg)` returns `{id, capabilities, client_type, client_ref}`.
  - `CEILING`. `writeGateOpen(cfg)` returns false unless `cfg.remote_writes === 'enabled'`.
- **`bridge/remote-surface.mjs`**
  - `mcpFactory(ctx)`: reads `ctx.authInfo.extra.principal`, builds a new `McpServer`, and runs `registerAll(forwardingTarget(principal), throwingGetRuntime, {include: toolsFor(principal)})`. `throwingGetRuntime` guarantees the hub never runs a tool itself.
  - `toolsFor` keeps only the tools whose `OPERATION_CAPABILITY` is in the capability set.
  - Wraps each handler with the rate limiter, the response budget and the audit record.
  - Reads `_meta["openai/session"]` and `["openai/subject"]` from the request (hashed and truncated, for logs and labels only).
- **`bridge/forward.mjs`**: the routing table (§4) on top of phase-4 `bridge/ops.mjs`.
  - Builds an envelope `{op, args, principal:{id,caps,client_type}, request_id, client_session}`.
  - Uses the per-op timeouts from phase-4.
  - Reassembles 16 KiB frames.
- **`bridge/ratelimit.mjs`**: token buckets in memory, keyed `principal|class`, with classes `read`, `write`, `execute`. Also a 401 bucket per client address, taken from the trusted proxy header only.

**Changed files**
- **`bridge/oidc.mjs`**
  - Implements the SDK `OAuthTokenVerifier`: `verifyAccessToken` returns `AuthInfo` with `{clientId, scopes, expiresAt, resource, extra:{sub}}`.
  - Requires the baseline scope `coordinator:read` only. Other scopes map to capabilities instead of all being required.
  - Adds `typ:'at+jwt'` (RFC 9068), a `client_id` claim checked against the allowlist, and `maxTokenAge` from configuration, aligned with the Pocket ID token lifetime (Q3).
  - Keeps `accepts()` as a wrapper so the existing tests stay valid.
- **`bridge/hub.mjs`**
  - `/mcp` goes through `requireBearerAuth` → Origin/Host validation (`originValidationResponse` / `hostHeaderValidationResponse` with an allowlist for `bridge.memolabs.dev`) → `createMcpHandler(mcpFactory,{legacy:'stateless', responseMode:'json', maxRequestBodySize})` → `handler.fetch(request,{authInfo})`.
  - Forwards the original headers (`mcp-protocol-version`) instead of rebuilding them as on `:101`.
  - Raises the body bound to 128 KiB for the remote surface (Q7).
  - Still serves the agent WSS and `/health`. The old `makeMcp()` is removed.
- **`server/runtime.mjs`**
  - `as(principal)` (phase-4 TODO-06), memoized per `principal.id + sorted caps + client_type`. This keeps the WeakMap and single-slot caches warm.
  - The memoized views share the store and the ledger. Each view has its own coordinator.
  - `getRuntime()` stays synchronous, because of `github-tools.mjs:57,153`.
- **`server/coordinator/policy.mjs`**
  - Adds `READ` entries for `list_hosts`, `host_status`, `bridge_info`, `projects_list`, `project_info`, `project_git_status`, `projects_audit` and `observe_*`.
  - `makePrincipal(id, caps, {client_type, via})`.
  - `principalFromHub(envelope, agentTrust)`: accepts only principals whose prefix is `oidc:` or `hub:`, and caps them with the agent-side ceiling.
- **`server/coordinator/index.mjs`** (`workspaceOpen`)
  - `clientType = principal.client_type ?? args.client_type ?? 'other'`.
  - When `via==='hub'`, `host` defaults to `'vps'`. `host:'mac'` is refused remotely with `host_not_remote_enabled` until Q5 is decided.
  - Stores `client_session` (a sha256 prefix of `openai/session`).
- **`server/coordinator/store.mjs`**, `SCHEMA_V4` after phase-4 v3:
  - `events`: add `via` (`stdio`|`hub`), `client_type`, `request_id`.
  - `workspaces`: add `client_session`.
  - No arguments and no content are stored.
- **Tool modules**
  - Compact JSON on the hub path. Stdio keeps pretty-printing.
  - Optional `max_bytes` on `worktree_read_file` and `worktree_diff`, with a remote clamp (§6).
  - `destructiveHint:true` on `worktree_remove`, `job_cancel` and `task_release`.
  - Coordinator tools get `openWorldHint:false`. OpenAI's reference says a private account is not open-world.
- **`bridge/hub-cli.mjs`**: reads `remote.json` (root 0644): `owner_sub`, `allowed_client_ids`, `ceiling`, `remote_writes`, budgets, rate limits.
- **Docs**
  - `docs/OIDC_RESOURCE.md`: Pocket ID APIs, RFC 9068 and CIMD are documented since v2.10/v2.13, still to be exercised.
  - `docs/HUB_SECURITY.md`: write gate status.
  - New `docs/REMOTE_CHATGPT.md`.

## 3. OIDC scopes to capabilities

OAuth scope names are the same strings as the capabilities, and they fit the scope-token grammar.

| Scope in token | Capability | Tools reachable remotely | While #161 is open |
|---|---|---|---|
| `coordinator:read` (baseline, required) | READ | observe, catalog, `workspace_status/list/recover`, `tasks_list`, `task_status`, worktree reads, job reads, `host_*`, `github_*` reads, `audit_*` | allowed |
| `coordinator:write` | WRITE | `workspace_open/close`, `task_claim/renew/release/complete/checkpoint` | **removed by the ceiling** (inferred to be in scope of the gate: claims change the shared ledger) |
| `runner:execute` | EXECUTE | `jobs_submit`, `job_cancel` | removed |
| `repo:write` | REPO_WRITE | `worktree_create/write_file/commit/push/remove` | removed |
| `github:write` | GITHUB_WRITE | `github_create_pr` | removed |
| `coordinator:audit` | AUDIT | everyone's audit events | allowed (read) |

- `scopes_supported` in RFC 9728 metadata lists only `coordinator:read`. The others come through 403 `insufficient_scope` step-up, following the MCP spec on scope minimization.
- `oidc.mjs` today requires every configured scope (`REQUIRED_SCOPE='hosts:read'`). That has to change, or step-up cannot work.

## 4. Where each tool is served

| Class | Tools | Served by |
|---|---|---|
| hub-local | `bridge_info`, and `list_hosts` (inventory from WSS state) | The hub answers from its registry and agent inventory. No runtime. |
| VPS runtime | all coordinator tools, `tasks_*`, `github_*`, `audit_*`, `projects_*`, `project_*`, `observe_*` | `vps` (the coordination owner) |
| workspace host | `worktree_*`, `jobs_*`, `job_*` | The host recorded in the workspace. For Phase 5 v1 this is `vps` only (`workspace_open` refuses `mac` remotely). |
| arg host | `host_status`, `host_capabilities`, `host_resources` | `args.host`. Mac offline gives `host_offline` (phase-4 code). |

**Mac-only work (Swift/Xcode):** `host_capabilities` on the VPS will report no Swift recipe, so the VPS refuses those recipes. Enabling `host:'mac'` workspaces remotely needs one of two things, decided in Q5: id-tagged routing (§9), or Mac runtime trust in claims signed by the VPS coordinator. Phase 4 lists Swift on the VPS as a non-goal.

## 5. Sessions and parallel ChatGPT conversations

- **Shared token, shared principal (inferred).** All of the owner's conversations very likely use the same connector token, and so the same principal `oidc:<sub>`. Ownership checks (`ownsWorkspace`) do not separate them.
- **Separation is per workspace.** `workerFor(workspace)` = `mb.vps.<ws_id>` (`policy.mjs`). The ledger already refuses a second worker on the same Issue.
- **Optional guard.** `workspace_open` records `client_session`. Later calls whose `openai/session` differs get a non-blocking `warning:'session_mismatch'`.
  - This is never an authorization check. OpenAI says the field is a correlation hint, and it can be absent.
  - Whether it should become blocking is Q6.
- **No `MCP-Session-Id`.** GET and DELETE return 405. This matches the current hub behaviour and the SDK stateless path.

## 6. Rate limits, audit, response bounds

**Rate limiting (hub, in memory)**
- Starting values (inferred): read 60/min, write 20/min, execute 6/min per principal; 401s 30/min per address. In-flight cap of 8, as in phase-4 REQ-P4-02.
- A refused call returns a tool result `{ok:false,error:'rate_limited',retry_after_s}`, not an HTTP 429.
- Because the buckets are in memory, a hub restart resets them. That is acceptable for a single owner (inferred).

**Audit**
- **Hub:** one JSON line per call to journald with `{at, request_id, principal, client_ref (hash), op, outcome, code, ms, bytes}`. It also records transport refusals: 401, 403 scope, origin, rate limit, write gate. Never arguments, tokens or `sub` in clear text when it is not the owner.
- **Runtime:** the existing SQLite `events`, plus `via`, `client_type` and `request_id`. The shared `request_id` joins the two.
- Journald retention on the VPS is Q8.

**Response budget**
- Remote results default to 24 KiB of compact JSON (inferred value, configurable).
- Remote clamps: `worktree_read_file`/`worktree_diff` 16 KiB per page with `next_offset`; `job_results` 200 lines / 16 KiB; lists 50.
- Remote `worktree_write_file` accepts at most 96 KiB, against a 128 KiB body bound.
- Over budget gives `result_too_large` plus a hint, never a silent cut.
- Results go in `structuredContent` with a one-line `content` summary. Nothing goes in `_meta`, which is hidden from the model.

## 7. Write gate until #161 is closed

1. `remote.json.remote_writes` defaults to `"disabled"`. While disabled, write tools are absent from `tools/list`, so ChatGPT never sees or offers them.
2. Turning it to `"enabled"` needs all three of these:
   - an owner-only edit in lab-infra (root-owned file);
   - the hub start-up self-check, which reads `systemctl show -p User,ActiveState 'actions.runner.*'` (read-only D-Bus, inferred to work unprivileged) and refuses to start with writes enabled if any runner is `User=root` and active;
   - phase-4 AC-P4-14 passing.
3. The runtime caps hub principals with its own `agent_ceiling`. A forged envelope cannot add capabilities.
4. Today's live data would fail the check: emargo runs as root and is active.

## 8. Tests

The suite runs offline with `node --test`. Fixtures: `jose` local JWKS and fake-gh (`tests/helpers/fake-gh`).

- **`tests/oidc-resource.test.mjs`** (extend):
  - `typ` other than `at+jwt` → rejected.
  - Missing or unlisted `client_id` → rejected.
  - Baseline scope only → accepted, and the capabilities are read only.
  - An ID token (`aud` = client) → rejected.
  - `maxTokenAge` comes from config.
  - `verifyAccessToken` returns `AuthInfo` with `expiresAt`.
- **`tests/remote-surface.test.mjs`** (new):
  - `tools/list` for a read-only principal equals `TOOL_DEFS` filtered by policy, and contains no write tool.
  - Every remotely exposed tool has an `OPERATION_CAPABILITY` entry.
  - Name, schema and annotations are identical to stdio, compared against a stdio `listTools` snapshot.
  - With the gate closed, a token carrying `repo:write` still shows no write tools.
  - With the gate open in the test config, the tools appear.
- **`tests/hub-oidc-http.test.mjs`** (update): the assertion `tools.length===3` becomes a registry equality check. Add:
  - an `Origin` header present → 403;
  - an `MCP-Protocol-Version` header preserved;
  - GET/DELETE → 405 with no `mcp-session-id` header;
  - missing scope → 403 `insufficient_scope` with `scope=` and `resource_metadata`;
  - an over-size body → 413.
- **`tests/runtime-principal.test.mjs`** (shared with phase-4 TODO-06):
  - `as()` is memoized (same object for the same principal).
  - Principals are isolated: workspace A of `oidc:x` is invisible to `local:memo`.
  - `workspace_open` called with `client_type:'codex'` by a hub chatgpt principal stores `chatgpt`.
  - `host:'mac'` is refused remotely.
- **`tests/remote-bounds.test.mjs`**:
  - A 300 KiB file read in 16 KiB pages reaches the end through `next_offset`.
  - A synthetic 40 KiB result gives `result_too_large`.
  - Compact JSON is used.
- **`tests/remote-ratelimit.test.mjs`**:
  - Buckets per class.
  - `rate_limited` carries `retry_after_s`.
  - The 401 flood bucket is keyed on the trusted proxy header only.
- **`tests/remote-audit.test.mjs`**:
  - Hub line plus runtime event share `request_id`.
  - No argument or token substrings in either.
  - A gate refusal is journaled.
- **`tests/mcp-smoke.mjs`**: compare against `TOOL_DEFS` instead of `ALL_TOOLS`. Add one end-to-end over the hub using `@modelcontextprotocol/client` with a minted owner token.
- **Live checks (later, owner windows)**, none of these executed:
  - a Pocket ID authorize request with `resource=https://bridge.memolabs.dev/mcp` → decode `aud`, `scope`, `typ`, `client_id`, lifetime;
  - ChatGPT connect → 401 → consent → `tools/list` read-only;
  - measure the size of the remote `tools/list` (Q2).

## 9. Open questions

1. **Exposure path.**
   - A public route to `/mcp` and to Pocket ID breaks "VPS private" for the AS at least.
   - OpenAI's Secure MCP Tunnel keeps the MCP server private: outbound only, 10 MiB envelope, **120 s deadline**, 600 req/min (developers.openai.com/api/docs/guides/secure-mcp-tunnels). But the page says "the authorization server itself is not automatically tunneled", so the AS must still be publicly reachable.
   - Eligibility for a personal Plus or Pro account (not Enterprise) is not documented on that page.
   - **Owner decision.**
2. **Tool definition size.** There is a community-reported ~5000-token cap on ChatGPT tool definitions (forum, unverified). 49 tools with long descriptions may exceed it (inferred). Options: shorter remote descriptions, or a reduced remote set. Measure first.
3. **Pocket ID v2.18.0 tokens.**
   - Access token lifetime and refresh-token rotation are unknown. `maxTokenAge:'20m'` would force re-authorization loops if the lifetime is longer (inferred).
   - The `scope` claim format is not on the docs page.
   - Pocket ID also needs RFC 9207 `iss` to give the fixed ChatGPT redirect URI. Without it ChatGPT uses `https://chatgpt.com/connector/oauth/{callback_id}`.
   - Is CVE-2026-28513 fixed in v2.18.0? The release page does not say.
4. **Timeouts.** ChatGPT's direct-connection tool timeout is not documented. Phase-4 ledger ops can take at least 130 s, which is over the tunnel's 120 s. Should `task_claim` become asynchronous?
5. **Mac-hosted workspaces remotely.** Choose between:
   - (a) a host tag in the first id character (`ws_v…` / `ws_m…`; `WS_RE` is unchanged);
   - (b) a VPS-signed workspace/claim assertion that the Mac runtime trusts;
   - (c) deferring them to Phase 5b. This is my recommendation.
6. **Session guard.** Should `openai/session` mismatch stay a warning, or block writes once the gate opens?
7. **Remote write size.** Is a 96 KiB `worktree_write_file` cap acceptable, or is a chunked or patch-based write tool needed?
8. **Journald retention** for the hub audit (lab-infra), and whether hub refusals should also be copied into the runtime store so `audit_events` shows them.
9. **Is `coordinator:write` really gated by #161?** Claims write only ledger refs, not repositories. The owner could allow claims before #161 closes. My default is no.
10. **Allowlisted client id.** The exact ChatGPT CIMD `client_id` URL(s) for the allowlist are not in the docs I read. Capture them from the first live authorization request.

Sources:
- [ChatGPT authentication](https://developers.openai.com/apps-sdk/build/auth)
- [ChatGPT reference (`_meta`, annotations)](https://developers.openai.com/plugins/reference.md)
- [Connect and test in ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt.md)
- [Plugin troubleshooting](https://developers.openai.com/plugins/deploy/troubleshooting.md)
- [Security and privacy](https://developers.openai.com/plugins/guides/security-privacy.md)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode) (page returned 404 when fetched; facts above come from search summaries and are not authoritative)
- [Forum report of tool response truncation](https://community.openai.com/t/tool-response-truncation-on-mcp-connector-responses-that-previously-worked/1383071)
- [Forum thread on the tool schema token limit](https://community.openai.com/t/token-limit-when-connecting-chatgpt-with-external-mcp/1371022)
- [MCP transports 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP authorization 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Pocket ID APIs and permissions](https://pocket-id.org/docs/guides/apis)
- [Pocket ID releases](https://github.com/pocket-id/pocket-id/releases)
- [GHSA-qh6q-598w-w6m2](https://github.com/advisories/GHSA-qh6q-598w-w6m2)
- Installed SDK types: `/Users/memo/projects/memo-bridge/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts`

Files read:
- `/Users/memo/projects/memo-bridge/bridge/{hub,oidc,hub-cli,agent,agent-cli}.mjs`
- `/Users/memo/projects/memo-bridge/server/{index,runtime}.mjs`
- `/Users/memo/projects/memo-bridge/server/coordinator/{policy,index}.mjs`
- `/Users/memo/projects/memo-bridge/server/tools/*.mjs`
- `/Users/memo/projects/memo-bridge/tests/{hub-oidc-http,oidc-resource}.test.mjs`
- `/Users/memo/projects/memo-bridge/docs/{OIDC_RESOURCE,HUB_SECURITY}.md`
- `/Users/memo/projects/_worktrees/memo-bridge/phase-4/.agent/project/phase-4/spec.md`