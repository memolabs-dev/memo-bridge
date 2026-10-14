// Phase 5 additions to the hub <-> agent envelope (bridge/protocol.mjs), additive and optional:
// principal.client_type (a server-derived label) and meta {request_id, client_session} (the
// hub's per-request metadata). They reach the tool handlers as extra.meta, never as arguments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeRequest, validateRequest, wireMeta } from '../bridge/protocol.mjs';
import { createRuntimeOperations, wireClaim } from '../bridge/agent.mjs';
import { principalFromWire } from '../bridge/ops.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';

const P = makePrincipal('oidc:owner-sub', [CAPABILITIES.READ], { client_type: 'chatgpt', via: 'hub' });
const SESSION = 'a'.repeat(32);

test('the envelope carries client_type and well-formed meta only; capabilities never travel', () => {
  const msg = makeRequest({ id: 'req-00000001', op: 'workspace_list', args: {}, principal: P, timeoutMs: 1000,
    meta: { request_id: 'req-00000001', client_session: SESSION, extra: 'dropped' } });
  assert.deepEqual(msg.principal, { id: 'oidc:owner-sub', client_type: 'chatgpt' });
  assert.deepEqual(msg.meta, { request_id: 'req-00000001', client_session: SESSION });
  const checked = validateRequest(JSON.parse(JSON.stringify(msg)));
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.value.principal, { id: 'oidc:owner-sub', client_type: 'chatgpt' });
  assert.deepEqual(checked.value.meta, { request_id: 'req-00000001', client_session: SESSION });
  // A Phase 4 principal: unchanged envelope, no meta key at all.
  const old = makeRequest({ id: 'req-00000002', op: 'workspace_list', principal: makePrincipal('hub:owner', [CAPABILITIES.READ]) });
  assert.deepEqual(old.principal, { id: 'hub:owner' });
  assert.equal('meta' in old, false);
  assert.equal(validateRequest(old).value.meta, null);
  // Malformed values are dropped (meta) or refused (client_type), never passed on.
  assert.equal(wireMeta({ request_id: 'short', client_session: 'not-a-hash' }), null);
  assert.deepEqual(validateRequest({ ...msg, meta: { request_id: 'x y', client_session: SESSION.toUpperCase() } }).value.meta, null);
  assert.equal(validateRequest({ ...msg, principal: { id: 'oidc:owner-sub', client_type: 'Root!' } }).code, 'unknown_principal');
  assert.equal(validateRequest({ ...msg, principal: { id: 'oidc:owner-sub', capabilities: ['repo:write'] } }).value.principal.capabilities,
    undefined, 'claimed capabilities are not read from the wire');
});

test('the runtime operations map client_type through the grants and hand meta to the tool as extra.meta', async () => {
  const seen = [];
  const tools = new Map([['workspace_list', { inputSchema: { safeParse: v => ({ success: true, data: v }) },
    handler: async (args, extra) => { seen.push({ args, extra }); return { content: [{ type: 'text', text: '{"ok":true}' }] }; } }]]);
  const ops = await createRuntimeOperations({ runtimeFor: async () => ({ audit: async () => {} }), collect: async () => tools,
    principalFromWire: wire => principalFromWire(wire, { 'oidc:owner-sub': 'read' }), ops: ['workspace_list'] });
  const out = await ops.handlers.workspace_list({ x: 1 }, { principal: { id: 'oidc:owner-sub', client_type: 'chatgpt' },
    requestKey: null, meta: { request_id: 'req-00000003', client_session: SESSION } });
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(seen[0].args, { x: 1 }, 'the arguments are untouched');
  assert.deepEqual(seen[0].extra.meta, { request_id: 'req-00000003', client_session: SESSION });
  // An unknown client kind is refused at mapping time.
  await assert.rejects(ops.handlers.workspace_list({}, { principal: { id: 'oidc:owner-sub', client_type: 'nobody' } }), /unknown_principal/);
});

test('agent-cli maps the wire principal through wireClaim: id and client_type, nothing else', () => {
  assert.deepEqual(wireClaim({ id: 'oidc:a', client_type: 'chatgpt', capabilities: ['repo:write'] }), { id: 'oidc:a', client_type: 'chatgpt' });
  assert.deepEqual(wireClaim({ id: 'hub:owner' }), { id: 'hub:owner' });
  assert.match(readFileSync(new URL('../bridge/agent-cli.mjs', import.meta.url), 'utf8'), /principalFromWire: wire => base\.principalFromHub\(wireClaim\(wire\)\)/);
});
