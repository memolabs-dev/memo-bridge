import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLandingInspector } from '../server/source-engine/landing-inspector.mjs';

const repo = 'memolabs-dev/memo-bridge';
const sha = c => c.repeat(40);
const now = () => 10_000;

function evidence({ head = sha('a'), base = sha('b') } = {}) {
  return {
    ok: true, repo,
    pr: { number: 7, head_sha: head, base_sha: base, base_ref: 'main' },
    target: { ref: 'main', sha: base },
    checks: { head_sha: head, required: [{ name: 'test (22)', status: 'completed', conclusion: 'success' }] }
  };
}
function sharedVpsQueue() {
  let claimed = null;
  let attempted = 0;
  const queue = {
    async claim({ repo: selected, worker }) {
      attempted++;
      if (selected !== repo) return { ok: false, error: 'repo_not_allowed' };
      if (claimed) return { ok: false, error: 'repo_busy' };
      const lease_id = randomUUID();
      claimed = {
        repo: selected, pr_number: 7, status: 'leased', lease_id,
        lease_expires_at: 100_000, head_sha: sha('a'),
        base_sha: sha('b'), base_ref: 'main', worker
      };
      return { ok: true, lease_id, revalidate_required: true, item: { ...claimed } };
    }
  };
  return { queue, calls: () => attempted };
}
function factory(queue, overrides = {}) {
  return createLandingInspector({
    serverHost: 'vps', mode: 'trusted_server', allowedRepos: [repo],
    queue, now, readGitHub: async () => evidence(),
    checkPolicy: async () => ({ ok: true, eligible: true, head_sha: sha('a') }),
    ...overrides
  });
}

test('two independent clients compete for exactly one shared VPS queue lease', async () => {
  const state = sharedVpsQueue();
  // Instances are independent (as if separate agent connections), but share
  // one injected authority. This is not yet a live Mac/VPS transport test.
  const a = factory(state.queue);
  const b = factory(state.queue);
  const results = await Promise.all([
    a.inspectNext({ repo, worker: 'macAgent' }),
    b.inspectNext({ repo, worker: 'vpsAgent' })
  ]);
  assert.equal(results.filter(x => x.ok && x.verified).length, 1);
  assert.equal(results.filter(x => x.error === 'repo_busy').length, 1);
  assert.equal(results.some(x => x.merge_authorized === true), false);
  assert.equal(state.calls(), 2);
});

test('rejects Mac fallback and untrusted session before any queue mutation', async () => {
  for (const [serverHost, mode, expected] of [
    ['mac', 'trusted_server', 'not_landing_authority'],
    ['vps', 'remote_model', 'server_only'],
    [undefined, 'trusted_server', 'not_landing_authority']
  ]) {
    const state = sharedVpsQueue();
    const inspected = await factory(state.queue, { serverHost, mode })
      .inspectNext({ repo, worker: 'agentOne' });
    assert.equal(inspected.error, expected);
    assert.equal(state.calls(), 0);
  }
});

test('allowlist, invalid worker and broken service fail closed with zero merge authority', async () => {
  const state = sharedVpsQueue();
  const inspector = factory(state.queue);
  assert.equal((await inspector.inspectNext({ repo: 'outsider/repo', worker: 'agentOne' })).error, 'repo_not_allowed');
  assert.equal((await inspector.inspectNext({ repo, worker: 'A A' })).error, 'invalid_worker');
  assert.equal(state.calls(), 0);
  assert.equal((await factory({}, { queue: {} }).inspectNext({ repo, worker: 'agentOne' })).error,
    'inspector_not_configured');
  assert.equal((await factory({ claim: () => { throw Error('sensitive'); } })
    .inspectNext({ repo, worker: 'agentOne' })).error, 'queue_unavailable');
  assert.equal((await factory({ claim: async () => ({ ok: false, error: 'repo_busy' }) })
    .inspectNext({ repo, worker: 'agentOne' })).error, 'repo_busy');
});

test('empty queue has no implicit merge action', async () => {
  const result = await factory({ claim: async () => ({ ok: true, empty: true }) })
    .inspectNext({ repo, worker: 'agentOne' });
  assert.deepEqual(result, { ok: true, empty: true, merge_authorized: false });
});

test('a lease returned for another repo is refused without GitHub reads', async () => {
  const state = sharedVpsQueue();
  let reads = 0;
  const result = await factory(state.queue, {
    queue: { claim: async () => ({ ok: true, item: { repo: 'other/repo' } }) },
    readGitHub: async () => { reads++; return evidence(); }
  }).inspectNext({ repo, worker: 'agentOne' });
  assert.equal(result.error, 'queue_scope_mismatch');
  assert.equal(reads, 0);
});

test('stale head/base/check status, missing approval, and remote outages never grant permission', async () => {
  const scenarios = [
    [{ readGitHub: async () => evidence({ head: sha('c') }) }, 'stale_remote_snapshot'],
    [{ readGitHub: async () => evidence({ base: sha('c') }) }, 'stale_remote_snapshot'],
    [{ readGitHub: async () => ({ ...evidence(), checks: { head_sha: sha('d') } }) }, 'stale_remote_snapshot'],
    [{ checkPolicy: async () => ({ ok: true, eligible: false, head_sha: sha('a') }) }, 'policy_not_satisfied'],
    [{ readGitHub: async () => { throw Error('private-token'); } }, 'github_unavailable']
  ];
  for (const [overrides, expected] of scenarios) {
    const state = sharedVpsQueue();
    const result = await factory(state.queue, overrides).inspectNext({ repo, worker: 'agentOne' });
    assert.equal(result.error, expected);
    assert.equal(result.merge_authorized, false);
    assert.equal(JSON.stringify(result).includes('private-token'), false);
  }
});

test('an expired lease and a late GitHub response both fail closed', async () => {
  const state = sharedVpsQueue();
  const expired = await factory(state.queue, { now: () => 100_001 })
    .inspectNext({ repo, worker: 'agentOne' });
  assert.equal(expired.error, 'lease_expired_or_short');

  let tick = 10_000;
  const another = sharedVpsQueue();
  const late = await factory(another.queue, {
    now: () => tick,
    readGitHub: async () => { tick = 99_000; return evidence(); }
  }).inspectNext({ repo, worker: 'agentTwo' });
  assert.equal(late.error, 'lease_expired_or_short');
});
