// Explicit, read-only OAuth issuer capability preflight for a separately owned MCP.
// This is NOT an authorization server or an end-to-end ChatGPT connection.
const MAX_RESPONSE_BYTES = 16384;
const TIMEOUT_MS = 5000;

async function jsonResponse(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' }
    });
  } catch { return { ok: false, error: 'issuer_unreachable' }; }
  if (!response || !response.ok || response.status !== 200) {
    try { await response?.body?.cancel(); } catch { /* no side effects */ }
    return { ok: false, error: 'discovery_unavailable' };
  }
  const type = response.headers.get('content-type') ?? '';
  if (!/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|\s*$)/i.test(type)) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    return { ok: false, error: 'invalid_content_type' };
  }
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_RESPONSE_BYTES) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    return { ok: false, error: 'response_too_large' };
  }
  let raw = '';
  try {
    // Limit bytes while streaming. Never buffer an unbounded provider response.
    for await (const chunk of response.body ?? []) {
      raw += Buffer.from(chunk).toString('utf8');
      if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new Error('oversize');
    }
  } catch { return { ok: false, error: 'response_unreadable' }; }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('json_type');
    return { ok: true, data: parsed };
  } catch { return { ok: false, error: 'malformed_json' }; }
}

function requireEndpoint(value, issuerOrigin) {
  if (typeof value !== 'string' || value.length > 1024) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  // Conservative standalone policy: no request to a different origin, no SSRF to localhost.
  return url.protocol === 'https:' && url.origin === issuerOrigin &&
    !url.username && !url.password && !url.hash;
}

function has(values, expected) {
  return Array.isArray(values) && values.includes(expected);
}

/**
 * Fetch only same-origin OAuth metadata and public JWKS from a preconfigured
 * personal issuer. Never fetch a metadata-supplied arbitrary URL.
 * Reports a fixed reason code, no tokens, endpoint URLs or credentials.
 */
export async function preflightPersonalIssuer(settings, { fetchImpl = globalThis.fetch } = {}) {
  if (!settings?.issuer || !settings?.resource || !settings?.jwksUri || typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'config_required' };
  }
  let issuer, jwksUrl;
  try {
    issuer = new URL(settings.issuer);
    jwksUrl = new URL(settings.jwksUri);
    if (issuer.protocol !== 'https:' || jwksUrl.protocol !== 'https:' ||
        jwksUrl.origin !== issuer.origin) throw new Error('invalid');
  } catch { return { ok: false, reason: 'invalid_issuer_configuration' }; }
  // RFC 8414 authorization server metadata and OpenID Connect discovery.
  const paths = [
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration'
  ];
  let metadata = null;
  for (const path of paths) {
    const result = await jsonResponse(fetchImpl, new URL(path, issuer.origin).href);
    if (result.ok) { metadata = result.data; break; }
  }
  if (!metadata) return { ok: false, reason: 'oauth_discovery_unavailable' };
  if (metadata.issuer !== settings.issuer) return { ok: false, reason: 'issuer_mismatch' };
  if (!requireEndpoint(metadata.authorization_endpoint, issuer.origin) ||
      !requireEndpoint(metadata.token_endpoint, issuer.origin) ||
      !has(metadata.response_types_supported, 'code') ||
      !has(metadata.code_challenge_methods_supported, 'S256') ||
      (metadata.grant_types_supported && !has(metadata.grant_types_supported, 'authorization_code'))) {
    return { ok: false, reason: 'oauth_pkce_unsupported' };
  }
  if (metadata.jwks_uri && metadata.jwks_uri !== settings.jwksUri) {
    return { ok: false, reason: 'jwks_mismatch' };
  }
  const jwks = await jsonResponse(fetchImpl, settings.jwksUri);
  if (!jwks.ok || !Array.isArray(jwks.data.keys) || jwks.data.keys.length < 1 ||
      jwks.data.keys.length > 32 ||
      !jwks.data.keys.some(k => k && (k.kty === 'RSA' || k.kty === 'EC' || k.kty === 'OKP') &&
        k.kty !== 'oct' && k.use !== 'enc')) return { ok: false, reason: 'jwks_unavailable' };
  return {
    ok: true, issuer_verified: true, authorization_code: true, pkce_s256: true,
    resource: 'independently-configured', json_web_keys: true,
    chatgpt_e2e_verified: false, remote_https_edge_verified: false,
    oauth_client_registration_verified: false
  };
}
