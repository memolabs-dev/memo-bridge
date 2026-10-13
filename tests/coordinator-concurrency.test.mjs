import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { coordinatorOn, fakeGitHub, journal, ledgerFor, skipWithoutLedger, tempStateDir } from './helpers/coordinator-fixture.mjs';

const WORKER = fileURLToPath(new URL('./helpers/claim-worker.mjs', import.meta.url));
const DROP = 'memolabs-dev/drop#7';

function startWorker(stateDir, githubState) {
  const child = fork(WORKER, [stateDir, githubState], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = []; const waiters = [];
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
async function startWorkers(stateDir, githubState, count) {
  const workers = Array.from({ length: count }, () => startWorker(stateDir, githubState));
  const ready = await Promise.all(workers.map(w => w.next('ready')));
  return { workers, ready };
}
async function stopWorkers(workers) {
  await Promise.all(workers.map(w => new Promise(resolve => { w.child.once('exit', resolve); w.child.send({ type: 'exit' }); })));
}

test('eight sessions in eight processes race for one Issue: the ledger grants exactly one claim',
  { skip: skipWithoutLedger, timeout: 120000 }, async t => {
    const github = await fakeGitHub(t);
    const stateDir = await tempStateDir(t);
    const { workers } = await startWorkers(stateDir, github.file, 8);
    for (const w of workers) w.child.send({ type: 'claim', issue: DROP });
    const results = (await Promise.all(workers.map(w => w.next('claimed')))).map(m => m.claim);
    await stopWorkers(workers);
    const winners = results.filter(r => r.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.ok(results.filter(r => !r.ok).every(r => r.error === 'lease_held'),
      JSON.stringify(results.filter(r => !r.ok)));
    const { store, coordinator } = coordinatorOn(stateDir, { ledger: ledgerFor(github) });
    t.after(() => store.close());
    const status = await coordinator.taskStatus({ issue: DROP });
    assert.equal(status.lease.state, 'claimed');
    assert.equal(status.lease.fence_sha, winners[0].fence);
    assert.equal(status.lease.epoch, 1);
    const ok = (await journal(store, { issue: DROP })).filter(e => e.op === 'task_claim' && e.outcome === 'ok');
    assert.equal(ok.length, 1);
  });

test('sixteen sessions opening a brand-new store at once all get their own workspace',
  { skip: skipWithoutLedger, timeout: 120000 }, async t => {
    const github = await fakeGitHub(t);
    const stateDir = await tempStateDir(t);
    const { workers, ready } = await startWorkers(stateDir, github.file, 16);
    await stopWorkers(workers);
    assert.deepEqual(ready.map(r => r.workspace.ok), Array(16).fill(true));
    assert.equal(new Set(ready.map(r => r.workspace.workspace.workspace_id)).size, 16);
  });
