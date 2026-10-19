// Invariant: the Mac and the VPS judge a lease against their own wall clock, up to 30 s apart.
// A holder stops writing 60 s before expires_at and nobody reclaims before expires_at + 60 s, so
// a holder and a reclaimer never both write.
//
// The canonical ledger script (issue_lease.py) reads the wall clock of the machine it runs on and
// cannot take an injected one from its command line. The time-dependent cases therefore drive an
// in-memory ledger with the script's contract and an injected clock (lib/fixture.mjs memoryLedger);
// the property under test is Bridge's margin, not the script. One case runs the real script on
// the offline fake `gh` to check the status receipt Bridge now reads before every claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOCK_MARGIN_MS, reclaimableAfter, writableUntil } from '../../server/coordinator/issue-lease.mjs';
import { DEMO_ISSUE, coordinatorOn, demoGh, fakeGitHub, gitRuntime, isolateGit, ledgerFor, memoryLedger, skipWithoutLedger,
  tempStateDir } from './lib/fixture.mjs';

const ISSUE = 'memolabs-dev/drop#7';
const T0 = Date.parse('2026-10-19T12:00:00Z');
const SECOND = 1000;

test('the margin is 60 s on both sides of expires_at', () => {
  const expires = '2026-10-19T12:05:00.000Z';
  assert.equal(CLOCK_MARGIN_MS, 60_000);
  assert.equal(writableUntil(expires), Date.parse(expires) - 60_000);
  assert.equal(reclaimableAfter(expires), Date.parse(expires) + 60_000);
});

test('a holder cannot write in the last 60 s of its lease', async t => {
  await isolateGit(t);
  const clock = { t: T0 };
  const now = () => clock.t;
  const { gh } = demoGh();
  const f = await gitRuntime(t, { ledger: memoryLedger(now), now, gh });
  const opened = await f.coordinator.workspaceOpen({ project: 'demo', client_type: 'cli' });
  const workspace_id = opened.workspace.workspace_id;
  const claim = await f.coordinator.taskClaim({ workspace_id, issue: DEMO_ISSUE, ttl_seconds: 300 });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  const created = await f.call('worktree_create', { workspace_id, issue: DEMO_ISSUE });
  assert.equal(created.ok, true, JSON.stringify(created));
  const worktree_id = created.worktree.worktree_id;
  const branch = created.worktree.branch;
  const own = { workspace_id, issue: DEMO_ISSUE, claim_id: claim.claim_id };
  const expires = Date.parse(claim.expires_at);

  // Writing files stays local and allowed; the changes wait for the commit.
  assert.equal((await f.call('worktree_write_file', { worktree_id, path: 'a.txt', content: 'one\n' })).ok, true);

  // 30 s before expires_at: inside the margin.
  clock.t = expires - 30 * SECOND;
  const expiring = r => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.error, 'lease_expiring', JSON.stringify(r)); assert.equal(r.next_step, 'task_renew'); };
  expiring(await f.call('worktree_commit', { worktree_id, message: 'feat: a' }));
  expiring(await f.call('worktree_push', { worktree_id }));
  expiring(await f.call('github_create_pr', { workspace_id, worktree_id, title: 'Demo: a' }));
  expiring(await f.coordinator.taskCheckpoint({ ...own, fence: claim.fence, handoff: { goal: 'a' } }));
  expiring(await f.coordinator.taskComplete({ ...own, fence: claim.fence }));

  // Renewing is allowed inside the margin, and lifts it.
  const renewed = await f.coordinator.taskRenew({ ...own, fence: claim.fence, ttl_seconds: 300 });
  assert.equal(renewed.ok, true, JSON.stringify(renewed));
  const live = { ...own, fence: renewed.fence };

  const committed = await f.call('worktree_commit', { worktree_id, message: 'feat: a' });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const pushed = await f.call('worktree_push', { worktree_id });
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  const pr = await f.call('github_create_pr', { workspace_id, worktree_id, title: 'Demo: a' });
  assert.equal(pr.ok, true, JSON.stringify(pr));
  assert.equal(pr.head, branch);
  assert.equal((await f.coordinator.taskCheckpoint({ ...live, handoff: { goal: 'a' } })).ok, true);
  const completed = await f.coordinator.taskComplete(live);
  assert.equal(completed.ok, true, JSON.stringify(completed));
});

test('giving a claim back and renewing it stay allowed until real expiry', async t => {
  const clock = { t: T0 };
  const now = () => clock.t;
  const { store, coordinator } = coordinatorOn(await tempStateDir(t), { now, ledger: memoryLedger(now) });
  t.after(() => store.close());
  const opened = await coordinator.workspaceOpen({ project: 'drop', client_type: 'cli' });
  const own = { workspace_id: opened.workspace.workspace_id, issue: ISSUE };
  const claim = await coordinator.taskClaim({ ...own, ttl_seconds: 60 });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  const expires = Date.parse(claim.expires_at);

  clock.t = expires - 59 * SECOND;
  assert.equal((await coordinator.taskCheckpoint({ ...own, claim_id: claim.claim_id, fence: claim.fence, handoff: { goal: 'x' } })).error,
    'lease_expiring');
  const renewed = await coordinator.taskRenew({ ...own, claim_id: claim.claim_id, fence: claim.fence, ttl_seconds: 60 });
  assert.equal(renewed.ok, true, JSON.stringify(renewed));

  clock.t = Date.parse(renewed.expires_at) - 1 * SECOND;
  const released = await coordinator.taskRelease({ ...own, claim_id: claim.claim_id, fence: renewed.fence, outcome: 'cancelled' });
  assert.equal(released.ok, true, JSON.stringify(released));
});

test('no one reclaims before expires_at + 60 s, even with a clock 30 s ahead', async t => {
  const world = { t: T0 };
  const leases = new Map();
  const clockA = () => world.t;
  const clockB = () => world.t + 30 * SECOND;
  const ledgerA = memoryLedger(clockA, leases);
  const ledgerB = memoryLedger(clockB, leases);
  const a = coordinatorOn(await tempStateDir(t), { now: clockA, ledger: ledgerA });
  const b = coordinatorOn(await tempStateDir(t), { now: clockB, ledger: ledgerB });
  t.after(() => { a.store.close(); b.store.close(); });

  const wsA = (await a.coordinator.workspaceOpen({ project: 'drop', client_type: 'cli' })).workspace.workspace_id;
  const wsB = (await b.coordinator.workspaceOpen({ project: 'drop', client_type: 'cli' })).workspace.workspace_id;
  const claimA = await a.coordinator.taskClaim({ workspace_id: wsA, issue: ISSUE, ttl_seconds: 60 });
  assert.equal(claimA.ok, true, JSON.stringify(claimA));
  const expires = Date.parse(claimA.expires_at);

  // B's clock reads expires_at + 30 s: the ledger calls the lease expired, Bridge still refuses.
  world.t = expires;
  const early = await b.coordinator.taskClaim({ workspace_id: wsB, issue: ISSUE, ttl_seconds: 60 });
  assert.equal(early.ok, false);
  assert.equal(early.error, 'lease_held');
  assert.equal(ledgerB.claims, 0, 'the ledger is not asked to grant the lease inside the margin');

  // Just inside, then just past expires_at + 60 s on B's own clock.
  world.t = expires + 29 * SECOND;
  assert.equal((await b.coordinator.taskClaim({ workspace_id: wsB, issue: ISSUE, ttl_seconds: 60 })).error, 'lease_held');
  assert.equal(ledgerB.claims, 0);
  world.t = expires + 31 * SECOND;
  const takeover = await b.coordinator.taskClaim({ workspace_id: wsB, issue: ISSUE, ttl_seconds: 60 });
  assert.equal(takeover.ok, true, JSON.stringify(takeover));
  assert.notEqual(takeover.claim_id, claimA.claim_id);
  assert.equal(ledgerB.claims, 1);
});

test('with clocks 30 s apart, holder and reclaimer never both write', async t => {
  const world = { t: T0 };
  const leases = new Map();
  const clockA = () => world.t - 30 * SECOND;
  const clockB = () => world.t + 30 * SECOND;
  const a = coordinatorOn(await tempStateDir(t), { now: clockA, ledger: memoryLedger(clockA, leases) });
  const b = coordinatorOn(await tempStateDir(t), { now: clockB, ledger: memoryLedger(clockB, leases) });
  t.after(() => { a.store.close(); b.store.close(); });

  const wsA = (await a.coordinator.workspaceOpen({ project: 'drop', client_type: 'cli' })).workspace.workspace_id;
  const wsB = (await b.coordinator.workspaceOpen({ project: 'drop', client_type: 'cli' })).workspace.workspace_id;
  const claimA = await a.coordinator.taskClaim({ workspace_id: wsA, issue: ISSUE, ttl_seconds: 300 });
  assert.equal(claimA.ok, true, JSON.stringify(claimA));
  const expires = Date.parse(claimA.expires_at);
  const writeA = async () => (await a.coordinator.taskCheckpoint({ workspace_id: wsA, issue: ISSUE, claim_id: claimA.claim_id,
    fence: claimA.fence, handoff: { goal: 'A writes' } })).ok === true;

  let claimB = null; let aWrote = 0; let bWrote = 0;
  const log = [];
  for (let offset = -90; offset <= 90; offset += 10) {
    world.t = expires + offset * SECOND;
    // Whichever acts first at an instant, the two must never both succeed at it.
    const aOk = await writeA();
    if (!claimB) {
      const tried = await b.coordinator.taskClaim({ workspace_id: wsB, issue: ISSUE, ttl_seconds: 300 });
      if (tried.ok) claimB = tried;
    }
    const bOk = claimB ? (await b.coordinator.taskCheckpoint({ workspace_id: wsB, issue: ISSUE, claim_id: claimB.claim_id,
      fence: claimB.fence, handoff: { goal: 'B writes' } })).ok === true : false;
    log.push(`${offset}:${aOk ? 'A' : '-'}${bOk ? 'B' : '-'}`);
    aWrote += aOk ? 1 : 0; bWrote += bOk ? 1 : 0;
    assert.ok(!(aOk && bOk), `both wrote at expires_at${offset >= 0 ? '+' : ''}${offset} s: ${log.join(' ')}`);
  }
  assert.ok(aWrote > 0, `the holder writes while its lease is safe: ${log.join(' ')}`);
  assert.ok(bWrote > 0, `the reclaimer writes once the margin has passed: ${log.join(' ')}`);
});

test('the real ledger script still gates a live foreign lease through Bridge', { skip: skipWithoutLedger }, async t => {
  const github = await fakeGitHub(t);
  const ledger = ledgerFor(github);
  const a = coordinatorOn(await tempStateDir(t), { ledger });
  const b = coordinatorOn(await tempStateDir(t), { ledger });
  t.after(() => { a.store.close(); b.store.close(); });
  const wsA = (await a.coordinator.workspaceOpen({ project: 'drop', client_type: 'cli' })).workspace.workspace_id;
  const wsB = (await b.coordinator.workspaceOpen({ project: 'drop', client_type: 'cli' })).workspace.workspace_id;
  const claimA = await a.coordinator.taskClaim({ workspace_id: wsA, issue: ISSUE, ttl_seconds: 300 });
  assert.equal(claimA.ok, true, JSON.stringify(claimA));
  const refused = await b.coordinator.taskClaim({ workspace_id: wsB, issue: ISSUE, ttl_seconds: 300 });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'lease_held');
  assert.equal((await ledger.status({ ref: ISSUE, repo: 'memolabs-dev/drop', number: '7' })).receipt.claim_id, claimA.claim_id);
});
