# Memo Bridge — owner-only OAuth resource validation

Optional mode in bridge/oidc.mjs. Keep the current production private hub unchanged until owner authentication is provisioned and tested.

## Enforcement and protections

The resource server accepts only JWTs signed by trusted provider keys, with exact issuer, canonical MCP audience URL, immutable owner subject ID, hosts:read scope, expiration, and recent issue time. It rejects invalid/expired or unauthorized tokens and publishes OAuth protected-resource metadata per RFC 9728. The agent WebSocket endpoint retains independent Ed25519 enrollment.

The provider metadata and JWKS URI are explicitly configured and TLS-only. Never forward arbitrary upstream tokens or treat a provider ID token as an MCP access token.

## Current state

Pocket ID v2.18.0 is installed on the Memo Labs VPS under /opt/memo-bridge-auth, bound only to 127.0.0.1:1411. Discovery responds HTTP 200 and advertises PKCE S256. The configured issuer is https://auth.memolabs.dev, but there is no public route and no enrolled owner yet. The existing Memo Bridge remains private and on its previous loopback authentication mode.

Pocket ID is an upstream passkey identity provider. It is not assumed to issue audience-bound access tokens for https://bridge.memolabs.dev/mcp. Validate OAuth resource-indicator support or add a secure token brokerage/authorization server to mint dedicated MCP access tokens. Public access also requires owner passkey setup, issuer metadata, client registration (CIMD or DCR), authorization code + PKCE, RFC8707 resource indicators, revocation, rate limits, and end-to-end negative access tests.

Private secrets remain on the host and are never written to Git.

## Tests

The test suite covers signature and claim validation, token expiration, metadata discovery, HTTPS 401 responses, authorized MCP listing, and rejected impostors. No live public OAuth flow is claimed.
