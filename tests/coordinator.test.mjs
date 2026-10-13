// End-to-end tests of the Coordinator against the canonical lease ledger
// (memolabs-dev/.github scripts/issue_lease.py), run offline through a fake `gh`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCoordinator } from '../server/coordinator/index.mjs';
import { createIssueLeaseClient, parseIssueRef as parseRef } from '../server/coordinator/issue-lease.mjs';
import { CAPABILITIES, authorize, localOwnerPrincipal, makePrincipal } from '../server/coordinator/policy.mjs';
import { GOVERNANCE_ROOT, OWNER, coordinatorOn, fakeGitHub, ledgerFor, skipWithoutLedger, stubProjects, tempDir, tempStateDir } from './helpers/coordinator-fixture.mjs';

const DROP = 'memolabs-dev/drop#7';

async function setup(t, { issues, repos } = {}) {
  const github = await fakeGitHub(t, issues);
  const stateDir = await tempStateDir(t);
  const { store, coordinator } = coordinatorOn(stateDir, { ledger: ledgerFor(github), repos });
  t.after(() => store.close());
  const ws = async (project = 'drop') =>
    (await coordinator.workspaceOpen({ project, client_type: 'claude-code' })).workspace.workspace_id;
  return { github, stateDir, store, coordinator, ws };
}

test('happy path: claim, heartbeat, checkpoint, release, all through the canonical ledger', { skip: skipWithoutLedger }, async t => {
  const { coordinator, ws } = await setup(t);
  const a = await ws();
  const claim = await coordinator.issueClaim({ workspace_id: a, issue: DROP, ttl_seconds: 120 });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  assert.match(claim.claim_id, /^[0-9a-f]{32}$/);
  assert.match(claim.fence, /^[0-9a-f]{40}$/);
  assert.equal(claim.epoch, 1);
  assert.equal(claim.worker, `mb.mac.${a}`);
  assert.equal(claim.project_origin_verified, true);

  const status = await coordinator.issueStatus({ issue: DROP });
  assert.equal(status.lease.state, 'claimed');
  assert.equal(status.lease.fence_sha, claim.fence);

  const beat = await coordinator.issueHeartbeat({ workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence });
  assert.equal(beat.ok, true, JSON.stringify(beat));
  assert.notEqual(beat.fence, claim.fence, 'every heartbeat rotates the fence');

  const held = { workspace_id: a, issue: DROP, claim_id: claim.claim_id };
  const stale = await coordinator.issueCheckpoint({ ...held, fence: claim.fence, branch: 'feat/x', commit: 'a'.repeat(40) });
  assert.equal(stale.error, 'stale_lease', 'the pre-heartbeat fence is dead');
  const cp = await coordinator.issueCheckpoint({ ...held, fence: beat.fence, branch: 'feat/x', commit: 'a'.repeat(40), note: 'wip' });
  assert.equal(cp.ok, true, JSON.stringify(cp));
  assert.equal(cp.durability, 'unverified');

  const done = await coordinator.issueRelease({ ...held, fence: beat.fence, outcome: 'completed' });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal((await coordinator.issueStatus({ issue: DROP })).lease.state, 'released');
  assert.equal((await coordinator.issueStatus({ issue: DROP })).checkpoints.length, 1);
  assert.deepEqual((await coordinator.workspaceStatus({ workspace_id: a })).claims, []);

  const ops = (await coordinator.events({ issue: DROP })).events.map(e => `${e.op}:${e.outcome}`).reverse();
  assert.deepEqual(ops, ['issue_claim:ok', 'issue_heartbeat:ok', 'issue_checkpoint:denied', 'issue_checkpoint:ok', 'issue_release:ok']);
});

test('one holder: a second workspace is refused, then takes over after expiry with a new epoch', { skip: skipWithoutLedger }, async t => {
  const { coordinator, github, ws } = await setup(t);
  const a = await ws(); const b = await ws();
  const first = await coordinator.issueClaim({ workspace_id: a, issue: DROP });
  assert.equal((await coordinator.issueClaim({ workspace_id: b, issue: DROP })).error, 'lease_held');

  await github.expireAll();
  const second = await coordinator.issueClaim({ workspace_id: b, issue: DROP });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.epoch, 2);

  const old = { workspace_id: a, issue: DROP, claim_id: first.claim_id, fence: first.fence };
  assert.equal((await coordinator.issueHeartbeat(old)).error, 'stale_lease');
  assert.equal((await coordinator.issueCheckpoint({ ...old, branch: 'main', commit: 'b'.repeat(40) })).error, 'stale_lease');
  assert.equal((await coordinator.issueRelease({ ...old, outcome: 'failed' })).error, 'stale_lease');
  // Knowing the new holder's claim and fence is not enough from another workspace.
  assert.equal((await coordinator.issueHeartbeat({ workspace_id: a, issue: DROP, claim_id: second.claim_id, fence: second.fence })).error,
    'unknown_claim');
  assert.equal((await coordinator.issueStatus({ issue: DROP })).lease.epoch, 2);
});

test('an expired claim cannot write even when nobody took it over', { skip: skipWithoutLedger }, async t => {
  const { coordinator, github, ws } = await setup(t);
  const a = await ws();
  const claim = await coordinator.issueClaim({ workspace_id: a, issue: DROP });
  await github.expireAll();
  const args = { workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence };
  assert.equal((await coordinator.issueHeartbeat(args)).error, 'stale_lease');
  assert.equal((await coordinator.issueCheckpoint({ ...args, branch: 'main', commit: 'c'.repeat(40) })).error, 'stale_lease');
});

test('governance gates come from the ledger: readiness, allowlist, Issue edits; and the project must match', { skip: skipWithoutLedger }, async t => {
  const { coordinator, github, ws } = await setup(t, { issues: {
    'memolabs-dev/drop#8': { labels: ['priority:p1'] },
    'memolabs-dev/drop#9': { labels: ['agent:ready', 'priority:p1', 'needs:human'] },
    'memolabs-dev/drop#10': { state: 'closed' }
  } });
  const a = await ws();
  assert.equal((await coordinator.issueClaim({ workspace_id: a, issue: 'memolabs-dev/drop#8' })).error, 'issue_not_ready');
  assert.equal((await coordinator.issueClaim({ workspace_id: a, issue: 'memolabs-dev/drop#9' })).error, 'issue_not_ready');
  assert.equal((await coordinator.issueClaim({ workspace_id: a, issue: 'memolabs-dev/drop#10' })).error, 'issue_not_ready');
  assert.equal((await coordinator.issueClaim({ workspace_id: a, issue: 'memolabs-dev/cuesheet#3' })).error, 'project_mismatch');
  const other = await ws('unknown-origin');
  assert.equal((await coordinator.issueClaim({ workspace_id: other, issue: 'guillaume-flambard/kollio#1' })).error, 'repo_not_allowed');

  const claim = await coordinator.issueClaim({ workspace_id: a, issue: DROP });
  await github.editIssue(DROP, { body: 'scope changed after the claim' });
  const args = { workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence };
  assert.equal((await coordinator.issueCheckpoint({ ...args, branch: 'main', commit: 'd'.repeat(40) })).error, 'issue_changed');
  const denied = (await coordinator.events({ limit: 200 })).events.filter(e => e.outcome === 'denied').map(e => e.code);
  assert.ok(denied.includes('issue_not_ready') && denied.includes('repo_not_allowed') && denied.includes('issue_changed'));
});

test('workspace_close releases its claims in the ledger', { skip: skipWithoutLedger }, async t => {
  const { coordinator, ws } = await setup(t);
  const a = await ws(); const b = await ws();
  await coordinator.issueClaim({ workspace_id: a, issue: DROP });
  const closed = await coordinator.workspaceClose({ workspace_id: a });
  assert.deepEqual(closed.released, [DROP]);
  assert.deepEqual(closed.unreleased, []);
  assert.equal((await coordinator.issueStatus({ issue: DROP })).lease.state, 'released');
  assert.equal((await coordinator.issueClaim({ workspace_id: a, issue: DROP })).error, 'workspace_closed');
  assert.equal((await coordinator.issueClaim({ workspace_id: b, issue: DROP })).epoch, 2);
  assert.equal((await coordinator.workspaceClose({ workspace_id: a })).ok, true, 'idempotent');
});

test('local state survives a restart', { skip: skipWithoutLedger }, async t => {
  const github = await fakeGitHub(t);
  const stateDir = await tempStateDir(t);
  let { store, coordinator } = coordinatorOn(stateDir, { ledger: ledgerFor(github) });
  const a = (await coordinator.workspaceOpen({ project: 'drop' })).workspace.workspace_id;
  const claim = await coordinator.issueClaim({ workspace_id: a, issue: DROP });
  await store.close();
  ({ store, coordinator } = coordinatorOn(stateDir, { ledger: ledgerFor(github) }));
  t.after(() => store.close());
  const status = await coordinator.workspaceStatus({ workspace_id: a });
  assert.equal(status.claims[0].claim_id, claim.claim_id);
  assert.equal((await coordinator.issueHeartbeat({ workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence })).ok, true);
});

test('missing capability and foreign workspaces are refused and audited', { skip: skipWithoutLedger }, async t => {
  const { stateDir, coordinator, github, ws } = await setup(t);
  const a = await ws();
  const claim = await coordinator.issueClaim({ workspace_id: a, issue: DROP });
  const reader = makePrincipal('oidc:reader', [CAPABILITIES.READ]);
  const { store: s2, coordinator: readOnly } = coordinatorOn(stateDir, { principal: reader, ledger: ledgerFor(github) });
  t.after(() => s2.close());
  assert.deepEqual(await readOnly.issueClaim({ workspace_id: a, issue: DROP }), { ok: false, error: 'forbidden' });
  assert.deepEqual(await readOnly.workspaceOpen({ project: 'drop' }), { ok: false, error: 'forbidden' });
  assert.deepEqual(await readOnly.issueClaim({ workspace_id: 'nope' }), { ok: false, error: 'forbidden' });
  assert.equal((await readOnly.issueStatus({ issue: DROP })).ok, true);

  const stranger = makePrincipal('oidc:stranger', [CAPABILITIES.READ, CAPABILITIES.WRITE]);
  const { store: s3, coordinator: other } = coordinatorOn(stateDir, { principal: stranger, ledger: ledgerFor(github) });
  t.after(() => s3.close());
  assert.equal((await other.workspaceStatus({ workspace_id: a })).error, 'forbidden');
  assert.equal((await other.workspaceClose({ workspace_id: a })).error, 'forbidden');
  assert.equal((await other.issueRelease({ workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence, outcome: 'cancelled' })).error, 'forbidden');
  assert.equal((await other.events({})).events.every(e => e.principal === 'oidc:stranger'), true);

  const journal = (await coordinator.events({ limit: 200 })).events;
  const deniedBy = p => journal.filter(e => e.principal === p && e.outcome === 'denied' && e.code === 'forbidden');
  assert.equal(deniedBy('oidc:reader').length, 3);
  assert.equal(deniedBy('oidc:stranger').length, 3);
  assert.equal((await coordinator.issueStatus({ issue: DROP })).lease.state, 'claimed');
});

test('checkpoints are verified read-only against the project repository', { skip: skipWithoutLedger }, async t => {
  const root = await tempDir(t, 'memo-checkpoint-');
  const remote = join(root, 'remote.git'); const repo = join(root, 'drop');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).trim();
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'feat/p2p', repo]);
  await writeFile(join(repo, 'a.txt'), 'one');
  git(repo, 'add', 'a.txt'); git(repo, 'commit', '-q', '-m', 'one');
  git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-q', 'origin', 'feat/p2p');
  const pushed = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'a.txt'), 'two'); git(repo, 'commit', '-q', '-am', 'two');
  const unpushed = git(repo, 'rev-parse', 'HEAD');
  const refsBefore = git(repo, 'for-each-ref');

  const { coordinator, ws } = await setup(t, { repos: { drop: repo } });
  const a = await ws();
  const claim = await coordinator.issueClaim({ workspace_id: a, issue: DROP });
  const base = { workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence, branch: 'feat/p2p' };
  assert.equal((await coordinator.issueCheckpoint({ ...base, commit: pushed })).durability, 'remote');
  const local = await coordinator.issueCheckpoint({ ...base, commit: unpushed.toUpperCase() });
  assert.equal(local.durability, 'local_only');
  assert.match(local.warning, /cannot resume/);
  assert.equal((await coordinator.issueCheckpoint({ ...base, commit: 'c'.repeat(40) })).error, 'commit_not_found');
  assert.equal(git(repo, 'for-each-ref'), refsBefore, 'no fetch, no ref moved');
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('invalid inputs are rejected before reaching the ledger', { skip: skipWithoutLedger }, async t => {
  const { coordinator, ws } = await setup(t);
  const a = await ws();
  const claim = await coordinator.issueClaim({ workspace_id: a, issue: DROP });
  const held = { workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence };
  const cases = [
    [coordinator.workspaceOpen({ project: 'unknown' }), 'unknown_project'],
    [coordinator.workspaceOpen({ project: '../etc' }), 'invalid_input'],
    [coordinator.workspaceOpen({ project: 'drop', client_label: 'tab\there' }), 'invalid_input'],
    [coordinator.workspaceOpen({ project: 'drop', branch: '-x' }), 'invalid_input'],
    [coordinator.issueClaim({ workspace_id: a, issue: 'drop#7' }), 'invalid_input'],
    [coordinator.issueClaim({ workspace_id: a, issue: 'a-/b#1' }), 'invalid_input'],
    [coordinator.issueClaim({ workspace_id: a, issue: 'memolabs-dev/drop#123456789' }), 'invalid_input'],
    [coordinator.issueClaim({ workspace_id: a, issue: 'memolabs-dev/drop#7; rm -rf /' }), 'invalid_input'],
    [coordinator.issueClaim({ workspace_id: a, issue: DROP, ttl_seconds: 59 }), 'invalid_input'],
    [coordinator.issueClaim({ workspace_id: a, issue: DROP, ttl_seconds: 1801 }), 'invalid_input'],
    [coordinator.issueClaim({ workspace_id: 'ws_' + 'x'.repeat(16), issue: DROP }), 'unknown_workspace'],
    [coordinator.issueHeartbeat({ ...held, claim_id: 'nope' }), 'invalid_input'],
    [coordinator.issueHeartbeat({ ...held, fence: 'HEAD' }), 'invalid_input'],
    [coordinator.issueRelease({ ...held, outcome: 'merged' }), 'invalid_input'],
    [coordinator.issueCheckpoint({ ...held, branch: 'HEAD', commit: 'a'.repeat(40) }), 'invalid_input'],
    [coordinator.issueCheckpoint({ ...held, branch: 'main', commit: 'main' }), 'invalid_input'],
    [coordinator.issueCheckpoint({ ...held, branch: 'main', commit: 'a'.repeat(40), note: 'x‮y' }), 'invalid_input'],
    [coordinator.events({ limit: 500 }), 'invalid_input']
  ];
  for (const [promise, error] of cases) assert.equal((await promise).error, error);
});

test('an unreachable ledger fails closed without crashing', async t => {
  const stateDir = await tempStateDir(t);
  const ledger = createIssueLeaseClient({ root: '/nonexistent/governance' });
  const { store, coordinator } = coordinatorOn(stateDir, { ledger });
  t.after(() => store.close());
  const a = (await coordinator.workspaceOpen({ project: 'drop' })).workspace.workspace_id;
  assert.equal((await coordinator.issueClaim({ workspace_id: a, issue: DROP })).error, 'ledger_unavailable');
  assert.equal((await coordinator.issueStatus({ issue: DROP })).error, 'ledger_unavailable');
  assert.equal((await coordinator.workspaceStatus({ workspace_id: a })).ok, true);
});

test('policy: unknown operations are never authorized; local owner holds all capabilities', () => {
  assert.equal(authorize(OWNER, 'exec'), false);
  assert.equal(authorize(OWNER, 'issue_claim'), true);
  assert.equal(authorize(null, 'issue_status'), false);
  const local = localOwnerPrincipal({ USER: 'x' });
  assert.match(local.id, /^local:/);
  assert.throws(() => makePrincipal('no colon', []));
  assert.throws(() => createCoordinator({ principal: OWNER, resolveProject: stubProjects() }));
});

// Ledger whose calls can be paused or failed, around the real one. Used to reproduce the
// races and outages found by the adversarial review of #12.
function controllable(real) {
  const gates = {}; const down = new Set(); const lose = new Set();
  const wrap = name => async (...args) => {
    if (down.has(name)) return { ok: false, error: name === 'status' ? 'ledger_unavailable' : 'ledger_outcome_unknown', detail: 'down' };
    if (gates[name]) await gates[name];
    const result = await real[name](...args);
    // The write landed but its outcome never reached us.
    if (lose.has(name) && result.ok) return { ok: false, error: 'ledger_outcome_unknown', detail: 'lost' };
    return result;
  };
  return {
    api: Object.fromEntries(['status', 'claim', 'verify', 'heartbeat', 'release'].map(n => [n, wrap(n)])),
    pause(name) { let open; gates[name] = new Promise(r => { open = r; }); return () => { delete gates[name]; open(); }; },
    down, lose
  };
}

async function setupControlled(t) {
  const github = await fakeGitHub(t);
  const real = ledgerFor(github);
  const ctl = controllable(real);
  const { store, coordinator } = coordinatorOn(await tempStateDir(t), { ledger: ctl.api });
  t.after(() => store.close());
  const a = (await coordinator.workspaceOpen({ project: 'drop' })).workspace.workspace_id;
  return { github, real, ctl, coordinator, a };
}

test('a claim racing workspace_close never leaves an orphan lease', { skip: skipWithoutLedger }, async t => {
  const { real, ctl, coordinator, a } = await setupControlled(t);
  const resume = ctl.pause('claim');
  const pending = coordinator.issueClaim({ workspace_id: a, issue: DROP });
  const closed = await coordinator.workspaceClose({ workspace_id: a });
  assert.deepEqual(closed.released, []);
  resume();
  const claim = await pending;
  assert.equal(claim.error, 'workspace_closed');
  assert.equal(claim.detail, 'claim released');
  assert.equal((await real.status(parseRef(DROP))).receipt.state, 'released');
});

test('workspace_close can be retried after a ledger outage', { skip: skipWithoutLedger }, async t => {
  const { real, ctl, coordinator, a } = await setupControlled(t);
  await coordinator.issueClaim({ workspace_id: a, issue: DROP });
  ctl.down.add('release'); ctl.down.add('status');
  const first = await coordinator.workspaceClose({ workspace_id: a });
  assert.equal(first.workspace.status, 'closed');
  assert.deepEqual(first.unreleased.map(u => u.issue), [DROP]);
  assert.equal((await real.status(parseRef(DROP))).receipt.state, 'claimed');
  ctl.down.clear();
  const second = await coordinator.workspaceClose({ workspace_id: a });
  assert.deepEqual(second.released, [DROP]);
  assert.equal((await real.status(parseRef(DROP))).receipt.state, 'released');
});

test('workspace_close reconciles a stale local fence instead of claiming a release', { skip: skipWithoutLedger }, async t => {
  const { real, coordinator, a } = await setupControlled(t);
  const claim = await coordinator.issueClaim({ workspace_id: a, issue: DROP });
  // A heartbeat landed in the ledger but the local mirror never saw the new fence.
  await real.heartbeat(parseRef(DROP), claim.worker, claim.claim_id, claim.fence, 300);
  const closed = await coordinator.workspaceClose({ workspace_id: a });
  assert.deepEqual(closed.released, [DROP]);
  assert.deepEqual(closed.lost, []);
  assert.equal((await real.status(parseRef(DROP))).receipt.state, 'released');
});

test('a claim whose outcome was lost is recovered, not orphaned', { skip: skipWithoutLedger }, async t => {
  const { real, ctl, coordinator, a } = await setupControlled(t);
  ctl.lose.add('claim');
  const claim = await coordinator.issueClaim({ workspace_id: a, issue: DROP });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  assert.equal(claim.recovered, true);
  ctl.lose.clear();
  const done = await coordinator.issueRelease({ workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence, outcome: 'completed' });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal((await real.status(parseRef(DROP))).receipt.state, 'released');
});

test('a heartbeat whose outcome was lost adopts the new fence', { skip: skipWithoutLedger }, async t => {
  const { ctl, coordinator, a } = await setupControlled(t);
  const claim = await coordinator.issueClaim({ workspace_id: a, issue: DROP });
  ctl.lose.add('heartbeat');
  const beat = await coordinator.issueHeartbeat({ workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence });
  assert.equal(beat.ok, true, JSON.stringify(beat));
  assert.notEqual(beat.fence, claim.fence);
  ctl.lose.clear();
  const status = await coordinator.workspaceStatus({ workspace_id: a });
  assert.equal(status.claims[0].fence, beat.fence, 'the local mirror follows the ledger');
});

test('a ledger timeout kills the whole process group: nothing is written afterwards', { skip: skipWithoutLedger, timeout: 60000 }, async t => {
  const github = await fakeGitHub(t);
  const slow = createIssueLeaseClient({ root: GOVERNANCE_ROOT, timeoutMs: 1500, env: { ...github.env, FAKE_GH_SLOW_REFS: '3' } });
  const result = await slow.claim(parseRef(DROP), 'mb.mac.ws_aaaaaaaaaaaaaaaa', 300);
  assert.equal(result.error, 'ledger_outcome_unknown');
  assert.equal(result.detail, 'timeout');
  await new Promise(r => setTimeout(r, 3500));
  assert.equal((await ledgerFor(github).status(parseRef(DROP))).receipt.state, 'unclaimed');
});

test('release works on a closed workspace and a lost race reads as lease_held', { skip: skipWithoutLedger }, async t => {
  const { real, ctl, coordinator, a } = await setupControlled(t);
  const claim = await coordinator.issueClaim({ workspace_id: a, issue: DROP });
  ctl.down.add('release'); ctl.down.add('status');
  await coordinator.workspaceClose({ workspace_id: a });
  ctl.down.clear();
  const done = await coordinator.issueRelease({ workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence, outcome: 'cancelled' });
  assert.equal(done.ok, true, JSON.stringify(done));
  const b = (await coordinator.workspaceOpen({ project: 'drop' })).workspace.workspace_id;
  await real.claim(parseRef(DROP), 'someone-else', 300);
  ctl.lose.add('claim');
  assert.equal((await coordinator.issueClaim({ workspace_id: b, issue: DROP })).error, 'lease_held');
});
