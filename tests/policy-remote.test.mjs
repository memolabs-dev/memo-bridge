// Phase 5, TODO-P5-05 (AC-P5-07 policy layers, AC-P5-08): remote principals oidc:<sub>, their
// capabilities (scopes, ceiling, write gate), the server-derived client_type, the runtime grants
// for oidc ids, and workspace_open's server-side client_type and host on the runtime.
// Private temporary state and a stub ledger only; nothing touches the user's state or GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from '../server/runtime.mjs';
import {
  CAPABILITIES, CLIENT_TYPES, WRITE_CAPABILITIES, isPrincipal, isRemotePrincipal, makePrincipal, parseHubGrants, principalFromHub,
  remotePrincipal
} from '../server/coordinator/policy.mjs';
import { CLIENT_TYPES as COORDINATOR_CLIENT_TYPES } from '../server/coordinator/index.mjs';
import { registerCoordinatorTools } from '../server/tools/coordinator-tools.mjs';
import { stubLedger, stubProjects, tempDir, tempStateDir, PROJECT_ORIGINS } from './helpers/coordinator-fixture.mjs';

const ALL = Object.values(CAPABILITIES);
const SUB = '7f0c2a51-3b8e-4d7a-9c11-2f4e5a6b7c8d';
const CHATGPT = 'https://chatgpt.com/connector/oauth/client.json';
const remote = (overrides = {}) => ({ ownerSub: SUB, clientTypes: new Map([[CHATGPT, 'chatgpt']]),
  ceiling: ALL, remoteWrites: false, ...overrides });
const claims = (overrides = {}) => ({ sub: SUB, client_id: CHATGPT, scopes: ['coordinator:read'], ...overrides });
const caps = p => [...p.capabilities].sort();

test('makePrincipal: server attributes client_type and via, validated and frozen', () => {
  const p = makePrincipal('oidc:abc', [CAPABILITIES.READ], { client_type: 'chatgpt', via: 'hub' });
  assert.equal(p.client_type, 'chatgpt');
  assert.equal(p.via, 'hub');
  assert.throws(() => { p.client_type = 'codex'; }, TypeError);
  const plain = makePrincipal('local:me', []);
  assert.deepEqual(Object.keys(plain).sort(), ['capabilities', 'id'], 'no attribute keys unless given');
  assert.throws(() => makePrincipal('oidc:abc', [], { client_type: 'root' }), /invalid_principal/);
  assert.throws(() => makePrincipal('oidc:abc', [], { via: 'internet' }), /invalid_principal/);
  assert.equal(COORDINATOR_CLIENT_TYPES, CLIENT_TYPES, 'one list, re-exported by the coordinator');
});

test('remotePrincipal: the owner through an allowed client with the baseline scope', () => {
  const out = remotePrincipal(claims(), remote());
  assert.equal(out.ok, true);
  assert.ok(isPrincipal(out.principal));
  assert.equal(out.principal.id, `oidc:${SUB}`);
  assert.equal(out.principal.client_type, 'chatgpt');
  assert.equal(out.principal.via, 'hub');
  assert.deepEqual(caps(out.principal), [CAPABILITIES.READ]);
  assert.ok(isRemotePrincipal(out.principal));
  assert.equal(isRemotePrincipal(makePrincipal('hub:owner', ALL)), false);
  assert.equal(isRemotePrincipal({ id: 'oidc:x' }) && isPrincipal({ id: 'oidc:x' }), false, 'a look-alike is never a principal');
});

test('remotePrincipal: identity, client and scope refusals', () => {
  const cases = [
    [claims({ sub: 'someone-else' }), 'not_owner'],
    [claims({ client_id: 'https://evil.example/client.json' }), 'client_not_allowed'],
    [claims({ scopes: ['coordinator:write', 'repo:write'] }), 'insufficient_scope'],
    [claims({ scopes: [] }), 'insufficient_scope'],
    [claims({ sub: undefined }), 'invalid_token'],
    [claims({ sub: 'a b' }), 'invalid_token'],
    [claims({ sub: 'x'.repeat(121) }), 'invalid_token'],
    [claims({ client_id: '' }), 'invalid_token'],
    [claims({ client_id: undefined }), 'invalid_token'],
    [claims({ scopes: 'coordinator:read' }), 'invalid_token'],
    [claims({ scopes: [42] }), 'invalid_token'],
    [claims({ scopes: new Array(33).fill('coordinator:read') }), 'invalid_token'],
    [undefined, 'invalid_token']
  ];
  for (const [c, error] of cases) assert.deepEqual(remotePrincipal(c, remote()), { ok: false, error }, JSON.stringify(c));
  // A client id that only looks like a listed one, or that names an inherited property.
  for (const client_id of [CHATGPT + '/', CHATGPT.toUpperCase(), 'constructor', '__proto__']) {
    assert.deepEqual(remotePrincipal(claims({ client_id }), remote()), { ok: false, error: 'client_not_allowed' }, client_id);
  }
  for (const bad of [null, {}, remote({ ownerSub: '' }), remote({ clientTypes: { [CHATGPT]: 'chatgpt' } }), remote({ ceiling: 'all' }),
    remote({ remoteWrites: 'enabled' })]) {
    assert.deepEqual(remotePrincipal(claims(), bad), { ok: false, error: 'remote_misconfigured' });
  }
  assert.deepEqual(remotePrincipal(claims(), remote({ clientTypes: new Map([[CHATGPT, 'root']]) })), { ok: false, error: 'remote_misconfigured' });
});

test('remotePrincipal: capabilities = scopes, within the ceiling, minus writes while the gate is closed', () => {
  const everything = claims({ scopes: [...ALL, 'offline_access', 'made:up'] });
  // Gate closed: no write capability, whatever the token and the ceiling hold (gate layer 2).
  assert.deepEqual(caps(remotePrincipal(everything, remote()).principal), [CAPABILITIES.AUDIT, CAPABILITIES.READ].sort());
  for (const c of WRITE_CAPABILITIES) assert.equal(remotePrincipal(everything, remote()).principal.capabilities.has(c), false, c);
  // Gate open: the token's write scopes within the ceiling.
  assert.deepEqual(caps(remotePrincipal(everything, remote({ remoteWrites: true })).principal), [...ALL].sort());
  // The ceiling bounds even an open gate; unknown scopes never become capabilities.
  const narrow = remotePrincipal(everything, remote({ remoteWrites: true, ceiling: [CAPABILITIES.READ, CAPABILITIES.WRITE] }));
  assert.deepEqual(caps(narrow.principal), [CAPABILITIES.READ, CAPABILITIES.WRITE].sort());
  // Scopes the token lacks are never added by the ceiling.
  assert.deepEqual(caps(remotePrincipal(claims(), remote({ remoteWrites: true })).principal), [CAPABILITIES.READ]);
  // The ceiling may even remove the baseline: the principal then holds nothing.
  assert.deepEqual(caps(remotePrincipal(claims(), remote({ ceiling: [] })).principal), []);
});

test('principalFromHub and grants accept oidc ids, only when granted', () => {
  const grants = parseHubGrants(JSON.stringify({ [`oidc:${SUB}`]: 'read', 'hub:owner': 'owner' }));
  const p = principalFromHub(`oidc:${SUB}`, grants);
  assert.ok(isPrincipal(p));
  assert.deepEqual(caps(p), [CAPABILITIES.READ]);
  assert.equal(p.via, 'hub');
  assert.equal(principalFromHub(`oidc:${SUB}`), null, 'not in the default grants');
  assert.equal(principalFromHub('oidc:other', grants), null);
  // The claim narrows, never widens; client_type is a label from a fixed list.
  const forged = principalFromHub({ id: `oidc:${SUB}`, capabilities: ALL, client_type: 'chatgpt' }, grants);
  assert.deepEqual(caps(forged), [CAPABILITIES.READ]);
  assert.equal(forged.client_type, 'chatgpt');
  assert.equal(principalFromHub({ id: `oidc:${SUB}`, client_type: 'root' }, grants), null);
  assert.equal(principalFromHub({ id: `oidc:${SUB}`, client_type: 42 }, grants), null);
  assert.equal(principalFromHub({ id: `oidc:${SUB}`, role: 'owner' }, grants), null);
  for (const bad of ['oidc:', 'oidc:a b', `oidc:${'a'.repeat(121)}`, 'oidc:a/b', 'OIDC:abc', 'oidc:abc\n']) {
    assert.throws(() => parseHubGrants({ [bad]: 'read' }), /invalid_hub_grants/, bad);
    assert.equal(principalFromHub(bad, { [bad]: 'read' }), null, bad);
  }
  // Phase 4 behaviour unchanged.
  assert.deepEqual(caps(principalFromHub('hub:owner')), [...ALL].sort());
});

// The runtime as the VPS runner would build it, with oidc grants from MEMO_BRIDGE_HUB_PRINCIPALS.
function runtimeFor(t, stateDir, env) {
  const rt = createRuntime({ stateDir, principal: makePrincipal('local:owner', ALL), ledger: stubLedger(), host: 'vps', env,
    resolveProject: stubProjects(), projectRemote: project => Promise.resolve(PROJECT_ORIGINS[project.name] ?? null) });
  t.after(() => rt.close());
  return rt;
}
function coordinatorCall(view) {
  const tools = {};
  registerCoordinatorTools({ registerTool(name, def, handler) { tools[name] = { def, handler }; } }, () => view);
  return async (name, args = {}) => JSON.parse((await tools[name].handler(tools[name].def.inputSchema.parse(args))).content[0].text);
}
const events = rt => rt.store().transaction(repo => repo.listEvents({ limit: 100 }), { write: false });

test('runtime: oidc grants from the environment, read by default only when listed', async t => {
  const config = await policyPath(t, { projects: ['drop'] });
  const reader = runtimeFor(t, await tempStateDir(t), { MEMO_BRIDGE_HUB_PRINCIPALS: JSON.stringify({ [`oidc:${SUB}`]: 'read' }),
    MEMO_BRIDGE_REMOTE_CONFIG: config });
  assert.deepEqual(caps(reader.principalFromHub({ id: `oidc:${SUB}` })), [CAPABILITIES.READ]);
  const defaults = runtimeFor(t, await tempStateDir(t), { MEMO_BRIDGE_REMOTE_CONFIG: config });
  assert.equal(defaults.principalFromHub({ id: `oidc:${SUB}` }), null, 'the runtime default grants no oidc principal');
  const noFile = runtimeFor(t, await tempStateDir(t), { MEMO_BRIDGE_HUB_PRINCIPALS: JSON.stringify({ [`oidc:${SUB}`]: 'owner' }) });
  assert.equal(noFile.principalFromHub({ id: `oidc:${SUB}` }), null, 'no remote principal at all without a readable remote.json');
  // Gate layer 3: a read grant refuses a forged write, and journals it.
  const view = reader.as(reader.principalFromHub({ id: `oidc:${SUB}` }));
  const out = await coordinatorCall(view)('workspace_open', { project: 'drop' });
  assert.deepEqual({ ok: out.ok, error: out.error }, { ok: false, error: 'forbidden' });
  assert.ok((await events(reader)).some(e => e.principal === `oidc:${SUB}` && e.op === 'workspace_open' && e.outcome === 'denied'));
});

// The runtime's remote policy (bridge/write-gate.mjs) allowlists the projects a remote principal
// may open; it is read from MEMO_BRIDGE_REMOTE_CONFIG (cached per path, so a fresh path per test).
async function policyPath(t, policy) {
  const file = join(await tempDir(t, 'memo-remote-policy-'), 'remote.json');
  await writeFile(file, JSON.stringify(policy));
  return file;
}

test('AC-P5-08: workspace_open stores the server client_type, defaults a remote principal to vps and refuses mac', async t => {
  const config = await policyPath(t, { projects: ['drop'], remote_writes: 'enabled' });
  const rt = runtimeFor(t, await tempStateDir(t), { MEMO_BRIDGE_HUB_PRINCIPALS: JSON.stringify({ [`oidc:${SUB}`]: 'owner' }),
    MEMO_BRIDGE_REMOTE_CONFIG: config });
  const chat = coordinatorCall(rt.as(principalFromHub({ id: `oidc:${SUB}`, client_type: 'chatgpt' }, { [`oidc:${SUB}`]: 'owner' })));
  const refused = await chat('workspace_open', { project: 'drop', client_type: 'codex', host: 'mac' });
  assert.deepEqual(refused, { ok: false, error: 'host_not_remote_enabled' });
  const opened = await chat('workspace_open', { project: 'drop', client_type: 'codex' });
  assert.equal(opened.ok, true);
  assert.equal(opened.workspace.client_type, 'chatgpt', 'the argument never overrides the server-derived client');
  assert.equal(opened.workspace.host, 'vps');
  assert.equal((await chat('workspace_open', { project: 'drop', host: 'vps' })).workspace.host, 'vps');
  const journal = await events(rt);
  assert.ok(journal.some(e => e.op === 'workspace_open' && e.outcome === 'denied' && e.code === 'host_not_remote_enabled'),
    JSON.stringify(journal));

  // Without a server-derived client (the v2 wire carries {id} only), the argument the hub set is kept.
  const wire = coordinatorCall(rt.as(rt.principalFromHub({ id: `oidc:${SUB}` })));
  assert.equal((await wire('workspace_open', { project: 'drop', client_type: 'chatgpt' })).workspace.client_type, 'chatgpt');
  assert.equal((await wire('workspace_open', { project: 'drop', host: 'mac' })).error, 'host_not_remote_enabled');

  // Phase 4 hub principals and local principals keep their behaviour: argument client_type, any host.
  const hubOwner = coordinatorCall(rt.as(principalFromHub('hub:owner')));
  const mac = await hubOwner('workspace_open', { project: 'drop', client_type: 'claude-code', host: 'mac' });
  assert.deepEqual([mac.ok, mac.workspace.client_type, mac.workspace.host], [true, 'claude-code', 'mac']);
  const local = coordinatorCall(rt);
  const own = await local('workspace_open', { project: 'drop' });
  assert.deepEqual([own.workspace.client_type, own.workspace.host], ['other', 'vps']);
});

// Write gate layer 3 (D7) on the runtime: the oidc grant and the write gate come from the same
// remote.json the hub reads. No MEMO_BRIDGE_HUB_PRINCIPALS entry is needed for the owner.
test('runtime: remote.json grants the owner read, or owner once remote_writes is enabled, and strips writes otherwise', async t => {
  const closed = runtimeFor(t, await tempStateDir(t), { MEMO_BRIDGE_REMOTE_CONFIG: await policyPath(t,
    { projects: ['drop'], oidc: { owner_sub: SUB }, remote_writes: 'disabled' }) });
  const reader = closed.principalFromHub({ id: `oidc:${SUB}`, client_type: 'chatgpt' });
  assert.deepEqual([caps(reader), reader.client_type, reader.via], [[CAPABILITIES.READ], 'chatgpt', 'hub']);
  assert.equal(closed.principalFromHub({ id: 'oidc:someone-else' }), null, 'only the owner sub of remote.json');
  const forced = runtimeFor(t, await tempStateDir(t), { MEMO_BRIDGE_REMOTE_CONFIG: await policyPath(t,
    { projects: ['drop'], remote_writes: 'disabled' }), MEMO_BRIDGE_HUB_PRINCIPALS: JSON.stringify({ [`oidc:${SUB}`]: 'owner' }) });
  assert.deepEqual(caps(forced.principalFromHub({ id: `oidc:${SUB}` })), [CAPABILITIES.AUDIT, CAPABILITIES.READ].sort(),
    'an env owner grant still loses every write capability while the gate is closed');
  const open = runtimeFor(t, await tempStateDir(t), { MEMO_BRIDGE_REMOTE_CONFIG: await policyPath(t,
    { projects: ['drop'], oidc: { owner_sub: SUB }, remote_writes: 'enabled' }) });
  assert.deepEqual(caps(open.principalFromHub({ id: `oidc:${SUB}` })), [...ALL].sort());
  // Phase 4 hub principals are not touched by the remote policy.
  assert.deepEqual(caps(closed.principalFromHub({ id: 'hub:owner' })), [CAPABILITIES.READ]);
});
