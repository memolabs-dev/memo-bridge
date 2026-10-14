// TODO-P5-02, AC-P5-02: the Phase 5 OAuth access-token verifier (bridge/oidc.mjs).
// Locally minted keys only (jose); no identity provider, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { OAuthError, verifyBearerToken } from '@modelcontextprotocol/server';
import {
  BASELINE_SCOPE, CANONICAL_RESOURCE, WRITE_CAPABILITIES, capabilitiesFor, clientTypesOf, createOidcVerifier, scopesSupported, tokenScopes
} from '../bridge/oidc.mjs';
import { CAPABILITIES, isPrincipal } from '../server/coordinator/policy.mjs';

const issuer = 'https://auth.memolabs.dev';
const ownerSub = '6b3c1c9e-4f7a-4d2b-9e55-0c1f2a3b4c5d';
const chatgpt = 'https://chatgpt.com/oauth/client.json';
const now = () => Math.floor(Date.now() / 1000);

const pair = await generateKeyPair('ES256');
const other = await generateKeyPair('ES256');
const rsa = await generateKeyPair('RS256');
const pub = await exportJWK(pair.publicKey);
const rsaPub = await exportJWK(rsa.publicKey);
const keySet = { keys: [{ ...pub, kid: 'k1', alg: 'ES256', use: 'sig' }, { ...rsaPub, kid: 'r1', alg: 'RS256', use: 'sig' }] };
const jwks = createLocalJWKSet(keySet);

function verifier(extra = {}) {
  return createOidcVerifier({ issuer, ownerSub, allowedClientIds: [chatgpt], jwks, ...extra });
}
async function mint({ claims = {}, header = {}, key = pair.privateKey, alg = 'ES256', kid = 'k1', typ = 'at+jwt',
  iss = issuer, aud = CANONICAL_RESOURCE, sub = ownerSub, clientId = chatgpt, scope = BASELINE_SCOPE, iat = now(), exp = now() + 3600 } = {}) {
  // null omits a claim (undefined would select the default).
  const body = { ...(scope === null ? {} : { scope }), ...(clientId === null ? {} : { client_id: clientId }), ...claims };
  const h = { alg, ...(kid ? { kid } : {}), ...(typ ? { typ } : {}), ...header };
  let jwt = new SignJWT(body).setProtectedHeader(h);
  if (iss !== null) jwt = jwt.setIssuer(iss);
  if (aud !== null) jwt = jwt.setAudience(aud);
  if (sub !== null) jwt = jwt.setSubject(sub);
  if (iat !== null) jwt = jwt.setIssuedAt(iat);
  if (exp !== null) jwt = jwt.setExpirationTime(exp);
  return jwt.sign(key);
}
async function reason(v, token) {
  try { await v.verifyAccessToken(token); } catch (error) {
    assert.ok(error instanceof OAuthError, 'OAuthError expected');
    return { code: error.code, reason: error.reason };
  }
  return null;
}

test('a valid owner access token yields AuthInfo with the oidc principal and read capability only', async () => {
  const v = verifier();
  const token = await mint();
  const info = await v.verifyAccessToken(token);
  assert.equal(info.token, token);
  assert.equal(info.clientId, chatgpt);
  assert.deepEqual(info.scopes, [BASELINE_SCOPE]);
  assert.equal(typeof info.expiresAt, 'number');
  assert.equal(info.resource.href, CANONICAL_RESOURCE);
  assert.equal(info.resourceMetadataUrl, 'https://bridge.memolabs.dev/.well-known/oauth-protected-resource/mcp');
  assert.equal(info.extra.sub, ownerSub);
  assert.equal(info.extra.principal.id, 'oidc:' + ownerSub);
  assert.ok(isPrincipal(info.extra.principal), 'principal minted by policy.mjs');
  assert.deepEqual([...info.extra.principal.capabilities], [CAPABILITIES.READ]);
  assert.equal(info.extra.client_type, 'chatgpt');
  assert.match(info.extra.client_ref, /^[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(info.extra).includes(chatgpt), 'client id kept out of the audit-facing extra');
  assert.equal(await v.accepts('Bearer ' + token), true);
  // Map form: the configured client_type is attached; the client must still be listed.
  const mapped = verifier({ allowedClientIds: { [chatgpt]: 'cli' } });
  assert.equal((await mapped.verifyAccessToken(token)).extra.client_type, 'cli');
  // RS256 (what Pocket ID signs with) is accepted too.
  assert.ok(await v.verifyAccessToken(await mint({ key: rsa.privateKey, alg: 'RS256', kid: 'r1' })));
});

test('every claim and header defect is refused as invalid_token with a distinct reason', async () => {
  const v = verifier();
  const cases = {
    issuer: await mint({ iss: 'https://evil.example' }),
    issuer_slash: await mint({ iss: issuer + '/' }),
    audience: await mint({ aud: 'https://other.memolabs.dev/mcp' }),
    audience_slash: await mint({ aud: CANONICAL_RESOURCE + '/' }),
    id_token_audience: await mint({ aud: chatgpt }),
    owner_mismatch: await mint({ sub: 'someone-else' }),
    typ_jwt: await mint({ typ: 'JWT' }),
    typ_missing: await mint({ typ: null }),
    client_missing: await mint({ clientId: null }),
    client_unlisted: await mint({ clientId: 'https://chatgpt.com/oauth/other/client.json' }),
    expired: await mint({ iat: now() - 600, exp: now() - 120 }),
    too_old: await mint({ iat: now() - 7200, exp: now() + 600 }),
    iat_future: await mint({ iat: now() + 600, exp: now() + 3600 }),
    nbf_future: await mint({ claims: { nbf: now() + 600 } }),
    no_exp: await mint({ exp: null }),
    no_iat: await mint({ iat: null }),
    no_sub: await mint({ sub: null }),
    other_key: await mint({ key: other.privateKey }),
    unknown_kid: await mint({ key: other.privateKey, kid: 'nope' })
  };
  const expected = {
    issuer: 'issuer', issuer_slash: 'issuer', audience: 'audience', audience_slash: 'audience', id_token_audience: 'audience',
    owner_mismatch: 'owner_mismatch', typ_jwt: 'typ', typ_missing: 'typ', client_missing: 'missing_client_id',
    client_unlisted: 'client_not_allowed', expired: 'expired', too_old: 'too_old', iat_future: 'issued_at',
    nbf_future: 'not_yet_valid', no_exp: 'missing_exp', no_iat: 'missing_iat', no_sub: 'missing_sub', other_key: 'signature', unknown_kid: 'unknown_key'
  };
  for (const [name, token] of Object.entries(cases)) {
    const got = await reason(v, token);
    assert.deepEqual(got, { code: 'invalid_token', reason: expected[name] }, name);
    assert.equal(await v.accepts('Bearer ' + token), false, name);
  }
  // HS256 with any secret, alg none, malformed strings, the static owner bearer: never accepted.
  const hs = await new SignJWT({ scope: BASELINE_SCOPE, client_id: chatgpt }).setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .setIssuer(issuer).setAudience(CANONICAL_RESOURCE).setSubject(ownerSub).setIssuedAt().setExpirationTime('5m')
    .sign(new TextEncoder().encode('x'.repeat(32)));
  const none = Buffer.from('{"alg":"none","typ":"at+jwt"}').toString('base64url') + '.' +
    Buffer.from(JSON.stringify({ iss: issuer, aud: CANONICAL_RESOURCE, sub: ownerSub, client_id: chatgpt, scope: BASELINE_SCOPE, iat: now(), exp: now() + 60 })).toString('base64url') + '.';
  for (const token of [hs, none, 'malformed', 'a.b', '', 'f'.repeat(64), 'x'.repeat(9000) + '.a.b']) {
    const got = await reason(v, token);
    assert.equal(got?.code, 'invalid_token', 'refused: ' + token.slice(0, 20));
  }
});

test('clock skew is bounded by clockToleranceSec and token age by maxTokenAgeSec', async () => {
  const lenient = verifier();                      // 30 s tolerance, 3600 s age
  const strict = verifier({ clockToleranceSec: 0, maxTokenAgeSec: 900 });
  const justExpired = await mint({ iat: now() - 300, exp: now() - 10 });
  assert.ok(await lenient.verifyAccessToken(justExpired), 'within the 30 s skew');
  assert.equal((await reason(strict, justExpired)).reason, 'expired');
  const longExpired = await mint({ iat: now() - 300, exp: now() - 90 });
  assert.equal((await reason(lenient, longExpired)).reason, 'expired', 'beyond the skew');
  const halfHour = await mint({ iat: now() - 1800, exp: now() + 600 });
  assert.ok(await lenient.verifyAccessToken(halfHour), '30 min old under a 1 h maximum');
  assert.equal((await reason(strict, halfHour)).reason, 'too_old', '30 min old over a 15 min maximum');
  const slightFuture = await mint({ iat: now() + 10 });
  assert.ok(await lenient.verifyAccessToken(slightFuture), 'issuer clock 10 s ahead');
  assert.equal((await reason(strict, slightFuture)).reason, 'issued_at');
});

test('scopes map to capabilities, capped by the ceiling and the write gate', async () => {
  const all = Object.values(CAPABILITIES).join(' ') + ' openid offline_access hosts:read';
  const closed = verifier();
  const info = await closed.verifyAccessToken(await mint({ scope: all }));
  assert.deepEqual(info.extra.capabilities, [CAPABILITIES.AUDIT, CAPABILITIES.READ].sort(), 'gate closed: no write capability');
  const open = verifier({ remoteWrites: 'enabled' });
  const openInfo = await open.verifyAccessToken(await mint({ scope: all }));
  assert.deepEqual(openInfo.extra.capabilities, Object.values(CAPABILITIES).sort());
  const narrowed = verifier({ remoteWrites: 'enabled', ceiling: [CAPABILITIES.READ, CAPABILITIES.WRITE] });
  assert.deepEqual((await narrowed.verifyAccessToken(await mint({ scope: all }))).extra.capabilities, [CAPABILITIES.READ, CAPABILITIES.WRITE].sort());
  // scp array when scope is absent (Pocket ID emits both).
  const scp = await closed.verifyAccessToken(await mint({ scope: null, claims: { scp: [BASELINE_SCOPE, 'bad scope', BASELINE_SCOPE] } }));
  assert.deepEqual(scp.scopes, [BASELINE_SCOPE]);
  // Pure helpers.
  assert.deepEqual(capabilitiesFor(['repo:write', 'coordinator:read'], {}), ['coordinator:read']);
  assert.deepEqual(capabilitiesFor(['constructor', '__proto__', 'toString'], { remoteWrites: 'enabled' }), []);
  assert.deepEqual(tokenScopes({ scope: 'a  b a' }), ['a', 'b']);
  assert.deepEqual(scopesSupported({}), [BASELINE_SCOPE]);
  assert.deepEqual(scopesSupported({ remoteWrites: 'enabled' }), [BASELINE_SCOPE, ...WRITE_CAPABILITIES]);
  assert.deepEqual([...clientTypesOf([chatgpt])], [[chatgpt, 'chatgpt']]);
  assert.deepEqual([...clientTypesOf({ '5f0c-predefined': 'chatgpt', 'cli-client': 'cli' })], [['5f0c-predefined', 'chatgpt'], ['cli-client', 'cli']]);
  // Resource metadata advertises write scopes only once the gate is open (spec D7).
  assert.deepEqual(closed.resourceMetadata.scopes_supported, [BASELINE_SCOPE]);
  assert.deepEqual(open.resourceMetadata.scopes_supported, [BASELINE_SCOPE, ...WRITE_CAPABILITIES]);
  assert.deepEqual(closed.resourceMetadata.authorization_servers, [issuer]);
  assert.equal(closed.resourceMetadata.resource, CANONICAL_RESOURCE);
});

test('through the SDK bearer helper: missing baseline scope is 403 insufficient_scope, the rest 401', async () => {
  const v = verifier();
  const options = { verifier: v, requiredScopes: [BASELINE_SCOPE], resourceMetadataUrl: v.resourceMetadataUrl, expectedResource: v.resourceUrl };
  const ok = await verifyBearerToken('Bearer ' + await mint(), options);
  assert.equal(ok.extra.principal.id, 'oidc:' + ownerSub);
  await assert.rejects(verifyBearerToken('Bearer ' + await mint({ scope: 'openid profile' }), options), e => e.code === 'insufficient_scope');
  assert.equal(await v.accepts('Bearer ' + await mint({ scope: 'openid' })), false);
  await assert.rejects(verifyBearerToken('Bearer ' + await mint({ sub: 'x' }), options), e => e.code === 'invalid_token');
  await assert.rejects(verifyBearerToken(undefined, options), e => e.code === 'invalid_token');
});

test('JWKS is fetched from the issuer origin, cached, and an unreachable issuer is a server error', async () => {
  let calls = 0;
  const urls = [];
  const fetchImpl = async url => { calls++; urls.push(String(url)); return new Response(JSON.stringify(keySet), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const v = createOidcVerifier({ issuer, ownerSub, allowedClientIds: [chatgpt], fetchImpl });
  assert.equal(v.jwksUri, 'https://auth.memolabs.dev/.well-known/jwks.json');
  for (let i = 0; i < 3; i++) assert.ok(await v.verifyAccessToken(await mint()));
  assert.equal(calls, 1, 'keys cached across verifications');
  assert.deepEqual(urls, ['https://auth.memolabs.dev/.well-known/jwks.json']);
  // A token for an unknown kid inside the cooldown does not refetch: refused, still one call.
  assert.equal((await reason(v, await mint({ key: other.privateKey, kid: 'rotated' }))).reason, 'unknown_key');
  assert.equal(calls, 1, 'cooldown bounds refetches');
  const down = createOidcVerifier({ issuer, ownerSub, allowedClientIds: [chatgpt], fetchImpl: async () => new Response('no', { status: 502 }) });
  assert.deepEqual(await reason(down, await mint()), { code: 'server_error', reason: 'jwks_unavailable' });
  const thrown = createOidcVerifier({ issuer, ownerSub, allowedClientIds: [chatgpt], fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual(await reason(thrown, await mint()), { code: 'server_error', reason: 'jwks_unavailable' });
});

test('unsafe or malformed verifier configuration is refused', () => {
  const base = { issuer, ownerSub, allowedClientIds: [chatgpt], jwks };
  const bad = [
    { issuer: 'http://auth.memolabs.dev' },
    { issuer: 'https://user:pw@auth.memolabs.dev' },
    { issuer: 'https://auth.memolabs.dev/?x=1' },
    { resource: 'http://bridge.memolabs.dev/mcp' },
    { resource: 'https://bridge.memolabs.dev/mcp/' },
    { resource: 'https://bridge.memolabs.dev/other' },
    { resource: 'https://bridge.memolabs.dev/mcp?x=1' },
    { resource: 'https://Bridge.memolabs.dev/mcp' },
    { ownerSub: '' }, { ownerSub: ' owner' }, { ownerSub: 'a/b' },
    { allowedClientIds: [] }, { allowedClientIds: 'x' }, { allowedClientIds: [chatgpt, chatgpt] }, { allowedClientIds: ['has space'] },
    { allowedClientIds: {} }, { allowedClientIds: { [chatgpt]: 'Bad Type' } }, { allowedClientIds: null },
    { maxTokenAgeSec: 10 }, { maxTokenAgeSec: 90000 }, { maxTokenAgeSec: '1h' },
    { clockToleranceSec: 121 }, { clockToleranceSec: -1 },
    { remoteWrites: 'yes' }, { ceiling: ['root:all'] },
    { jwks: undefined, jwksUri: 'https://attacker.example/jwks.json' },
    { jwks: undefined, jwksUri: 'http://auth.memolabs.dev/.well-known/jwks.json' },
    { jwks: 'not a function' }
  ];
  for (const override of bad) assert.throws(() => createOidcVerifier({ ...base, ...override }), JSON.stringify(override));
  assert.throws(() => createOidcVerifier(null));
  // Accepted: another canonical host (O5-02 may pick it) and explicit bounds.
  assert.ok(createOidcVerifier({ ...base, resource: 'https://mcp.memolabs.dev/mcp', maxTokenAgeSec: 60, clockToleranceSec: 0 }));
});
