import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinatorOn, stubLedger, tempStateDir } from './helpers/coordinator-fixture.mjs';

const ISSUE = 'memolabs-dev/drop#7';
async function fixture(t, options = {}) {
  const dir = await tempStateDir(t);
  const ledger = stubLedger();
  let mutations = 0; let releases = 0;
  const release = ledger.release;
  ledger.release = (...args) => { releases++; return release(...args); };
  const claim = ledger.claim;
  ledger.claim = (...args) => { mutations++; return claim(...args); };
  const { store, coordinator } = coordinatorOn(dir, { ledger, tasks: options });
  t.after(() => store.close());
  const opened = await coordinator.workspaceOpen({ project: 'drop' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return { coordinator, workspace_id: opened.workspace.workspace_id, get mutations() { return mutations; }, get releases() { return releases; } };
}
test('guard denies missing or stale dependency evidence before touching the lease ledger', async t => {
  const x = await fixture(t, { dependencyProtection: true, dependencyCheck: async () =>
    ({ ok: true, eligible: false, reason: 'dependency_acceptance_missing' }) });
  const denied = await x.coordinator.taskClaim({ workspace_id: x.workspace_id, issue: ISSUE });
  assert.equal(denied.error, 'dependency_blocked');
  assert.equal(denied.detail, 'dependency_acceptance_missing');
  assert.equal(x.mutations, 0);
});
test('guarded claim succeeds with fresh server-side approval', async t => {
  let observed = null;
  const x = await fixture(t, { dependencyProtection: true, dependencyCheck: async ref => {
    observed = ref;
    return { ok: true, eligible: true };
  }});
  const result = await x.coordinator.taskClaim({ workspace_id: x.workspace_id, issue: ISSUE });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(observed, ISSUE);
  assert.equal(x.mutations, 1);
});
test('dependency source error fails closed before ledger claim', async t => {
  const x = await fixture(t, { dependencyProtection: true, dependencyCheck: async () => { throw Error('offline'); } });
  const r = await x.coordinator.taskClaim({ workspace_id: x.workspace_id, issue: ISSUE });
  assert.equal(r.error, 'dependency_blocked');
  assert.equal(x.mutations, 0);
});
test('default-off mode preserves existing manual claim behavior', async t => {
  const x = await fixture(t, { dependencyProtection: false, dependencyCheck: async () => { throw Error('not used'); } });
  const r = await x.coordinator.taskClaim({ workspace_id: x.workspace_id, issue: ISSUE });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(x.mutations, 1);
});
test('an advisory recommendation cannot bypass changed live dependency status', async t => {
  let accepted = true;
  const x = await fixture(t, { dependencyProtection: true, dependencyCheck: async () =>
    ({ ok: true, eligible: accepted, reason: accepted ? 'ready' : 'dependency_blocked' }) });
  accepted = false; // State changed since scheduling, before authoritative taskClaim.
  const r = await x.coordinator.taskClaim({ workspace_id: x.workspace_id, issue: ISSUE });
  assert.equal(r.error, 'dependency_blocked');
  assert.equal(x.mutations, 0);
});
test('dependency changes after ledger grant: lease is released and no local task is recorded', async t => {
  let observations = 0;
  const x = await fixture(t, { dependencyProtection: true, dependencyCheck: async () =>
    ({ ok: true, eligible: ++observations === 1, reason: 'dependency_changed' }) });
  const r = await x.coordinator.taskClaim({ workspace_id: x.workspace_id, issue: ISSUE });
  assert.equal(r.error, 'dependency_blocked');
  assert.equal(r.detail, 'dependency_changed');
  assert.equal(x.mutations, 1);
  assert.equal(x.releases, 1);
  const status = await x.coordinator.workspaceStatus({ workspace_id: x.workspace_id });
  assert.deepEqual(status.claims, []);
});
