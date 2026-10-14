// Phase 5, TODO-P5-08 (AC-P5-09 first case, REQ-P5-09): the Coordinator limits a remote
// principal (oidc:) to the projects of the remote allowlist, whatever the arguments say. Work can
// always be given back (release, complete, close) after a project leaves the allowlist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { UNCONFIGURED_POLICY, parseRemotePolicy } from '../bridge/write-gate.mjs';
import { coordinatorOn, journal, stubLedger, tempStateDir } from './helpers/coordinator-fixture.mjs';

const ALL = Object.values(CAPABILITIES);
const CHAT = makePrincipal('oidc:owner-sub', ALL, { client_type: 'chatgpt', via: 'hub' });
const LOCAL = makePrincipal('local:owner', ALL);

function on(t, stateDir, { principal = CHAT, policy = parseRemotePolicy({ projects: ['drop'] }), tasks = {} } = {}) {
  const fx = coordinatorOn(stateDir, { principal, ledger: stubLedger(), tasks: { remotePolicy: policy, ...tasks } });
  t.after(() => fx.store.close());
  return fx;
}

test('workspace_open: a remote principal opens only allowlisted projects; a local principal is not limited', async t => {
  const stateDir = await tempStateDir(t);
  const { coordinator, store } = on(t, stateDir);
  assert.deepEqual(await coordinator.workspaceOpen({ project: 'cuesheet' }), { ok: false, error: 'project_not_allowed' });
  assert.equal((await coordinator.workspaceOpen({ project: 'drop' })).ok, true);
  assert.ok((await journal(store)).some(e => e.op === 'workspace_open' && e.outcome === 'denied' && e.code === 'project_not_allowed'));
  // No readable remote.json: nothing is allowed remotely.
  const unconfigured = on(t, stateDir, { policy: UNCONFIGURED_POLICY });
  assert.equal((await unconfigured.coordinator.workspaceOpen({ project: 'drop' })).error, 'project_not_allowed');
  const local = on(t, stateDir, { principal: LOCAL });
  assert.equal((await local.coordinator.workspaceOpen({ project: 'cuesheet' })).ok, true);
});

test('a workspace whose project left the allowlist can no longer claim or renew, but can still give work back', async t => {
  const stateDir = await tempStateDir(t);
  const before = on(t, stateDir);
  const ws = (await before.coordinator.workspaceOpen({ project: 'drop' })).workspace.workspace_id;
  const claim = await before.coordinator.taskClaim({ workspace_id: ws, issue: 'memolabs-dev/drop#7' });
  assert.equal(claim.ok, true);
  const after = on(t, stateDir, { policy: parseRemotePolicy({ projects: ['cuesheet'] }) });
  assert.equal((await after.coordinator.taskClaim({ workspace_id: ws, issue: 'memolabs-dev/drop#8' })).error, 'project_not_allowed');
  assert.equal((await after.coordinator.taskRenew({ workspace_id: ws, issue: 'memolabs-dev/drop#7', claim_id: claim.claim_id,
    fence: claim.fence })).error, 'project_not_allowed');
  assert.equal((await after.coordinator.taskRelease({ workspace_id: ws, issue: 'memolabs-dev/drop#7', claim_id: claim.claim_id,
    fence: claim.fence, outcome: 'cancelled' })).ok, true);
  assert.equal((await after.coordinator.workspaceClose({ workspace_id: ws })).ok, true);
});

test('task_claim remotely needs the Issue proven to belong to the project (known origin)', async t => {
  const { coordinator } = on(t, await tempStateDir(t), { policy: parseRemotePolicy({ projects: ['unknown-origin'] }) });
  const ws = (await coordinator.workspaceOpen({ project: 'unknown-origin' })).workspace.workspace_id;
  assert.equal((await coordinator.taskClaim({ workspace_id: ws, issue: 'memolabs-dev/drop#7' })).error, 'project_origin_unknown');
  const local = on(t, await tempStateDir(t), { principal: LOCAL });
  const localWs = (await local.coordinator.workspaceOpen({ project: 'unknown-origin' })).workspace.workspace_id;
  assert.equal((await local.coordinator.taskClaim({ workspace_id: localWs, issue: 'memolabs-dev/drop#7' })).ok, true, 'unchanged locally');
});

test('task_status and tasks_list: a remote principal sees only the allowlisted projects', async t => {
  const searched = [];
  const tasks = { searchIssues: async query => { searched.push(query); return { ok: true, total_count: 0, incomplete: false, items: [] }; } };
  const { coordinator } = on(t, await tempStateDir(t), { tasks });
  assert.equal((await coordinator.taskStatus({ issue: 'memolabs-dev/cuesheet#3' })).error, 'project_not_allowed');
  assert.equal((await coordinator.taskStatus({ issue: 'memolabs-dev/drop#7' })).ok, true);
  assert.equal((await coordinator.tasksList({ project: 'cuesheet' })).error, 'project_not_allowed');
  const listed = await coordinator.tasksList({});
  assert.deepEqual(listed.repositories, ['memolabs-dev/drop']);
  assert.ok(searched.every(q => !q.includes('cuesheet')), searched.join(' | '));
  const unconfigured = on(t, await tempStateDir(t), { policy: UNCONFIGURED_POLICY, tasks });
  assert.equal((await unconfigured.coordinator.tasksList({})).error, 'project_not_allowed');
  assert.equal((await unconfigured.coordinator.taskStatus({ issue: 'memolabs-dev/drop#7' })).error, 'project_not_allowed');
});
