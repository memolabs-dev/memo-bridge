import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightPersonalIssuer } from '../standalone/personal-preflight.mjs';

const settings = Object.freeze({
  issuer: 'https://id.friend.example',
  resource: 'https://mcp.friend.example/mcp',
  jwksUri: 'https://id.friend.example/.well-known/jwks.json'
});
const metadata = Object.freeze({
  issuer: settings.issuer,
  authorization_endpoint: 'https://id.friend.example/authorize',
  token_endpoint: 'https://id.friend.example/token',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  grant_types_supported: ['authorization_code'],
  jwks_uri: settings.jwksUri
});
const keys = Object.freeze({ keys: [{ kty: 'RSA', kid: 'friend-public', n: 'AQAB', e: 'AQAB', use: 'sig' }] });

function stub({ meta = metadata, jwks = keys, status = 200, type = 'application/json' } = {}) {
  const urls = [], opts = [];
  const fetchImpl = async (url, options) => {
    urls.push(url); opts.push(options);
    return new Response(JSON.stringify(url.endsWith('/jwks.json') ? jwks : meta),
      { status, headers: { 'content-type': type } });
  };
  return { fetchImpl, urls, opts };
}

test('only separately configured personal issuer metadata, S256 PKCE and public same-origin JWKS pass', async () => {
  const { fetchImpl, urls, opts } = stub();
  const result = await preflightPersonalIssuer(settings, { fetchImpl });
  assert.deepEqual(result, {
    ok: true, issuer_verified: true, authorization_code: true, pkce_s256: true,
    resource: 'independently-configured', json_web_keys: true,
    chatgpt_e2e_verified: false, remote_https_edge_verified: false,
    oauth_client_registration_verified: false
  });
  assert.deepEqual(urls, ['https://id.friend.example/.well-known/oauth-authorization-server', settings.jwksUri]);
  assert.ok(opts.every(o => o.method === 'GET' && o.redirect === 'error' && o.signal));
});

test('preflight refuses an OAuth issuer mismatch, missing PKCE and external metadata endpoints', async () => {
  const changes = [
    { issuer: 'https://another.example' },
    { code_challenge_methods_supported: ['plain'] },
    { code_challenge_methods_supported: [] },
    { response_types_supported: ['token'] },
    { token_endpoint: 'https://bridge.memolabs.dev/token' },
    { authorization_endpoint: 'http://id.friend.example/authorize' },
    { jwks_uri: 'https://other.example/keys' },
    { grant_types_supported: ['client_credentials'] }
  ];
  for (const change of changes) {
    const r = await preflightPersonalIssuer(settings, { fetchImpl: stub({ meta: { ...metadata, ...change } }).fetchImpl });
    assert.equal(r.ok, false, JSON.stringify(change));
    assert.ok(['issuer_mismatch', 'oauth_pkce_unsupported', 'jwks_mismatch'].includes(r.reason));
  }
});

test('the preflight cannot be tricked into fetching a metadata-supplied endpoint', async () => {
  const invalid = { ...metadata, jwks_uri: 'https://evil.example/private', token_endpoint: 'https://evil.example/token' };
  const { fetchImpl, urls } = stub({ meta: invalid });
  const result = await preflightPersonalIssuer(settings, { fetchImpl });
  assert.equal(result.ok, false);
  assert.deepEqual(urls, ['https://id.friend.example/.well-known/oauth-authorization-server']);
});

test('preflight rejects missing keys, symmetric keys, malformed content and unreachable services', async () => {
  for (const badKeys of [{ keys: [] }, { keys: [{ kty: 'oct', k: 'secret' }] }, { keys: new Array(33).fill({ kty: 'RSA' }) }]) {
    const r = await preflightPersonalIssuer(settings, { fetchImpl: stub({ jwks: badKeys }).fetchImpl });
    assert.equal(r.reason, 'jwks_unavailable');
  }
  assert.deepEqual(await preflightPersonalIssuer(settings, { fetchImpl: stub({ status: 404 }).fetchImpl }),
    { ok: false, reason: 'oauth_discovery_unavailable' });
  assert.deepEqual(await preflightPersonalIssuer(settings, { fetchImpl: stub({ type: 'text/html' }).fetchImpl }),
    { ok: false, reason: 'oauth_discovery_unavailable' });
  assert.deepEqual(await preflightPersonalIssuer(settings, { fetchImpl: async () => { throw Error('secret token'); } }),
    { ok: false, reason: 'oauth_discovery_unavailable' });
  assert.deepEqual(await preflightPersonalIssuer(null), { ok: false, reason: 'config_required' });
});

test('metadata response size limits are enforced and never logged', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ ...metadata, padding: 'x'.repeat(20000) }),
    { headers: { 'content-type': 'application/json' } });
  const r = await preflightPersonalIssuer(settings, { fetchImpl });
  assert.equal(r.reason, 'oauth_discovery_unavailable');
  assert.ok(!JSON.stringify(r).includes('padding'));
});
