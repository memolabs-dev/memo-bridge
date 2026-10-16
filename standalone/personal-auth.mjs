// Personal OAuth resource verifier. Isolated from the Memo Labs owner hub.
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const PERSONAL_SCOPE = 'inventory:read';
export const PERSONAL_TOKEN_TYPE = 'at+jwt';
const JWT_CHARS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ALGORITHMS = Object.freeze(['RS256', 'ES256', 'EdDSA']);
const OWNER_DOMAINS = new Set(['bridge.memolabs.dev', 'auth.memolabs.dev']);

function requireHttps(text, key, path = null) {
  if (typeof text !== 'string' || text.length > 512) throw new Error('invalid_' + key);
  let url;
  try { url = new URL(text); } catch { throw new Error('invalid_' + key); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      OWNER_DOMAINS.has(url.hostname) || url.origin.includes('localhost') ||
      ['127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname)) throw new Error('invalid_' + key);
  if (path !== null && url.pathname !== path) throw new Error('invalid_' + key);
  // OAuth issuer URLs are often bare origins, without the slash URL() adds.
  // Preserve the literal issuer exactly for the JWT iss comparison.
  if (url.href !== text && !(path === null && text === url.origin)) throw new Error('noncanonical_' + key);
  return url;
}

export function parsePersonalRemoteConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_remote_config');
  const allowedFields = ['version', 'enabled', 'issuer', 'resource', 'owner_sub', 'allowed_client_ids', 'jwks_uri', 'port'];
  if (Object.keys(raw).some(k => !allowedFields.includes(k)) ||
      raw.version !== 1 || raw.enabled !== true) throw new Error('invalid_remote_config');
  const issuer = requireHttps(raw.issuer, 'issuer');
  const resource = requireHttps(raw.resource, 'resource', '/mcp');
  if (typeof raw.owner_sub !== 'string' || !/^[a-zA-Z0-9._@-]{1,120}$/.test(raw.owner_sub)) throw new Error('invalid_owner_sub');
  const clients = raw.allowed_client_ids;
  if (!Array.isArray(clients) || clients.length < 1 || clients.length > 16 ||
      clients.some(v => typeof v !== 'string' || v.length < 1 || v.length > 512 || /\s/.test(v)) ||
      new Set(clients).size !== clients.length) throw new Error('invalid_allowed_clients');
  const jwks = raw.jwks_uri === undefined ? new URL('/.well-known/jwks.json', issuer.origin)
    : requireHttps(raw.jwks_uri, 'jwks_uri');
  if (jwks.origin !== issuer.origin) throw new Error('jwks_origin_mismatch');
  const port = raw.port === undefined ? 4481 : raw.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 9443 || port === 9445) {
    throw new Error('invalid_remote_port');
  }
  return Object.freeze({
    issuer: raw.issuer, resource: resource.href, ownerSub: raw.owner_sub,
    allowedClientIds: Object.freeze([...clients]), jwksUri: jwks.href, port
  });
}

export function createPersonalVerifier(config, { jwks = null, now = Date.now } = {}) {
  if (!config?.issuer || !config?.resource || !config?.ownerSub || !Array.isArray(config?.allowedClientIds)) {
    throw new Error('personal_policy_required');
  }
  const keys = jwks ?? createRemoteJWKSet(new URL(config.jwksUri), {
    timeoutDuration: 3000, cooldownDuration: 30000, cacheMaxAge: 600000
  });
  const clients = new Set(config.allowedClientIds);
  const metadata = Object.freeze({
    resource: config.resource, authorization_servers: [config.issuer],
    scopes_supported: [PERSONAL_SCOPE], bearer_methods_supported: ['header']
  });
  return Object.freeze({
    metadata,
    metadataUrl: new URL('/.well-known/oauth-protected-resource', config.resource).href,
    async verify(token) {
      if (typeof token !== 'string' || token.length > 8192 || !JWT_CHARS.test(token)) return null;
      let claims;
      try {
        ({ payload: claims } = await jwtVerify(token, keys, {
          issuer: config.issuer, audience: config.resource, typ: PERSONAL_TOKEN_TYPE,
          algorithms: ALGORITHMS, requiredClaims: ['exp', 'iat', 'sub', 'client_id']
        }));
      } catch { return null; }
      const sec = Math.floor(now() / 1000);
      if (claims.sub !== config.ownerSub || typeof claims.client_id !== 'string' ||
          !clients.has(claims.client_id) || typeof claims.iat !== 'number' ||
          claims.iat > sec + 30 || claims.iat < sec - 3600 ||
          !Number.isInteger(claims.exp) || claims.exp - sec > 3630 ||
          typeof claims.scope !== 'string' || !claims.scope.split(/ +/).includes(PERSONAL_SCOPE)) return null;
      return { clientId: claims.client_id, sub: claims.sub, expiresAt: claims.exp };
    }
  });
}
