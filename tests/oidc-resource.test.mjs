// The resource-server configuration the public listener accepts (bridge/oidc.mjs). The Phase 1
// oidcGuard (scope hosts:read, no typ check) is gone with the 9443 OIDC mode (decision D4); its
// configuration refusals live on here, for createOidcVerifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as oidc from '../bridge/oidc.mjs';

const base = { issuer: 'https://auth.memolabs.dev', ownerSub: 'owner-uuid', allowedClientIds: ['https://chatgpt.com/oauth/client.json'] };

test('the Phase 1 guard and its hosts:read scope are gone', () => {
  assert.equal(oidc.oidcGuard, undefined);
  assert.equal(oidc.REQUIRED_SCOPE, undefined);
  assert.equal(oidc.BASELINE_SCOPE, 'coordinator:read');
});

test('JWKS location: HTTPS on the issuer origin, or HTTP on a loopback address literal only', () => {
  assert.equal(oidc.createOidcVerifier(base).jwksUri, 'https://auth.memolabs.dev/.well-known/jwks.json');
  // lab-infra remote.json: Pocket ID's own port on the VPS, no public route in the path.
  assert.equal(oidc.createOidcVerifier({ ...base, jwksUri: 'http://127.0.0.1:1411/.well-known/jwks.json' }).jwksUri,
    'http://127.0.0.1:1411/.well-known/jwks.json');
  assert.equal(oidc.createOidcVerifier({ ...base, jwksUri: 'http://[::1]:1411/jwks' }).jwksUri, 'http://[::1]:1411/jwks');
  for (const jwksUri of ['http://auth.memolabs.dev/.well-known/jwks.json', 'http://localhost:1411/jwks', 'http://10.0.7.2:1411/jwks',
    'http://127.0.0.1.attacker.example/jwks', 'http://user:pw@127.0.0.1:1411/jwks', 'http://127.0.0.1:1411/jwks?x=1',
    'https://attacker.example/jwks', 'ftp://127.0.0.1/jwks']) {
    assert.throws(() => oidc.createOidcVerifier({ ...base, jwksUri }), Error, jwksUri);
  }
});

test('refuse unsafe identity and resource configuration', () => {
  for (const c of [
    { ...base, issuer: 'http://auth.memolabs.dev' },
    { ...base, ownerSub: '' },
    { ...base, ownerSub: 'a b' },
    { ...base, resource: 'https://bridge.memolabs.dev/other' },
    { ...base, resource: 'https://bridge.memolabs.dev/mcp/' },
    { ...base, allowedClientIds: [] },
    { ...base, maxTokenAgeSec: 10 },
    { ...base, clockToleranceSec: 600 },
    { ...base, ceiling: ['root'] },
    { ...base, remoteWrites: 'yes' }
  ]) assert.throws(() => oidc.createOidcVerifier(c), Error, JSON.stringify(c));
});
