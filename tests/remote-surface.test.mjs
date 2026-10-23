// Phase 5, TODO-P5-04 and TODO-P5-05 (AC-P5-06, AC-P5-07 hub and runtime layers, AC-P5-08 hub
// side): the remote MCP surface built per request by createRemoteServerFactory, served through
// the SDK's createMcpHandler exactly as the public listener serves it, and forwarding over the
// real Phase 4 hub to a real agent and runtime. Loopback TLS, temporary state, stub ledger;
// nothing reaches the network, GitHub or the user's state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { RemoteAccessError, createRemoteServerFactory, parseRemoteConfig, remotePrincipalFor, remoteToolNames } from '../bridge/remote-surface.mjs';
import { REMOTE_OPERATOR_TOOLS, REMOTE_TOOLS, REMOTE_TOOLS_READ, REMOTE_TOOLS_WRITE } from '../server/registry.mjs';
import { CAPABILITIES, REMOTE_DEFAULT_CEILING, isPrincipal, makePrincipal, operatorTier } from '../server/coordinator/policy.mjs';
import { createHub } from '../bridge/hub.mjs';
import { createAgent, createRuntimeOperations, probeOperations } from '../bridge/agent.mjs';
import { generateAgentIdentity } from '../bridge/crypto.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { stubLedger, stubProjects, tempDir, tempStateDir, PROJECT_ORIGINS } from './helpers/coordinator-fixture.mjs';

const ALL = Object.values(CAPABILITIES);
const SUB = '4b9f6c3e-1a2d-4e5f-8a7b-9c0d1e2f3a4b';
const CHATGPT = 'https://chatgpt.com/connector/oauth/abc/client.json';
const CONFIG = { owner_sub: SUB, allowed_client_ids: [CHATGPT], surface: 'full' };
const auth = (overrides = {}) => ({ token: 'not-a-real-token', clientId: CHATGPT, scopes: ['coordinator:read'], extra: { sub: SUB },
  ...overrides });

const jsonRpcBody = text => JSON.parse(/^(event|data):/m.test(text)
  ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('') : text);

// A remote surface as the public listener serves it: createMcpHandler(factory), fetch(req, {authInfo}).
function surface({ config = CONFIG, authInfo = auth(), dispatch, audit } = {}) {
  const calls = [];
  const events = [];
  const send = dispatch ?? (async (host, op, o) => { calls.push({ host, op, args: o.args, principal: o.principal, clientId: o.clientId,
    hasCtx: Boolean(o.ctx) }); return { ok: true, op }; });
  const factory = createRemoteServerFactory({ config, dispatch: send, audit: audit ?? (e => events.push(e)) });
  const handler = createMcpHandler(factory, { legacy: 'stateless' });
  let id = 0;
  const rpc = async (method, params = {}) => {
    const response = await handler.fetch(new Request('http://localhost/mcp', { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }), { authInfo });
    return { status: response.status, body: response.status === 200 ? jsonRpcBody(await response.text()) : null };
  };
  return {
    calls, events, factory,
    async list() { return (await rpc('tools/list')).body.result.tools.map(t => t.name).sort(); },
    async call(name, args = {}) {
      const out = await rpc('tools/call', { name, arguments: args });
      const result = out.body?.result;
      const text = result?.content?.[0]?.text;
      return { ...out, isError: result?.isError === true, error: out.body?.error ?? null, text,
        data: text && result?.isError !== true ? JSON.parse(text) : null };
    }
  };
}

test('remote config: required keys, strict known keys, unknown keys ignored', () => {
  const cfg = parseRemoteConfig({ ...CONFIG, issuer: 'https://auth.example', session_binding: 'warn', projects: ['drop'] });
  assert.equal(cfg.ownerSub, SUB);
  assert.equal(cfg.clientTypes.get(CHATGPT), 'chatgpt');
  assert.equal(cfg.remoteWrites, false, 'writes disabled by default');
  assert.deepEqual([...cfg.ceiling].sort(), [...REMOTE_DEFAULT_CEILING].sort(), 'default ceiling: all but operator:*, as the verifier');
  assert.deepEqual([cfg.budgetBytes, cfg.listLimit, cfg.readPageBytes, cfg.jobTailLines, cfg.writeContentBytes, cfg.runtimeHost],
    [24 * 1024, 50, 16 * 1024, 200, 96 * 1024, 'vps']);
  assert.equal(parseRemoteConfig({ ...CONFIG, allowed_client_ids: { [CHATGPT]: 'chatgpt', 'pid-client': 'other' } }).clientTypes.get('pid-client'), 'other');
  assert.equal(parseRemoteConfig({ ...CONFIG, remote_writes: 'enabled' }).remoteWrites, true);
  const bad = [
    null, [], {}, { ...CONFIG, owner_sub: '' }, { ...CONFIG, owner_sub: 'a b' }, { ...CONFIG, allowed_client_ids: [] },
    { ...CONFIG, allowed_client_ids: 'https://chatgpt.com' }, { ...CONFIG, allowed_client_ids: [''] },
    { ...CONFIG, allowed_client_ids: { [CHATGPT]: 'root' } }, { ...CONFIG, allowed_client_ids: new Array(17).fill(0).map((_, i) => `c${i}`) },
    { ...CONFIG, ceiling: ['root'] }, { ...CONFIG, ceiling: 'coordinator:read' }, { ...CONFIG, remote_writes: 'yes' },
    { ...CONFIG, remote_writes: true }, { ...CONFIG, result_budget_bytes: 10 }, { ...CONFIG, result_budget_bytes: 2 * 1024 * 1024 },
    { ...CONFIG, list_limit: 0 }, { ...CONFIG, read_page_bytes: 1.5 }, { ...CONFIG, write_content_bytes: 600 * 1024 }
  ];
  for (const value of bad) assert.throws(() => parseRemoteConfig(value), /invalid_remote_config/, JSON.stringify(value));
  assert.throws(() => createRemoteServerFactory({ config: { ...CONFIG, remote_writes: 'on' }, dispatch: async () => ({}) }), /invalid_remote_config/);
  assert.throws(() => createRemoteServerFactory({ config: CONFIG }), /dispatch required/);
});

test('AC-P5-06/07: a read principal lists the read set; writes stay unlisted while the gate is closed', async () => {
  assert.deepEqual(await surface().list(), [...REMOTE_TOOLS_READ].sort());
  // Every write scope in the token and an all-capability ceiling: still no write tool (layers 1 and 2).
  const writes = surface({ authInfo: auth({ scopes: ALL }) });
  assert.deepEqual(await writes.list(), [...REMOTE_TOOLS_READ].sort());
  for (const name of REMOTE_TOOLS_WRITE) assert.equal((await writes.list()).includes(name), false, name);
  // Opened in the configuration, the write tools appear for a principal holding the scopes...
  const open = surface({ config: { ...CONFIG, remote_writes: 'enabled' }, authInfo: auth({ scopes: ALL }) });
  assert.deepEqual(await open.list(), [...REMOTE_TOOLS].sort());
  // ...and only those its scopes and the ceiling allow.
  const claims = surface({ config: { ...CONFIG, remote_writes: 'enabled', ceiling: ['coordinator:read', 'coordinator:write'] },
    authInfo: auth({ scopes: ALL }) });
  const listed = await claims.list();
  assert.ok(listed.includes('task_claim') && !listed.includes('worktree_push') && !listed.includes('jobs_submit'));
  // A principal minted with every capability (not through the ceiling) also lists the T0 operator tools.
  // (T0 only: the operator write tiers follow the write gate, closed here.)
  assert.deepEqual(remoteToolNames(makePrincipal('oidc:x', ALL), CONFIG),
    [...REMOTE_TOOLS_READ, ...REMOTE_OPERATOR_TOOLS.filter(t => operatorTier(t) === 0)].sort());
  assert.deepEqual(remoteToolNames(makePrincipal('oidc:x', ALL), { ...CONFIG, remote_writes: 'enabled' }),
    [...REMOTE_TOOLS, ...REMOTE_OPERATOR_TOOLS].sort());
  assert.deepEqual(remoteToolNames(makePrincipal('oidc:x', REMOTE_DEFAULT_CEILING), CONFIG), [...REMOTE_TOOLS_READ].sort());
});

test('AC-P5-07: a forged write call with the gate closed never reaches the runtime', async () => {
  const s = surface({ authInfo: auth({ scopes: ALL }) });
  for (const name of ['task_claim', 'workspace_open', 'worktree_push', 'jobs_submit', 'github_create_pr', 'worktree_remove', 'observe_agents']) {
    const out = await s.call(name, { workspace_id: 'ws_aaaaaaaaaaaaaaaa', issue: 'memolabs-dev/drop#7' });
    assert.ok(out.isError || out.error, `${name} refused by the MCP layer: ${JSON.stringify(out.body)}`);
  }
  assert.deepEqual(s.calls, []);
});

test('a read call forwards to the VPS runtime as the minted remote principal, with compact JSON back', async () => {
  const s = surface({ dispatch: async (host, op, o) => {
    s.calls.push({ host, op, args: o.args, principal: o.principal, clientId: o.clientId, hasCtx: Boolean(o.ctx) });
    return { ok: true, nested: { a: [1, 2, { b: 'c' }] } };
  } });
  const out = await s.call('workspace_list', { status: 'active' });
  assert.deepEqual(out.data, { ok: true, nested: { a: [1, 2, { b: 'c' }] } });
  assert.equal(out.text, '{"ok":true,"nested":{"a":[1,2,{"b":"c"}]}}', 'compact JSON on the remote path');
  const [call] = s.calls;
  assert.equal(call.host, 'vps');
  assert.equal(call.op, 'workspace_list');
  assert.deepEqual(call.args, { status: 'active' });
  assert.ok(isPrincipal(call.principal));
  assert.equal(call.principal.id, `oidc:${SUB}`);
  assert.equal(call.principal.client_type, 'chatgpt');
  assert.deepEqual([...call.principal.capabilities], [CAPABILITIES.READ]);
  assert.equal(call.clientId, CHATGPT);
  assert.equal(call.hasCtx, true, 'the MCP request context reaches the forwarder (session hash)');
});

test('AC-P5-08 (hub side): workspace_open gets the server client_type and host vps; a requested mac is kept as a label (repatriation D-R14)', async () => {
  const s = surface({ config: { ...CONFIG, remote_writes: 'enabled' }, authInfo: auth({ scopes: ALL }) });
  const mac = await s.call('workspace_open', { project: 'drop', client_type: 'codex', host: 'mac' });
  assert.deepEqual(s.calls[0].args, { project: 'drop', client_type: 'chatgpt', client_label: '(host mac)', host: 'vps' });
  assert.equal(mac.data.note.host_requested, 'mac');
  assert.match(mac.data.note.detail, /operator tools still act on the host you name/);
  assert.equal(JSON.stringify(s.events).includes('codex'), false, 'arguments never reach the audit');
  await s.call('workspace_open', { project: 'drop', client_type: 'codex', client_label: 'chat 1' });
  assert.deepEqual(s.calls[1].args, { project: 'drop', client_type: 'chatgpt', client_label: 'chat 1', host: 'vps' });
});

test('the factory refuses anyone but the owner through an allowed client, and never widens the verifier', async () => {
  const cfg = parseRemoteConfig(CONFIG);
  const cases = [
    [undefined, 'invalid_token'],
    [auth({ extra: { sub: 'intruder' } }), 'not_owner'],
    [auth({ clientId: 'https://chatgpt.com.evil.example/client.json' }), 'client_not_allowed'],
    [auth({ scopes: ['repo:write'] }), 'insufficient_scope'],
    [auth({ extra: { sub: SUB, principal: makePrincipal('oidc:someone-else', [CAPABILITIES.READ]) } }), 'principal_mismatch'],
    [auth({ extra: { sub: SUB, principal: { id: `oidc:${SUB}`, capabilities: new Set(ALL) } } }), 'principal_mismatch']
  ];
  const events = [];
  const factory = createRemoteServerFactory({ config: CONFIG, dispatch: async () => ({ ok: true }), audit: e => events.push(e) });
  for (const [authInfo, code] of cases) {
    assert.deepEqual(remotePrincipalFor(authInfo, cfg), { ok: false, error: code });
    await assert.rejects(factory({ authInfo }), err => err instanceof RemoteAccessError && err.code === code, code);
  }
  assert.equal(events.filter(e => e.event === 'remote_principal_refused').length, cases.length);
  // The verifier's principal can only narrow: it holds read, the token claims audit too.
  const narrowed = remotePrincipalFor(auth({ scopes: ['coordinator:read', 'coordinator:audit'],
    extra: { sub: SUB, principal: makePrincipal(`oidc:${SUB}`, [CAPABILITIES.READ]) } }), cfg);
  assert.deepEqual([...narrowed.principal.capabilities], [CAPABILITIES.READ]);
  assert.equal(narrowed.principal.client_type, 'chatgpt');
  // A bound authInfo serves when the request context carries none.
  const bound = createRemoteServerFactory({ authInfo: auth(), config: CONFIG, dispatch: async () => ({ ok: true }) });
  assert.ok(await bound({}));
});

test('dispatch failures become short codes', async () => {
  const thrown = surface({ dispatch: async () => { throw new Error('/secret/path exploded'); } });
  assert.deepEqual((await thrown.call('tasks_list', {})).data, { ok: false, error: 'internal_error' });
  const weird = surface({ dispatch: async () => ['not', 'an', 'object'] });
  assert.deepEqual((await weird.call('tasks_list', {})).data, { ok: false, error: 'invalid_agent_response' });
  const refusal = surface({ dispatch: async () => ({ ok: false, error: 'host_offline' }) });
  assert.deepEqual((await refusal.call('tasks_list', {})).data, { ok: false, error: 'host_offline' });
});

// ---------------------------------------------------------------------------------------------
// End to end over the Phase 4 hub: the remote surface's dispatch is hub.requestAgent, the agent
// runs createRuntimeOperations on a real runtime whose grants name the owner's oidc principal.
function tls(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memo-remote-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return { tlsKey: readFileSync(join(dir, 'k'), 'utf8'), tlsCert: readFileSync(join(dir, 'c'), 'utf8') };
}
async function until(fn, ms = 5000) {
  const expire = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > expire) throw new Error('wait expired'); await new Promise(r => setTimeout(r, 15)); }
}

test('end to end: remote surface -> hub v2 envelope -> agent -> runtime, re-authorized there (gate layer 3)', async t => {
  // A catalogue with two projects; the runtime's remote policy allowlists one of them.
  const root = await tempDir(t, 'memo-remote-e2e-');
  await mkdir(join(root, 'drop'));
  await mkdir(join(root, 'cuesheet'));
  await writeFile(join(root, 'PROJECTS.md'), ['# Test registry', '## Projets appartenant à Memo Labs',
    '| Name | Path | Kind | Status | Nature | Stack | Vault note |', '|---|---|---|---|---|---|---|',
    '| drop | drop | repo | active | app | Node.js | - |', '| cuesheet | cuesheet | repo | active | app | Node.js | - |', '## Autres'].join('\n'));
  const policyFile = join(root, 'remote.json');
  await writeFile(policyFile, JSON.stringify({ projects: ['drop'] }));
  const previous = process.env.MEMO_BRIDGE_REMOTE_CONFIG;
  process.env.MEMO_BRIDGE_REMOTE_CONFIG = policyFile;   // catalog-tools reads the process env
  t.after(() => { if (previous === undefined) delete process.env.MEMO_BRIDGE_REMOTE_CONFIG; else process.env.MEMO_BRIDGE_REMOTE_CONFIG = previous; });

  const runtime = createRuntime({ stateDir: await tempStateDir(t), principal: makePrincipal('local:owner', ALL), ledger: stubLedger(),
    host: 'vps', env: { MEMO_BRIDGE_HUB_PRINCIPALS: JSON.stringify({ [`oidc:${SUB}`]: 'read' }), MEMO_BRIDGE_REMOTE_CONFIG: policyFile },
    catalogOptions: { projectsRoot: root, layoutRoot: root }, resolveProject: stubProjects(),
    projectRemote: project => Promise.resolve(PROJECT_ORIGINS[project.name] ?? null) });
  t.after(() => runtime.close());
  const seen = [];
  const ops = await createRuntimeOperations({ runtimeFor: p => runtime.as(p),
    principalFromWire: wire => { seen.push(wire); return runtime.principalFromHub(wire); } });
  t.after(() => ops.close());

  const keys = { vps: generateAgentIdentity() };
  const { tlsKey, tlsCert } = tls(t);
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: createHash('sha256').update('x'.repeat(64)).digest('hex'),
    allowedAgentKeys: { vps: keys.vps.publicKey }, runtimeHost: 'vps', port: 0 });
  const { port } = await hub.start();
  t.after(() => hub.stop());
  const agent = createAgent({ host: 'vps', url: `wss://127.0.0.1:${port}/agent`, privateKey: keys.vps.privateKey, ca: tlsCert,
    reconnectMs: 100_000, operations: { ...probeOperations('vps'), ...ops.handlers } });
  t.after(() => agent.stop());
  await until(() => hub.agentInfo('vps')?.version === 2);
  assert.ok(hub.agentInfo('vps').ops.includes('projects_list'), 'FU-4: the agent serves projects_list and the hub forwards it');

  const s = surface({ dispatch: hub.requestAgent });
  const projects = await s.call('projects_list', {});
  assert.deepEqual(projects.data.projects.map(p => p.name), ['drop'], 'only the allowlisted project, for a remote principal');
  const listed = await s.call('workspace_list', {});
  assert.deepEqual([listed.data.ok, listed.data.count], [true, 0]);
  assert.ok(seen.every(w => JSON.stringify(Object.keys(w).sort()) === '["client_type","id"]' && w.id === `oidc:${SUB}` &&
    w.client_type === 'chatgpt'), 'the wire carries {id, client_type} only, never capabilities');

  // A forged write envelope straight to the runtime (whoever holds the hub's TLS key): refused
  // by the runtime's own grant and journaled there.
  const forged = await hub.requestAgent('vps', 'workspace_open', { args: { project: 'drop' }, principal: makePrincipal(`oidc:${SUB}`, ALL) });
  assert.deepEqual(forged, { ok: false, error: 'forbidden' });
  const journal = await runtime.store().transaction(repo => repo.listEvents({ limit: 50 }), { write: false });
  assert.ok(journal.some(e => e.principal === `oidc:${SUB}` && e.op === 'workspace_open' && e.outcome === 'denied'));
  // An oidc principal the runtime does not grant is unknown there, whatever the hub says.
  assert.deepEqual(await hub.requestAgent('vps', 'workspace_list', { args: {}, principal: makePrincipal('oidc:stranger', ALL) }),
    { ok: false, error: 'unknown_principal' });
});
