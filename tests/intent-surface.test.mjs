import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { INTENT_DEFINITIONS, intentToolsFor, resolveIntent } from '../server/intent-registry.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { collectOperatorDefinitions, collectToolDefinitions, SIMPLE_REMOTE_OPERATOR_TOOLS, SIMPLE_REMOTE_TOOLS, toolsFor, operatorToolsFor } from '../server/registry.mjs';
import { createRemoteServerFactory, parseRemoteConfig, remoteToolNames, unlistedToolCalls } from '../bridge/remote-surface.mjs';
const all = Object.values(CAPABILITIES);
const config = { owner_sub: 'owner', allowed_client_ids: ['client'], surface: 'intent', ceiling: all, remote_writes: 'enabled' };
const auth = { clientId: 'client', scopes: all, extra: { sub: 'owner' } };
function surface({ cfg = config, authInfo = auth, dispatch } = {}) {
  const calls = [], events = [];
  const handler = createMcpHandler(createRemoteServerFactory({ config: cfg, audit: e => events.push(e),
    dispatch: dispatch ?? (async (host, op, options) => { calls.push({ host, op, ...options }); return { ok: true, op }; }) }), { legacy: 'stateless' });
  let id = 0;
  async function rpc(method, params) {
    const response = await handler.fetch(new Request('http://localhost/mcp', { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }), { authInfo });
    const text = await response.text();
    return JSON.parse(text.startsWith('event:') || text.startsWith('data:')
      ? text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('') : text);
  }
  return { calls, events, rpc, call: (name, args = {}) => rpc('tools/call', { name, arguments: args }) };
}
const data = out => JSON.parse(out.result.content[0].text);

test('intent registry is typed, strict, read-only and resolves only to existing authorized schemas', async () => {
  const defs = new Map([...await collectToolDefinitions(), ...await collectOperatorDefinitions()]);
  for (const [name, args] of [
    ['intent_inspect', { search: 'bridge', status: 'lab' }],
    ['intent_status', { target: 'policy', host: 'vps' }],
    ['intent_status', { target: 'snapshot', host: 'mac', path: '~/repo' }], ['intent_guidance', {}]
  ]) {
    const resolved = resolveIntent(name, args);
    assert.equal(resolved.ok, true);
    assert.equal(defs.get(resolved.op).inputSchema.safeParse(resolved.args).success, true);
    assert.equal(INTENT_DEFINITIONS[name].annotations.readOnlyHint, true);
    assert.equal(resolveIntent(name, { ...args, command: 'id' }).ok, false);
  }
  for (const args of [{}, { target: 'policy' }, { target: 'policy', host: 'lab' },
    { target: 'snapshot', host: 'mac' }, { target: 'snapshot', host: 'vps', path: '' },
    { target: 'execute', host: 'mac' }, { target: 'policy', host: 'mac', principal: 'owner' }])
    assert.equal(resolveIntent('intent_status', args).ok, false);
  assert.equal(resolveIntent('operator_run', {}).ok, false);
  assert.equal(resolveIntent('__proto__', {}).ok, false);
});

test('capability filtering, ceiling and verifier intersection never grant intent rights', async () => {
  const reader = makePrincipal('oidc:owner', [CAPABILITIES.READ]);
  assert.deepEqual(intentToolsFor(reader), ['intent_inspect']);
  assert.deepEqual(toolsFor(reader, { surface: 'intent' }), []);
  assert.deepEqual(operatorToolsFor(reader, { surface: 'intent' }), []);
  for (const overrides of [ { scopes: [CAPABILITIES.READ] },
    { extra: { sub: 'owner', principal: reader } } ]) {
    const s = surface({ authInfo: { ...auth, ...overrides } });
    assert.deepEqual((await s.rpc('tools/list')).result.tools.map(t => t.name), ['intent_inspect']);
    const out = await s.call('intent_status', { target: 'policy', host: 'mac' });
    assert.ok(out.error || out.result?.isError);
    assert.equal(s.calls.length, 0);
  }
  const limited = surface({ cfg: { ...config, ceiling: [CAPABILITIES.READ] } });
  assert.equal((await limited.rpc('tools/list')).result.tools.length, 1);
});

test('MCP intent routing preserves trusted principal, host args, session context and client; raw calls fail closed', async () => {
  const s = surface();
  const listed = (await s.rpc('tools/list')).result.tools;
  assert.deepEqual(listed.map(t => t.name).sort(), Object.keys(INTENT_DEFINITIONS).sort());
  for (const tool of listed) assert.equal(tool.annotations.readOnlyHint, true);
  await s.call('intent_inspect', { search: 'bridge' });
  await s.call('intent_status', { target: 'policy', host: 'vps' });
  await s.call('intent_status', { target: 'snapshot', host: 'mac', path: '~/repo' });
  await s.call('intent_guidance');
  assert.deepEqual(s.calls.map(c => [c.op, c.args]), [
    ['projects_list', { search: 'bridge' }], ['operator_policy', { host: 'vps' }],
    ['operator_snapshot', { host: 'mac', path: '~/repo' }], ['operator_help', { topic: 'refusals', limit: 10 }]
  ]);
  for (const c of s.calls) {
    assert.equal(c.principal.id, 'oidc:owner'); assert.equal(c.clientId, 'client'); assert.ok(c.ctx);
    assert.equal(c.host, 'vps', 'existing dispatcher selects the operator host from args');
  }
  for (const name of ['operator_run', 'operator_script', 'operator_policy', 'projects_list', 'jobs_submit', 'worktree_push', 'task_claim']) {
    const out = await s.call(name, { command: 'id' });
    assert.ok(out.error || out.result?.isError, name);
    assert.equal(unlistedToolCalls(auth, config, { method: 'tools/call', params: { name } }).length, 1);
  }
  for (const [name, args] of [['intent_guidance', { playbook: 'restart_stack' }],
    ['intent_inspect', { op: 'operator_run' }], ['intent_status', { target: 'policy', host: 'mac', command: 'id' }]]) {
    const out = await s.call(name, args); assert.ok(out.error || out.result?.isError || data(out).ok === false);
  }
  assert.equal(s.calls.length, 4);
  assert.deepEqual(unlistedToolCalls(auth, config, { method: 'tools/call', params: { name: 'intent_status' } }), []);
});

test('inner refusals, invalid responses, thrown errors and output budgets survive aliases', async () => {
  for (const [dispatch, expected] of [
    [async () => ({ ok: false, error: 'path_denied' }), 'path_denied'],
    [async () => { throw Error('secret'); }, 'internal_error'],
    [async () => [], 'invalid_agent_response'],
    [async () => ({ ok: true, text: 'x'.repeat(200000) }), 'result_too_large']
  ]) {
    const s = surface({ dispatch });
    const result = data(await s.call('intent_status', { target: 'snapshot', host: 'mac', path: '~/repo' }));
    assert.equal(result.error, expected); assert.equal(result.op_completed, undefined);
  }
});

test('default simple remains exactly 26 tools; full and explicit intent remain separate', () => {
  const principal = makePrincipal('oidc:owner', all);
  const { surface: _, ...base } = config;
  assert.equal(parseRemoteConfig(base).surface, 'simple');
  assert.deepEqual(remoteToolNames(principal, base), [...SIMPLE_REMOTE_TOOLS, ...SIMPLE_REMOTE_OPERATOR_TOOLS].sort());
  assert.equal(remoteToolNames(principal, base).length, 26);
  assert.equal(remoteToolNames(principal, { ...base, surface: 'full' }).includes('intent_status'), false);
  assert.equal(parseRemoteConfig(config).surface, 'intent');
});
