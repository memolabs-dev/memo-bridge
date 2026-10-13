import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoordinator } from '../server/coordinator/index.mjs';
import { CAPABILITIES, authorize, localOwnerPrincipal, makePrincipal } from '../server/coordinator/policy.mjs';
import { OWNER, clock, coordinatorOn, stubProjects, tempStateDir } from './helpers/coordinator-fixture.mjs';

const MIN = 60 * 1000;

async function setup(t, options = {}) {
  const stateDir = await tempStateDir(t);
  const time = clock();
  const { store, coordinator } = coordinatorOn(stateDir, { now: time.now, ...options });
  t.after(() => store.close());
  const ws = async (project = 'drop') =>
    (await coordinator.workspaceOpen({ project, client_type: 'claude-code' })).workspace.workspace_id;
  const task = async (project = 'drop') =>
    (await coordinator.taskCreate({ project, title: 'feature' })).task.task_id;
  return { stateDir, time, store, coordinator, ws, task };
}

test('happy path: open, create, claim, renew, checkpoint (unverified), complete, audited', async t => {
  const { coordinator, ws, task } = await setup(t);
  const a = await ws();
  const id = await task();
  const claim = await coordinator.taskClaim({ workspace_id: a, task_id: id, ttl_seconds: 120 });
  assert.equal(claim.ok, true);
  assert.equal(claim.fencing_token, 1);
  const renew = await coordinator.taskRenew({ workspace_id: a, task_id: id, fencing_token: 1, ttl_seconds: 300 });
  assert.equal(renew.ok, true);
  const cp = await coordinator.taskCheckpoint({ workspace_id: a, task_id: id, fencing_token: 1, branch: 'feat/x', commit: 'a'.repeat(40) });
  assert.equal(cp.ok, true);
  assert.equal(cp.durability, 'unverified');
  assert.match(cp.warning, /not available/);
  const done = await coordinator.taskComplete({ workspace_id: a, task_id: id, fencing_token: 1, summary: 'shipped' });
  assert.equal(done.ok, true);
  assert.equal(done.task.status, 'completed');
  assert.equal(done.task.lease, null);
  const status = await coordinator.taskStatus({ task_id: id });
  assert.equal(status.checkpoints.length, 1);
  const ops = (await coordinator.events({ task_id: id })).events.map(e => `${e.op}:${e.outcome}`).reverse();
  assert.deepEqual(ops, ['task_create:ok', 'task_claim:ok', 'task_renew:ok', 'task_checkpoint:ok', 'task_complete:ok']);
});

test('AC-03: after takeover every write with the old fencing token is refused', async t => {
  const { coordinator, time, ws, task } = await setup(t);
  const a = await ws(); const b = await ws();
  const id = await task();
  const first = await coordinator.taskClaim({ workspace_id: a, task_id: id, ttl_seconds: 60 });
  assert.equal((await coordinator.taskClaim({ workspace_id: b, task_id: id })).error, 'lease_held');
  time.advance(61 * 1000);
  const second = await coordinator.taskClaim({ workspace_id: b, task_id: id });
  assert.equal(second.ok, true);
  assert.equal(second.fencing_token, first.fencing_token + 1);
  const stale = { workspace_id: a, task_id: id, fencing_token: first.fencing_token };
  assert.equal((await coordinator.taskRenew(stale)).error, 'stale_lease');
  assert.equal((await coordinator.taskRelease(stale)).error, 'stale_lease');
  assert.equal((await coordinator.taskComplete(stale)).error, 'stale_lease');
  assert.equal((await coordinator.taskCheckpoint({ ...stale, branch: 'main', commit: 'b'.repeat(40) })).error, 'stale_lease');
  // Even reusing the new token from the wrong workspace fails.
  assert.equal((await coordinator.taskRenew({ workspace_id: a, task_id: id, fencing_token: second.fencing_token })).error, 'stale_lease');
  assert.equal((await coordinator.taskStatus({ task_id: id })).task.lease.workspace_id, b);
  const denied = (await coordinator.events({ task_id: id })).events.filter(e => e.outcome === 'denied');
  assert.ok(denied.length >= 5);
});

test('AC-04: an expired lease cannot write even if nobody reclaimed it', async t => {
  const { coordinator, time, ws, task } = await setup(t);
  const a = await ws(); const id = await task();
  const claim = await coordinator.taskClaim({ workspace_id: a, task_id: id, ttl_seconds: 60 });
  time.advance(60 * 1000);
  const args = { workspace_id: a, task_id: id, fencing_token: claim.fencing_token };
  assert.equal((await coordinator.taskRenew(args)).error, 'stale_lease');
  assert.equal((await coordinator.taskComplete(args)).error, 'stale_lease');
  assert.equal((await coordinator.taskStatus({ task_id: id })).task.status, 'open');
  // The same workspace may claim again, with a new token.
  assert.equal((await coordinator.taskClaim({ workspace_id: a, task_id: id })).fencing_token, 2);
  // A delayed write from the first claim of the same workspace still carries token 1.
  assert.equal((await coordinator.taskRenew(args)).error, 'stale_lease');
  assert.equal((await coordinator.taskComplete(args)).error, 'stale_lease');
  assert.equal((await coordinator.taskRenew({ ...args, fencing_token: 2 })).ok, true);
});

test('AC-05: state survives a restart, generations stay monotonic, completed tasks stay closed', async t => {
  const stateDir = await tempStateDir(t);
  const time = clock();
  let { store, coordinator } = coordinatorOn(stateDir, { now: time.now });
  const a = (await coordinator.workspaceOpen({ project: 'drop' })).workspace.workspace_id;
  const open = (await coordinator.taskCreate({ project: 'drop', title: 'interrupted' })).task.task_id;
  const closed = (await coordinator.taskCreate({ project: 'drop', title: 'finished' })).task.task_id;
  await coordinator.taskClaim({ workspace_id: a, task_id: open, ttl_seconds: 60 });
  const c = await coordinator.taskClaim({ workspace_id: a, task_id: closed });
  await coordinator.taskComplete({ workspace_id: a, task_id: closed, fencing_token: c.fencing_token });
  await store.close(); // simulated crash/restart of the client process

  time.advance(5 * MIN);
  ({ store, coordinator } = coordinatorOn(stateDir, { now: time.now }));
  t.after(() => store.close());
  const b = (await coordinator.workspaceOpen({ project: 'drop' })).workspace.workspace_id;
  assert.equal((await coordinator.workspaceStatus({ workspace_id: a })).workspace.status, 'active');
  assert.equal((await coordinator.taskStatus({ task_id: open })).task.status, 'open');
  const resumed = await coordinator.taskClaim({ workspace_id: b, task_id: open });
  assert.equal(resumed.fencing_token, 2);
  assert.equal((await coordinator.taskClaim({ workspace_id: b, task_id: closed })).error, 'task_closed');
  assert.equal((await coordinator.tasksList({ status: 'completed' })).count, 1);
  assert.ok((await coordinator.events({ limit: 200 })).count >= 6);
});

test('AC-06: missing capability and foreign workspaces are refused and audited', async t => {
  const { stateDir, coordinator, ws, task } = await setup(t);
  const a = await ws(); const id = await task();
  const claim = await coordinator.taskClaim({ workspace_id: a, task_id: id });

  const reader = makePrincipal('oidc:reader', [CAPABILITIES.READ]);
  const { store: s2, coordinator: readOnly } = coordinatorOn(stateDir, { principal: reader });
  t.after(() => s2.close());
  assert.deepEqual(await readOnly.taskCreate({ project: 'drop', title: 'x' }), { ok: false, error: 'forbidden' });
  assert.deepEqual(await readOnly.workspaceOpen({ project: 'drop' }), { ok: false, error: 'forbidden' });
  // Authorization precedes validation: malformed arguments are refused and journaled too.
  assert.deepEqual(await readOnly.taskClaim({ workspace_id: 'nope', ttl_seconds: 1 }), { ok: false, error: 'forbidden' });
  assert.equal((await readOnly.tasksList({})).ok, true);

  const stranger = makePrincipal('oidc:stranger', [CAPABILITIES.READ, CAPABILITIES.WRITE]);
  const { store: s3, coordinator: other } = coordinatorOn(stateDir, { principal: stranger });
  t.after(() => s3.close());
  assert.equal((await other.workspaceStatus({ workspace_id: a })).error, 'forbidden');
  assert.equal((await other.workspaceClose({ workspace_id: a })).error, 'forbidden');
  assert.equal((await other.taskComplete({ workspace_id: a, task_id: id, fencing_token: claim.fencing_token })).error, 'forbidden');
  assert.equal((await other.workspaceList({})).count, 0);
  assert.equal((await other.events({})).events.every(e => e.principal === 'oidc:stranger'), true);

  const journal = (await coordinator.events({ limit: 200 })).events;
  const deniedBy = p => journal.filter(e => e.principal === p && e.outcome === 'denied' && e.code === 'forbidden');
  assert.equal(deniedBy('oidc:reader').length, 3);
  assert.equal(deniedBy('oidc:stranger').length, 3);
  assert.equal((await coordinator.taskStatus({ task_id: id })).task.status, 'claimed');
});

test('AC-07: invalid inputs are rejected before touching state', async t => {
  const { coordinator, ws, task } = await setup(t);
  const a = await ws(); const id = await task();
  const cases = [
    [coordinator.workspaceOpen({ project: 'unknown' }), 'unknown_project'],
    [coordinator.workspaceOpen({ project: '../etc' }), 'invalid_input'],
    [coordinator.workspaceOpen({ project: 'drop', client_type: 'root' }), 'invalid_input'],
    [coordinator.workspaceOpen({ project: 'drop', host: 'router' }), 'invalid_input'],
    [coordinator.workspaceOpen({ project: 'drop', branch: '../../x' }), 'invalid_input'],
    [coordinator.taskCreate({ project: 'drop', title: '' }), 'invalid_input'],
    [coordinator.taskCreate({ project: 'drop', title: 'x\u0007' }), 'invalid_input'],
    [coordinator.taskCreate({ project: 'drop', title: 'x', issue_ref: 'drop#1; rm -rf /' }), 'invalid_input'],
    [coordinator.taskClaim({ workspace_id: a, task_id: id, ttl_seconds: 59 }), 'invalid_input'],
    [coordinator.taskClaim({ workspace_id: a, task_id: id, ttl_seconds: 3601 }), 'invalid_input'],
    [coordinator.taskClaim({ workspace_id: 'ws_' + 'x'.repeat(16), task_id: id }), 'unknown_workspace'],
    [coordinator.taskClaim({ workspace_id: a, task_id: 'task_' + 'y'.repeat(16) }), 'unknown_task'],
    [coordinator.taskCheckpoint({ workspace_id: a, task_id: id, fencing_token: 1, branch: 'main', commit: 'HEAD' }), 'invalid_input'],
    [coordinator.taskCheckpoint({ workspace_id: a, task_id: id, fencing_token: 1, branch: '-x', commit: 'a'.repeat(40) }), 'invalid_input'],
    [coordinator.taskRenew({ workspace_id: a, task_id: id, fencing_token: 0 }), 'invalid_input'],
    [coordinator.tasksList({ limit: 500 }), 'invalid_input'],
    [coordinator.taskCreate({ project: 'drop', title: 'line\nbreak' }), 'invalid_input'],
    [coordinator.taskCreate({ project: 'drop', title: 'ok \u202Eevil' }), 'invalid_input'],
    [coordinator.workspaceOpen({ project: 'drop', client_label: 'tab\there' }), 'invalid_input'],
    [coordinator.taskCreate({ project: 'drop', title: 'x', issue_ref: 'a-/b#1' }), 'invalid_input'],
    [coordinator.taskCheckpoint({ workspace_id: a, task_id: id, fencing_token: 1, branch: 'HEAD', commit: 'a'.repeat(40) }), 'invalid_input'],
    [coordinator.taskCheckpoint({ workspace_id: a, task_id: id, fencing_token: 1, branch: 'refs/heads/main', commit: 'a'.repeat(40) }), 'invalid_input'],
    [coordinator.taskComplete({ workspace_id: a, task_id: id, fencing_token: 1, summary: 'x\u2066y' }), 'invalid_input']
  ];
  for (const [promise, error] of cases) assert.equal((await promise).error, error);
  const kollio = await ws('kollio');
  assert.equal((await coordinator.taskClaim({ workspace_id: kollio, task_id: id })).error, 'project_mismatch');
  assert.equal(await coordinator.taskCreate({ project: 'drop', title: 'ok', issue_ref: 'memolabs-dev/drop#84' })
    .then(r => r.task.issue_ref), 'memolabs-dev/drop#84');
});

test('workspace_close releases its leases and blocks new claims', async t => {
  const { coordinator, ws, task } = await setup(t);
  const a = await ws(); const b = await ws(); const id = await task();
  const claim = await coordinator.taskClaim({ workspace_id: a, task_id: id });
  const closed = await coordinator.workspaceClose({ workspace_id: a });
  assert.deepEqual(closed.released, [id]);
  assert.equal(closed.workspace.status, 'closed');
  assert.equal((await coordinator.workspaceClose({ workspace_id: a })).ok, true);
  assert.equal((await coordinator.taskClaim({ workspace_id: a, task_id: id })).error, 'workspace_closed');
  assert.equal((await coordinator.taskRenew({ workspace_id: a, task_id: id, fencing_token: claim.fencing_token })).error, 'workspace_closed');
  assert.equal((await coordinator.taskClaim({ workspace_id: b, task_id: id })).fencing_token, 2);
});

test('AC-08: checkpoints are verified read-only against the project repository', async t => {
  const root = await mkdtemp(join(tmpdir(), 'memo-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'drop');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).trim();
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'feat/p2p', repo]);
  await writeFile(join(repo, 'a.txt'), 'one');
  git(repo, 'add', 'a.txt'); git(repo, 'commit', '-q', '-m', 'one');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'feat/p2p');
  const pushed = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'a.txt'), 'two');
  git(repo, 'commit', '-q', '-am', 'two');
  const unpushed = git(repo, 'rev-parse', 'HEAD');

  const refsBefore = git(repo, 'for-each-ref');
  const { coordinator, ws, task } = await setup(t, { repos: { drop: repo } });
  const a = await ws(); const id = await task();
  const { fencing_token } = await coordinator.taskClaim({ workspace_id: a, task_id: id });
  const base = { workspace_id: a, task_id: id, fencing_token, branch: 'feat/p2p' };
  assert.equal((await coordinator.taskCheckpoint({ ...base, commit: pushed })).durability, 'remote');
  const local = await coordinator.taskCheckpoint({ ...base, commit: unpushed });
  assert.equal(local.durability, 'local_only');
  assert.match(local.warning, /cannot resume/);
  assert.equal((await coordinator.taskCheckpoint({ ...base, branch: 'other', commit: pushed })).durability, 'local_only');
  assert.equal((await coordinator.taskCheckpoint({ ...base, commit: 'c'.repeat(40) })).error, 'commit_not_found');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), unpushed);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(git(repo, 'for-each-ref'), refsBefore, 'checkpoints must not fetch or move any ref');
  assert.equal((await coordinator.taskCheckpoint({ ...base, commit: pushed.toUpperCase(), note: 'multi\nline ok' })).durability, 'remote');
  assert.equal((await coordinator.taskStatus({ task_id: id })).checkpoints.length, 4);
});

test('policy: unknown operations are never authorized; local owner holds all capabilities', () => {
  assert.equal(authorize(OWNER, 'exec'), false);
  assert.equal(authorize(OWNER, 'task_claim'), true);
  assert.equal(authorize(null, 'task_status'), false);
  const local = localOwnerPrincipal();
  assert.match(local.id, /^local:/);
  assert.equal(authorize(local, 'task_complete'), true);
  assert.throws(() => makePrincipal('no colon', []));
});

test('a coordinator without store or principal refuses to start', () => {
  assert.throws(() => createCoordinator({ principal: OWNER, resolveProject: stubProjects() }));
});

test('tasks_list filters by effective status in storage, beyond any page size', async t => {
  const { coordinator, time, ws } = await setup(t);
  const a = await ws();
  const old = (await coordinator.taskCreate({ project: 'drop', title: 'oldest open' })).task.task_id;
  const claimed = (await coordinator.taskCreate({ project: 'drop', title: 'claimed' })).task.task_id;
  for (let i = 0; i < 260; i++) {
    time.advance(1);
    const id = (await coordinator.taskCreate({ project: 'drop', title: `done ${i}` })).task.task_id;
    const c = await coordinator.taskClaim({ workspace_id: a, task_id: id });
    await coordinator.taskComplete({ workspace_id: a, task_id: id, fencing_token: c.fencing_token });
  }
  await coordinator.taskClaim({ workspace_id: a, task_id: claimed, ttl_seconds: 60 });
  const open = await coordinator.tasksList({ project: 'drop', status: 'open', limit: 1 });
  assert.deepEqual(open.tasks.map(x => x.task_id), [old]);
  assert.deepEqual((await coordinator.tasksList({ status: 'claimed' })).tasks.map(x => x.task_id), [claimed]);
  assert.equal((await coordinator.tasksList({ status: 'completed', limit: 200 })).count, 200);
  time.advance(61 * 1000);
  assert.equal((await coordinator.tasksList({ status: 'open' })).count, 2, 'an expired lease counts as open');
});
