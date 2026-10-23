import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { parsePersonalRemoteConfig, createPersonalVerifier, PERSONAL_SCOPE } from '../standalone/personal-auth.mjs';

const NOW = Math.floor(Date.now() / 1000);
const RAW = Object.freeze({
  version: 1, enabled: true, issuer: 'https://identity.friend.example',
  resource: 'https://friend-mcp.example/mcp', owner_sub: 'friend-user',
  allowed_client_ids: ['chatgpt-personal'], port: 4481
});
const config = () => parsePersonalRemoteConfig({ ...RAW });

async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'fixture-key', use: 'sig' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const make = async (overrides = {}, header = {}) => new SignJWT({
    client_id: 'chatgpt-personal', scope: 'inventory:read', ...overrides
  }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'fixture-key', ...header })
    .setIssuer(RAW.issuer).setAudience(RAW.resource).setSubject('friend-user')
    .setIssuedAt(NOW).setExpirationTime(NOW + 1800).sign(privateKey);
  return { verifier: createPersonalVerifier(config(), { jwks, now: () => NOW * 1000 }), make, jwks };
}

test('personal issuer and resource must belong to user, never Memo Labs hub', () => {
  const setting = config();
  assert.equal(setting.ownerSub, 'friend-user');
  assert.equal(setting.port, 4481);
  assert.deepEqual(setting.allowedClientIds, ['chatgpt-personal']);
  for (const change of [
    { issuer: 'https://auth.memolabs.dev' },
    { resource: 'https://bridge.memolabs.dev/mcp' },
    { resource: 'http://friend-mcp.example/mcp' },
    { resource: 'https://friend-mcp.example/other' },
    { resource: 'https://friend-mcp.example/mcp?x=1' },
    { issuer: 'http://identity.friend.example' },
    { jwks_uri: 'https://untrusted.example/keys' },
    { allowed_client_ids: ['chatgpt-personal', 'chatgpt-personal'] },
    { allowed_client_ids: [] },
    { owner_sub: '' },
    { port: 9443 },
    { enabled: false },
    { secret_owner_token: 'stolen' }
  ]) assert.throws(() => parsePersonalRemoteConfig({ ...RAW, ...change }));
  assert.throws(() => parsePersonalRemoteConfig(null));
});

test('RS256 bearer is accepted only when issuer, audience, owner, client, age and scope match', async () => {
  const { verifier, make } = await fixture();
  const ok = await verifier.verify(await make());
  assert.equal(ok?.sub, 'friend-user');
  assert.equal(ok?.clientId, 'chatgpt-personal');
  assert.equal(verifier.metadata.resource, RAW.resource);
  assert.deepEqual(verifier.metadata.authorization_servers, [RAW.issuer]);
  assert.deepEqual(verifier.metadata.scopes_supported, [PERSONAL_SCOPE]);
  assert.ok(!JSON.stringify(ok).includes('token'));
});

test('same signing key cannot authorize another user, client or token audience', async () => {
  const { verifier, make, jwks } = await fixture();
  for (const change of [
    { client_id: 'other-client' },
    { client_id: 'chatgpt-personal', scope: 'other:read' },
    { client_id: null },
    { scope: '' }
  ]) assert.equal(await verifier.verify(await make(change)), null);
  const otherOwner = createPersonalVerifier({ ...config(), ownerSub: 'other-person' }, { jwks, now: () => NOW * 1000 });
  assert.equal(await otherOwner.verify(await make()), null);
  const otherAudience = createPersonalVerifier({ ...config(), resource: 'https://other.example/mcp' }, { jwks, now: () => NOW * 1000 });
  assert.equal(await otherAudience.verify(await make()), null);
  const otherIssuer = createPersonalVerifier({ ...config(), issuer: 'https://another.example' }, { jwks, now: () => NOW * 1000 });
  assert.equal(await otherIssuer.verify(await make()), null);
});

test('tampered, expired, future, old, wrong-typ and unsigned-looking tokens fail closed', async () => {
  const { verifier, make } = await fixture();
  assert.equal(await verifier.verify('a.b.c'), null);
  assert.equal(await verifier.verify(''), null);
  const token = await make();
  assert.equal(await verifier.verify(token.slice(0, -5) + 'wrong'), null);
  assert.equal(await verifier.verify(await make({}, { typ: 'JWT' })), null);
  const { privateKey } = await generateKeyPair('RS256');
  const expired = await new SignJWT({ client_id: 'chatgpt-personal', scope: 'inventory:read' })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' }).setIssuer(RAW.issuer)
    .setAudience(RAW.resource).setSubject('friend-user').setIssuedAt(NOW - 3600)
    .setExpirationTime(NOW - 100).sign(privateKey);
  assert.equal(await verifier.verify(expired), null);
  assert.equal(await verifier.verify('X'.repeat(10000)), null);
});

test('owner can revoke previously issued access tokens with an explicit personal cutoff', async () => {
  const { make, jwks } = await fixture();
  const current = await make();
  const old = createPersonalVerifier({
    ...config(), tokensValidAfter: NOW + 1
  }, { jwks, now: () => NOW * 1000 });
  assert.equal(await old.verify(current), null,
    'a previously minted token is rejected even if its signature is valid');
  const unchanged = createPersonalVerifier({
    ...config(), tokensValidAfter: NOW
  }, { jwks, now: () => NOW * 1000 });
  assert.equal((await unchanged.verify(current))?.sub, 'friend-user');
  assert.equal(parsePersonalRemoteConfig({ ...RAW, tokens_valid_after: NOW + 1 }).tokensValidAfter, NOW + 1);
  for (const tokens_valid_after of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => parsePersonalRemoteConfig({ ...RAW, tokens_valid_after }), /invalid_token_cutoff/);
  }
});
