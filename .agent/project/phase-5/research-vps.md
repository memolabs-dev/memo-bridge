## Memo Bridge public ingress: VPS inventory and Traefik recipe

**Conclusion.** Nothing for Memo Bridge is public today. Pocket ID v2.18.0 can cover owner-only ChatGPT access with no extra token broker, using a client ID metadata document (CIMD) and RFC 8707 resource indicators. Dynamic client registration (DCR) is not available.

Three things block the route:
1. Pocket ID has **0 users** and its `/setup` page answers 200. Whoever reaches `https://auth.memolabs.dev/setup` first becomes admin.
2. The hub running on the VPS has no `oidc.mjs`. It still runs in static owner bearer mode.
3. lab-infra #161 is still OPEN, so no write tool can be exposed.

I made no changes anywhere. VPS checks were read-only `ssh lab` commands, and only environment variable names were read.

### A. Inventory (observed facts)

**DNS** (dig from the Mac)
- The nameservers are Porkbun, so there is no Cloudflare in front.
- `*.memolabs.dev` is a wildcard A record to 159.195.213.26. `auth`, `mcp`, `memolabs.dev` and a random name all resolve there.
- There is no AAAA record.
- No DNS change is needed for `auth.` or `mcp.`, and the HTTP-01 challenge already works.
- From the Mac, `https://auth.memolabs.dev` and `https://mcp.memolabs.dev` fail TLS (curl verify error 20). On the VPS through Traefik both return 404. There is no route and no certificate: `acme.json` holds 34 certificates, none for auth, mcp or bridge.

**Firewall**
- UFW is active and allows only 22, 80 and 443. This matches `docs/architecture.md` on origin/main ("Ce qui est réellement public").

**Traefik**
- Container `traefik`, image `traefik:v3.6`, running version 3.6.25, `network_mode: host`.
- It mounts only `/etc/traefik` and the docker socket.
- `/etc/traefik/traefik.yml` is identical to the lab-infra template `ansible/roles/traefik/templates/traefik.yml.j2` (origin/main 74db062):
  - entryPoints `:80` and `:443`, with http3;
  - docker provider with `exposedByDefault: false` and `network: lab`;
  - file provider on `/etc/traefik/dynamic` with `watch: true`;
  - a single cert resolver, `letsencrypt` (HTTP-01, `/etc/traefik/acme.json`, email empty);
  - the dashboard is not exposed insecurely.
- `group_vars/lab.yml` sets `traefik_version: "v3.6"`, a floating tag.
- `/etc/traefik/dynamic` holds three files: `middlewares.yml`, `www.yml` and `opencode.yml`. All three are declared in lab-infra, the last through `roles/opencode`.
- **Middlewares in use:**
  - `redirect-to-https`
  - `gzip`
  - basicAuth: `jobs-auth`, `search-auth`, `factura-auth`
  - `www-to-apex`
- There is no rateLimit, ipAllowList, forwardAuth, security-headers middleware or custom TLS option anywhere. A `git grep` over lab-infra and the VPS files finds nothing.
- **Precedent for a loopback service:** `roles/opencode/templates/opencode.yml.j2` uses the file provider and points to `http://127.0.0.1:4096`, which works because Traefik runs on the host network.
- **Precedent for an identity provider:** `stacks/kollio-logto` puts OIDC behind Traefik labels and keeps its admin console on `127.0.0.1:3002`.
- A transient Traefik error was logged at 15:47Z on 13 Oct: `emargo-docker-probe@file`, service missing. That file is no longer present.

**Pocket ID**
- Container `memo-bridge-auth-pocket-id-1`, image `ghcr.io/pocket-id/pocket-id:v2.18.0`. That is the latest release, published 2026-10-04 (GitHub releases API).
- Published on `127.0.0.1:1411`, network `memo-bridge-auth_default` (10.0.7.0/24, gateway 10.0.7.1), with `no-new-privileges`.
- It is **not declared in lab-infra**. It lives only in `/opt/memo-bridge-auth/compose.yml` with a `.env` and `secrets/encryption_key`. That is drift from lab-infra.
- Environment variable names: PUID, PGID, APP_URL, ENCRYPTION_KEY_FILE, ALLOW_INSECURE_CALLBACK_URLS, DISABLE_RATE_LIMITING, TRUST_PROXY, APP_ENV.
- Non-secret values:

| Variable | Value |
|---|---|
| APP_URL | `https://auth.memolabs.dev` |
| ALLOW_INSECURE_CALLBACK_URLS | `false` |
| DISABLE_RATE_LIMITING | `false` |
| TRUST_PROXY | `false` |
| APP_ENV | `production` |

- **Problem:** the logs show every client as `ip=10.0.7.1`. With `TRUST_PROXY=false`, Pocket ID's built-in rate limit and audit log would put every internet client in one bucket. One attacker could rate-limit the owner out (inferred).
- The DB, read with sqlite in read-only mode, has 0 users, 0 admins, 0 passkeys and 0 OIDC clients. `/setup` returns 200.

**Pocket ID capabilities** (discovery on `127.0.0.1:1411` plus the v2.18.0 source)
- Issuer is `https://auth.memolabs.dev`.
- PKCE: `code_challenge_methods_supported` is `[plain, S256]`. PKCE is enforced for public clients (`EnforcePKCEForPublicClients: true`, `backend/internal/oidc/provider.go` at v2.18.0).
- `authorization_response_iss_parameter_supported` is true (RFC 9207). PAR is supported.
- `token_endpoint_auth_methods_supported` includes `none`.
- **No DCR:** there is no `registration_endpoint`. The test `well_known_controller_test.go` at v2.18.0 asserts it is absent.
- **No revocation endpoint:** the same test asserts that too.
- **CIMD is supported but off:** `client_id_metadata_document_supported: false` because the allowlist is empty.
  - `CIMD_URL_ALLOWLIST`: https://pocket-id.org/docs/configuration/environment-variables
  - Guide: https://pocket-id.org/docs/guides/client-id-metadata-documents
- **Custom audience and scopes via RFC 8707:** `backend/internal/oidc/api_resource.go` (v2.18.0), `resolveResource`, maps `resource` to `aud` (trailing slash trimmed) and grants that API's permission keys as scopes.
  - Standard scopes are fixed: openid, profile, email, groups, offline_access.
  - An API can be opened to CIMD clients with selected permissions (`SetCIMDAccess`, `backend/internal/api/service.go`).
- **Access tokens** follow RFC 9068 (JWT, RS256), and `JWTScopeFieldBoth` emits both `scope` and `scp` (`provider.go`).
  - Refresh lifespan is 30 days.
  - Access-token lifespan is not set there, so it is probably fosite's 1h default (inferred).
- Passkeys are bound to the APP_URL domain and need HTTPS:
  - https://pocket-id.org/docs/configuration/environment-variables
  - https://pocket-id.org/docs/setup/installation ("The setup page only works until the first account exists").

**Memo Bridge hub on the VPS**
- `memo-bridge-hub.service` has been running since 13 Oct 17:51, as user `memo-bridge`, with ProtectSystem=strict and NoNewPrivileges.
- It listens on `127.0.0.1:9443`.
- Its TLS certificate is self-signed: CN `localhost`, SAN `DNS:localhost, IP:127.0.0.1`, expiring 2027-02-10.
- Secret file names in `/var/lib/memo-bridge/secrets`: `mac.pub`, `owner.token`, `tls.crt`, `tls.key`, `vps.pub`.
- **The deployed `bridge/` has no `oidc.mjs`.**
  - `/mcp` without a token returns 401 with `Bearer realm="memo-bridge"`.
  - `/.well-known/oauth-protected-resource` returns an empty body.
  - So the static owner bearer is still in force, as `docs/HUB_SECURITY.md` says.
- In the local repo (`bridge/hub.mjs`, `bridge/oidc.mjs` on main a499754):
  - paths: `/health` (GET), `/mcp` (POST only, 64 KiB), `/.well-known/oauth-protected-resource` (root only, OIDC mode), and the WebSocket upgrade `/agent`;
  - the OIDC guard checks the audience exactly (must end `/mcp`), the owner `sub`, the `hosts:read` scope and `maxTokenAge: 20m`;
  - there is no Origin header check on `/mcp`.
- `docs/OIDC_RESOURCE.md` names the audience `https://bridge.memolabs.dev/mcp`, while the task suggests `mcp.memolabs.dev`. The hostname is not decided yet.
- Branch `feat/phase-4-vps-runner` (1410e47) only adds `.agent/project/phase-4/spec.md`. Nothing on ingress.

**Blocking issue**
- lab-infra #161, "security: isolate remaining privileged GitHub Actions runners on VPS", is **OPEN**.

**ChatGPT requirements** (https://developers.openai.com/apps-sdk/build/auth)
- Protected resource metadata (PRM) at `/.well-known/oauth-protected-resource`, or advertised in `WWW-Authenticate` `resource_metadata`.
- Authorization server metadata via RFC 8414 or OIDC discovery, with S256 required.
- Client registration: CIMD is preferred. When RFC 9207 is supported, the client ID is `https://chatgpt.com/oauth/client.json` and the redirect is `https://chatgpt.com/connector_platform_oauth_redirect`. Copy the exact values from the connector management page.
- ChatGPT sends `resource` exactly as published, on both the authorize and token requests, and expects it in `aud`.
- Every advertised scope must be enabled for the client.
- ChatGPT presents a client certificate (mTLS) chained to the OpenAI Connectors intermediate CA, with SAN `mtls.prod.connectors.openai.com`:
  - https://developers.openai.com/plugins/mtls/openai-connectors-mtls-ca.pem
  - https://developers.openai.com/plugins/mtls/openai-root-ca.pem
- Egress IP ranges: https://developers.openai.com/api/docs/guides/ip-addresses

### B. Ingress recipe, consistent with lab-infra

**Conventions to keep:**
- A container goes in `stacks/<name>/compose.yml` with Traefik labels on network `lab` (like kollio-logto).
- A host process gets a file-provider route templated by an Ansible role into `/etc/traefik/dynamic/` (like opencode). With `watch: true`, no Traefik restart is needed.
- Secrets come from the macOS keychain through the Makefile, never from the repo.
- A router that references a missing middleware is refused, so routes fail closed.

**Step 0. Preconditions (outside Traefik)**
1. Choose the hostname and canonical resource:
   - `mcp.memolabs.dev` gives `https://mcp.memolabs.dev/mcp`;
   - `bridge.memolabs.dev` gives `https://bridge.memolabs.dev/mcp` (the name in `OIDC_RESOURCE.md`).
   - The same value must be used in the PRM, in Pocket ID's API audience and in the hub's `audience`.
2. Redeploy the hub in OIDC mode before any route exists:
   - issuer `https://auth.memolabs.dev`, `jwksUri` `https://auth.memolabs.dev/.well-known/jwks.json`, owner `sub` set to the owner's Pocket ID UUID;
   - remove the static bearer;
   - expose only read-only tools until #161 closes. Phase-4 tools such as `task_claim`, `worktree_*`, `jobs_*` and `github_create_pr` must not be registered on the remote hub.
3. Move Pocket ID into lab-infra as `stacks/memo-bridge-auth/compose.yml`:
   - same pinned image (preferably by digest);
   - on network `lab`;
   - Traefik labels for `auth.memolabs.dev`;
   - keep `127.0.0.1:1411` only for admin, or drop it;
   - set `TRUST_PROXY` to the gateway of `lab` as seen by the container (observed with the current network: 10.0.7.1, so verify after the move);
   - add `ALLOW_USER_SIGNUPS=disabled` and `UI_CONFIG_DISABLED=true` with `CIMD_URL_ALLOWLIST=["https://chatgpt.com/oauth/client.json"]`, so the configuration is declarative.

**Step 1. Owner enrollment window on auth.memolabs.dev only**
- Temporary `ipAllowList` with `sourceRange` set to the owner's current IP. Traefik is on the host network, so it sees the real client IP (inferred).
- The owner opens `https://auth.memolabs.dev/setup` and creates the admin and passkey. Passkeys require the real domain over HTTPS, which is why an SSH tunnel to localhost does not work here.
- In the admin UI:
  - create the API with audience equal to the chosen MCP resource (e.g. `https://mcp.memolabs.dev/mcp`);
  - add the permission `hosts:read`;
  - open it to CIMD clients with `hosts:read` only.
- Record the owner's `sub` for the hub.
- Then replace the allowlist with rate limiting. The authorize page must be reachable from the owner's browser anywhere, and the token endpoint from ChatGPT servers.

**Step 2. MCP route** (new role, e.g. `roles/memo-bridge-ingress`, template `/etc/traefik/dynamic/memo-bridge.yml`)
- Copy the hub's public certificate (not the key) to `/etc/traefik/certs/memo-bridge-hub.crt`, since Traefik only mounts `/etc/traefik`.
- Also copy the two OpenAI CA PEMs there.

```yaml
http:
  routers:
    memo-bridge-mcp:
      rule: Host(`mcp.memolabs.dev`) && (Path(`/mcp`) || Path(`/.well-known/oauth-protected-resource`) || Path(`/.well-known/oauth-protected-resource/mcp`))
      entryPoints: [https]
      service: memo-bridge-hub
      middlewares: [mcp-ratelimit]
      tls:
        certResolver: letsencrypt
        options: chatgpt-mtls
    memo-bridge-mcp-http:
      rule: Host(`mcp.memolabs.dev`)
      entryPoints: [http]
      service: noop@internal
      middlewares: [redirect-to-https]
  services:
    memo-bridge-hub:
      loadBalancer:
        serversTransport: memo-bridge-hub-tls
        servers:
          - url: "https://127.0.0.1:9443"
  serversTransports:
    memo-bridge-hub-tls:
      serverName: localhost
      rootCAs: ["/etc/traefik/certs/memo-bridge-hub.crt"]   # pin the self-signed cert; never insecureSkipVerify
  middlewares:
    mcp-ratelimit:
      rateLimit: { average: 30, period: 1m, burst: 20 }
tls:
  options:
    chatgpt-mtls:
      minVersion: VersionTLS12
      clientAuth:
        caFiles: ["/etc/traefik/certs/openai-connectors-mtls-ca.pem", "/etc/traefik/certs/openai-root-ca.pem"]
        clientAuthType: RequireAndVerifyClientCert
```

- `/agent` and `/health` are deliberately not routed. Agents keep the SSH tunnel and loopback.
- Optional: add `passTLSClientCert` with `info.sans: true` and have the hub check for `mtls.prod.connectors.openai.com`. Traefik TLS options cannot filter on SAN.
- Doc references (pages are v3.7; VPS runs 3.6.25; I assume these fields exist in 3.6, inferred):
  - https://doc.traefik.io/traefik/reference/routing-configuration/http/load-balancing/serverstransport/
  - https://doc.traefik.io/traefik/reference/routing-configuration/http/tls/tls-options/
  - https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/ratelimit/
  - https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/passtlsclientcert/
- Add a rateLimit middleware on the auth router as well.

**Step 3. Negative tests before connecting ChatGPT**
- No client certificate: TLS fails.
- Valid certificate but no token: 401 with `resource_metadata`.
- Token for another `aud`, another `sub`, missing `hosts:read`, or older than 20 min: 401.
- `/agent` and `/health` on the public host: 404.
- `/setup` once the admin exists: closed.
- Another user from another IP cannot sign up.
- Unknown hostnames keep returning 404 with the default certificate.

### C. Risks
- **P0, setup takeover:** `/setup` is open and there are 0 users. A public route without an IP allowlist before enrollment hands over the admin account.
- **P0, write tools:** remote write tools while #161 is open contradict the owner decision. Enforce this in the hub's tool registration, not in Traefik.
- **P1, single rate-limit bucket:** `TRUST_PROXY=false` puts every client in one bucket, so an attacker can lock the owner out. There is also no proxy-level rate limit anywhere in lab-infra today.
- **P1, hub not in OIDC mode:** the hub still uses the static bearer, and a public route must not exist before the redeploy.
- **P1, token age mismatch:** the hub rejects tokens after 20 min while Pocket ID's are probably valid 1h (inferred). ChatGPT has to refresh on 401. Test this, or align the two.
- **P1, no revocation endpoint:** Pocket ID has none. Revoking means deleting refresh tokens or sessions; the 20-minute token age bounds exposure.
- **P2, mTLS limits:** `RequireAndVerifyClientCert` blocks direct owner tests (MCP Inspector from the Mac); use the loopback path for those. It also needs a refresh plan if OpenAI changes its intermediate CA.
- **P2, wildcard DNS:** any `*.memolabs.dev` reaches Traefik. That is harmless as long as routers are exact, but it does not hide the VPS IP.
- **P2, configuration drift:** Pocket ID's compose and the hub's systemd unit are outside lab-infra.
- **P2, hub certificate expiry:** the hub cert expires 2027-02-10. The pinned copy in `/etc/traefik/certs` must be rotated with it.
- **P2, floating Traefik tag:** `traefik:v3.6` floats. Pin it by digest, and inspect by digest rather than pulling.
- **P3, no Origin validation:** the hub does not validate Origin on `/mcp`. Low impact given JWT plus mTLS (inferred).

Files read: `~/projects/lab-infra` origin/main (`ansible/roles/traefik/*`, `ansible/roles/opencode/*`, `ansible/group_vars/lab.yml`, `docs/architecture.md`, `stacks/kollio-logto/compose.yml`); `~/projects/memo-bridge/bridge/hub.mjs`, `bridge/oidc.mjs`, `docs/OIDC_RESOURCE.md`, `docs/HUB_SECURITY.md`; VPS `/etc/traefik/traefik.yml`, `/etc/traefik/dynamic/*`, `/opt/memo-bridge-auth/compose.yml`, `/etc/systemd/system/memo-bridge-hub.service`.