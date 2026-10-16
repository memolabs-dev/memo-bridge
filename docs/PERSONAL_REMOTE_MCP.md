# Independent personal remote MCP — staged OAuth resource server (W3 / #74)

**Stage:** development-only single-owner read-only resource server. No hosted service, ChatGPT account onboarding, HTTPS ingress, native Windows end-to-end test, or GPU execution is delivered by this PR. A local stdio MCP client already works through [STANDALONE_WINDOWS.md](STANDALONE_WINDOWS.md).

## Trust boundaries

- **One owner = one independent process, config, issuer/resource and project allowlist.** No shared gateway or multi-tenant database.
- Remote calls see only the five read-only standalone tools: `bridge_info`, `host_capabilities`, `gpu_inventory`, `projects_list`, `project_inspect`. No shells, writes, jobs, GitHub Apps, owner SSH secrets, worktree APIs, GPU compute or arbitrary file paths.
- No one else may authenticate as the owner. The resource server validates signed, expiring **OAuth access JWTs** (`typ: at+jwt`), expected issuer, exact audience `https://<personal-host>/mcp`, one owner `sub`, a list of explicit client IDs, `inventory:read` scope, issue time and expiration.
- Wrong/substituted owner, resource, issuer, client ID, scope, signing algorithm, invalid signature, expired or very old token all fail closed. Refresh/revoke a client at the authorization server, and remove its ID from the local allowlist; restart the resource process to apply changes.
- The endpoint is bound **only to loopback** (`127.0.0.1` default; `::1` allowed). No port exposed to the LAN or Internet. No owner `bridge.memolabs.dev`, `auth.memolabs.dev`, token, agent key or permission is accepted.
- A different HTTPS edge/tunnel and a separately owned OAuth 2.1 authorization server (client registration, PKCE, Resource Indicators) are **mandatory** before trying to connect a remote ChatGPT client. These are not provisioned automatically.

## Explicitly configured personal OAuth resource

There is no implied default from `MEMOLABS_ROOT` or `MEMO_BRIDGE_REMOTE_CONFIG`. Two **absolute paths** are required: the standalone allowlist config created by the local installer, plus a distinct private `remote-personal.json` file. This example uses dummy, personal hostnames:

```json
{
  "version": 1,
  "enabled": true,
  "issuer": "https://id.user-owned.example",
  "resource": "https://mcp.user-owned.example/mcp",
  "owner_sub": "EXACT_SUB_FROM_THE_USER_IDENTITY_PROVIDER",
  "allowed_client_ids": ["EXPLICIT_PERSONAL_OAUTH_CLIENT_ID"],
  "port": 4481
}
```

The JWT signing keys are obtained from the issuer's **same-origin HTTPS JWKS** (`/.well-known/jwks.json` by default). An explicit `jwks_uri` must be on the same origin. HTTPS URL validation and fixed paths reject credentials, queries, fragments, loopback public resources and the Memo Labs owner domains. If these JWT/access-token parameters do not match a chosen provider, the integration does **not** silently accept another token format.

From a trusted local repository checkout on Windows (PowerShell), after installing the W1 dependencies:

```powershell
pnpm run build:personal-remote
node dist/standalone/personal-cli.mjs --config "$env:APPDATA\MemoBridge\config.json" --remote-config "$env:APPDATA\MemoBridge\remote-personal.json"
```

The personal remote config file is **never generated with credentials, uploaded or activated by default**. It must be written by the user and remain in their own Windows profile. It is not the Memo Labs `remote.json`.

A successful process starts a **loopback HTTP** listener, but the local listener is *not* a public HTTPS service. For production ChatGPT connectivity, the owner still needs an authenticated, TLS-protected forwarding edge with a personally owned domain and OAuth client setup; **do not redirect the ChatGPT connection to localhost**, reuse the Memo Labs tunnel or publish the local HTTP port directly. The chosen reverse proxy must forward `/mcp` and both `/.well-known/oauth-protected-resource` paths and rewrite/validate Host correctly.

## Server behavior

- `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/mcp`: public RFC 9728 metadata (resource and authorization server URLs, one scope).
- `POST /mcp` without a bearer token: 401 with a resource-metadata discovery challenge.
- `POST /mcp` with a valid JWT: a **stateless, read-only** MCP response.
- Everything else: 404 or 405. No WebSocket and no agent enrollment. Request bodies are limited to 64 KiB, responses no-store, JSON only. Requests with an untrusted browser Origin or Host are rejected.

An OAuth issuer must publish standards-compliant authorization-server/OIDC discovery and support a compatible authorization-code + PKCE flow for the actual ChatGPT client. This implementation **only verifies access tokens**; it never issues them.

## Threats and stages still open

- **Remote onboarding is not complete:** no automatic domain, TLS edge, outbound tunnel, OAuth client registration, device enrollment, refresh-token handling, real Windows proof or independent-user dry run. These require their own security review before deployment.
- **Token revocation is not instantaneous here:** JWTs may remain valid until expiration; short access-token lifetimes and authorization-server revocation/session termination are essential.
- **Read-only does not mean private information is safe to publish.** GPU/host details and project names become visible to any explicitly authorized client. Keep the project allowlist minimal.
- **No shared identity service with the owner.** This is intentionally a per-user resource server rather than a multitenant public plugin.
- **No GPU execution.** The backend selection and sandboxed workloads remain #73, after Windows and GPU hardware verification.

Reference: MCP authorization and RFC 9728 Resource Metadata, https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization and https://www.rfc-editor.org/rfc/rfc9728.html .
