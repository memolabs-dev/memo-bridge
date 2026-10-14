// End-to-end tests of the Coordinator against the canonical lease ledger
// (memolabs-dev/.github scripts/issue_lease.py), run offline through a fake `gh`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCoordinator, decodeOutcome, ghSearchIssues, parsePublicAllowlist, rankTasks, readPublicAllowlist,
  sanitizeExternal, tasksQuery, workerFor } from '../server/coordinator/index.mjs';
import { createIssueLeaseClient, parseIssueRef as parseRef } from '../server/coordinator/issue-lease.mjs';
import { CAPABILITIES, OPERATION_CAPABILITY, authorize, localOwnerPrincipal, makePrincipal } from '../server/coordinator/policy.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { COORDINATOR_TOOLS, registerCoordinatorTools } from '../server/tools/coordinator-tools.mjs';
import { GOVERNANCE_ROOT, HAS_GOVERNANCE, OWNER, PROJECT_ORIGINS, coordinatorOn, fakeGitHub, journal, ledgerFor, skipWithoutLedger,
  stubLedger, stubProjects, tempDir, tempStateDir } from './helpers/coordinator-fixture.mjs';

const DROP = 'memolabs-dev/drop#7';
// Characters a model must never receive, built at run time so this file stays plain ASCII.
const RLO = String.fromCharCode(0x202e);
const BEL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);
const UNSAFE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${RLO}]`);

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
  const { coordinator, store, ws } = await setup(t);
  const a = await ws();
  const claim = await coordinator.taskClaim({ workspace_id: a, issue: DROP, ttl_seconds: 120 });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  assert.match(claim.claim_id, /^[0-9a-f]{32}$/);
  assert.match(claim.fence, /^[0-9a-f]{40}$/);
  assert.equal(claim.epoch, 1);
  assert.equal(claim.worker, `mb.mac.${a}`);
  assert.equal(claim.project_origin_verified, true);

  const status = await coordinator.taskStatus({ issue: DROP });
  assert.equal(status.lease.state, 'claimed');
  assert.equal(status.lease.fence_sha, claim.fence);

  const beat = await coordinator.taskRenew({ workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence });
  assert.equal(beat.ok, true, JSON.stringify(beat));
  assert.notEqual(beat.fence, claim.fence, 'every heartbeat rotates the fence');

  const held = { workspace_id: a, issue: DROP, claim_id: claim.claim_id };
  const stale = await coordinator.taskCheckpoint({ ...held, fence: claim.fence, branch: 'feat/x', commit: 'a'.repeat(40) });
  assert.equal(stale.error, 'stale_lease', 'the pre-heartbeat fence is dead');
  const cp = await coordinator.taskCheckpoint({ ...held, fence: beat.fence, branch: 'feat/x', commit: 'a'.repeat(40), note: 'wip' });
  assert.equal(cp.ok, true, JSON.stringify(cp));
  assert.equal(cp.durability, 'unverified');

  const done = await coordinator.taskRelease({ ...held, fence: beat.fence, outcome: 'completed' });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal((await coordinator.taskStatus({ issue: DROP })).lease.state, 'released');
  assert.equal((await coordinator.taskStatus({ issue: DROP })).checkpoints.length, 1);
  assert.deepEqual((await coordinator.workspaceStatus({ workspace_id: a })).claims, []);

  const ops = (await journal(store, { issue: DROP })).map(e => `${e.op}:${e.outcome}`).reverse();
  assert.deepEqual(ops, ['task_claim:ok', 'task_renew:ok', 'task_checkpoint:denied', 'task_checkpoint:ok', 'task_release:ok']);
});

test('one holder: a second workspace is refused, then takes over after expiry with a new epoch', { skip: skipWithoutLedger }, async t => {
  const { coordinator, github, ws } = await setup(t);
  const a = await ws(); const b = await ws();
  const first = await coordinator.taskClaim({ workspace_id: a, issue: DROP });
  assert.equal((await coordinator.taskClaim({ workspace_id: b, issue: DROP })).error, 'lease_held');

  await github.expireAll();
  const second = await coordinator.taskClaim({ workspace_id: b, issue: DROP });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.epoch, 2);

  const old = { workspace_id: a, issue: DROP, claim_id: first.claim_id, fence: first.fence };
  assert.equal((await coordinator.taskRenew(old)).error, 'stale_lease');
  assert.equal((await coordinator.taskCheckpoint({ ...old, branch: 'main', commit: 'b'.repeat(40) })).error, 'stale_lease');
  assert.equal((await coordinator.taskRelease({ ...old, outcome: 'failed' })).error, 'stale_lease');
  // Knowing the new holder's claim and fence is not enough from another workspace.
  assert.equal((await coordinator.taskRenew({ workspace_id: a, issue: DROP, claim_id: second.claim_id, fence: second.fence })).error,
    'unknown_claim');
  assert.equal((await coordinator.taskStatus({ issue: DROP })).lease.epoch, 2);
});

test('an expired claim cannot write even when nobody took it over', { skip: skipWithoutLedger }, async t => {
  const { coordinator, github, ws } = await setup(t);
  const a = await ws();
  const claim = await coordinator.taskClaim({ workspace_id: a, issue: DROP });
  await github.expireAll();
  const args = { workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence };
  assert.equal((await coordinator.taskRenew(args)).error, 'stale_lease');
  assert.equal((await coordinator.taskCheckpoint({ ...args, branch: 'main', commit: 'c'.repeat(40) })).error, 'stale_lease');
});

test('governance gates come from the ledger: readiness, allowlist, Issue edits; and the project must match', { skip: skipWithoutLedger }, async t => {
  const { coordinator, store, github, ws } = await setup(t, { issues: {
    'memolabs-dev/drop#8': { labels: ['priority:p1'] },
    'memolabs-dev/drop#9': { labels: ['agent:ready', 'priority:p1', 'needs:human'] },
    'memolabs-dev/drop#10': { state: 'closed' }
  } });
  const a = await ws();
  assert.equal((await coordinator.taskClaim({ workspace_id: a, issue: 'memolabs-dev/drop#8' })).error, 'issue_not_ready');
  assert.equal((await coordinator.taskClaim({ workspace_id: a, issue: 'memolabs-dev/drop#9' })).error, 'issue_not_ready');
  assert.equal((await coordinator.taskClaim({ workspace_id: a, issue: 'memolabs-dev/drop#10' })).error, 'issue_not_ready');
  assert.equal((await coordinator.taskClaim({ workspace_id: a, issue: 'memolabs-dev/cuesheet#3' })).error, 'project_mismatch');
  const other = await ws('unknown-origin');
  assert.equal((await coordinator.taskClaim({ workspace_id: other, issue: 'guillaume-flambard/kollio#1' })).error, 'repo_not_allowed');

  const claim = await coordinator.taskClaim({ workspace_id: a, issue: DROP });
  await github.editIssue(DROP, { body: 'scope changed after the claim' });
  const args = { workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence };
  assert.equal((await coordinator.taskCheckpoint({ ...args, branch: 'main', commit: 'd'.repeat(40) })).error, 'issue_changed');
  const denied = (await journal(store)).filter(e => e.outcome === 'denied').map(e => e.code);
  assert.ok(denied.includes('issue_not_ready') && denied.includes('repo_not_allowed') && denied.includes('issue_changed'));
});

test('workspace_close releases its claims in the ledger', { skip: skipWithoutLedger }, async t => {
  const { coordinator, ws } = await setup(t);
  const a = await ws(); const b = await ws();
  await coordinator.taskClaim({ workspace_id: a, issue: DROP });
  const closed = await coordinator.workspaceClose({ workspace_id: a });
  assert.deepEqual(closed.released, [DROP]);
  assert.deepEqual(closed.unreleased, []);
  assert.equal((await coordinator.taskStatus({ issue: DROP })).lease.state, 'released');
  assert.equal((await coordinator.taskClaim({ workspace_id: a, issue: DROP })).error, 'workspace_closed');
  assert.equal((await coordinator.taskClaim({ workspace_id: b, issue: DROP })).epoch, 2);
  assert.equal((await coordinator.workspaceClose({ workspace_id: a })).ok, true, 'idempotent');
});

test('local state survives a restart', { skip: skipWithoutLedger }, async t => {
  const github = await fakeGitHub(t);
  const stateDir = await tempStateDir(t);
  let { store, coordinator } = coordinatorOn(stateDir, { ledger: ledgerFor(github) });
  const a = (await coordinator.workspaceOpen({ project: 'drop' })).workspace.workspace_id;
  const claim = await coordinator.taskClaim({ workspace_id: a, issue: DROP });
  await store.close();
  ({ store, coordinator } = coordinatorOn(stateDir, { ledger: ledgerFor(github) }));
  t.after(() => store.close());
  const status = await coordinator.workspaceStatus({ workspace_id: a });
  assert.equal(status.claims[0].claim_id, claim.claim_id);
  assert.equal((await coordinator.taskRenew({ workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence })).ok, true);
});

test('missing capability and foreign workspaces are refused and audited', { skip: skipWithoutLedger }, async t => {
  const { stateDir, store, coordinator, github, ws } = await setup(t);
  const a = await ws();
  const claim = await coordinator.taskClaim({ workspace_id: a, issue: DROP });
  const reader = makePrincipal('peer:reader', [CAPABILITIES.READ]);
  const { store: s2, coordinator: readOnly } = coordinatorOn(stateDir, { principal: reader, ledger: ledgerFor(github) });
  t.after(() => s2.close());
  assert.deepEqual(await readOnly.taskClaim({ workspace_id: a, issue: DROP }), { ok: false, error: 'forbidden' });
  assert.deepEqual(await readOnly.workspaceOpen({ project: 'drop' }), { ok: false, error: 'forbidden' });
  assert.deepEqual(await readOnly.taskClaim({ workspace_id: 'nope' }), { ok: false, error: 'forbidden' });
  assert.equal((await readOnly.taskStatus({ issue: DROP })).ok, true);

  const stranger = makePrincipal('peer:stranger', [CAPABILITIES.READ, CAPABILITIES.WRITE]);
  const { store: s3, coordinator: other } = coordinatorOn(stateDir, { principal: stranger, ledger: ledgerFor(github) });
  t.after(() => s3.close());
  assert.equal((await other.workspaceStatus({ workspace_id: a })).error, 'forbidden');
  assert.equal((await other.workspaceClose({ workspace_id: a })).error, 'forbidden');
  assert.equal((await other.taskRelease({ workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence, outcome: 'cancelled' })).error, 'forbidden');

  const events = await journal(store);
  const deniedBy = p => events.filter(e => e.principal === p && e.outcome === 'denied' && e.code === 'forbidden');
  assert.equal(deniedBy('peer:reader').length, 3);
  assert.equal(deniedBy('peer:stranger').length, 3);
  assert.equal((await coordinator.taskStatus({ issue: DROP })).lease.state, 'claimed');
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
  const claim = await coordinator.taskClaim({ workspace_id: a, issue: DROP });
  const base = { workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence, branch: 'feat/p2p' };
  assert.equal((await coordinator.taskCheckpoint({ ...base, commit: pushed })).durability, 'remote');
  const local = await coordinator.taskCheckpoint({ ...base, commit: unpushed.toUpperCase() });
  assert.equal(local.durability, 'local_only');
  assert.match(local.warning, /cannot resume/);
  assert.equal((await coordinator.taskCheckpoint({ ...base, commit: 'c'.repeat(40) })).error, 'commit_not_found');
  assert.equal(git(repo, 'for-each-ref'), refsBefore, 'no fetch, no ref moved');
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('invalid inputs are rejected before reaching the ledger', { skip: skipWithoutLedger }, async t => {
  const { coordinator, ws } = await setup(t);
  const a = await ws();
  const claim = await coordinator.taskClaim({ workspace_id: a, issue: DROP });
  const held = { workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence };
  const cases = [
    [coordinator.workspaceOpen({ project: 'unknown' }), 'unknown_project'],
    [coordinator.workspaceOpen({ project: '../etc' }), 'invalid_input'],
    [coordinator.workspaceOpen({ project: 'drop', client_label: 'tab\there' }), 'invalid_input'],
    [coordinator.workspaceOpen({ project: 'drop', branch: '-x' }), 'invalid_input'],
    [coordinator.taskClaim({ workspace_id: a, issue: 'drop#7' }), 'invalid_input'],
    [coordinator.taskClaim({ workspace_id: a, issue: 'a-/b#1' }), 'invalid_input'],
    [coordinator.taskClaim({ workspace_id: a, issue: 'memolabs-dev/drop#123456789' }), 'invalid_input'],
    [coordinator.taskClaim({ workspace_id: a, issue: 'memolabs-dev/drop#7; rm -rf /' }), 'invalid_input'],
    [coordinator.taskClaim({ workspace_id: a, issue: DROP, ttl_seconds: 59 }), 'invalid_input'],
    [coordinator.taskClaim({ workspace_id: a, issue: DROP, ttl_seconds: 1801 }), 'invalid_input'],
    [coordinator.taskClaim({ workspace_id: 'ws_' + 'x'.repeat(16), issue: DROP }), 'unknown_workspace'],
    [coordinator.taskRenew({ ...held, claim_id: 'nope' }), 'invalid_input'],
    [coordinator.taskRenew({ ...held, fence: 'HEAD' }), 'invalid_input'],
    [coordinator.taskRelease({ ...held, outcome: 'merged' }), 'invalid_input'],
    [coordinator.taskCheckpoint({ ...held, branch: 'HEAD', commit: 'a'.repeat(40) }), 'invalid_input'],
    [coordinator.taskCheckpoint({ ...held, branch: 'main', commit: 'main' }), 'invalid_input'],
    [coordinator.taskCheckpoint({ ...held, branch: 'main', commit: 'a'.repeat(40), note: 'x\u202ey' }), 'invalid_input'],
    [coordinator.taskComplete({ ...held, summary: 'x'.repeat(2001) }), 'invalid_input'],
    [coordinator.taskComplete({ ...held, summary: `done${RLO}` }), 'invalid_input'],
    [coordinator.tasksList({ limit: 101 }), 'invalid_input'],
    [coordinator.tasksList({ project: '../etc' }), 'invalid_input'],
    [coordinator.tasksList({ project: 'nope' }), 'unknown_project'],
    [coordinator.workspaceRecover({ workspace_id: 'nope' }), 'invalid_input'],
    [coordinator.workspaceRecover({ workspace_id: 'ws_' + 'x'.repeat(16) }), 'unknown_workspace']
  ];
  for (const [promise, error] of cases) assert.equal((await promise).error, error);
});

test('an unreachable ledger fails closed without crashing', async t => {
  const stateDir = await tempStateDir(t);
  const ledger = createIssueLeaseClient({ root: '/nonexistent/governance' });
  const { store, coordinator } = coordinatorOn(stateDir, { ledger });
  t.after(() => store.close());
  const a = (await coordinator.workspaceOpen({ project: 'drop' })).workspace.workspace_id;
  assert.equal((await coordinator.taskClaim({ workspace_id: a, issue: DROP })).error, 'ledger_unavailable');
  assert.equal((await coordinator.taskStatus({ issue: DROP })).error, 'ledger_unavailable');
  assert.equal((await coordinator.workspaceStatus({ workspace_id: a })).ok, true);
});

test('policy: unknown operations are never authorized; local owner holds all capabilities', () => {
  assert.equal(authorize(OWNER, 'exec'), false);
  assert.equal(authorize(OWNER, 'task_claim'), true);
  assert.equal(authorize(null, 'task_status'), false);
  // The pre-contract names are gone: they must never be authorized again.
  for (const old of ['issue_claim', 'issue_status', 'issue_heartbeat', 'issue_release', 'issue_checkpoint', 'coordinator_events']) {
    assert.equal(authorize(OWNER, old), false, old);
  }
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
  const pending = coordinator.taskClaim({ workspace_id: a, issue: DROP });
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
  await coordinator.taskClaim({ workspace_id: a, issue: DROP });
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
  const claim = await coordinator.taskClaim({ workspace_id: a, issue: DROP });
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
  const claim = await coordinator.taskClaim({ workspace_id: a, issue: DROP });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  assert.equal(claim.recovered, true);
  ctl.lose.clear();
  const done = await coordinator.taskRelease({ workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence, outcome: 'completed' });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal((await real.status(parseRef(DROP))).receipt.state, 'released');
});

test('a heartbeat whose outcome was lost adopts the new fence', { skip: skipWithoutLedger }, async t => {
  const { ctl, coordinator, a } = await setupControlled(t);
  const claim = await coordinator.taskClaim({ workspace_id: a, issue: DROP });
  ctl.lose.add('heartbeat');
  const beat = await coordinator.taskRenew({ workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence });
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
  const claim = await coordinator.taskClaim({ workspace_id: a, issue: DROP });
  ctl.down.add('release'); ctl.down.add('status');
  await coordinator.workspaceClose({ workspace_id: a });
  ctl.down.clear();
  const done = await coordinator.taskRelease({ workspace_id: a, issue: DROP, claim_id: claim.claim_id, fence: claim.fence, outcome: 'cancelled' });
  assert.equal(done.ok, true, JSON.stringify(done));
  const b = (await coordinator.workspaceOpen({ project: 'drop' })).workspace.workspace_id;
  await real.claim(parseRef(DROP), 'someone-else', 300);
  ctl.lose.add('claim');
  assert.equal((await coordinator.taskClaim({ workspace_id: b, issue: DROP })).error, 'lease_held');
});

// ---------------------------------------------------------------------------------------------
// task_complete

test('task_complete releases with outcome completed and keeps the summary with the claim', { skip: skipWithoutLedger }, async t => {
  const { coordinator, store, ws } = await setup(t);
  const a = await ws();
  const claim = await coordinator.taskClaim({ workspace_id: a, issue: DROP });
  const held = { workspace_id: a, issue: DROP, claim_id: claim.claim_id };
  const summary = 'Renamed the coordinator tools.\nAll tests green.';
  const done = await coordinator.taskComplete({ ...held, fence: claim.fence, summary });
  assert.deepEqual(done, { ok: true, issue: DROP, released: true, outcome: 'completed', summary });
  assert.equal((await coordinator.taskStatus({ issue: DROP })).lease.state, 'released');
  const row = await store.transaction(repo => repo.getClaim(claim.claim_id));
  assert.deepEqual(decodeOutcome(row.outcome), { outcome: 'completed', summary });
  assert.deepEqual(await coordinator.taskComplete({ ...held, fence: claim.fence }),
    { ok: true, issue: DROP, released: true, outcome: 'completed', summary }, 'repeating reports the recorded completion');
  const ops = (await journal(store, { issue: DROP })).map(e => `${e.op}:${e.outcome}`).reverse();
  assert.deepEqual(ops, ['task_claim:ok', 'task_complete:ok', 'task_complete:ok']);
});

test('task_complete without summary, and with a dead fence, follows task_release', { skip: skipWithoutLedger }, async t => {
  const { coordinator, github, ws } = await setup(t);
  const a = await ws();
  const first = await coordinator.taskClaim({ workspace_id: a, issue: DROP });
  await github.expireAll();
  const args = { workspace_id: a, issue: DROP, claim_id: first.claim_id, fence: first.fence };
  assert.equal((await coordinator.taskComplete(args)).error, 'stale_lease');
  const b = await ws();
  const second = await coordinator.taskClaim({ workspace_id: b, issue: DROP });
  const done = await coordinator.taskComplete({ workspace_id: b, issue: DROP, claim_id: second.claim_id, fence: second.fence });
  assert.deepEqual(done, { ok: true, issue: DROP, released: true, outcome: 'completed' });
});

// ---------------------------------------------------------------------------------------------
// tasks_list

const T0 = Date.parse('2026-10-01T00:00:00Z');
const day = n => new Date(T0 + n * 86400000).toISOString();
function ghItem(repo, number, labels, { created = 0, title = `Task ${number}`, state = 'open', pr = false } = {}) {
  return { number, title, state, created_at: day(created), updated_at: day(created + 1),
    repository_url: `https://api.github.com/repos/${repo}`, labels: labels.map(name => ({ name })),
    html_url: `https://github.com/${repo}/issues/${number}`, ...(pr ? { pull_request: {} } : {}) };
}
const READY = (p, ...rest) => ['agent:ready', `priority:${p}`, ...rest];

function tasksStub(items, { total } = {}) {
  const queries = [];
  return {
    queries,
    searchIssues: async query => { queries.push(query); return { ok: true, total_count: total ?? items.length, incomplete: false, items }; }
  };
}

test('tasks_list ranks claimable Issues of registered and allowlisted repositories only', async t => {
  const stateDir = await tempStateDir(t);
  const items = [
    ghItem('memolabs-dev/drop', 11, READY('p1'), { created: 1 }),
    ghItem('memolabs-dev/drop', 12, READY('p0'), { created: 5 }),
    ghItem('memolabs-dev/cuesheet', 4, READY('p2'), { created: 0 }),
    ghItem('memolabs-dev/drop', 13, READY('p1'), { created: 0, title: `Oldest p1 ${RLO}evil${BEL} ${'x'.repeat(400)}` }),
    ghItem('memolabs-dev/drop', 14, ['agent:ready', 'priority:p0', 'priority:p1']),
    ghItem('memolabs-dev/drop', 15, ['agent:ready']),
    ghItem('memolabs-dev/drop', 16, ['priority:p0']),
    ghItem('memolabs-dev/drop', 17, READY('p0', 'needs:human')),
    ghItem('memolabs-dev/drop', 18, READY('p0', 'agent:working')),
    ghItem('memolabs-dev/drop', 19, READY('p0', 'status:blocked')),
    ghItem('memolabs-dev/drop', 20, READY('p0', 'type:epic')),
    ghItem('memolabs-dev/drop', 21, READY('p0'), { pr: true }),
    ghItem('memolabs-dev/drop', 22, READY('p0'), { state: 'closed' }),
    ghItem('someone/else', 1, READY('p0')),
    ghItem('memolabs-dev/drop', 23, ['agent:ready', 'priority:p3'])
  ];
  const stub = tasksStub(items);
  const { store, coordinator } = coordinatorOn(stateDir, { ledger: stubLedger(), tasks: stub });
  t.after(() => store.close());

  const listed = await coordinator.tasksList({});
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(listed.tasks.map(x => x.issue),
    ['memolabs-dev/drop#12', 'memolabs-dev/drop#13', 'memolabs-dev/drop#11', 'memolabs-dev/cuesheet#4']);
  assert.deepEqual(listed.tasks.map(x => x.priority), ['p0', 'p1', 'p1', 'p2']);
  assert.equal(listed.tasks[2].project, 'drop');
  assert.equal(listed.tasks[3].project, 'cuesheet');
  assert.equal(listed.tasks[0].url, 'https://github.com/memolabs-dev/drop/issues/12');
  const title = listed.tasks[1].title;
  assert.ok(title.length <= 200 && !UNSAFE.test(title), title);
  assert.deepEqual(listed.repositories, ['memolabs-dev/cuesheet', 'memolabs-dev/drop']);
  assert.equal(listed.truncated, false);
  assert.equal(stub.queries.length, 1);
  assert.equal(stub.queries[0], 'is:issue is:open label:"agent:ready" repo:memolabs-dev/cuesheet repo:memolabs-dev/drop');

  const one = await coordinator.tasksList({ limit: 1 });
  assert.deepEqual(one.tasks.map(x => x.issue), ['memolabs-dev/drop#12']);
  assert.equal(one.truncated, true);

  assert.equal((await journal(store)).length, 0, 'successful reads journal nothing');
});

test('tasks_list intersects registered origins with the ledger allowlist', async t => {
  const stateDir = await tempStateDir(t);
  const stub = tasksStub([ghItem('memolabs-dev/drop', 1, READY('p1')), ghItem('memolabs-dev/cuesheet', 2, READY('p0'))]);
  const { store, coordinator } = coordinatorOn(stateDir, { ledger: stubLedger(), tasks: {
    ...stub,
    readAllowlist: async () => ({ ok: true, repos: ['memolabs-dev/drop', 'memolabs-dev/lab-hub'] }),
    listProjectRepos: async () => [{ name: 'drop' }, { name: 'cuesheet' }, { name: 'unknown-origin' }]
  } });
  t.after(() => store.close());
  const listed = await coordinator.tasksList({});
  assert.deepEqual(listed.tasks.map(x => x.issue), ['memolabs-dev/drop#1'], 'cuesheet is registered but not allowlisted');
  assert.deepEqual(listed.repositories, ['memolabs-dev/drop'], 'lab-hub is allowlisted but not registered');
  assert.deepEqual(listed.not_allowed, ['cuesheet']);
  assert.equal(stub.queries.at(-1), 'is:issue is:open label:"agent:ready" repo:memolabs-dev/drop');

  assert.equal((await coordinator.tasksList({ project: 'drop' })).count, 1);
  assert.equal((await coordinator.tasksList({ project: 'cuesheet' })).error, 'repo_not_allowed');
  assert.equal((await coordinator.tasksList({ project: 'unknown-origin' })).error, 'project_origin_unknown');
  const journaled = (await journal(store)).map(e => `${e.op}:${e.outcome}:${e.code}`);
  assert.deepEqual(journaled, ['tasks_list:denied:repo_not_allowed'], 'only the refusal is journaled');
});

test('tasks_list with nothing to search, a GitHub failure, an unreadable allowlist, or no capability', async t => {
  const stateDir = await tempStateDir(t);
  const none = coordinatorOn(stateDir, { ledger: stubLedger(), tasks: {
    readAllowlist: async () => ({ ok: true, repos: ['memolabs-dev/lab-hub'] }),
    searchIssues: async () => { throw new Error('must not search'); }
  } });
  t.after(() => none.store.close());
  assert.deepEqual((await none.coordinator.tasksList({})).tasks, []);

  const down = coordinatorOn(stateDir, { ledger: stubLedger() });
  t.after(() => down.store.close());
  assert.deepEqual(await down.coordinator.tasksList({}), { ok: false, error: 'github_unavailable', detail: 'not stubbed' });

  const noAllowlist = coordinatorOn(stateDir, { ledger: stubLedger(),
    tasks: { readAllowlist: () => readPublicAllowlist('/nonexistent/governance') } });
  t.after(() => noAllowlist.store.close());
  assert.equal((await noAllowlist.coordinator.tasksList({})).error, 'ledger_unavailable');

  const noCatalog = coordinatorOn(stateDir, { ledger: stubLedger(), tasks: { listProjectRepos: async () => { throw new Error('x'); } } });
  t.after(() => noCatalog.store.close());
  assert.equal((await noCatalog.coordinator.tasksList({})).error, 'catalog_unavailable');

  const truncated = coordinatorOn(stateDir, { ledger: stubLedger(),
    tasks: tasksStub([ghItem('memolabs-dev/drop', 1, READY('p1'))], { total: 250 }) });
  t.after(() => truncated.store.close());
  assert.equal((await truncated.coordinator.tasksList({})).truncated, true);

  const nobody = coordinatorOn(stateDir, { ledger: stubLedger(), principal: makePrincipal('peer:nobody', []) });
  t.after(() => nobody.store.close());
  assert.deepEqual(await nobody.coordinator.tasksList({}), { ok: false, error: 'forbidden' });
  const reader = coordinatorOn(stateDir, { ledger: stubLedger(), principal: makePrincipal('peer:reader', [CAPABILITIES.READ]),
    tasks: tasksStub([]) });
  t.after(() => reader.store.close());
  assert.equal((await reader.coordinator.tasksList({})).ok, true, 'coordinator:read is enough');
  const events = await journal(none.store);
  assert.ok(events.some(e => e.principal === 'peer:nobody' && e.op === 'tasks_list' && e.code === 'forbidden'));
});

test('the ledger allowlist is parsed as text, strictly', async () => {
  const sample = '# x\nPUBLIC_ALLOWLIST = frozenset({\n    "memolabs-dev/.github",\n    "memolabs-dev/drop",  # pilot\n})\nOTHER = 1\n';
  assert.deepEqual(parsePublicAllowlist(sample), ['memolabs-dev/.github', 'memolabs-dev/drop']);
  assert.equal(parsePublicAllowlist(sample.replace('"memolabs-dev/drop"', '"memolabs-dev/drop" + EXTRA')), null);
  assert.equal(parsePublicAllowlist(sample.replace('"memolabs-dev/drop"', '"../../etc"')), null);
  assert.equal(parsePublicAllowlist(sample.replace('"memolabs-dev/drop"', 'open("x").read()')), null);
  assert.equal(parsePublicAllowlist('PUBLIC_ALLOWLIST = frozenset({})'), null);
  assert.equal(parsePublicAllowlist(42), null);
  assert.equal((await readPublicAllowlist('/nonexistent/governance')).error, 'ledger_unavailable');
  if (HAS_GOVERNANCE) {
    // The canonical file must keep parsing: a format change in memolabs-dev/.github turns this red.
    const live = await readPublicAllowlist(GOVERNANCE_ROOT);
    assert.equal(live.ok, true, JSON.stringify(live));
    assert.ok(live.repos.includes('memolabs-dev/drop'));
  }
});

test('tasks_list ranking and query helpers', () => {
  const projects = new Map([['memolabs-dev/drop', { name: 'drop', repo: 'memolabs-dev/drop' }]]);
  assert.deepEqual(rankTasks(null, projects), []);
  assert.deepEqual(rankTasks([ghItem('memolabs-dev/drop', 0, READY('p0')), { ...ghItem('memolabs-dev/drop', 1, READY('p0')), number: '1' }],
    projects), [], 'numbers must be positive integers');
  const sameDay = rankTasks([ghItem('memolabs-dev/drop', 9, READY('p1')), ghItem('memolabs-dev/drop', 8, READY('p1'))], projects);
  assert.deepEqual(sameDay.map(x => x.issue), ['memolabs-dev/drop#8', 'memolabs-dev/drop#9']);
  assert.equal(tasksQuery(['a/b']), 'is:issue is:open label:"agent:ready" repo:a/b');
  assert.equal(sanitizeExternal(`a${String.fromCharCode(0)}b${RLO}c\nd`, 10), 'a b c d');
  assert.equal(sanitizeExternal(5, 10), null);
});

test('the GitHub search runs gh with a fixed argv and no shell', async t => {
  const bin = await tempDir(t, 'memo-gh-bin-');
  const log = join(bin, 'argv.json');
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), prompt: process.env.GH_PROMPT_DISABLED }));\nprocess.stdout.write(JSON.stringify({ total_count: 1, incomplete_results: false, items: [{ number: 1 }] }));\n`);
  await chmod(join(bin, 'gh'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const query = 'is:issue is:open label:"agent:ready" repo:memolabs-dev/drop; touch pwned $(id)';
  const out = await ghSearchIssues(query, { env });
  assert.deepEqual(out, { ok: true, total_count: 1, incomplete: false, items: [{ number: 1 }] });
  const seen = JSON.parse(await readFile(log, 'utf8'));
  assert.deepEqual(seen.argv, ['api', '-X', 'GET', 'search/issues', '-f', `q=${query}`, '-f', 'sort=created', '-f', 'order=asc',
    '-f', 'per_page=100']);
  assert.equal(seen.prompt, '1');
  await writeFile(join(bin, 'gh'), '#!/bin/sh\necho not-json\n');
  assert.equal((await ghSearchIssues('q', { env })).error, 'github_unavailable');
  await writeFile(join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
  assert.equal((await ghSearchIssues('q', { env })).error, 'github_unavailable');
});

// ---------------------------------------------------------------------------------------------
// workspace_recover

const HEX = c => c.repeat(40);
// A ledger whose status answers are scripted per Issue; every write is refused and recorded,
// so the test proves workspace_recover never writes to the ledger.
function scriptedLedger(answers = {}) {
  const writes = [];
  const refuse = name => async () => { writes.push(name); return { ok: false, error: 'lease_denied', detail: 'read-only test ledger' }; };
  return {
    writes, answers,
    status: async issue => answers[issue.ref] ?? { ok: false, error: 'ledger_unavailable' },
    claim: refuse('claim'), verify: refuse('verify'), heartbeat: refuse('heartbeat'), release: refuse('release')
  };
}

async function recoverRuntime(t, ledger = scriptedLedger()) {
  const rt = createRuntime({ stateDir: await tempStateDir(t), principal: OWNER, ledger, host: 'mac', resolveProject: stubProjects(),
    projectRemote: project => Promise.resolve(PROJECT_ORIGINS[project.name] ?? null) });
  t.after(() => rt.close());
  return rt;
}

test('workspace_recover reconciles held claims with the ledger and never writes', async t => {
  const ledger = scriptedLedger();
  const rt = await recoverRuntime(t, ledger);
  const coordinator = rt.coordinator();
  const ws = (await coordinator.workspaceOpen({ project: 'drop', client_type: 'codex' })).workspace;
  const worker = workerFor({ host: ws.host, id: ws.workspace_id });
  const claimRow = (n, id, fence) => ({ claim_id: id.repeat(32), workspace_id: ws.workspace_id, issue_ref: `memolabs-dev/drop#${n}`,
    fence_sha: HEX(fence), epoch: 1, expires_at: '2026-10-13T12:00:00+00:00', updated_at: n });
  const answer = (id, extra) => ({ ok: true, receipt: { state: 'claimed', expired: false, worker, claim_id: id.repeat(32),
    fence_sha: HEX('9'), epoch: 3, expires_at: '2099-01-01T00:00:00+00:00', ...extra } });
  Object.assign(ledger.answers, {
    'memolabs-dev/drop#1': answer('a'),
    'memolabs-dev/drop#2': answer('b', { expired: true }),
    'memolabs-dev/drop#3': answer('c', { worker: 'mb.vps.ws_someoneelse00000' }),
    'memolabs-dev/drop#5': answer('e', { state: 'released' })
  });
  await rt.store().transaction(repo => {
    for (const [n, id] of [[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd'], [5, 'e']]) repo.insertClaim(claimRow(n, id, String(n)));
    repo.insertCheckpoint({ issue_ref: 'memolabs-dev/drop#1', claim_id: 'a'.repeat(32), workspace_id: ws.workspace_id,
      fence_sha: HEX('1'), branch: 'feat/one', commit_sha: HEX('c'), durability: 'local_only', note: null, at: 10 });
    repo.insertWorktree({ id: 'wt_1', workspace_id: ws.workspace_id, project_id: 'drop', host: 'mac', path: '/private/secret/wt',
      branch: 'feat/one', base_ref: 'main', base_commit: HEX('0'), issue_ref: 'memolabs-dev/drop#1', created_at: 1, updated_at: 1 });
    repo.insertJob({ id: 'job_1', workspace_id: ws.workspace_id, worktree_id: 'wt_1', project_id: 'drop', host: 'mac', recipe: 'npm-test',
      argv_json: '[]', timeout_ms: 1000, log_path: '/private/secret/log', created_at: 2 });
    repo.updateJob('job_1', { status: 'running', summary: `running ${ESC}[31mred${RLO}` }, 'queued');
  });
  const snapshot = () => rt.store().transaction(repo => ({ events: repo.listEvents({ limit: 200 }).length,
    claims: repo.claimsOf(ws.workspace_id).map(c => `${c.claim_id}:${c.fence_sha}:${c.state}:${c.outcome}`) }), { write: false });
  const before = await snapshot();

  const snap = await coordinator.workspaceRecover({ workspace_id: ws.workspace_id });
  assert.equal(snap.ok, true, JSON.stringify(snap));
  const states = Object.fromEntries(snap.claims.map(c => [c.issue, c.state]));
  assert.deepEqual(states, { 'memolabs-dev/drop#1': 'still_held', 'memolabs-dev/drop#2': 'expired', 'memolabs-dev/drop#3': 'lost',
    'memolabs-dev/drop#4': 'unknown', 'memolabs-dev/drop#5': 'lost' });
  assert.equal(snap.claims[0].issue, 'memolabs-dev/drop#5', 'most recent claim first');
  const one = snap.claims.find(c => c.issue === 'memolabs-dev/drop#1');
  assert.equal(one.fence, HEX('9'), 'the ledger fence, not the stale local one');
  assert.equal(one.local_fence, HEX('1'));
  assert.equal(snap.worker, worker);
  assert.deepEqual(snap.worktrees.map(w => w.worktree_id), ['wt_1']);
  assert.deepEqual(snap.checkpoints.map(c => c.durability), ['local_only']);
  assert.equal(snap.jobs[0].status, 'running');
  assert.ok(!UNSAFE.test(snap.jobs[0].summary), snap.jobs[0].summary);
  assert.ok(!JSON.stringify(snap).includes('/private/secret'), 'local paths never leave the server');
  const actions = snap.next_actions.join('\n');
  assert.match(actions, /Renew memolabs-dev\/drop#1 with task_renew .*fence 9{40}/);
  assert.match(actions, /Push branch feat\/one/);
  assert.match(actions, /memolabs-dev\/drop#2 expired/);
  assert.match(actions, /memolabs-dev\/drop#3 is no longer held/);
  assert.match(actions, /Ledger unreachable for memolabs-dev\/drop#4/);
  assert.match(actions, /Job job_1 is running/);
  assert.ok(snap.next_actions.every(a => a.length <= 300));

  assert.deepEqual(await snapshot(), before, 'no store write, not even a journal entry');
  assert.deepEqual(ledger.writes, [], 'no ledger write');
});

test('workspace_recover on an empty or closed workspace, and for another principal', async t => {
  const rt = await recoverRuntime(t);
  const coordinator = rt.coordinator();
  const id = (await coordinator.workspaceOpen({ project: 'drop' })).workspace.workspace_id;
  const fresh = await coordinator.workspaceRecover({ workspace_id: id });
  assert.deepEqual(fresh.claims, []);
  assert.deepEqual(fresh.next_actions, ['No task held: pick one with tasks_list, then task_claim.']);

  await coordinator.workspaceClose({ workspace_id: id });
  const closed = await coordinator.workspaceRecover({ workspace_id: id });
  assert.equal(closed.workspace.status, 'closed');
  assert.match(closed.next_actions[0], /Workspace is closed/);

  const stranger = createRuntime({ stateDir: rt.stateDir, principal: makePrincipal('peer:stranger', [CAPABILITIES.READ]),
    ledger: stubLedger(), host: 'mac', resolveProject: stubProjects() });
  t.after(() => stranger.close());
  assert.deepEqual(await stranger.coordinator().workspaceRecover({ workspace_id: id }), { ok: false, error: 'forbidden' });
  const denied = (await journal(rt.store())).filter(e => e.principal === 'peer:stranger');
  assert.deepEqual(denied.map(e => `${e.op}:${e.outcome}:${e.code}`), ['workspace_recover:denied:forbidden']);
});

test('workspace_recover against the canonical ledger: held, then expired, then lost', { skip: skipWithoutLedger }, async t => {
  const { coordinator, github, ws } = await setup(t);
  const a = await ws();
  const claim = await coordinator.taskClaim({ workspace_id: a, issue: DROP });
  const held = await coordinator.workspaceRecover({ workspace_id: a });
  assert.equal(held.claims[0].state, 'still_held');
  assert.equal(held.claims[0].fence, claim.fence);
  await github.expireAll();
  assert.equal((await coordinator.workspaceRecover({ workspace_id: a })).claims[0].state, 'expired');
  const b = await ws();
  assert.equal((await coordinator.taskClaim({ workspace_id: b, issue: DROP })).ok, true);
  assert.equal((await coordinator.workspaceRecover({ workspace_id: a })).claims[0].state, 'lost');
});

// ---------------------------------------------------------------------------------------------
// MCP registration

test('registered tools match the contract, the policy table and the runtime', async t => {
  const tools = new Map();
  const server = { registerTool: (name, config, handler) => tools.set(name, { config, handler }) };
  const rt = createRuntime({ stateDir: await tempStateDir(t), principal: OWNER, ledger: stubLedger(), host: 'mac',
    resolveProject: stubProjects(), projectRemote: () => Promise.resolve(null) });
  t.after(() => rt.close());
  registerCoordinatorTools(server, () => rt);
  assert.deepEqual([...tools.keys()].sort(), [...COORDINATOR_TOOLS].sort());
  for (const name of COORDINATOR_TOOLS) {
    assert.ok(OPERATION_CAPABILITY[name], `${name} has a capability`);
    const shape = Object.keys(tools.get(name).config.inputSchema.shape);
    assert.ok(!shape.some(k => /principal|worker|capabilit/.test(k)), `${name} takes no identity argument`);
  }
  const call = async (name, args) => JSON.parse((await tools.get(name).handler(args)).content[0].text);
  const opened = await call('workspace_open', { project: 'drop' });
  assert.equal(opened.ok, true);
  assert.equal((await call('workspace_recover', { workspace_id: opened.workspace.workspace_id })).ok, true);
  const claimed = await call('task_claim', { workspace_id: opened.workspace.workspace_id, issue: DROP });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  // A coordinator can be passed directly too (the pre-runtime entry point).
  const direct = new Map();
  registerCoordinatorTools({ registerTool: (name, config, handler) => direct.set(name, handler) }, () => rt.coordinator());
  assert.equal(JSON.parse((await direct.get('workspace_list')({})).content[0].text).count, 1);
  const broken = new Map();
  registerCoordinatorTools({ registerTool: (name, config, handler) => broken.set(name, handler) },
    () => { throw new Error('state_dir_not_private'); });
  assert.deepEqual(JSON.parse((await broken.get('tasks_list')({})).content[0].text),
    { ok: false, error: 'store_unavailable', detail: 'state_dir_not_private' });
});
