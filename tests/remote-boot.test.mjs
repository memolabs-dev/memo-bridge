// TODO-P5-11 and the integration of the public listener (bridge/remote-boot.mjs): kill switch 2
// (remote_enabled false answers 503), write gate layer 2 at start on systemctl fixtures, the 401
// flood bucket keyed on the trusted proxy header only, client certificate logging (U-P5-08),
// all from a lab-infra shaped remote.json. Loopback HTTPS, locally minted tokens, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createOidcVerifier } from '../bridge/oidc.mjs';
import { createRemoteService } from '../bridge/remote-boot.mjs';
import { CHATGPT, ISSUER, RESOURCE, SUB, SYSTEMCTL_NO_RUNNER, SYSTEMCTL_ROOT_RUNNER, labRemoteJson, loopbackFetch, tlsPair }
  from './helpers/remote-stack.mjs';

const pair = await generateKeyPair('ES256');
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] });
const mint = ({ sub = SUB } = {}) => new SignJWT({ scope: 'coordinator:read', client_id: CHATGPT })
  .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' }).setIssuer(ISSUER).setAudience(RESOURCE).setSubject(sub)
  .setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
const LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

async function service(t, remote = {}, { systemctl = SYSTEMCTL_NO_RUNNER, requestAgent = async () => ({ ok: false, error: 'host_offline' }) } = {}) {
  const raw = labRemoteJson(remote);
  const { tlsKey, tlsCert } = await tlsPair(t);
  const journal = [];
  const verifier = createOidcVerifier({ issuer: ISSUER, ownerSub: SUB, allowedClientIds: [CHATGPT], jwks, remoteWrites: raw.remote_writes });
  const listener = await createRemoteService({ raw, tlsKey, tlsCert, requestAgent, audit: e => journal.push(e), systemctl, verifier, port: 0 });
  const { port } = await listener.start();
  t.after(() => listener.stop());
  const post = (token, headers = {}) => loopbackFetch(port, tlsCert, headers)(RESOURCE, { method: 'POST', body: LIST,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return { listener, journal, post, fetch: loopbackFetch(port, tlsCert) };
}

test('kill switch 2: remote_enabled false answers 503 on every path, before any authentication', async t => {
  const s = await service(t, { remote_enabled: false });
  assert.equal((await s.post(await mint())).status, 503);
  assert.equal((await s.fetch(`https://bridge.memolabs.dev/.well-known/oauth-protected-resource/mcp`)).status, 503);
  assert.ok(s.journal.every(e => e.reason === 'remote_disabled'));
  const on = await service(t, { remote_enabled: true });
  assert.equal((await on.post(await mint())).status, 200);
});

test('write gate layer 2 at start: enabled writes need the systemctl probe to find no root runner, and fail closed', async t => {
  await assert.rejects(service(t, { remote_writes: 'enabled' }, { systemctl: SYSTEMCTL_ROOT_RUNNER }), /remote writes refused: root_runner/);
  await assert.rejects(service(t, { remote_writes: 'enabled' }, { systemctl: async () => ({ code: -1, stdout: '' }) }),
    /remote writes refused: probe_failed/);
  const open = await service(t, { remote_writes: 'enabled' }, { systemctl: SYSTEMCTL_NO_RUNNER });
  assert.equal(open.listener.remoteWrites, 'enabled');
  assert.deepEqual(open.listener.resourceMetadata.scopes_supported.sort(),
    ['coordinator:read', 'coordinator:write', 'github:write', 'repo:write', 'runner:execute'].sort(), 'write scopes advertised only now');
  const closed = await service(t, {}, { systemctl: async () => { throw new Error('the probe must not run while writes are disabled'); } });
  assert.deepEqual(closed.listener.resourceMetadata.scopes_supported, ['coordinator:read']);
});

test('401 flood: per client address from the trusted proxy header, 429 before any token verification', async t => {
  const s = await service(t, { rate_limits: { read_per_min: 60, write_per_min: 20, execute_per_min: 6, in_flight: 8, unauthorized_per_min_per_ip: 2 } });
  const stranger = await mint({ sub: 'someone-else' });
  const from = ip => ({ 'x-forwarded-for': `203.0.113.250, ${ip}` });
  assert.equal((await s.post(stranger, from('198.51.100.7'))).status, 401);
  assert.equal((await s.post(stranger, from('198.51.100.7'))).status, 401);
  const limited = await s.post(await mint(), from('198.51.100.7'));
  assert.equal(limited.status, 429, 'even a valid token waits once its address is over the budget');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await s.post(await mint(), from('198.51.100.8'))).status, 200, 'another address has its own bucket');
  // A request without credentials is the normal start of the OAuth flow: never counted.
  for (let i = 0; i < 4; i++) assert.equal((await s.post(null, from('198.51.100.9'))).status, 401);
  assert.equal((await s.post(await mint(), from('198.51.100.9'))).status, 200);
});

test('client certificate logging: two booleans from the Traefik info header, never the certificate', async t => {
  const s = await service(t);
  const info = encodeURIComponent('Subject="CN=mtls.prod.connectors.openai.com";Issuer="CN=OpenAI Connectors";SAN="mtls.prod.connectors.openai.com"');
  assert.equal((await s.post(await mint(), { 'x-forwarded-tls-client-cert-info': info })).status, 200);
  assert.equal((await s.post(await mint(), { 'x-forwarded-tls-client-cert-info': encodeURIComponent('SAN="other.example"') })).status, 200);
  assert.equal((await s.post(await mint())).status, 200);
  const lines = s.journal.filter(e => e.event === 'public_request');
  assert.deepEqual(lines.map(e => [e.client_cert, e.client_cert_san]), [[true, true], [true, false], [false, undefined]]);
  assert.ok(!JSON.stringify(s.journal).includes('OpenAI Connectors'), 'the certificate info itself is never journaled');
});
