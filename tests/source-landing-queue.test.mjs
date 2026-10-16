import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { openSqliteStore, SCHEMA_VERSION } from '../server/coordinator/store.mjs';
import { assessLanding, enqueueLanding, claimLanding, finishLanding, landingQueueStatus } from '../server/source-engine/landing-queue.mjs';
import { tempStateDir } from './helpers/coordinator-fixture.mjs';

const sha = c => c.repeat(40);
const baseEvidence = (number = 11) => ({
  repo: 'memolabs-dev/memo-bridge',
  allowedRepos: ['memolabs-dev/memo-bridge'],
  pr: {
    number, repo: 'memolabs-dev/memo-bridge', state: 'open',
    draft: false, fork: false, base_ref: 'main', base_sha: sha('a'),
    head_sha: sha('b'), expected_head_sha: sha('b'),
    mergeable: true, review_decision: 'APPROVED', branch_protection_ok: true
  },
  target: { ref: 'main', sha: sha('a') },
  checks: { head_sha: sha('b'), required: [{ name: 'test', status: 'completed', conclusion: 'success' }] }
});
async function opened(t) {
  const dir = await tempStateDir(t);
  const store = openSqliteStore({ dir });
  t.after(() => store.close());
  return { dir, store };
}

test('safe landing eligibility fails closed for stale, pending, unapproved, forks and drafts', () => {
  assert.equal(assessLanding(baseEvidence()).ok, true);
  const cases = [
    [e => { e.allowedRepos = []; }, 'repo_not_allowed'],
    [e => { e.pr.draft = true; }, 'pr_not_ready'],
    [e => { e.pr.fork = true; }, 'pr_not_ready'],
    [e => { e.pr.base_sha = sha('c'); }, 'stale_sha'],
    [e => { e.pr.expected_head_sha = sha('c'); }, 'stale_sha'],
    [e => { e.pr.review_decision = 'CHANGES_REQUESTED'; }, 'review_or_protection_required'],
    [e => { e.pr.branch_protection_ok = false; }, 'review_or_protection_required'],
    [e => { e.pr.mergeable = false; }, 'review_or_protection_required'],
    [e => { e.checks.required[0].status = 'pending'; }, 'checks_not_green'],
    [e => { e.checks.required[0].conclusion = 'failure'; }, 'checks_not_green'],
    [e => { e.checks.required = []; }, 'checks_not_green'],
    [e => { e.checks.head_sha = sha('c'); }, 'checks_not_green']
  ];
  for (const [mutation, error] of cases) {
    const evidence = baseEvidence();
    mutation(evidence);
    assert.equal(assessLanding(evidence).error, error);
  }
});

test('landing queue is FIFO, durable, idempotent, and exclusive by repo', async t => {
  const { dir, store } = await opened(t);
  const evidence = baseEvidence(11);
  assert.equal((await enqueueLanding(store, evidence, { at: 1000 })).ok, true);
  assert.equal((await enqueueLanding(store, evidence, { at: 1100 })).unchanged, true);
  assert.equal((await enqueueLanding(store, baseEvidence(12), { at: 1200 })).ok, true);
  const changed = baseEvidence(11);
  changed.pr.head_sha = sha('c');
  changed.pr.expected_head_sha = sha('c');
  changed.checks.head_sha = sha('c');
  assert.equal((await enqueueLanding(store, changed)).error, 'head_or_base_changed');
  const next = await claimLanding(store, { repo: evidence.repo, worker: 'worker1', at: 2000 });
  assert.equal(next.item.pr_number, 11);
  assert.equal(next.revalidate_required, true);
  assert.equal((await claimLanding(store, { repo: evidence.repo, worker: 'worker2', at: 2000 })).error, 'repo_busy');
  const other = openSqliteStore({ dir });
  assert.equal((await claimLanding(other, { repo: evidence.repo, worker: 'worker3', at: 2001 })).error, 'repo_busy');
  await other.close();
  assert.equal((await finishLanding(store, { repo: evidence.repo, pr_number: 11,
    lease_id: next.lease_id, outcome: 'landed', at: 2002 })).ok, true);
  const second = await claimLanding(store, { repo: evidence.repo, worker: 'worker2', at: 2003 });
  assert.equal(second.item.pr_number, 12);
  assert.equal((await landingQueueStatus(store, { repo: evidence.repo })).queue.map(q => q.status).join(','), 'landed,leased');
});

test('expired leases are fenced and recoverable only after revalidation', async t => {
  const { store } = await opened(t);
  await enqueueLanding(store, baseEvidence(), { at: 1000 });
  const previous = await claimLanding(store, { repo: 'memolabs-dev/memo-bridge',
    worker: 'old', at: 2000, ttl_ms: 1000 });
  const newClaim = await claimLanding(store, { repo: 'memolabs-dev/memo-bridge',
    worker: 'new', at: 3001, ttl_ms: 1000 });
  assert.notEqual(newClaim.lease_id, previous.lease_id);
  assert.equal(newClaim.revalidate_required, true);
  assert.equal((await finishLanding(store, { repo: 'memolabs-dev/memo-bridge', pr_number: 11,
    lease_id: previous.lease_id, outcome: 'landed', at: 3002 })).error, 'stale_lease');
  assert.equal((await finishLanding(store, { repo: 'memolabs-dev/memo-bridge', pr_number: 11,
    lease_id: newClaim.lease_id, outcome: 'blocked', at: 3002 })).ok, true);
  assert.equal((await claimLanding(store, { repo: 'memolabs-dev/memo-bridge',
    worker: 'third', at: 3003 })).empty, true);
  assert.equal((await enqueueLanding(store, baseEvidence())).error, 'already_terminal');
});

test('only one caller wins a contested claim', async t => {
  const { store } = await opened(t);
  await enqueueLanding(store, baseEvidence());
  const results = await Promise.all(Array.from({ length: 16 }, (_, n) => claimLanding(store, {
    repo: 'memolabs-dev/memo-bridge', worker: 'worker' + n
  })));
  assert.equal(results.filter(x => x.ok && x.lease_id).length, 1);
  assert.equal(results.filter(x => x.error === 'repo_busy').length, 15);
});

test('v8 Coordinator migrates landing table in place', async t => {
  const { dir, store } = await opened(t);
  assert.equal(SCHEMA_VERSION, 9);
  await store.transaction(repo => repo.insertWorkspace({
    id: 'ws_test', principal: 'local:owner', client_type: 'cli', project_id: 'drop',
    host: 'mac', status: 'active', created_at: 1000, updated_at: 1000
  }));
  await store.close();
  const db = new DatabaseSync(join(dir, 'coordinator.sqlite'));
  db.exec('DROP TABLE source_landing_queue; PRAGMA user_version = 8;');
  db.close();
  const reopened = openSqliteStore({ dir });
  assert.equal(reopened.settings().schema_version, 9);
  assert.equal((await reopened.transaction(repo => repo.getWorkspace('ws_test'), { write: false })).id, 'ws_test');
  assert.equal((await enqueueLanding(reopened, baseEvidence())).ok, true);
  await reopened.close();
});
