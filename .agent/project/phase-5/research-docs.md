# ChatGPT Chat to Memo Bridge: requirements as of 2026-10-14, and gaps against bridge/oidc.mjs

Every check was read-only. I read OpenAI's docs on developers.openai.com and help.openai.com, and the MCP spec 2026-07-28 on modelcontextprotocol.io. Help-center pages carry "Updated" dates of 2 to 12 days before 2026-10-14. On the VPS I ran one read-only command: `ssh lab curl 127.0.0.1:1411/.well-known/openid-configuration`, which is Pocket ID's discovery document. Statements marked (inferred) are my reasoning, not something a doc says.

## Source key

- [A] https://developers.openai.com/plugins/build/auth
- [B] https://developers.openai.com/api/docs/guides/custom-mcp-server
- [C] https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- [D] https://developers.openai.com/api/docs/guides/ip-addresses
- [E] https://developers.openai.com/plugins/build/mcp-server
- [F] https://developers.openai.com/plugins/reference
- [G] https://developers.openai.com/plugins/deploy/connect-chatgpt
- [Q] https://developers.openai.com/plugins/quickstart
- [HC1] https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- [HC2] https://help.openai.com/en/articles/20001256-plugins-in-chatgpt
- [HC3] https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt
- [HC4] https://help.openai.com/en/articles/20001062-elevated-risk-labels
- [MCP] https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- [MCP-D] https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery

## Requirements

| # | Topic | What the docs say | Source |
|---|---|---|---|
| 1 | Which plans can use write tools | "Full MCP support, including modify/write actions" is a beta for **Business, Enterprise and Edu**. FAQ: "Full MCP is only available to Business and Enterprise/Edu users, currently. **Pro users can connect MCPs with read/fetch permissions in developer mode.**" Plus, Go and Free are not mentioned for custom MCP. On Business, only admins and owners can use developer mode, each toggling it for themselves. | [HC1] |
| 1b | The developer docs disagree | [B] says "ChatGPT supports both read and write tools" and only adds that workspace permissions apply. It names no plan. [Q] creates a *personal* plugin. [HC2]: "Installing or using an individual plugin depends on your plan." The help center (updated 5 days ago) is more restrictive and more recent; the actual account UI decides. | [B] [Q] [HC2] |
| 2 | Regular Chat versus Work and agent | Plugins work "in ChatGPT Chat, Work and Codex" [HC2]. You select one with `@` in the composer [B]. "Agent mode will not use custom apps"; deep research can call them for read/fetch only, never write [HC1]. MCP apps are "web only", not on mobile [HC1]. ([Q] tests in the Work tab, but [HC2] confirms Chat works.) | [HC1] [HC2] [B] [Q] |
| 3 | How to add the server | chatgpt.com/plugins, then "+", then **Add custom MCP server**. Give a URL **or Tunnel**, choose auth, accept the risk warning, then "Create as a plugin" and install it. Tools can be toggled per tool. **Refresh** re-pulls tools, descriptions and instructions. On Enterprise, published apps use a frozen tool snapshot. | [B] [G] [HC1] |
| 4 | Write tools and confirmation | "Write actions by default require confirmation." "We respect the `readOnlyHint` ... **Tools without this hint are treated as write actions.**" An approve or deny choice can be remembered for one tool *for the rest of the conversation*. **New conversations prompt again**, and so does refreshing the page. Personal permission levels are "Always ask", "Allow read actions", "Allow low-risk actions" and "Allow all actions" (elevated risk). "Some requests may be denied instead of showing an approval prompt." | [B] [HC3] [HC1] [HC4] |
| 5 | Tool annotations | `readOnlyHint`, `destructiveHint` and `openWorldHint` are marked **Required** booleans; `idempotentHint` is optional. `destructiveHint` makes the host "elicit explicit approval first". The hints "only influence how ChatGPT ... frames the tool call"; the server must still enforce authorization. | [F] [E] |
| 6 | Several conversations in parallel | Nothing in the docs limits parallel use. App selection is per message, approvals are remembered per conversation, and one plugin can hold several connected accounts, with each call routed with the selected account's credentials. I found no documented per-user concurrency cap for direct connections. (inferred: every conversation shares the same OAuth connection) | [B] [HC1] [A] |
| 7 | Transport | "Supported MCP protocols: SSE and streaming HTTP." The endpoint is typically `/mcp`. "Custom MCP servers do not require search/fetch tools." The `instructions` field is used, and its first 512 characters should stand alone. | [B] [G] |
| 8 | Network | The server must be reachable over **public HTTPS or Secure MCP Tunnel**. "ChatGPT connects to remote MCP servers"; a local or private server needs the tunnel. | [G] [HC1] |
| 8b | Secure MCP Tunnel | `tunnel-client` makes only outbound connections, to `api.openai.com:443` on `/v1/tunnel/*`; no inbound port is needed. It needs a `tunnel_id` and a runtime **API key** from Platform tunnel settings, with Tunnels Read+Use permission. The tunnel must be associated with the ChatGPT workspace ("For personal accounts, use the personal Platform organization"). Limits: **600 requests/min per tunnel and app, 10 MiB per serialized message, 120 s absolute deadline, queue of 1,000.** The tunnel does not carry the authorization server: "If it is unreachable from the public internet and from the tunnel-client host, the OAuth flow can still fail." It cannot be used for public plugin submission. | [C] |
| 8c | IP allowlist and mTLS | Egress IP ranges are published at https://openai.com/chatgpt-connectors.json and change over time, so fetch them regularly. An allowlist identifies OpenAI, not a user. ChatGPT presents an OpenAI client certificate: it chains to the "OpenAI Connectors mTLS intermediate CA" (https://developers.openai.com/plugins/mtls/openai-connectors-mtls-ca.pem) and has SAN `mtls.prod.connectors.openai.com`. Do not pin the leaf certificate. | [D] [A] |
| 9 | Auth modes | **OAuth**, **No authentication**, or **OAuth or no authentication** (mixed: initialize and tools/list run without auth, then each tool follows its `securitySchemes`). ChatGPT "cannot present custom API keys or customer-provided mTLS certificates". It does not support client credentials, service accounts or JWT bearer grants. **There is no static bearer mode.** "Static credentials" means a predefined OAuth client id and secret. | [B] [A] |
| 10 | OAuth flow | OAuth 2.1 authorization code + **PKCE S256**. A server whose metadata omits `S256` "is unsupported". Clients follow the MCP authorization spec. | [A] [MCP] |
| 11 | Protected resource metadata (RFC 9728) | `/.well-known/oauth-protected-resource`, or the URL given in the 401 `WWW-Authenticate: Bearer resource_metadata="...", scope="..."`. Required fields: `resource` (canonical HTTPS URL; ChatGPT sends this exact value as `resource`) and `authorization_servers`. Clients also probe the path form `/.well-known/oauth-protected-resource/mcp`. | [A] [MCP-D] |
| 12 | Authorization server metadata (RFC 8414 or OIDC discovery) | Required: `issuer` (must exactly equal the `authorization_servers` entry), `authorization_endpoint`, `token_endpoint`, and `code_challenge_methods_supported` including S256. Recommended: `authorization_response_iss_parameter_supported`, `client_id_metadata_document_supported`, `token_endpoint_auth_methods_supported`, `registration_endpoint`. OIDC scopes listed in `scopes_supported` are **requested by default**. | [A] |
| 13 | Client registration | Order of preference: **CIMD** (`client_id` = `https://chatgpt.com/oauth/client.json`, or `.../oauth/{callback_id}/client.json`; token auth `none` or `private_key_jwt`), then **DCR** (once per connection, client reused), then a **predefined client** (`none`, `client_secret_post` or `client_secret_basic`). | [A] [B] |
| 14 | Redirect URI | When the server returns `iss` per RFC 9207: `https://chatgpt.com/connector_platform_oauth_redirect`. Otherwise: `https://chatgpt.com/connector/oauth/{callback_id}`. Copy the exact URI shown on the management page. | [A] |
| 15 | RFC 8707 resource indicators and audience | ChatGPT adds `resource=<canonical URL>` to **both** the authorize and token requests. The authorization server should copy it into `aud`. The MCP server MUST check that the audience is itself and MUST NOT accept or pass along other tokens. The canonical URL should have no trailing slash. | [A] [MCP] |
| 16 | Token checks on the server | Check signature (JWKS), `iss`, `aud` or `resource`, `exp`/`nbf`, and the scopes each tool needs. Invalid or expired token: **401** plus the challenge. Insufficient scope: SHOULD be **403** with `error="insufficient_scope"`, `scope`, `resource_metadata`. | [A] [MCP] |
| 17 | Refresh tokens | If `offline_access` is not advertised and issued, "ChatGPT may lose access after the original authorization expires". | [HC1] |
| 18 | Per-tool linking UI | Showing the OAuth linking UI for a single tool needs `securitySchemes` (`noauth` or `oauth2`+scopes) **and** a runtime result with `isError:true` and `_meta["mcp/www_authenticate"]`. Without the array, a tool inherits the server default. | [A] |
| 19 | Limits on tool count, response size and timeouts | **No documented limit** for direct connections; I searched [A] [B] [E] [F] [G] and the troubleshooting page. The only published numbers are the tunnel's (row 8b): 10 MiB and 120 s. | [C] |

## Pocket ID as it actually runs on the VPS

This is what `ssh lab` read from 127.0.0.1:1411:

- `issuer`: `https://auth.memolabs.dev`
- `authorization_response_iss_parameter_supported`: `true`, so ChatGPT would use the stable redirect URI.
- `code_challenge_methods_supported`: `["plain","S256"]`
- `client_id_metadata_document_supported`: `false`
- No `registration_endpoint`, so no DCR.
- `token_endpoint_auth_methods_supported`: `client_secret_basic`, `client_secret_post`, `none`
- `scopes_supported`: `openid profile email groups offline_access`. **`hosts:read` is absent.**
- No resource-indicator support is advertised.
- `/.well-known/oauth-authorization-server` returns 200.

## Gaps against bridge/oidc.mjs and hub.mjs

oidc.mjs is identical on `main` and `feat/phase-4-vps-runner`.

1. **P0, plan.** Write tools (`task_claim`, `worktree_*`, `jobs_*`, `github_create_pr`) in Chat require Business, Enterprise or Edu per [HC1]. Pro gets read/fetch only, and Plus is not documented. I couldn't find which plan the owner has. The owner needs to decide whether the "included in subscription" requirement is met.
2. **P0, audience.** Nothing shows Pocket ID honours `resource` (RFC 8707). (inferred: its `aud` will be the client_id.) Then `jwtVerify({audience:'…/mcp'})` rejects every ChatGPT token. This needs a token broker or authorization server that mints `aud=https://<host>/mcp`, which docs/OIDC_RESOURCE.md already flags as unvalidated.
3. **P0, scope.** `REQUIRED_SCOPE='hosts:read'` is not in Pocket ID's `scopes_supported`. (inferred: its tokens will not carry it.) Today every request is rejected. There is also only one global scope; per-tool scopes such as read versus write do not exist.
4. **P0, network.** The hub binds `127.0.0.1:9443`. ChatGPT needs public HTTPS or Secure MCP Tunnel. The tunnel fits "VPS stays private", but it needs an OpenAI Platform runtime API key, a workspace association, and an authorization server reachable from the browser and the token step. `auth.memolabs.dev` has no public route today.
5. **P1, client registration.** No CIMD and no DCR, so ChatGPT must use a predefined Pocket ID client ("static credentials" [B]). That client's redirect allowlist needs `https://chatgpt.com/connector_platform_oauth_redirect`, confirmed against the URI the management page shows.
6. **P1, token age.** `maxTokenAge:'20m'` rejects valid tokens older than 20 minutes regardless of `exp`. If the authorization server issues longer-lived tokens, expect repeated 401s and re-authorization (inferred). Align the issued token lifetime with this value, or rely on `exp`. Refresh needs `offline_access`, which Pocket ID advertises, so the client must be allowed it [HC1].
7. **P1, error codes.** A missing scope returns 401 (hub.mjs: any `accepts()` failure becomes 401). The spec says 403 with `insufficient_scope` [MCP]. The challenge is also static and carries no `error=` value.
8. **P1, write-tool annotations.** The current tools are read-only and correct (`readOnlyHint:true`, `destructiveHint:false`, `openWorldHint:false`, `idempotentHint:true`). Every future write tool needs explicit `readOnlyHint:false` and an accurate `destructiveHint`, which is `true` for worktree removal, job cancel and PR operations [F]. Confirmation is only a hint, so the server must enforce authorization itself [E].
9. **P2, `securitySchemes` and `_meta["mcp/www_authenticate"]`.** Neither is present. That is fine for server-level OAuth, where tools inherit the default, but it is needed for mixed auth or per-tool linking [A].
10. **P2, `typ` check.** `typ` is not checked (no RFC 9068 `at+jwt`). (inferred: an ID token with a matching `aud` would pass.) `nbf` is already enforced: jose 6.2.12, `jwt_claims_set.js:81`.
11. **P2, mTLS.** The hub runs with `requestCert:false`. If there is ever a public route, ChatGPT's mTLS certificate and/or the published IP ranges are the documented ways to restrict callers to OpenAI [A] [D]. Neither replaces OAuth.
12. **OK already.** Stateless Streamable HTTP with JSON responses is supported [B]. RFC 9728 metadata has `resource` equal to the audience and `authorization_servers` equal to the issuer, which matches exactly. Pocket ID returns `iss` and supports S256. Signature checks allow RS256/ES256/EdDSA. Requiring the owner's `sub` is stricter than OpenAI requires and compatible with it. Root-path metadata is allowed because the challenge advertises it [MCP-D].

**Binding constraint:** none of this changes the rule that no write tool is exposed remotely before lab-infra #161 is closed.

Files I read: /Users/memo/projects/memo-bridge/bridge/oidc.mjs, /Users/memo/projects/memo-bridge/bridge/hub.mjs, /Users/memo/projects/memo-bridge/docs/OIDC_RESOURCE.md, and /Users/memo/memolabs/workspace/worktrees/memo-bridge/phase-4 (no oidc.mjs diff). Downloaded docs are in /private/tmp/claude-501/-/fdde9467-cc48-4578-8ddc-2eb314628494/scratchpad/docs/ (full.txt, custom.md, tunnel.md, ip.md, auth-spec.md, asd.md).