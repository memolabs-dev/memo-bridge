// Invariant: up to 6 parallel sessions (12 for margin) never share a claim.
//   - N sessions in N processes race for one Issue: the canonical ledger grants one lease, every
//     other session is told lease_held, and the store keeps a single `claimed` row.
//   - When the lease has really expired, N reclaimers race again: one expired_recovery (epoch 2,
//     a new claim_id), the rest lease_held, and the previous holder's row is closed as lost.
//   - A second conversation on a workspace it did not open gets workspace_other_session.
//
// The races run the real issue_lease.py on the offline fake `gh` (lib/fake-gh). The script reads
// the wall clock and cannot take an injected one, so the expired cases wait for the real expiry
// (ttl 60 s is the ledger minimum) and move only the reclaimers' Bridge clock +61 s, which is
// what clears Bridge's own margin (expires_at + 60 s). One expiry wait serves both sizes: two
// Issues are claimed up front and expire together.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { clientSessionHash } from '../../bridge/forward.mjs';
import { parseRemotePolicy } from '../../bridge/write-gate.mjs';
import { CAPABILITIES, makePrincipal } from '../../server/coordinator/policy.mjs';
import { coordinatorOn, fakeGitHub, ledgerFor, skipWithoutLedger, tempStateDir } from './lib/fixture.mjs';
import { claimRows, raceClaims, raceInserts, startWorkers, stopWorkers } from './lib/race.mjs';

const SIZES = [6, 12];
const REPO = 'memolabs-dev/drop';
const issueOf = n => `${REPO}#${n === 6 ? 7 : 8}`; // n = 6 races for drop#7, n = 12 for drop#8
const LATER = 61_000; // a reclaimer's Bridge clock: past expires_at + 60 s once the ledger says expired
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const refs = rows => rows.filter(r => r.state === 'claimed');
const GITHUB_ISSUES = { 'memolabs-dev/drop#8': {} };

for (const n of SIZES) {
  test(`${n} sessions race for one Issue: one holder, the rest lease_held`, { skip: skipWithoutLedger, timeout: 180000 }, async t => {
    const issue = issueOf(n);
    const github = await fakeGitHub(t, GITHUB_ISSUES);
    const stateDir = await tempStateDir(t);
    const { workers, ready } = await startWorkers(stateDir, github.file, n);
    t.after(() => stopWorkers(workers).catch(() => {}));
    assert.deepEqual(ready.map(r => r.workspace.ok), Array(n).fill(true));
    assert.equal(new Set(ready.map(r => r.workspace.workspace.workspace_id)).size, n, 'every session has its own workspace');

    const results = await raceClaims(workers, issue, 300);
    const winners = results.filter(r => r.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    const losers = results.filter(r => !r.ok);
    assert.equal(losers.length, n - 1);
    assert.ok(losers.every(r => r.error === 'lease_held'), JSON.stringify(losers));
    await stopWorkers(workers);

    // One `claimed` row in the store, the winner's; one live lease in the ledger, the same one.
    const { store } = coordinatorOn(stateDir, { ledger: ledgerFor(github) });
    t.after(() => store.close());
    const rows = await claimRows(store, issue);
    assert.deepEqual(refs(rows).map(r => r.claim_id), [winners[0].claim_id], JSON.stringify(rows));
    assert.equal(rows.length, 1, 'the losers left no row behind');
    const lease = (await ledgerFor(github).status({ ref: issue, repo: REPO, number: issue.split('#')[1] })).receipt;
    assert.equal(lease.state, 'claimed');
    assert.equal(lease.claim_id, winners[0].claim_id);
    assert.equal(lease.fence_sha, winners[0].fence);
    assert.equal(lease.epoch, 1);
  });
}

test('a lease that has not expired is held against reclaimers whose clock runs 61 s ahead',
  { skip: skipWithoutLedger, timeout: 180000 }, async t => {
    const issue = issueOf(6);
    const github = await fakeGitHub(t, GITHUB_ISSUES);
    const stateDir = await tempStateDir(t);
    const holder = coordinatorOn(stateDir, { ledger: ledgerFor(github) });
    t.after(() => holder.store.close());
    const workspace_id = (await holder.coordinator.workspaceOpen({ project: 'drop', client_type: 'cli' })).workspace.workspace_id;
    const claim = await holder.coordinator.taskClaim({ workspace_id, issue, ttl_seconds: 300 });
    assert.equal(claim.ok, true, JSON.stringify(claim));

    const { workers } = await startWorkers(stateDir, github.file, 6, { clockOffsetMs: Array(6).fill(LATER) });
    t.after(() => stopWorkers(workers).catch(() => {}));
    const results = await raceClaims(workers, issue, 300);
    assert.deepEqual(results.map(r => r.error), Array(6).fill('lease_held'), JSON.stringify(results));
    assert.deepEqual(refs(await claimRows(holder.store, issue)).map(r => r.claim_id), [claim.claim_id]);
  });

// taskClaim closes the other 'claimed' rows of the Issue before inserting its own, so the store's UNIQUE
// live-claim index (claims_live_issue, v9) is never reached through it. Reach it directly: the same insert
// production runs, from separate processes, with no coordinator and no ledger in between.
for (const n of [2, SIZES[0]]) {
  test(`the store refuses a second live claim on its own (${n} connections)`, { timeout: 120000 }, async t => {
    const issue = issueOf(6);
    const stateDir = await tempStateDir(t);
    const github = await fakeGitHub(t, GITHUB_ISSUES);
    const { workers } = await startWorkers(stateDir, github.file, n);
    t.after(() => stopWorkers(workers).catch(() => {}));
    const outcomes = await raceInserts(workers, issue);
    await stopWorkers(workers);
    assert.equal(outcomes.filter(o => o.ok).length, 1, JSON.stringify(outcomes));
    const refused = outcomes.filter(o => !o.ok);
    assert.equal(refused.length, n - 1);
    assert.ok(refused.every(o => /constraint|unique/i.test(`${o.error} ${o.code}`)), JSON.stringify(refused));
    const { store } = coordinatorOn(stateDir, { ledger: ledgerFor(github) });
    t.after(() => store.close());
    assert.equal(refs(await claimRows(store, issue)).length, 1, 'exactly one claimed row for the Issue');
    // A released row does not count: once closed, the Issue can be claimed again.
    const [winner] = await claimRows(store, issue);
    await store.transaction(repo => repo.updateClaim(winner.claim_id, { state: 'released', outcome: 'cancelled', updated_at: new Date().toISOString() }, winner.fence_sha));
    await store.transaction(repo => repo.insertClaim({ claim_id: 'c'.repeat(32), workspace_id: winner.workspace_id, issue_ref: issue,
      fence_sha: 'd'.repeat(40), epoch: 2, expires_at: new Date(Date.now() + 600_000).toISOString(), updated_at: new Date().toISOString() }));
    assert.equal(refs(await claimRows(store, issue)).length, 1);
  });
}

describe('expired lease: the reclaim race', { skip: skipWithoutLedger }, () => {
  const world = {};

  before(async () => {
    const cleanups = [];
    world.cleanups = cleanups;
    // fakeGitHub and tempStateDir register their cleanup on a test context; this suite-level setup owns its own.
    const hooks = { after: fn => cleanups.push(fn) };
    world.github = await fakeGitHub(hooks, GITHUB_ISSUES);
    world.stateDir = await tempStateDir(hooks);
    world.holder = coordinatorOn(world.stateDir, { ledger: ledgerFor(world.github) });
    cleanups.push(() => world.holder.store.close());
    world.holders = {};
    for (const n of SIZES) {
      const workspace_id = (await world.holder.coordinator.workspaceOpen({ project: 'drop', client_type: 'cli' })).workspace.workspace_id;
      // ttl 60 s is the ledger minimum; Bridge refuses writes in the last 60 s, so A never writes here.
      const claim = await world.holder.coordinator.taskClaim({ workspace_id, issue: issueOf(n), ttl_seconds: 60 });
      assert.equal(claim.ok, true, JSON.stringify(claim));
      assert.equal(claim.epoch, 1);
      world.holders[n] = { workspace_id, claim };
    }
  });

  after(async () => { for (const fn of world.cleanups.reverse()) await fn(); });

  // The ledger judges expiry with the real wall clock: wait until it says expired.
  async function untilExpired(n) {
    const wait = Date.parse(world.holders[n].claim.expires_at) + 1000 - Date.now();
    if (wait > 0) await sleep(wait);
  }

  for (const n of SIZES) {
    test(`expired lease, ${n} reclaimers: one expired_recovery`, { timeout: 180000 }, async t => {
      const issue = issueOf(n);
      const previous = world.holders[n].claim;
      await untilExpired(n);
      const { workers } = await startWorkers(world.stateDir, world.github.file, n, { clockOffsetMs: Array(n).fill(LATER) });
      t.after(() => stopWorkers(workers).catch(() => {}));

      const results = await raceClaims(workers, issue, 300);
      const winners = results.filter(r => r.ok);
      assert.equal(winners.length, 1, JSON.stringify(results));
      const losers = results.filter(r => !r.ok);
      assert.equal(losers.length, n - 1);
      assert.ok(losers.every(r => r.error === 'lease_held'), JSON.stringify(losers));
      await stopWorkers(workers);

      // The reclaim is the ledger's expired_recovery: epoch 2 and a claim_id nobody held before.
      const [won] = winners;
      assert.equal(won.epoch, 2, JSON.stringify(won));
      assert.notEqual(won.claim_id, previous.claim_id);
      assert.notEqual(won.fence, previous.fence);

      const rows = await claimRows(world.holder.store, issue);
      assert.deepEqual(refs(rows).map(r => r.claim_id), [won.claim_id], JSON.stringify(rows));
      const old = rows.find(r => r.claim_id === previous.claim_id);
      assert.equal(old.state, 'released', 'the expired holder\'s row is closed');
      assert.equal(old.outcome, 'lost', 'and marked lost, so it hears stale_lease');
      const lease = (await ledgerFor(world.github).status({ ref: issue, repo: REPO, number: issue.split('#')[1] })).receipt;
      assert.equal(lease.claim_id, won.claim_id);
      assert.equal(lease.epoch, 2);
    });
  }
});

test('a second session on the same workspace gets workspace_other_session', { skip: skipWithoutLedger, timeout: 120000 }, async t => {
  const CHAT = makePrincipal('oidc:owner-sub', Object.values(CAPABILITIES), { client_type: 'chatgpt', via: 'hub' });
  const session = name => ({ client_session: clientSessionHash({ mcpReq: { _meta: { 'openai/session': name } } }) });
  const github = await fakeGitHub(t);
  const remotePolicy = parseRemotePolicy({ projects: [REPO, 'memolabs-dev/cuesheet'], session_binding: 'enforce' });
  const ledger = ledgerFor(github);
  const { store, coordinator } = coordinatorOn(await tempStateDir(t), { principal: CHAT, ledger, tasks: { remotePolicy } });
  t.after(() => store.close());

  const issue = issueOf(6);
  const opened = await coordinator.workspaceOpen({ project: 'drop', client_label: 'first' }, session('first'));
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const workspace_id = opened.workspace.workspace_id;
  const claim = await coordinator.taskClaim({ workspace_id, issue, ttl_seconds: 300 }, session('first'));
  assert.equal(claim.ok, true, JSON.stringify(claim));

  // Another conversation names the same workspace: refused, whatever it asks, and the lease stays the first one's.
  const own = { workspace_id, issue, claim_id: claim.claim_id, fence: claim.fence };
  const attempts = [
    ['taskClaim', { workspace_id, issue: `${REPO}#7` }],
    ['taskRenew', { ...own, ttl_seconds: 300 }],
    ['taskCheckpoint', { ...own, handoff: { goal: 'not mine' } }],
    ['taskComplete', own],
    ['workspaceClose', { workspace_id }]
  ];
  for (const [method, args] of attempts) {
    assert.deepEqual(await coordinator[method](args, session('second')), { ok: false, error: 'workspace_other_session' }, method);
  }
  // Without any session hint the call is refused outright (fail safe).
  assert.equal((await coordinator.taskClaim({ workspace_id, issue }, undefined)).error, 'session_required');

  const rows = await claimRows(store, issue);
  assert.deepEqual(refs(rows).map(r => r.claim_id), [claim.claim_id]);
  assert.equal((await ledger.status({ ref: issue, repo: REPO, number: '7' })).receipt.claim_id, claim.claim_id);
  // The first conversation still works the claim.
  assert.equal((await coordinator.taskRenew({ ...own, ttl_seconds: 300 }, session('first'))).ok, true);
});
