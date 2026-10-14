// Phase 6, TODO-P6-05 (remote side): the operator tools on the public ChatGPT surface. Listed
// only for a token holding operator:read AND a remote.json ceiling that lists it (opt-in,
// DEV-P6-03); every call routed to hub.requestOperator for the host named in the tool's own
// arguments; refusals journaled as denied. Loopback HTTPS, locally minted tokens, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createOidcVerifier } from '../bridge/oidc.mjs';
import { createRemoteService } from '../bridge/remote-boot.mjs';
import { REMOTE_DEFAULT_CEILING, operatorTier } from '../server/coordinator/policy.mjs';
import { REMOTE_OPERATOR_TOOLS } from '../server/registry.mjs';
import { CHATGPT, ISSUER, RESOURCE, SUB, SYSTEMCTL_NO_RUNNER, labRemoteJson, loopbackFetch, tlsPair } from './helpers/remote-stack.mjs';

const pair = await generateKeyPair('ES256');
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] });
const mint = scope => new SignJWT({ scope, client_id: CHATGPT })
  .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' }).setIssuer(ISSUER).setAudience(RESOURCE).setSubject(SUB)
  .setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
const WITH_OPERATOR = [...REMOTE_DEFAULT_CEILING, 'operator:read'];

async function service(t, { ceiling, requestOperator, remoteWrites = 'disabled' } = {}) {
  const raw = labRemoteJson({ remote_writes: remoteWrites, ...(ceiling ? { oidc: { ...labRemoteJson().oidc, ceiling } } : {}) });
  const { tlsKey, tlsCert } = await tlsPair(t);
  const journal = [];
  const agentCalls = [];
  const verifier = createOidcVerifier({ issuer: ISSUER, ownerSub: SUB, allowedClientIds: [CHATGPT], jwks, remoteWrites,
    ...(ceiling ? { ceiling } : {}) });
  const listener = await createRemoteService({ raw, tlsKey, tlsCert, verifier, port: 0, systemctl: SYSTEMCTL_NO_RUNNER,
    audit: e => journal.push(e), requestAgent: async (host, op) => { agentCalls.push({ host, op }); return { ok: true }; },
    ...(requestOperator ? { requestOperator } : {}) });
  const { port } = await listener.start();
  t.after(() => listener.stop());
  const fetch = loopbackFetch(port, tlsCert);
  const client = async scope => {
    const c = new Client({ name: 'operator-remote', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { fetch, requestInit: { headers: { authorization: `Bearer ${await mint(scope)}` } } }));
    t.after(() => c.close());
    return c;
  };
  return { client, journal, agentCalls, metadata: async () => JSON.parse(await (await fetch(`https://bridge.memolabs.dev/.well-known/oauth-protected-resource/mcp`)).text()) };
}
const names = async c => (await c.listTools()).tools.map(x => x.name);
const callJson = async (c, name, args) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);

test('operator tools stay unlisted under the default ceiling, even with the scope in the token', async t => {
  const s = await service(t);
  const c = await s.client('coordinator:read operator:read');
  assert.equal((await names(c)).some(n => n.startsWith('operator_')), false);
  assert.deepEqual((await s.metadata()).scopes_supported, ['coordinator:read'], 'not advertised either');
});

test('with operator:read in the ceiling and the token: T0 tools listed, routed to requestOperator by the host argument', async t => {
  const routed = [];
  const requestOperator = async (host, op, o) => {
    routed.push({ host, op, args: o.args, principal: o.principal.id, requestId: o.requestId });
    if (o.args.path?.endsWith('.env')) return { ok: false, error: 'path_secret' };
    return { ok: true, host, untrusted_content: { content: 'x'.repeat(60 * 1024) } };
  };
  const s = await service(t, { ceiling: WITH_OPERATOR, requestOperator });
  assert.deepEqual((await s.metadata()).scopes_supported, ['coordinator:read', 'operator:read']);
  // Without the scope in the token: nothing operator.
  assert.equal((await names(await s.client('coordinator:read'))).some(n => n.startsWith('operator_')), false);
  const c = await s.client('coordinator:read operator:read');
  const listed = await names(c);
  for (const tool of REMOTE_OPERATOR_TOOLS) assert.equal(listed.includes(tool), operatorTier(tool) === 0, tool);
  const read = await callJson(c, 'operator_read', { host: 'mac', path: '~/notes.txt' });
  // 60 KiB of content: over the 24 KiB dev-tool budget, inside the operator bound (spec D10).
  assert.equal(read.ok, true);
  const denied = await callJson(c, 'operator_read', { host: 'vps', path: '/srv/app/.env' });
  assert.equal(denied.error, 'path_secret');
  assert.deepEqual(routed.map(r => [r.host, r.op, r.principal]), [['mac', 'operator_read', `oidc:${SUB}`], ['vps', 'operator_read', `oidc:${SUB}`]]);
  assert.ok(routed.every(r => /^[0-9a-f-]{36}$/.test(r.requestId)), 'the forwarder\'s request id travels');
  assert.deepEqual(s.agentCalls, [], 'never through requestAgent');
  const lines = s.journal.filter(e => e.event === 'remote_call' && e.op === 'operator_read');
  assert.deepEqual(lines.map(e => [e.outcome, e.code]), [['ok', null], ['denied', 'path_secret']]);
  // The schema refuses a host outside the enum before any routing.
  const bad = await c.callTool({ name: 'operator_policy', arguments: { host: 'lab' } });
  assert.equal(bad.isError, true);
  assert.equal(routed.length, 2);
});

test('without the hub operator key: operator calls answer operator_disabled', async t => {
  const s = await service(t, { ceiling: WITH_OPERATOR });
  const c = await s.client('coordinator:read operator:read');
  const out = await callJson(c, 'operator_policy', { host: 'vps' });
  assert.deepEqual([out.ok, out.error], [false, 'operator_disabled']);
  assert.deepEqual(s.agentCalls, []);
});

test('Lot 2: the operator write, exec and root tools are listed only with the write gate open, the ceiling and the scope', async t => {
  const ALL_OPERATOR = [...REMOTE_DEFAULT_CEILING, 'operator:read', 'operator:write', 'operator:exec', 'operator:root'];
  const scopes = 'coordinator:read operator:read operator:write operator:exec operator:root';
  const closed = await service(t, { ceiling: ALL_OPERATOR });
  const closedTools = await names(await closed.client(scopes));
  for (const tool of REMOTE_OPERATOR_TOOLS) assert.equal(closedTools.includes(tool), operatorTier(tool) === 0, `${tool} with the gate closed`);
  const open = await service(t, { ceiling: ALL_OPERATOR, remoteWrites: 'enabled' });
  assert.deepEqual((await open.metadata()).scopes_supported.filter(s => s.startsWith('operator:')).sort(),
    ['operator:exec', 'operator:read', 'operator:root', 'operator:write']);
  const all = await names(await open.client(scopes));
  for (const tool of REMOTE_OPERATOR_TOOLS) assert.ok(all.includes(tool), tool);
  // A token with operator:exec but not operator:root lists operator_run (as_root is checked per call by the hub) but not operator_script.
  const exec = await names(await open.client('coordinator:read operator:read operator:exec'));
  assert.ok(exec.includes('operator_run') && !exec.includes('operator_script') && !exec.includes('operator_edit'));
  // Default ceiling with the gate open: still no operator write tool.
  const plain = await service(t, { remoteWrites: 'enabled' });
  assert.equal((await names(await plain.client(scopes))).some(n => n.startsWith('operator_')), false);
});
