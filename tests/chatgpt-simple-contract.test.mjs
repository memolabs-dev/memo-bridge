import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createRemoteServerFactory, parseRemoteConfig, REMOTE_DESIGN_TOOLS, unlistedToolCalls } from '../bridge/remote-surface.mjs';
import { CAPABILITIES } from '../server/coordinator/policy.mjs';
import { SIMPLE_REMOTE_TOOLS, SIMPLE_REMOTE_OPERATOR_TOOLS } from '../server/registry.mjs';
import { OPERATOR_SCHEMAS } from '../server/tools/operator-tools.mjs';

const scopes = Object.values(CAPABILITIES);
const config = { owner_sub: 'owner', allowed_client_ids: ['client'],
  remote_writes: 'enabled', ceiling: scopes, surface: 'simple' };
const authInfo = { token: 'fixture', clientId: 'client', scopes, extra: { sub: 'owner' } };
const decode = text => JSON.parse(text.startsWith('event:') ? text.split('\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).trim()).join('') : text);
const create = (surface, overrides = {}) => {
  const calls = [];
  const routed = [];
  const factory = createRemoteServerFactory({ config: { ...config, surface, ...overrides },
    dispatch: async (host, op, options) => {
      calls.push(op);
      routed.push({ host, op, args: options.args });
      return { ok: false, error: 'fixture_refusal' };
    } });
  const handler = createMcpHandler(factory, { legacy: 'stateless' });
  let id = 0;
  return { calls, routed, async request(method, params = {}) {
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

test('simple tools/list contains the original 26 plus two typed design actions', async () => {
  const m = create('simple');
  const tools = (await m.request('tools/list')).result.tools;
  assert.deepEqual(tools.map(t => t.name).sort(), [...SIMPLE_REMOTE_TOOLS, ...SIMPLE_REMOTE_OPERATOR_TOOLS, ...REMOTE_DESIGN_TOOLS].sort());
  assert.equal(tools.length, 28);
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

test('design tools are fixed Mac operator_run requests, no arbitrary commands', async () => {
  const m = create('simple');
  const runId = '0344aeb2-b385-4ccd-9d77-2461a351b471';
  const createResponse = await m.request('tools/call', { name: 'design_create', arguments: {
    name: 'Orbit QA', brief: 'Prototype a responsive Orbit dashboard with a sidebar and accessibility checks.',
    design_system: 'application', skill: 'artifacts-builder' } });
  assert.ok(!createResponse.error && !createResponse.result?.isError, 'typed create accepted by MCP schema');
  assert.deepEqual(m.routed[0], {
    host: 'vps', op: 'operator_run',
    args: { host: 'mac', argv: ['/Users/memo/bin/opencode-v2', 'od-create', 'Orbit QA',
      'Prototype a responsive Orbit dashboard with a sidebar and accessibility checks.', 'application', 'artifacts-builder'], timeout_s: 45 }
  });
  const statusResponse = await m.request('tools/call', { name: 'design_status', arguments: { run_id: runId } });
  assert.ok(!statusResponse.error && !statusResponse.result?.isError);
  assert.deepEqual(m.routed[1].args.argv, ['/Users/memo/bin/opencode-v2', 'od-status', runId]);
  assert.equal(m.routed[1].args.host, 'mac');
  // Production regression: optional positional arguments must NEVER contain empty
  // strings, which operator_run rejects before invoking the Mac launcher.
  const combos = [
    [{}, ['/Users/memo/bin/opencode-v2', 'od-create', 'Design Smoke', 'Create a fully responsive HTML page.']],
    [{ design_system: 'application' }, ['/Users/memo/bin/opencode-v2', 'od-create', 'Design Smoke', 'Create a fully responsive HTML page.', 'application']],
    [{ skill: 'artifacts-builder' }, ['/Users/memo/bin/opencode-v2', 'od-create', 'Design Smoke', 'Create a fully responsive HTML page.', 'default', 'artifacts-builder']],
    [{ design_system: 'application', skill: 'artifacts-builder' }, ['/Users/memo/bin/opencode-v2', 'od-create', 'Design Smoke', 'Create a fully responsive HTML page.', 'application', 'artifacts-builder']]
  ];
  for (const [optional, expected] of combos) {
    const response = await m.request('tools/call', { name: 'design_create',
      arguments: { name: 'Design Smoke', brief: 'Create a fully responsive HTML page.', ...optional } });
    assert.ok(!response.error && !response.result?.isError, 'optional design arguments must be accepted');
    assert.deepEqual(m.routed.at(-1).args.argv, expected);
    assert.ok(m.routed.at(-1).args.argv.every(x => x.length > 0));
    assert.ok(OPERATOR_SCHEMAS.operator_run.safeParse(m.routed.at(-1).args).success,
      'design_create must satisfy the downstream operator_run schema');
  }
  const before = m.routed.length;
  for (const args of [{ name: 'X', brief: 'short' },
    { name: 'X', brief: 'long enough to be valid', executable: '/bin/sh' },
    { name: 'X', brief: 'long enough to be valid', design_system: '--help' },
    { name: 'X', brief: 'B'.repeat(4097) }]) {
    const response = await m.request('tools/call', { name: 'design_create', arguments: args });
    assert.ok(response.error || response.result?.isError, 'invalid design input rejected');
  }
  assert.equal(m.routed.length, before, 'invalid calls are not dispatched');
});

test('design tools are absent without write gate and operator execution capability', async () => {
  const gateClosed = create('simple', { remote_writes: 'disabled' });
  assert.ok(!(await gateClosed.request('tools/list')).result.tools.some(t => REMOTE_DESIGN_TOOLS.includes(t.name)));
  const noExec = create('simple', { ceiling: scopes.filter(s => s !== CAPABILITIES.OPERATOR_EXEC) });
  assert.ok(!(await noExec.request('tools/list')).result.tools.some(t => REMOTE_DESIGN_TOOLS.includes(t.name)));
  const filtered = unlistedToolCalls(authInfo, { ...config, remote_writes: 'disabled' },
    { method: 'tools/call', params: { name: 'design_create' } });
  assert.equal(filtered[0].reason, 'write_gate_closed');
});

test('full is opt-in and does not leak into simple', async () => {
  const a = (await create('simple').request('tools/list')).result.tools.map(t => t.name);
  const b = (await create('full').request('tools/list')).result.tools.map(t => t.name);
  assert.ok(b.length > a.length);
  assert.ok(b.includes('task_claim'));
  assert.ok(!a.includes('task_claim'));
});
