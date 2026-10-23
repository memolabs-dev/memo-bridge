import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createRemoteServerFactory, parseRemoteConfig } from '../bridge/remote-surface.mjs';
import { CAPABILITIES } from '../server/coordinator/policy.mjs';
import { SIMPLE_REMOTE_TOOLS, SIMPLE_REMOTE_OPERATOR_TOOLS } from '../server/registry.mjs';

const scopes = Object.values(CAPABILITIES);
const config = { owner_sub: 'owner', allowed_client_ids: ['client'],
  remote_writes: 'enabled', ceiling: scopes, surface: 'simple' };
const authInfo = { token: 'fixture', clientId: 'client', scopes, extra: { sub: 'owner' } };
const decode = text => JSON.parse(text.startsWith('event:') ? text.split('\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).trim()).join('') : text);
const create = surface => {
  const calls = [];
  const factory = createRemoteServerFactory({ config: { ...config, surface },
    dispatch: async (host, op) => { calls.push(op); return { ok: false, error: 'fixture_refusal' }; } });
  const handler = createMcpHandler(factory, { legacy: 'stateless' });
  let id = 0;
  return { calls, async request(method, params = {}) {
    const r = await handler.fetch(new Request('http://localhost/mcp', { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }), { authInfo });
    assert.equal(r.status, 200);
    return decode(await r.text());
  }};
};

test('simple is the default and invalid surface fails closed', () => {
  assert.equal(parseRemoteConfig({ ...config, surface: undefined }).surface, 'simple');
  assert.throws(() => parseRemoteConfig({ ...config, surface: 'everything' }), /invalid_remote_config:surface/);
});

test('simple tools/list is exactly the 26-item owner-facing contract', async () => {
  const m = create('simple');
  const tools = (await m.request('tools/list')).result.tools;
  assert.deepEqual(tools.map(t => t.name).sort(), [...SIMPLE_REMOTE_TOOLS, ...SIMPLE_REMOTE_OPERATOR_TOOLS].sort());
  assert.equal(tools.length, 26);
  for (const t of tools) {
    assert.ok(t.description.startsWith('Use this'), t.name);
    assert.ok(t.inputSchema, t.name);
    assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', t.name);
  }
});

test('every advertised simple tool is callable; full-only operations are blocked', async () => {
  const m = create('simple');
  const listed = (await m.request('tools/list')).result.tools;
  for (const { name } of listed) {
    // Empty args cannot perform destructive actions; the dispatcher is a harmless stub.
    const response = await m.request('tools/call', { name, arguments: {} });
    assert.doesNotMatch(JSON.stringify(response), /Unknown tool|Tool not found|unknown_tool/i, name);
  }
  for (const name of ['task_claim', 'workspace_open', 'github_create_pr', 'memory_save', 'operator_delete']) {
    const result = await m.request('tools/call', { name, arguments: {} });
    assert.ok(result.error || result.result?.isError, name);
    assert.equal(m.calls.includes(name), false, name + ' forwarded');
  }
});

test('full is opt-in and does not leak into simple', async () => {
  const a = (await create('simple').request('tools/list')).result.tools.map(t => t.name);
  const b = (await create('full').request('tools/list')).result.tools.map(t => t.name);
  assert.ok(b.length > a.length);
  assert.ok(b.includes('task_claim'));
  assert.ok(!a.includes('task_claim'));
});
