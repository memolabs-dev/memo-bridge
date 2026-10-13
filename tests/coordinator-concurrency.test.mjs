import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { coordinatorOn, tempStateDir } from './helpers/coordinator-fixture.mjs';

const WORKER = fileURLToPath(new URL('./helpers/claim-worker.mjs', import.meta.url));

function startWorker(stateDir) {
  const child = fork(WORKER, [stateDir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = [];
  const waiters = [];
  child.on('message', m => {
    const i = waiters.findIndex(w => w.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else messages.push(m);
  });
  const next = type => new Promise((resolve, reject) => {
    const i = messages.findIndex(m => m.type === type);
    if (i >= 0) return resolve(messages.splice(i, 1)[0]);
    waiters.push({ type, resolve });
    child.once('exit', code => reject(new Error(`worker exited ${code}`)));
  });
  return { child, next };
}

async function startWorkers(stateDir, count) {
  // Create the schema once so workers race on claims, not on the first migration.
  const { store } = coordinatorOn(stateDir);
  await store.close();
  const workers = Array.from({ length: count }, () => startWorker(stateDir));
  const ready = await Promise.all(workers.map(w => w.next('ready')));
  return { workers, ready };
}

async function stopWorkers(workers) {
  await Promise.all(workers.map(w => new Promise(resolve => {
    w.child.once('exit', resolve);
    w.child.send({ type: 'exit' });
  })));
}

test('AC-01: eight processes race to claim one task and exactly one wins', { timeout: 30000 }, async t => {
  const stateDir = await tempStateDir(t);
  const { workers } = await startWorkers(stateDir, 8);
  const { store, coordinator } = coordinatorOn(stateDir);
  t.after(() => store.close());
  const created = await coordinator.taskCreate({ project: 'drop', title: 'P2P security review' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const taskId = created.task.task_id;

  for (const w of workers) w.child.send({ type: 'claim', task_id: taskId });
  const results = (await Promise.all(workers.map(w => w.next('claimed')))).map(m => m.claim);
  await stopWorkers(workers);

  const winners = results.filter(r => r.ok);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(winners[0].fencing_token, 1);
  assert.deepEqual([...new Set(results.filter(r => !r.ok).map(r => r.error))], ['lease_held']);
  const status = await coordinator.taskStatus({ task_id: taskId });
  assert.equal(status.task.status, 'claimed');
  assert.equal(status.task.lease.workspace_id, winners[0].workspace_id);
  const events = await coordinator.events({ task_id: taskId, limit: 200 });
  assert.equal(events.events.filter(e => e.op === 'task_claim' && e.outcome === 'ok').length, 1);
  assert.equal(events.events.filter(e => e.op === 'task_claim' && e.outcome === 'denied').length, 7);
});

test('AC-02: ten processes get ten isolated workspaces that cannot use each other\'s lease', { timeout: 30000 }, async t => {
  const stateDir = await tempStateDir(t);
  const { workers, ready } = await startWorkers(stateDir, 10);
  await stopWorkers(workers);
  const ids = ready.map(r => r.workspace.workspace.workspace_id);
  assert.equal(new Set(ids).size, 10);

  const { store, coordinator } = coordinatorOn(stateDir);
  t.after(() => store.close());
  const task = (await coordinator.taskCreate({ project: 'drop', title: 'UI pass' })).task.task_id;
  const claim = await coordinator.taskClaim({ workspace_id: ids[0], task_id: task });
  assert.equal(claim.ok, true);
  for (const other of ids.slice(1)) {
    for (const call of ['taskRenew', 'taskRelease', 'taskComplete']) {
      const r = await coordinator[call]({ workspace_id: other, task_id: task, fencing_token: claim.fencing_token });
      assert.deepEqual(r, { ok: false, error: 'stale_lease' }, `${call} from ${other}`);
    }
    const status = await coordinator.workspaceStatus({ workspace_id: other });
    assert.deepEqual(status.active_leases, []);
  }
  assert.equal((await coordinator.workspaceStatus({ workspace_id: ids[0] })).active_leases.length, 1);
});

