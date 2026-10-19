// Phase 5, TODO-P5-04 (REQ-P5-06, AC-P5-06): one tool registry for stdio, the Phase 4 hub and
// the Phase 5 remote surface; the remote allowlists; toolsFor (gate layer 1); and parity of the
// remote definitions with what the stdio server actually lists (a real stdio server, spawned
// with a private HOME; listing tools opens no state).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  REMOTE_TOOLS, REMOTE_TOOLS_READ, REMOTE_TOOLS_WRITE, TOOL_MODULES, collectToolDefinitions, collectTools, isRemoteWriteTool,
  registryProblems, remoteWritesEnabled, toolsFor
} from '../server/registry.mjs';
import { CAPABILITIES, OPERATION_CAPABILITY, makePrincipal } from '../server/coordinator/policy.mjs';
import { RUNTIME_OPS, collectToolDefinitions as opsDefinitions } from '../bridge/ops.mjs';
import { createRemoteServerFactory } from '../bridge/remote-surface.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALL = Object.values(CAPABILITIES);
const READ_ONLY = makePrincipal('oidc:reader', [CAPABILITIES.READ]);
const EVERYTHING = makePrincipal('oidc:owner', ALL);
const NOT_REMOTE = ['observe_guardian', 'observe_agents', 'observe_live_state', 'observe_focus', 'host_resources', 'worktree_remove',
  'list_hosts', 'host_status', 'bridge_info', 'project_info', 'project_git_status', 'projects_audit'];

test('registry: the collected tools are exactly the policy table and the runtime ops', async () => {
  const defs = await collectToolDefinitions();
  assert.deepEqual([...defs.keys()].sort(), Object.keys(OPERATION_CAPABILITY).sort());
  assert.deepEqual([...defs.keys()].sort(), [...RUNTIME_OPS].sort());
  assert.ok(defs.has('projects_list'), 'FU-4: projects_list is served by the runtime');
  assert.equal(OPERATION_CAPABILITY.projects_list, CAPABILITIES.READ);
  for (const def of defs.values()) assert.deepEqual(Object.keys(def).sort(), ['annotations', 'description', 'inputSchema'], 'no handler');
  // The hub's view (bridge/ops.mjs) is the registry's, checked against the op table.
  assert.deepEqual([...(await opsDefinitions()).keys()].sort(), [...defs.keys()].sort());
  // Each caller gets its own Map: one surface cannot change another one's list.
  defs.delete('tasks_list');
  assert.ok((await collectToolDefinitions()).has('tasks_list'));
  assert.equal(TOOL_MODULES.length, 12);
  assert.ok(Object.isFrozen(TOOL_MODULES) && TOOL_MODULES.every(Object.isFrozen));
});

test('registry: definitions never reach a runtime; handlers do, lazily', async () => {
  let asked = 0;
  const tools = await collectTools(() => { asked++; throw new Error('state_unavailable'); });
  assert.equal(asked, 0, 'collecting calls no getRuntime');
  const out = await tools.get('projects_list').handler({});
  assert.equal(asked, 1);
  assert.deepEqual(JSON.parse(out.content[0].text), { ok: false, error: 'runtime_unavailable' });
});

test('remote allowlists: disjoint, read tools read, write tools write, exclusions absent', async () => {
  assert.equal(new Set(REMOTE_TOOLS).size, REMOTE_TOOLS.length, 'no duplicate');
  assert.equal(REMOTE_TOOLS.length, REMOTE_TOOLS_READ.length + REMOTE_TOOLS_WRITE.length);
  for (const name of REMOTE_TOOLS_READ) {
    assert.equal(OPERATION_CAPABILITY[name], CAPABILITIES.READ, name);
    assert.equal(isRemoteWriteTool(name), false, name);
  }
  for (const name of REMOTE_TOOLS_WRITE) {
    assert.ok(OPERATION_CAPABILITY[name] && OPERATION_CAPABILITY[name] !== CAPABILITIES.READ, name);
    assert.equal(isRemoteWriteTool(name), true, name);
  }
  for (const name of NOT_REMOTE) assert.equal(REMOTE_TOOLS.includes(name), false, name);
  assert.deepEqual(registryProblems(await collectToolDefinitions()), []);
  // The self-check catches a missing tool, a missing hint and a misfiled tool.
  const defs = await collectToolDefinitions();
  defs.delete('task_status');
  defs.set('job_status', { ...defs.get('job_status'), annotations: { readOnlyHint: true } });
  defs.set('tasks_list', { ...defs.get('tasks_list'), annotations: { ...defs.get('tasks_list').annotations, readOnlyHint: false } });
  const problems = registryProblems(defs);
  assert.ok(problems.includes('task_status: not collected'), problems.join('\n'));
  assert.ok(problems.includes('job_status: destructiveHint not explicit'), problems.join('\n'));
  assert.ok(problems.includes('tasks_list: readOnlyHint disagrees with policy'), problems.join('\n'));
});

test('toolsFor: gate layer 1 lists writes only with remote_writes "enabled", and only those authorized', () => {
  assert.deepEqual(toolsFor(READ_ONLY), [...REMOTE_TOOLS_READ].sort());
  assert.deepEqual(toolsFor(EVERYTHING), [...REMOTE_TOOLS_READ].sort(), 'gate closed by default, whatever the principal holds');
  assert.deepEqual(toolsFor(EVERYTHING, { remoteWrites: false }), [...REMOTE_TOOLS_READ].sort());
  assert.deepEqual(toolsFor(EVERYTHING, { remoteWrites: 'enabled' }), [...REMOTE_TOOLS_READ].sort(), 'only the boolean opens it');
  assert.deepEqual(toolsFor(EVERYTHING, { remoteWrites: true }), [...REMOTE_TOOLS].sort());
  assert.deepEqual(toolsFor(READ_ONLY, { remoteWrites: true }), [...REMOTE_TOOLS_READ].sort());
  const claimer = makePrincipal('oidc:claimer', [CAPABILITIES.READ, CAPABILITIES.WRITE]);
  assert.deepEqual(toolsFor(claimer, { remoteWrites: true }),
    [...REMOTE_TOOLS_READ, 'workspace_open', 'workspace_close', 'task_claim', 'task_renew', 'task_release', 'task_complete', 'task_checkpoint',
      'task_next', 'memory_save', 'source_reconcile', 'workspace_delegate', 'delegation_join', 'delegation_report', 'delegation_end'].sort());
  assert.deepEqual(toolsFor(makePrincipal('oidc:none', [])), []);
  assert.deepEqual(toolsFor(null), []);
  for (const value of [undefined, null, {}, { remote_writes: 'disabled' }, { remote_writes: 'yes' }, { remote_writes: true }]) {
    assert.equal(remoteWritesEnabled(value), false, JSON.stringify(value));
  }
  assert.equal(remoteWritesEnabled({ remote_writes: 'enabled' }), true);
});

// The legacy stateless leg answers with one SSE message (or plain JSON): the JSON-RPC body.
const jsonRpcBody = text => JSON.parse(/^(event|data):/m.test(text)
  ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('') : text);

// tools/list as a JSON-RPC client sees it, from the remote factory with every tool open.
async function remoteList() {
  const factory = createRemoteServerFactory({ dispatch: async () => ({ ok: true }),
    config: { owner_sub: 'owner', allowed_client_ids: ['https://chatgpt.com/c.json'], remote_writes: 'enabled' } });
  const handler = createMcpHandler(factory, { legacy: 'stateless' });
  const authInfo = { token: 't', clientId: 'https://chatgpt.com/c.json', scopes: ALL, extra: { sub: 'owner' } };
  const response = await handler.fetch(new Request('http://localhost/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }), { authInfo });
  assert.equal(response.status, 200);
  return jsonRpcBody(await response.text()).result.tools;
}

// JSON with object keys sorted at every level: equal strings mean equal documents.
const canonical = value => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));

test('AC-P5-06: every remote tool is identical to the stdio server\'s (name, description, canonical schema, annotations)', async t => {
  const home = await mkdtemp(join(tmpdir(), 'memo-registry-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const client = new Client({ name: 'registry-parity', version: '1.0.0' });
  const env = { PATH: process.env.PATH, HOME: home, MEMO_BRIDGE_STATE_DIR: join(home, 'state'), MEMO_BRIDGE_PROJECTS_ROOT: home };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'server', 'index.mjs')], env, stderr: 'ignore' }));
  t.after(() => client.close());
  const stdio = new Map((await client.listTools()).tools.map(tool => [tool.name, tool]));
  const remote = await remoteList();
  assert.deepEqual(remote.map(tool => tool.name).sort(), [...REMOTE_TOOLS].sort());
  for (const tool of remote) {
    const local = stdio.get(tool.name);
    assert.ok(local, `${tool.name} is served by stdio`);
    // Same JSON Schema; the two SDK serving paths may emit the keys in another order.
    assert.equal(canonical(tool.inputSchema), canonical(local.inputSchema), `${tool.name} schema`);
    assert.equal(tool.description, local.description, `${tool.name} description`);
    assert.deepEqual(tool.annotations, local.annotations, `${tool.name} annotations`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations?.[hint], 'boolean', `${tool.name} ${hint} explicit`);
    }
  }
});
