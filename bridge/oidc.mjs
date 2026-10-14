// OAuth resource-server side of Memo Bridge.
//
// createOidcVerifier (Phase 5, TODO-P5-02) is the SDK OAuthTokenVerifier for the public listener
//   (bridge/public-listener.mjs, spec D4). It accepts only RFC 9068 access tokens (typ at+jwt)
//   minted by the configured issuer for the canonical resource, for the owner, through an
//   allowlisted OAuth client, and returns an SDK AuthInfo carrying the principal oidc:<sub>
//   whose capabilities are the token scopes, capped by the server ceiling and the write gate
//   (spec D6, D7). Nothing in a tool argument can widen them.
// The Phase 1 oidcGuard (the 9443 OIDC mode, scope hosts:read, no typ check) was removed in
// Phase 5 with that mode: OAuth reaches the hub through the public listener only.
import { createHash } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { OAuthError, OAuthErrorCode, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/server';
import { CAPABILITIES, REMOTE_DEFAULT_CEILING, WRITE_CAPABILITIES as POLICY_WRITE_CAPABILITIES, makePrincipal }
  from '../server/coordinator/policy.mjs';

// Phase 5 constants (spec D3, REQ-P5-02).
export const CANONICAL_RESOURCE = 'https://bridge.memolabs.dev/mcp';
export const BASELINE_SCOPE = CAPABILITIES.READ;
export const ACCESS_TOKEN_TYP = 'at+jwt';
export const ALGORITHMS = Object.freeze(['RS256', 'ES256', 'EdDSA']);
export const DEFAULT_MAX_TOKEN_AGE_S = 3600;
export const MAX_TOKEN_AGE_BOUNDS_S = Object.freeze([60, 86400]);
export const DEFAULT_CLOCK_TOLERANCE_S = 30;
export const MAX_CLOCK_TOLERANCE_S = 120;
const MAX_TOKEN_CHARS = 8192;
const MAX_SCOPES = 32;
const MAX_CLIENT_IDS = 16;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SCOPE_TOKEN_RE = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;   // RFC 6749 scope-token
const SUB_RE = /^[A-Za-z0-9._@-]{1,120}$/;                     // fits policy.mjs PRINCIPAL_RE after "oidc:"

// OAuth scope names are the capability strings themselves (research-code §3).
export const SCOPE_TO_CAPABILITY = Object.freeze(Object.fromEntries(Object.values(CAPABILITIES).map(c => [c, c])));
// Capabilities that change state. Removed from every principal while the write gate is closed
// (spec D7, owner decision R-P4-01: no remote write before lab-infra #161 closes).
// The policy's list (Phase 6 adds operator:write, operator:exec and operator:root to it).
export const WRITE_CAPABILITIES = POLICY_WRITE_CAPABILITIES;
export const REMOTE_WRITES = Object.freeze(['disabled', 'enabled']);

export const writeGateOpen = config => config?.remoteWrites === 'enabled';

// Scopes advertised in the RFC 9728 metadata: the baseline only while the gate is closed, the
// write scopes too once it opens (the owner then reconnects to obtain them, spec D7). Phase 6:
// operator:read is advertised when the ceiling lists it (opt-in, REMOTE_DEFAULT_CEILING leaves
// it out); the operator write scopes follow the write gate like the others.
export function scopesSupported({ remoteWrites = 'disabled', ceiling = REMOTE_DEFAULT_CEILING } = {}) {
  const out = [BASELINE_SCOPE];
  if (ceiling.includes(CAPABILITIES.OPERATOR_READ)) out.push(CAPABILITIES.OPERATOR_READ);
  if (writeGateOpen({ remoteWrites })) for (const cap of WRITE_CAPABILITIES) if (ceiling.includes(cap)) out.push(cap);
  return out;
}

// Token scopes -> capabilities: known scopes only, capped by the ceiling, write capabilities
// dropped while the gate is closed. Sorted, so equal inputs give equal outputs.
export function capabilitiesFor(scopes, { remoteWrites = 'disabled', ceiling = REMOTE_DEFAULT_CEILING } = {}) {
  const gateOpen = writeGateOpen({ remoteWrites });
  const out = new Set();
  for (const scope of scopes) {
    const cap = Object.hasOwn(SCOPE_TO_CAPABILITY, scope) ? SCOPE_TO_CAPABILITY[scope] : null;
    if (!cap || !ceiling.includes(cap)) continue;
    if (!gateOpen && WRITE_CAPABILITIES.includes(cap)) continue;
    out.add(cap);
  }
  return [...out].sort();
}

// RFC 9068 carries scopes in `scope` (space separated); some providers also emit `scp`
// (Pocket ID emits both, research-vps). `scope` wins when present.
export function tokenScopes(payload) {
  let raw = [];
  if (typeof payload?.scope === 'string') raw = payload.scope.split(' ');
  else if (Array.isArray(payload?.scp)) raw = payload.scp;
  else if (typeof payload?.scp === 'string') raw = payload.scp.split(' ');
  const out = [];
  for (const s of raw) {
    if (typeof s !== 'string' || !SCOPE_TOKEN_RE.test(s) || out.includes(s)) continue;
    out.push(s);
    if (out.length >= MAX_SCOPES) break;
  }
  return out;
}

// client_type is derived from the authenticated client, never from tool arguments (spec D6).
// allowedClientIds is either a list (every listed client is a ChatGPT connector, the only remote
// client in Phase 5: client_type chatgpt) or a map {"<client_id>": "<client_type>"}, the same
// two forms as remote.json allowed_client_ids (bridge/remote-surface.mjs parseRemoteConfig).
// The type is only shape-checked here; policy.mjs checks it against CLIENT_TYPES.
const CLIENT_TYPE_RE = /^[a-z][a-z-]{1,19}$/;
export function clientTypesOf(allowedClientIds) {
  const entries = Array.isArray(allowedClientIds) ? allowedClientIds.map(id => [id, 'chatgpt'])
    : allowedClientIds !== null && typeof allowedClientIds === 'object' ? Object.entries(allowedClientIds) : null;
  if (!entries || entries.length === 0 || entries.length > MAX_CLIENT_IDS ||
    entries.some(([id, type]) => typeof id !== 'string' || id.length === 0 || id.length > 512 || /\s/.test(id) ||
      typeof type !== 'string' || !CLIENT_TYPE_RE.test(type)) ||
    new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error('allowedClientIds must list 1 to 16 distinct client ids');
  return new Map(entries);
}

export const clientRef = clientId => createHash('sha256').update(String(clientId)).digest('hex').slice(0, 12);

function httpsUrl(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Missing OIDC value: ' + label);
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid URL: ' + label); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('HTTPS URL without credentials, query or fragment required: ' + label);
  return url;
}

// The JWKS location: HTTPS (then on the issuer origin, checked by the caller), or HTTP on a
// loopback address literal only. On the VPS the hub reads Pocket ID's keys from its loopback
// port (127.0.0.1:1411): no DNS, no public route and no Traefik in the path, and nothing off
// the host can answer there. Any other plain-HTTP URL is refused.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);
function jwksUrl(value) {
  if (typeof value === 'string' && value.startsWith('http://')) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid URL: jwksUri'); }
    if (!LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash) {
      throw new Error('JWKS URI must be HTTPS on issuer origin, or HTTP on a loopback address');
    }
    return url;
  }
  return httpsUrl(value, 'jwksUri');
}

function boundedInt(value, fallback, [min, max], label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer in [${min}, ${max}]`);
  return value;
}

// Fixed descriptions: the reason goes to the audit line (err.reason), not to the caller.
function rejected(reason) {
  const err = new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is invalid or expired');
  err.reason = reason;
  return err;
}
function unavailable(reason) {
  const err = new OAuthError(OAuthErrorCode.ServerError, 'Token verification is unavailable');
  err.reason = reason;
  return err;
}
const CLAIM_REASONS = { iss: 'issuer', aud: 'audience', typ: 'typ', sub: 'subject', nbf: 'not_yet_valid', iat: 'issued_at', exp: 'expired', client_id: 'client_id' };
function mapJoseError(error) {
  switch (error?.code) {
    case 'ERR_JWT_EXPIRED': return rejected(error.claim === 'iat' ? 'too_old' : 'expired');
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
      const base = CLAIM_REASONS[error.claim] ?? 'claims';
      return rejected(error.reason === 'missing' ? 'missing_' + (CLAIM_REASONS[error.claim] ? error.claim : 'claim') : base);
    }
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED': return rejected('signature');
    case 'ERR_JOSE_ALG_NOT_ALLOWED': return rejected('algorithm');
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS': return rejected('unknown_key');
    case 'ERR_JWS_INVALID':
    case 'ERR_JWT_INVALID':
    case 'ERR_JOSE_NOT_SUPPORTED':
    case 'ERR_JWK_INVALID': return rejected('malformed');
    // JWKS fetch failures (timeout, non-200, bad JSON, network): the issuer is unreachable, not
    // the token wrong. A 401 here would push ChatGPT into a re-authorization loop.
    default: return unavailable('jwks_unavailable');
  }
}

// Phase 5 verifier (SDK OAuthTokenVerifier). Configuration, camelCase:
//   issuer            exact `iss`, HTTPS                               (required)
//   resource          canonical resource = expected `aud`             (default CANONICAL_RESOURCE)
//   ownerSub          the only accepted `sub`                          (required)
//   allowedClientIds  accepted `client_id` values, list or {id: type}  (required, 1..16)
//   maxTokenAgeSec    max REMAINING validity (`exp` - now), >= the issuer token lifetime
//                     (default 3600, 60..86400). Not the age since `iat`: a refreshed token
//                     may keep the `iat` of the first login (Pocket ID, 2026-10-14: ChatGPT's
//                     refreshed token was refused as too_old one hour after login, forcing a
//                     re-authorization every hour). A token valid further ahead is refused.
//   clockToleranceSec skew for exp/nbf/iat                             (default 30, 0..120)
//   jwksUri           HTTPS on the issuer origin, or plain HTTP on a loopback address (the
//                     identity provider's own port on the same host, lab-infra remote.json)
//                                                                      (default <issuer>/.well-known/jwks.json)
//   jwks              a jose key-set function instead of jwksUri       (tests)
//   fetchImpl         fetch used for the JWKS                          (tests; never from settings)
//   remoteWrites      'disabled' (default) | 'enabled'                 (spec D7)
//   ceiling           capabilities a remote principal may ever hold    (default all but operator:*)
export function createOidcVerifier(config) {
  if (!config || typeof config !== 'object') throw new Error('OIDC configuration required');
  const { issuer, resource = CANONICAL_RESOURCE, ownerSub, allowedClientIds, jwksUri, jwks, fetchImpl,
    remoteWrites = 'disabled', ceiling = REMOTE_DEFAULT_CEILING } = config;
  const issuerUrl = httpsUrl(issuer, 'issuer');
  const resourceUrl = httpsUrl(resource, 'resource');
  // The canonical form exactly: same string in PRM, audience, Pocket ID API and ChatGPT URL (D3).
  if (resourceUrl.href !== resource || resourceUrl.pathname !== '/mcp') throw new Error('Resource must be the canonical https://<host>/mcp URL');
  if (typeof ownerSub !== 'string' || !SUB_RE.test(ownerSub)) throw new Error('Invalid owner subject');
  const allowed = clientTypesOf(allowedClientIds);
  const maxTokenAge = boundedInt(config.maxTokenAgeSec, DEFAULT_MAX_TOKEN_AGE_S, MAX_TOKEN_AGE_BOUNDS_S, 'maxTokenAgeSec');
  const clockTolerance = boundedInt(config.clockToleranceSec, DEFAULT_CLOCK_TOLERANCE_S, [0, MAX_CLOCK_TOLERANCE_S], 'clockToleranceSec');
  if (!REMOTE_WRITES.includes(remoteWrites)) throw new Error('remoteWrites must be "disabled" or "enabled"');
  const known = Object.values(CAPABILITIES);
  if (!Array.isArray(ceiling) || ceiling.some(c => !known.includes(c))) throw new Error('ceiling lists an unknown capability');
  let keys = jwks;
  let keysUri = null;
  if (!keys) {
    const uri = jwksUri === undefined ? new URL('/.well-known/jwks.json', issuerUrl) : jwksUrl(jwksUri);
    if (uri.protocol === 'https:' && uri.origin !== issuerUrl.origin) throw new Error('JWKS URI must be HTTPS on issuer origin');
    keysUri = uri.href;
    // jose caches the set (10 min) and refetches on an unknown kid at most every 30 s.
    const options = { timeoutDuration: 3000, cooldownDuration: 30000, cacheMaxAge: 600000 };
    if (fetchImpl) options[customFetch] = fetchImpl;
    keys = createRemoteJWKSet(uri, options);
  } else if (typeof keys !== 'function') throw new Error('jwks must be a jose key set function');
  const gate = { remoteWrites, ceiling: [...ceiling] };
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const resourceMetadata = Object.freeze({
    resource, authorization_servers: [issuer], scopes_supported: scopesSupported(gate), bearer_methods_supported: ['header']
  });

  async function verifyAccessToken(token) {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS || !JWT_RE.test(token)) throw rejected('malformed');
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer, audience: resource, typ: ACCESS_TOKEN_TYP, algorithms: [...ALGORITHMS],
        requiredClaims: ['sub', 'exp', 'iat', 'client_id'], clockTolerance
      }));
    } catch (error) { throw mapJoseError(error); }
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.iat !== 'number' || payload.iat > nowSec + clockTolerance) throw rejected('issued_at');
    if (payload.exp - nowSec > maxTokenAge + clockTolerance) throw rejected('lifetime_too_long');
    if (payload.sub !== ownerSub) throw rejected('owner_mismatch');
    if (typeof payload.client_id !== 'string' || !allowed.has(payload.client_id)) throw rejected('client_not_allowed');
    const scopes = tokenScopes(payload);
    const capabilities = capabilitiesFor(scopes, gate);
    return {
      token, clientId: payload.client_id, scopes, expiresAt: payload.exp, resource: new URL(resource), resourceMetadataUrl,
      extra: Object.freeze({
        sub: payload.sub, principal: makePrincipal('oidc:' + payload.sub, capabilities), capabilities: Object.freeze(capabilities),
        client_type: allowed.get(payload.client_id), client_ref: clientRef(payload.client_id)
      })
    };
  }
  return Object.freeze({
    issuer, resource, resourceUrl, resourceMetadataUrl, resourceMetadata, jwksUri: keysUri, remoteWrites,
    baselineScope: BASELINE_SCOPE, maxTokenAgeSec: maxTokenAge, clockToleranceSec: clockTolerance,
    verifyAccessToken,
    // Boolean wrapper with the baseline scope required, mirroring oidcGuard().accepts.
    async accepts(header) {
      if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_.-]+$/.test(header)) return false;
      try { return (await verifyAccessToken(header.slice(7))).scopes.includes(BASELINE_SCOPE); } catch { return false; }
    }
  });
}
