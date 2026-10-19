// Invariant: a superseded holder (a zombie) can never write, and fences only move forward.
//   - A holds, B takes the Issue over, A wakes up: its commit, push, pull request and
//     task_complete all return stale_lease and nothing reaches origin or GitHub.
//   - Once a lease is renewed, the previous fence is refused by every operation, in every process.
//   - epoch only grows across holders; a renewal moves the fence but never the epoch.
//
// The four-writes case drives the same entry points as clock-skew.test.mjs (worktree and GitHub
// tools over a git project with a bare origin) on the in-memory ledger, whose clock the test
// owns: the zombie's Bridge clock stands still at the moment it fell asleep while the lease is
// reclaimed by another store. The real-ledger cases run issue_lease.py on the offline fake gh and
// wait for its real expiry (ttl 60 s is the ledger minimum); B's Bridge clock is +61 s ahead.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DEMO_ISSUE, coordinatorOn, demoGh, fakeGitHub, gitRuntime, isolateGit, ledgerFor, memoryLedger, skipWithoutLedger,
  tempStateDir } from './lib/fixture.mjs';
import { claimRows, raceClaims, startWorkers, stopWorkers } from './lib/race.mjs';

const T0 = Date.parse('2026-10-19T12:00:00Z');
const SECOND = 1000;
const REPO = 'memolabs-dev/drop';
const LATER = 61_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const refOf = n => ({ ref: `${REPO}#${n}`, repo: REPO, number: String(n) });
const stale = (r, label) => { assert.equal(r.ok, false, `${label}: ${JSON.stringify(r)}`); assert.equal(r.error, 'stale_lease', `${label}: ${JSON.stringify(r)}`); };

test('a zombie holder writes nothing after a reclaim', async t => {
  await isolateGit(t);
  const world = { t: T0 };
  const leases = new Map();
  const zombieClock = () => T0 + 10 * SECOND; // A fell asleep ten seconds into a 300 s lease
  const trueClock = () => world.t;
  const { gh, calls } = demoGh();
  const a = await gitRuntime(t, { ledger: memoryLedger(trueClock, leases), now: zombieClock, gh });
  const b = coordinatorOn(await tempStateDir(t), { now: trueClock, ledger: memoryLedger(trueClock, leases), repos: { demo: null } });
  t.after(() => b.store.close());

  const workspace_id = (await a.coordinator.workspaceOpen({ project: 'demo', client_type: 'cli' })).workspace.workspace_id;
  const claim = await a.coordinator.taskClaim({ workspace_id, issue: DEMO_ISSUE, ttl_seconds: 300 });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  const created = await a.call('worktree_create', { workspace_id, issue: DEMO_ISSUE });
  assert.equal(created.ok, true, JSON.stringify(created));
  const worktree_id = created.worktree.worktree_id;
  const branch = created.worktree.branch;
  // A works normally while it holds the lease: a first commit is pushed before it falls asleep.
  assert.equal((await a.call('worktree_write_file', { worktree_id, path: 'a.txt', content: 'first\n' })).ok, true);
  assert.equal((await a.call('worktree_commit', { worktree_id, message: 'feat: first' })).ok, true);
  const pushed = await a.call('worktree_push', { worktree_id });
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  const tipOnOrigin = () => execFileSync('git', ['-C', a.origin, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
  const pushedTip = tipOnOrigin();
  assert.equal((await a.call('worktree_write_file', { worktree_id, path: 'b.txt', content: 'zombie work\n' })).ok, true);

  // B takes the Issue over once expires_at + 60 s has passed on its clock.
  const wsB = (await b.coordinator.workspaceOpen({ project: 'demo', client_type: 'cli' })).workspace.workspace_id;
  world.t = Date.parse(claim.expires_at) + 60 * SECOND + 1;
  const takeover = await b.coordinator.taskClaim({ workspace_id: wsB, issue: DEMO_ISSUE, ttl_seconds: 300 });
  assert.equal(takeover.ok, true, JSON.stringify(takeover));
  assert.equal(takeover.epoch, 2);
  assert.notEqual(takeover.claim_id, claim.claim_id);

  // A wakes up still believing it holds the lease: every write is refused.
  stale(await a.call('worktree_commit', { worktree_id, message: 'feat: zombie' }), 'worktree_commit');
  stale(await a.call('worktree_push', { worktree_id }), 'worktree_push');
  stale(await a.call('github_create_pr', { workspace_id, worktree_id, title: 'Demo: zombie' }), 'github_create_pr');
  stale(await a.coordinator.taskComplete({ workspace_id, issue: DEMO_ISSUE, claim_id: claim.claim_id, fence: claim.fence }), 'task_complete');
  // The checkpoint and the renewal are writes too.
  stale(await a.coordinator.taskCheckpoint({ workspace_id, issue: DEMO_ISSUE, claim_id: claim.claim_id, fence: claim.fence, handoff: { goal: 'zombie' } }),
    'task_checkpoint');
  stale(await a.coordinator.taskRenew({ workspace_id, issue: DEMO_ISSUE, claim_id: claim.claim_id, fence: claim.fence, ttl_seconds: 300 }), 'task_renew');

  // Nothing more reached origin or GitHub, and B's lease is untouched.
  assert.equal(tipOnOrigin(), pushedTip, 'origin still has A\'s last write from before the takeover');
  assert.deepEqual(calls.filter(c => c.method !== 'GET'), [], 'no pull request was opened');
  const lease = leases.get(DEMO_ISSUE);
  assert.equal(lease.claim_id, takeover.claim_id);
  assert.equal(lease.epoch, 2);
  assert.equal((await b.coordinator.taskCheckpoint({ workspace_id: wsB, issue: DEMO_ISSUE, claim_id: takeover.claim_id, fence: takeover.fence,
    handoff: { goal: 'B writes' } })).ok, true, 'the new holder still writes');
});

test('a renewed fence is refused everywhere, and epoch and fence only move forward', { skip: skipWithoutLedger, timeout: 120000 }, async t => {
  const github = await fakeGitHub(t);
  const ledger = ledgerFor(github);
  const stateDir = await tempStateDir(t);
  const a = coordinatorOn(stateDir, { ledger });
  t.after(() => a.store.close());
  const issue = `${REPO}#7`;
  const wsA = (await a.coordinator.workspaceOpen({ project: 'drop', client_type: 'cli' })).workspace.workspace_id;
  const claimA = await a.coordinator.taskClaim({ workspace_id: wsA, issue, ttl_seconds: 300 });
  assert.equal(claimA.ok, true, JSON.stringify(claimA));
  assert.equal(claimA.epoch, 1);
  const own = { workspace_id: wsA, issue, claim_id: claimA.claim_id };

  // Renewing moves the fence, never the epoch; each fence is new.
  const seen = new Set([claimA.fence]);
  let fence = claimA.fence;
  const fences = [claimA.fence];
  for (let i = 0; i < 3; i += 1) {
    const renewed = await a.coordinator.taskRenew({ ...own, fence, ttl_seconds: 300 });
    assert.equal(renewed.ok, true, JSON.stringify(renewed));
    assert.ok(!seen.has(renewed.fence), 'a renewal never repeats a fence');
    seen.add(renewed.fence);
    fence = renewed.fence;
    fences.push(fence);
    assert.equal((await ledger.status(refOf(7))).receipt.epoch, 1, 'a renewal keeps the epoch');
  }
  // Every earlier fence is refused by every operation; the current one is not.
  for (const old of fences.slice(0, -1)) {
    stale(await a.coordinator.taskRenew({ ...own, fence: old, ttl_seconds: 300 }), 'task_renew');
    stale(await a.coordinator.taskCheckpoint({ ...own, fence: old, handoff: { goal: 'old fence' } }), 'task_checkpoint');
    stale(await a.coordinator.taskComplete({ ...own, fence: old }), 'task_complete');
    stale(await a.coordinator.taskRelease({ ...own, fence: old, outcome: 'cancelled' }), 'task_release');
  }
  assert.equal((await a.coordinator.taskCheckpoint({ ...own, fence, handoff: { goal: 'current fence' } })).ok, true);

  // The same holds from another process on the same store: a renewal in one session moves the
  // fence for all of them.
  const { workers } = await startWorkers(stateDir, github.file, 1);
  t.after(() => stopWorkers(workers).catch(() => {}));
  const [worker] = workers;
  worker.child.send({ type: 'write', op: 'task_checkpoint', args: { issue, claim_id: claimA.claim_id, fence: fences[0], handoff: { goal: 'x' } } });
  // The worker's own workspace does not own A's claim: it is refused whatever the fence.
  const foreign = (await worker.next('wrote')).result;
  assert.equal(foreign.ok, false, JSON.stringify(foreign));
  assert.equal(foreign.error, 'unknown_claim', JSON.stringify(foreign));

  // A gives the Issue back; B (another process) takes it: a higher epoch, a fence A never saw.
  assert.equal((await a.coordinator.taskRelease({ ...own, fence, outcome: 'cancelled' })).ok, true);
  const [claimB] = await raceClaims([worker], issue, 300);
  assert.equal(claimB.ok, true, JSON.stringify(claimB));
  assert.equal(claimB.epoch, 2);
  assert.ok(![...seen].includes(claimB.fence));
  worker.child.send({ type: 'renew', issue, claim_id: claimB.claim_id, fence: claimB.fence, ttl: 300 });
  const renewedB = (await worker.next('renewed')).renew;
  assert.equal(renewedB.ok, true, JSON.stringify(renewedB));
  assert.notEqual(renewedB.fence, claimB.fence);
  assert.equal((await ledger.status(refOf(7))).receipt.epoch, 2);

  // A is a zombie now: its last good fence, and B's superseded one, are both refused.
  stale(await a.coordinator.taskCheckpoint({ ...own, fence, handoff: { goal: 'zombie' } }), 'A with its last fence');
  stale(await a.coordinator.taskRenew({ ...own, fence, ttl_seconds: 300 }), 'A renew');
  worker.child.send({ type: 'write', op: 'task_checkpoint', args: { issue, claim_id: claimB.claim_id, fence: claimB.fence, handoff: { goal: 'old' } } });
  stale((await worker.next('wrote')).result, 'B with the fence it renewed away');
  worker.child.send({ type: 'write', op: 'task_checkpoint', args: { issue, claim_id: claimB.claim_id, fence: renewedB.fence, handoff: { goal: 'now' } } });
  assert.equal((await worker.next('wrote')).result.ok, true);

  // Back to A: epoch 3, and exactly one claimed row.
  worker.child.send({ type: 'write', op: 'task_release', args: { issue, claim_id: claimB.claim_id, fence: renewedB.fence, outcome: 'cancelled' } });
  assert.equal((await worker.next('wrote')).result.ok, true);
  const again = await a.coordinator.taskClaim({ workspace_id: wsA, issue, ttl_seconds: 300 });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.epoch, 3);
  assert.equal((await claimRows(a.store, issue)).filter(r => r.state === 'claimed').length, 1);
});

describe('zombie against the real ledger after real expiry', { skip: skipWithoutLedger }, () => {
  const world = {};
  const cleanups = [];
  const SHARED = `${REPO}#7`; // B shares A's store: A's row is closed as lost
  const OWN = `${REPO}#8`; // B has its own store: only the ledger can refuse A

  before(async () => {
    const hooks = { after: fn => cleanups.push(fn) };
    world.github = await fakeGitHub(hooks, { [OWN]: {} });
    world.ledger = ledgerFor(world.github);
    world.sharedState = await tempStateDir(hooks);
    world.aloneState = await tempStateDir(hooks);
    world.bState = await tempStateDir(hooks);
    // A's Bridge clock stands still just before it claimed, as after a suspended laptop wakes: it
    // believes its lease is live and outside the last 60 s, so only the ledger or the store can stop it.
    const frozen = Date.now() - 2 * SECOND;
    world.holders = {};
    for (const [issue, stateDir] of [[SHARED, world.sharedState], [OWN, world.aloneState]]) {
      const fx = coordinatorOn(stateDir, { ledger: world.ledger, now: () => frozen });
      cleanups.push(() => fx.store.close());
      const workspace_id = (await fx.coordinator.workspaceOpen({ project: 'drop', client_type: 'cli' })).workspace.workspace_id;
      const claim = await fx.coordinator.taskClaim({ workspace_id, issue, ttl_seconds: 60 });
      assert.equal(claim.ok, true, JSON.stringify(claim));
      world.holders[issue] = { ...fx, workspace_id, claim };
    }
  });

  after(async () => { for (const fn of cleanups.reverse()) await fn(); });

  async function takeOver(issue, stateDir, t) {
    const wait = Date.parse(world.holders[issue].claim.expires_at) + 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    const { workers } = await startWorkers(stateDir, world.github.file, 1, { clockOffsetMs: [LATER] });
    t.after(() => stopWorkers(workers).catch(() => {}));
    const [claim] = await raceClaims(workers, issue, 300);
    assert.equal(claim.ok, true, JSON.stringify(claim));
    assert.equal(claim.epoch, 2);
    assert.notEqual(claim.claim_id, world.holders[issue].claim.claim_id);
    return { workers, claim };
  }

  function zombieWrites(issue) {
    const { coordinator, workspace_id, claim } = world.holders[issue];
    const own = { workspace_id, issue, claim_id: claim.claim_id, fence: claim.fence };
    return [
      ['task_checkpoint', () => coordinator.taskCheckpoint({ ...own, handoff: { goal: 'zombie' } })],
      ['task_renew', () => coordinator.taskRenew({ ...own, ttl_seconds: 300 })],
      ['task_complete', () => coordinator.taskComplete(own)],
      ['task_release', () => coordinator.taskRelease({ ...own, outcome: 'cancelled' })]
    ];
  }

  test('a zombie on the new holder\'s store hears stale_lease and its row is lost', { timeout: 180000 }, async t => {
    const { claim } = await takeOver(SHARED, world.sharedState, t);
    for (const [label, write] of zombieWrites(SHARED)) stale(await write(), label);
    const rows = await claimRows(world.holders[SHARED].store, SHARED);
    assert.deepEqual(rows.filter(r => r.state === 'claimed').map(r => r.claim_id), [claim.claim_id]);
    const old = rows.find(r => r.claim_id === world.holders[SHARED].claim.claim_id);
    assert.deepEqual([old.state, old.outcome], ['released', 'lost']);
    assert.equal((await world.ledger.status(refOf(7))).receipt.claim_id, claim.claim_id, 'the zombie did not disturb the new lease');
  });

  test('a zombie on a store of its own is refused by the ledger alone', { timeout: 180000 }, async t => {
    const { claim } = await takeOver(OWN, world.bState, t);
    assert.equal((await claimRows(world.holders[OWN].store, OWN)).filter(r => r.state === 'claimed').length, 1,
      'A\'s own store still believes it holds the Issue');
    for (const [label, write] of zombieWrites(OWN)) stale(await write(), label);
    const lease = (await world.ledger.status(refOf(8))).receipt;
    assert.equal(lease.claim_id, claim.claim_id);
    assert.equal(lease.state, 'claimed');
    assert.equal(lease.epoch, 2);
  });
});
