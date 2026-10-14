# Memo Bridge: owner-only OAuth resource server

`bridge/oidc.mjs` (`createOidcVerifier`) is the OAuth resource-server side of the public
listener (`bridge/public-listener.mjs`, port 9445), the only place where Memo Bridge accepts an
OAuth token. How ChatGPT uses it, end to end: `docs/REMOTE_CHATGPT.md`.

## What a token must be

An RFC 9068 access token (`typ: at+jwt`), signed RS256, ES256 or EdDSA by a key of the
configured JWKS, with:

- `iss` exactly the issuer, `https://auth.memolabs.dev`;
- `aud` containing the canonical resource `https://bridge.memolabs.dev/mcp` (the same string in
  the protected resource metadata, the Pocket ID API, the hub configuration and ChatGPT);
- `sub` equal to the configured owner sub;
- `client_id` on the configured allowlist (the ChatGPT CIMD URL);
- `exp`, and `iat` no older than `max_token_age_sec` (with 30 s of clock tolerance);
- the scope `coordinator:read` (`scope`, or `scp` when `scope` is absent).

An ID token, a token for another resource, another user, another client, an expired or too old
token, or the static owner bearer is a 401 `invalid_token` with a fixed message; the reason goes
to the journal only. A missing baseline scope is a 403 `insufficient_scope`. An unreachable JWKS
is a 500, so ChatGPT does not loop on re-authorization.

Scopes are capability names. The capabilities of the principal `oidc:<sub>` are the scopes,
capped by the ceiling, minus every write capability while `remote_writes` is not `enabled`.

The JWKS URL is HTTPS on the issuer origin, or plain HTTP on a loopback address literal only
(`127.0.0.1`, `[::1]`): on the VPS the hub reads Pocket ID's keys from its loopback port. jose
caches the key set for 10 minutes and refetches on an unknown key at most every 30 seconds.

The protected resource metadata (RFC 9728) is served at `/.well-known/oauth-protected-resource`
and `/.well-known/oauth-protected-resource/mcp`: `resource`, `authorization_servers` (the
issuer), `scopes_supported` (`coordinator:read`, plus the write scopes once the gate is open),
`bearer_methods_supported: ["header"]`.

## Removed in Phase 5

The Phase 1 `oidcGuard` and the OIDC mode of the 9443 listener (`MEMO_BRIDGE_OIDC_SETTINGS`,
scope `hosts:read`, 20 minutes, no `typ` check, so an ID token with the right audience passed)
are gone. Setting `MEMO_BRIDGE_OIDC_SETTINGS` stops the hub at start.

## RFC 8707 and CIMD: status

Pocket ID v2.18.0 maps the RFC 8707 `resource` to `aud` through its APIs feature and supports
CIMD (read in its source and documentation, spec section 0). Neither has been exercised live
yet: whether the issued token carries `typ: at+jwt`, a `client_id` claim and the expected scopes
is unknown U-P5-02, answered in the read-stage window (TODO-P5-33), where the hub journal records
the decoded, non-secret claims. If Pocket ID does not set `typ` or `client_id` as expected,
every token is refused (fail closed) and the verifier or the identity setup has to change.

## Tests

`tests/oidc-verifier.test.mjs` (every claim check), `tests/oidc-resource.test.mjs` (configuration
refusals, JWKS location), `tests/public-listener.test.mjs` (HTTP shapes over loopback TLS),
`tests/remote-e2e.test.mjs` (an MCP client through the whole path with minted tokens). No live
OAuth flow is claimed.
