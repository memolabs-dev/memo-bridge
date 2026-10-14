// Phase 4, TODO-P4-06 (AC-P4-10, runtime side): principals forwarded by the hub, the runtime
// view runtime.as(principal), and the runtime's own re-authorization. A read-only principal is
// refused jobs_submit, job_cancel, task_claim and worktree_push by the runtime itself, whatever
// the hub claimed, and every refusal is journaled with the principal and the reason.
// Everything runs on a private temporary state directory with a stub ledger; nothing touches
// the user's state, the network or GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../server/runtime.mjs';
import {
  CAPABILITIES, DEFAULT_HUB_GRANTS, HUB_PRINCIPALS, HUB_ROLES, authorize, hubGrantsFromEnv, isPrincipal, makePrincipal,
  parseHubGrants, principalFromHub
} from '../server/coordinator/policy.mjs';
import { registerWorktreeTools } from '../server/tools/worktree-tools.mjs';
import { registerJobTools } from '../server/tools/job-tools.mjs';
import { registerCoordinatorTools } from '../server/tools/coordinator-tools.mjs';
import { stubLedger, stubProjects, tempStateDir, PROJECT_ORIGINS } from './helpers/coordinator-fixture.mjs';

const ALL = Object.values(CAPABILITIES).sort();
const LOCAL_OWNER = makePrincipal('local:owner', Object.values(CAPABILITIES));
const ISSUE = 'memolabs-dev/drop#7';

function runtimeFor(t, stateDir, options = {}) {
  const rt = createRuntime({ stateDir, principal: LOCAL_OWNER, ledger: stubLedger(), host: 'vps', env: {},
    resolveProject: stubProjects(), projectRemote: project => Promise.resolve(PROJECT_ORIGINS[project.name] ?? null),
    ...options });
  t.after(() => rt.close());
  return rt;
}

// Tool modules registered on a fake MCP server, with getRuntime returning `view`.
function toolsOn(view) {
  const tools = {};
  const server = { registerTool(name, def, handler) { tools[name] = { def, handler }; } };
  registerCoordinatorTools(server, () => view);
  registerWorktreeTools(server, () => view);
  registerJobTools(server, () => view);
  return async (name, args = {}) => JSON.parse((await tools[name].handler(tools[name].def.inputSchema.parse(args))).content[0].text);
}

const events = rt => rt.store().transaction(repo => repo.listEvents({ limit: 500 }), { write: false })
  .then(rows => rows.reverse().map(e => ({ principal: e.principal, op: e.op, outcome: e.outcome, code: e.code })));

test('makePrincipal: capabilities cannot be changed after minting, and look-alikes are not principals', () => {
  const p = makePrincipal('hub:owner', [CAPABILITIES.READ]);
  assert.ok(isPrincipal(p));
  assert.throws(() => p.capabilities.add(CAPABILITIES.EXECUTE), /principal_frozen/);
  assert.throws(() => p.capabilities.delete(CAPABILITIES.READ), /principal_frozen/);
  assert.throws(() => p.capabilities.clear(), /principal_frozen/);
  assert.throws(() => { p.id = 'hub:other'; }, TypeError);
  assert.deepEqual([...p.capabilities], [CAPABILITIES.READ]);
  // Same shape, not minted: a request body or a JSON round trip never becomes a principal.
  assert.equal(isPrincipal({ id: 'hub:owner', capabilities: new Set(ALL) }), false);
  assert.equal(isPrincipal(JSON.parse(JSON.stringify(p))), false);
  assert.throws(() => makePrincipal('owner', []), /invalid_principal/);
  assert.throws(() => makePrincipal(42, []), /invalid_principal/);
});

test('authorize: unknown and inherited operation names are refused', () => {
  for (const op of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nope', undefined, 42]) {
    assert.equal(authorize(LOCAL_OWNER, op), false, String(op));
  }
  assert.equal(authorize(LOCAL_OWNER, 'jobs_submit'), true);
});

test('principalFromHub: the runtime grant is the ceiling; hub claims can only narrow it', () => {
  assert.deepEqual(DEFAULT_HUB_GRANTS, { 'hub:owner': 'owner', 'hub:readonly': 'read' });
  const owner = principalFromHub(HUB_PRINCIPALS.OWNER);
  assert.ok(isPrincipal(owner));
  assert.equal(owner.id, 'hub:owner');
  assert.deepEqual([...owner.capabilities].sort(), ALL);
  assert.deepEqual([...principalFromHub({ id: 'hub:readonly' }).capabilities], [CAPABILITIES.READ]);
  // A claim narrows the owner...
  assert.deepEqual([...principalFromHub({ id: 'hub:owner', capabilities: [CAPABILITIES.READ, 'made:up'] }).capabilities],
    [CAPABILITIES.READ]);
  // ...but never widens the read-only principal (a forged or buggy hub).
  const forged = principalFromHub({ id: 'hub:readonly', capabilities: ALL });
  assert.deepEqual([...forged.capabilities], [CAPABILITIES.READ]);
  for (const op of ['jobs_submit', 'job_cancel', 'task_claim', 'worktree_push', 'workspace_open', 'github_create_pr']) {
    assert.equal(authorize(forged, op), false, op);
  }
  for (const op of ['job_status', 'job_events', 'job_results', 'jobs_list', 'task_status', 'workspace_list']) {
    assert.equal(authorize(forged, op), true, op);
  }
});

test('principalFromHub: every malformed or unknown claim is refused (null)', () => {
  const refused = [
    undefined, null, 42, true, [], ['hub:owner'], '', 'hub:', 'hub:Owner', 'local:owner', 'oidc:owner', 'hub:unknown',
    'hub:__proto__', 'hub:constructor', ' hub:owner', 'hub:owner\n', `hub:${'a'.repeat(65)}`,
    { id: 'hub:unknown' }, { id: 'local:owner' }, { id: 42 }, {}, { capabilities: [] },
    { id: 'hub:owner', role: 'owner' }, { id: 'hub:owner', capabilities: 'runner:execute' },
    { id: 'hub:owner', capabilities: [42] }, { id: 'hub:owner', capabilities: new Array(17).fill(CAPABILITIES.READ) },
    Object.assign(Object.create({ inherited: 1 }), { id: 'hub:owner' }), new Map([['id', 'hub:owner']])
  ];
  for (const claim of refused) assert.equal(principalFromHub(claim), null, JSON.stringify(claim) ?? String(claim));
  // An id is granted only by an own property of the grants map.
  assert.equal(principalFromHub('hub:owner', Object.create({ 'hub:owner': 'owner' })), null);
  assert.equal(principalFromHub('hub:owner', { 'hub:owner': 'root' }), null);
  assert.equal(principalFromHub('hub:owner', null), null);
});

test('hub grants: parsed strictly from MEMO_BRIDGE_HUB_PRINCIPALS, defaults otherwise', () => {
  assert.equal(hubGrantsFromEnv({}), DEFAULT_HUB_GRANTS);
  assert.deepEqual(hubGrantsFromEnv({ MEMO_BRIDGE_HUB_PRINCIPALS: '{"hub:ops":"read"}' }), { 'hub:ops': 'read' });
  for (const bad of ['not json', '[]', '"hub:owner"', '{"local:x":"owner"}', '{"hub:x":"admin"}', '{"hub:x":1}',
    JSON.stringify(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`hub:p${i}`, 'read'])))]) {
    assert.throws(() => hubGrantsFromEnv({ MEMO_BRIDGE_HUB_PRINCIPALS: bad }), /invalid_hub_grants/, bad);
  }
  assert.throws(() => parseHubGrants(null), /invalid_hub_grants/);
  assert.deepEqual(Object.keys(HUB_ROLES).sort(), ['owner', 'read']);
});

test('runtime.principalFromHub uses the runtime grants and fails closed on a bad configuration', async t => {
  const dir = await tempStateDir(t);
  const custom = runtimeFor(t, `${dir}-a`, { env: { MEMO_BRIDGE_HUB_PRINCIPALS: '{"hub:ci":"read"}' } });
  assert.equal(custom.principalFromHub('hub:owner'), null, 'not granted by this runtime');
  assert.deepEqual([...custom.principalFromHub('hub:ci').capabilities], [CAPABILITIES.READ]);
  const broken = runtimeFor(t, `${dir}-b`, { env: { MEMO_BRIDGE_HUB_PRINCIPALS: '{"hub:x":"superuser"}' } });
  assert.equal(broken.principalFromHub('hub:owner'), null);
  const explicit = runtimeFor(t, `${dir}-c`, { hubGrants: { 'hub:owner': 'read' } });
  assert.deepEqual([...explicit.principalFromHub('hub:owner').capabilities], [CAPABILITIES.READ]);
});

test('runtime.as: only minted principals, cached views, fixed identity, shared store', async t => {
  const rt = runtimeFor(t, await tempStateDir(t));
  for (const fake of [undefined, null, 'hub:owner', { id: 'hub:owner', capabilities: new Set(ALL) },
    JSON.parse(JSON.stringify(LOCAL_OWNER))]) {
    assert.throws(() => rt.as(fake), /invalid_principal/);
  }
  assert.equal(rt.as(LOCAL_OWNER), rt);
  const owner = rt.principalFromHub('hub:owner');
  const view = rt.as(owner);
  assert.equal(view.principal, owner);
  assert.equal(rt.as(rt.principalFromHub('hub:owner')), view, 'one view per principal');
  assert.equal(view.as(LOCAL_OWNER), rt, 'a view switches back only through minted principals');
  assert.throws(() => { view.principal = LOCAL_OWNER; }, TypeError);
  assert.throws(() => { rt.principal = owner; }, TypeError);
  assert.equal(rt.principal, LOCAL_OWNER);
  assert.equal(view.store(), rt.store(), 'same store');
  assert.equal(view.ledger, rt.ledger, 'same ledger');
  assert.equal(view.host, 'vps');
  assert.notEqual(view.coordinator(), rt.coordinator());
  assert.equal(view.coordinator().principal, 'hub:owner');
  await view.close();
  // Closing a view leaves the shared store open.
  await rt.store().transaction(repo => repo.listEvents({ limit: 1 }), { write: false });
});

test('AC-P4-10 runtime side: the read-only principal is refused mutating ops, each refusal journaled', async t => {
  const rt = runtimeFor(t, await tempStateDir(t));
  const ownerCall = toolsOn(rt.as(rt.principalFromHub('hub:owner')));
  // The hub-forwarded owner opens a workspace and claims an Issue.
  const opened = await ownerCall('workspace_open', { project: 'drop', client_type: 'claude-code', host: 'vps' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const ws = opened.workspace.workspace_id;
  assert.equal(opened.workspace.principal, 'hub:owner');
  const claimed = await ownerCall('task_claim', { workspace_id: ws, issue: ISSUE });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));

  // A request forwarded with the read-only identity, even one whose claim lists every
  // capability (the hub would refuse it first; the runtime refuses it again).
  const reader = rt.principalFromHub({ id: 'hub:readonly', capabilities: ALL });
  const readerCall = toolsOn(rt.as(reader));
  const refused = {
    jobs_submit: { workspace_id: ws, worktree_id: 'wt_AAAAAAAAAAAAAAAA', recipe: 'test' },
    job_cancel: { job_id: 'job_AAAAAAAAAAAAAAAA' },
    task_claim: { workspace_id: ws, issue: ISSUE },
    worktree_push: { worktree_id: 'wt_AAAAAAAAAAAAAAAA' },
    worktree_create: { workspace_id: ws, issue: ISSUE },
    workspace_open: { project: 'drop' },
    task_release: { workspace_id: ws, issue: ISSUE, claim_id: claimed.claim_id, fence: claimed.fence, outcome: 'cancelled' }
  };
  for (const [op, args] of Object.entries(refused)) {
    const out = await readerCall(op, args);
    assert.deepEqual({ ok: out.ok, error: out.error }, { ok: false, error: 'forbidden' }, op);
  }
  // Reads are allowed, but only over the reader's own workspaces: the owner's stay invisible.
  const listed = await readerCall('workspace_list', {});
  assert.equal(listed.ok, true);
  assert.equal(listed.workspaces.length, 0);
  assert.equal((await readerCall('workspace_status', { workspace_id: ws })).error, 'forbidden');
  assert.equal((await readerCall('jobs_list', { workspace_id: ws })).error, 'forbidden');

  const journal = await events(rt);
  for (const op of Object.keys(refused)) {
    assert.ok(journal.some(e => e.principal === 'hub:readonly' && e.op === op && e.outcome === 'denied' && e.code === 'forbidden'),
      `${op} refusal journaled with principal and reason`);
  }
  // The journal holds identifiers and codes only, never the arguments.
  const raw = JSON.stringify(await rt.store().transaction(repo => repo.listEvents({ limit: 500 }), { write: false }));
  assert.ok(!raw.includes('job_AAAAAAAAAAAAAAAA') && !raw.includes('wt_AAAAAAAAAAAAAAAA'));
  // The owner's claim is untouched by the refused release.
  assert.ok(journal.some(e => e.principal === 'hub:owner' && e.op === 'task_claim' && e.outcome === 'ok'));
  assert.ok(!journal.some(e => e.op === 'task_release' && e.outcome === 'ok'));
});

test('ownership follows the principal: neither hub principal nor the local owner acts on the other\'s workspace', async t => {
  const rt = runtimeFor(t, await tempStateDir(t));
  const hubOwner = toolsOn(rt.as(rt.principalFromHub('hub:owner')));
  const local = toolsOn(rt);
  const ws = (await local('workspace_open', { project: 'drop', host: 'vps' })).workspace.workspace_id;
  assert.equal((await hubOwner('workspace_status', { workspace_id: ws })).error, 'forbidden');
  assert.equal((await hubOwner('task_claim', { workspace_id: ws, issue: ISSUE })).error, 'forbidden');
  assert.equal((await hubOwner('workspace_close', { workspace_id: ws })).error, 'forbidden');
  assert.equal((await local('workspace_status', { workspace_id: ws })).ok, true);
});
