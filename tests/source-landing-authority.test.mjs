import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectLandingAuthority, landingAuthorityGuard, preflightAfterLandingLease
} from '../server/source-engine/landing-authority.mjs';

const SHA = ch => ch.repeat(40);
const origin = 'memolabs-dev/memo-bridge';
const expiry = 1_000_000;
const LEASE_ID = '442b8d7f-2b9a-4b9c-8288-61302338e109';
const validLease = () => ({
  ok: true, lease_id: LEASE_ID, revalidate_required: true,
  item: {
    repo: origin, pr_number: 106, status: 'leased',
    lease_id: LEASE_ID, lease_expires_at: expiry,
    head_sha: SHA('a'), base_sha: SHA('b'), base_ref: 'main'
  }
});
const remote = () => ({
  ok: true, repo: origin,
  pr: { number: 106, head_sha: SHA('a'), base_sha: SHA('b'), base_ref: 'main' },
  target: { sha: SHA('b'), ref: 'main' },
  checks: { head_sha: SHA('a') }
});
function setup(overrides = {}) {
  return {
    host: 'vps', mode: 'trusted_server',
    lease: validLease(), now: () => 100_000,
    readGitHub: async () => remote(),
    checkPolicy: async () => ({ ok: true, eligible: true, head_sha: SHA('a') }),
    ...overrides
  };
}

test('only a reachable VPS may own the landing queue, with no Mac fallback', () => {
  assert.deepEqual(selectLandingAuthority({ availableHosts: ['mac'] }), { ok: false, error: 'authority_unavailable' });
  assert.deepEqual(selectLandingAuthority({ availableHosts: ['mac', 'vps'] }), { ok: true, host: 'vps' });
  assert.equal(landingAuthorityGuard({ host: 'mac', mode: 'trusted_server' }).error, 'not_landing_authority');
  assert.equal(landingAuthorityGuard({ host: 'vps', mode: 'remote_model' }).error, 'server_only');
  assert.equal(landingAuthorityGuard({ host: 'vps', mode: 'trusted_server' }).ok, true);
});

test('fresh preflight returns a non-mergeable observation, never authority to merge', async () => {
  const calls = [];
  const preflight = await preflightAfterLandingLease(setup({
    readGitHub: async args => { calls.push(args); return remote(); }
  }));
  assert.equal(preflight.ok, true);
  assert.equal(preflight.verified, true);
  assert.equal(preflight.merge_authorized, false);
  assert.equal(preflight.head_sha, SHA('a'));
  assert.deepEqual(calls, [{ repo: origin, pr_number: 106 }]);
  assert.equal(Object.hasOwn(preflight, 'token'), false);
});

test('wrong host or nonserver invocation makes no GitHub call', async () => {
  for (const [host, mode, error] of [
    ['mac', 'trusted_server', 'not_landing_authority'],
    ['vps', 'model_request', 'server_only'],
    [undefined, 'trusted_server', 'not_landing_authority']
  ]) {
    let called = 0;
    const result = await preflightAfterLandingLease(setup({
      host, mode, readGitHub: async () => { called++; return remote(); }
    }));
    assert.equal(result.error, error);
    assert.equal(called, 0);
  }
});

test('reject invalid or near-expiry leases before remote fetch', async () => {
  for (const change of [
    l => { l.lease_id = 'forged'; },
    l => { l.item.lease_id = 'another'; },
    l => { l.item.status = 'queued'; },
    l => { l.revalidate_required = false; },
    l => { l.item.base_ref = '../main'; },
    l => { l.item.repo = '../bad'; },
    l => { l.item.lease_expires_at = 100_001; }
  ]) {
    const lease = validLease(); change(lease);
    let calls = 0;
    const result = await preflightAfterLandingLease(setup({
      lease, readGitHub: async () => { calls++; return remote(); }
    }));
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
  }
});

test('stale head SHA, target HEAD, PR number and required-check binding fail closed', async () => {
  for (const modify of [
    e => { e.pr.head_sha = SHA('c'); },
    e => { e.pr.base_sha = SHA('c'); },
    e => { e.target.sha = SHA('c'); },
    e => { e.checks.head_sha = SHA('c'); },
    e => { e.pr.number = 107; },
    e => { e.repo = 'example/other'; },
    e => { e.pr.base_ref = 'release'; }
  ]) {
    let policyCalls = 0;
    const result = await preflightAfterLandingLease(setup({
      readGitHub: async () => { const snap = remote(); modify(snap); return snap; },
      checkPolicy: async () => { policyCalls++; return { ok: true, eligible: true, head_sha: SHA('a') }; }
    }));
    assert.equal(result.error, 'stale_remote_snapshot');
    assert.equal(policyCalls, 0);
  }
});

test('approval/required-check policy failure, GitHub outage and exceptions fail closed', async () => {
  const cases = [
    [{ checkPolicy: async () => ({ ok: true, eligible: false, head_sha: SHA('a') }) }, 'policy_not_satisfied'],
    [{ checkPolicy: async () => ({ ok: true, eligible: true, head_sha: SHA('c') }) }, 'policy_not_satisfied'],
    [{ checkPolicy: async () => { throw Error('secret'); } }, 'policy_unavailable'],
    [{ readGitHub: async () => { throw Error('secret'); } }, 'github_unavailable'],
    [{ readGitHub: async () => ({ ok: false, error: 'github_forbidden' }) }, 'github_unavailable']
  ];
  for (const [change, expected] of cases) {
    const result = await preflightAfterLandingLease(setup(change));
    assert.equal(result.error, expected);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('lease expiring while GitHub is queried never passes the final gate', async () => {
  let current = 100_000;
  const result = await preflightAfterLandingLease(setup({
    now: () => current,
    readGitHub: async () => { current = 990_000; return remote(); }
  }));
  assert.equal(result.error, 'lease_expired_or_short');
});

test('the runtime must inject trusted callbacks explicitly', async () => {
  assert.equal((await preflightAfterLandingLease(setup({ checkPolicy: null }))).error, 'invalid_input');
  assert.equal((await preflightAfterLandingLease(setup({ readGitHub: null }))).error, 'invalid_input');
  assert.equal((await preflightAfterLandingLease(setup({ now: () => NaN }))).error, 'lease_expired_or_short');
  assert.equal((await preflightAfterLandingLease(setup({ minRemainingMs: -1 }))).error, 'invalid_input');
});
