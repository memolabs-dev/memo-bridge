// TODO-P5-11 and the integration of the public listener (bridge/remote-boot.mjs): kill switch 2
// (remote_enabled false answers 503), write gate layer 2 at start on systemctl fixtures, the 401
// flood bucket keyed on the trusted proxy header only, client certificate logging (U-P5-08) and
// the client certificate requirement (owner decision 2026-10-15, option A), all from a lab-infra
// shaped remote.json. Loopback HTTPS, locally minted tokens, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createOidcVerifier } from '../bridge/oidc.mjs';
import { createRemoteService } from '../bridge/remote-boot.mjs';
import { CERT_INFO_HEADER, CHATGPT, ISSUER, OPENAI_SAN, RESOURCE, SUB, SYSTEMCTL_NO_RUNNER, SYSTEMCTL_ROOT_RUNNER, labRemoteJson,
  loopbackFetch, queryEscape, tlsPair } from './helpers/remote-stack.mjs';

const pair = await generateKeyPair('ES256');
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] });
const mint = ({ sub = SUB } = {}) => new SignJWT({ scope: 'coordinator:read', client_id: CHATGPT })
  .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' }).setIssuer(ISSUER).setAudience(RESOURCE).setSubject(sub)
  .setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
const LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
const INITIALIZE = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'chatgpt', version: '1' } } });
const NO_CERT = { [CERT_INFO_HEADER]: null };

async function service(t, remote = {}, { systemctl = SYSTEMCTL_NO_RUNNER, requestAgent = async () => ({ ok: false, error: 'host_offline' }) } = {}) {
  const raw = labRemoteJson(remote);
  const { tlsKey, tlsCert } = await tlsPair(t);
  const journal = [];
  const verifier = createOidcVerifier({ issuer: ISSUER, ownerSub: SUB, allowedClientIds: [CHATGPT], jwks, remoteWrites: raw.remote_writes });
  const listener = await createRemoteService({ raw, tlsKey, tlsCert, requestAgent, audit: e => journal.push(e), systemctl, verifier, port: 0 });
  const { port } = await listener.start();
  t.after(() => listener.stop());
  const post = (token, headers = {}, body = LIST) => loopbackFetch(port, tlsCert, headers)(RESOURCE, { method: 'POST', body,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return { listener, journal, post, fetch: loopbackFetch(port, tlsCert), bare: loopbackFetch(port, tlsCert, NO_CERT) };
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
  const s = await service(t, { client_cert: { mode: 'log', info_header: CERT_INFO_HEADER, expected_san: OPENAI_SAN } });
  const info = encodeURIComponent('Subject="CN=mtls.prod.connectors.openai.com";Issuer="CN=OpenAI Connectors";SAN="mtls.prod.connectors.openai.com"');
  assert.equal((await s.post(await mint(), { 'x-forwarded-tls-client-cert-info': info })).status, 200);
  assert.equal((await s.post(await mint(), { 'x-forwarded-tls-client-cert-info': encodeURIComponent('SAN="other.example"') })).status, 200);
  assert.equal((await s.post(await mint(), NO_CERT)).status, 200, 'log mode never refuses');
  const lines = s.journal.filter(e => e.event === 'public_request');
  assert.deepEqual(lines.map(e => [e.client_cert, e.client_cert_san]), [[true, true], [true, false], [false, undefined]]);
  assert.ok(!JSON.stringify(s.journal).includes('OpenAI Connectors'), 'the certificate info itself is never journaled');
});

test('client certificate required: credentials count only with OpenAI\'s verified certificate; discovery stays open', async t => {
  const s = await service(t, { rate_limits: { read_per_min: 60, write_per_min: 20, execute_per_min: 6, in_flight: 8, unauthorized_per_min_per_ip: 2 } });
  assert.equal(s.listener.clientCertMode, 'require');
  const token = await mint();
  // Discovery without a certificate: the metadata and the bare 401 challenge.
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    assert.equal((await s.bare(`https://bridge.memolabs.dev${path}`)).status, 200, path);
  }
  const challenge = await s.post(null, NO_CERT);
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get('www-authenticate'), /^Bearer resource_metadata="https:\/\/bridge\.memolabs\.dev\/\.well-known\/oauth-protected-resource\/mcp"/);
  const deniedLine = s.journal.findLast(e => e.event === 'public_auth_denied');
  assert.deepEqual([deniedLine.reason, deniedLine.client_cert], ['no_credentials', false], 'the challenge line records the certificate fact');
  // A valid owner token without the certificate: 403 for initialize and tools/list alike.
  for (const body of [INITIALIZE, LIST]) {
    const refused = await s.post(token, NO_CERT, body);
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get('www-authenticate'), null, 'not an OAuth challenge');
    assert.deepEqual((await refused.json()).error, 'client_cert_required');
  }
  // Refused before verification: a garbage token gets the same 403, and the 401 flood bucket
  // (2 per minute here) is never charged, so the address still has its full budget.
  for (let i = 0; i < 4; i++) assert.equal((await s.post('not-a-token', NO_CERT)).status, 403);
  // A certificate that is present but not OpenAI's connector name: refused too.
  for (const info of [queryEscape('Subject="CN=someone.example";SAN="someone.example"'),
    queryEscape(`Subject="CN=x";SAN="evil-${OPENAI_SAN}.example"`), 'not%escaped%ZZ']) {
    assert.equal((await s.post(token, { [CERT_INFO_HEADER]: info })).status, 403, info);
  }
  const refusals = s.journal.filter(e => e.event === 'public_refused');
  assert.equal(refusals.length, 2 + 4 + 3);
  assert.ok(refusals.every(e => e.status === 403 && e.reason === 'client_cert_required'));
  assert.deepEqual(refusals.map(e => [e.client_cert, e.client_cert_san]).slice(-4),
    [[false, undefined], [true, false], [true, false], [true, false]]);
  assert.ok(!s.journal.some(e => e.event === 'public_request'), 'no MCP request was served');
  assert.ok(!JSON.stringify(s.journal).includes('someone.example'), 'the certificate info itself is never journaled');
  // With the certificate Traefik forwards for ChatGPT: initialize and tools/list are served.
  assert.equal((await s.post(token, {}, INITIALIZE)).status, 200);
  const listed = await s.post(token);
  assert.equal(listed.status, 200);
  const text = await listed.text();
  const message = JSON.parse(text.startsWith('{') ? text : text.split('\n').find(l => l.startsWith('data: ')).slice(6));
  assert.ok(Array.isArray(message.result.tools));
  // The subject CN alone also names the connector (exact match), for a certificate without SANs.
  assert.equal((await s.post(token, { [CERT_INFO_HEADER]: queryEscape(`Subject="CN=${OPENAI_SAN},O=OpenAI"`) })).status, 200);
  const served = s.journal.filter(e => e.event === 'public_request');
  assert.deepEqual(served.map(e => [e.status, e.client_cert, e.client_cert_san]), [[200, true, true], [200, true, true], [200, true, true]]);
  // An invalid token with the certificate is an OAuth failure again: 401, counted.
  assert.equal((await s.post('not-a-token')).status, 401);
  const failed = s.journal.findLast(e => e.event === 'public_auth_denied');
  assert.deepEqual([failed.status, failed.client_cert, failed.client_cert_san], [401, true, true]);
});

test('client certificate required without expected_san: any verified certificate info suffices', async t => {
  const s = await service(t, { client_cert: { mode: 'require', info_header: CERT_INFO_HEADER } });
  const token = await mint();
  assert.equal((await s.post(token, NO_CERT)).status, 403);
  assert.equal((await s.post(token, { [CERT_INFO_HEADER]: queryEscape('Subject="CN=other";SAN="other.example"') })).status, 200);
  assert.deepEqual(s.journal.filter(e => e.event === 'public_request').map(e => [e.client_cert, e.client_cert_san]), [[true, undefined]]);
});
