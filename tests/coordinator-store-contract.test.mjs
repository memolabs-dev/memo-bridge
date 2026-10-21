// Engine-independent contract for Coordinator storage. A future Postgres adapter is added
// to STORES and must pass unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, assertPrivateLocation, openSqliteStore } from '../server/coordinator/store.mjs';
import { tempStateDir } from './helpers/coordinator-fixture.mjs';

const STORES = [{ engine: 'sqlite', open: dir => openSqliteStore({ dir }) }];
const T = 1_700_000_000_000;
const workspace = id => ({ id, principal: 'local:owner', client_type: 'cli', project_id: 'drop', host: 'mac',
  status: 'active', created_at: T, updated_at: T });
const claim = (id, fence = 'a'.repeat(40)) => ({ claim_id: id, workspace_id: 'ws_1', issue_ref: 'memolabs-dev/drop#7', fence_sha: fence,
  epoch: 1, expires_at: '2026-10-13T12:00:00+00:00', updated_at: T });

const fence = i => i.toString(16).padStart(40, '0');

for (const { engine, open } of STORES) {
  test(`[${engine}] round trip, compare-and-set on the fence, persistence`, async t => {
    const dir = await tempStateDir(t);
    let store = open(dir);
    await store.transaction(repo => {
      repo.insertWorkspace(workspace('ws_1'));
      repo.insertClaim(claim('c1', fence(1)));
      repo.appendEvent({ at: T, principal: 'local:owner', op: 'task_claim', outcome: 'ok', issue_ref: 'memolabs-dev/drop#7' });
    });
    const changed = await store.transaction(repo => repo.updateClaim('c1', { fence_sha: fence(2), updated_at: T }, fence(1)));
    assert.equal(changed, 1);
    const lost = await store.transaction(repo => repo.updateClaim('c1', { fence_sha: fence(3), updated_at: T }, fence(1)));
    assert.equal(lost, 0, 'an outdated fence must never overwrite the newer one');
    await assert.rejects(store.transaction(repo => repo.updateClaim('c1', { issue_ref: 'x' }, fence(2))), /invalid_patch/);
    await store.close();

    store = open(dir);
    t.after(() => store.close());
    const row = await store.transaction(repo => repo.getClaim('c1'));
    assert.equal(row.fence_sha, fence(2));
    assert.equal((await store.transaction(repo => repo.claimsOf('ws_1', 'claimed'))).length, 1);
    assert.equal((await store.transaction(repo => repo.listEvents({ issue_ref: 'memolabs-dev/drop#7', limit: 10 }))).length, 1);
  });

  test(`[${engine}] a failing transaction leaves no partial write`, async t => {
    const store = open(await tempStateDir(t));
    t.after(() => store.close());
    await store.transaction(repo => repo.insertWorkspace(workspace('ws_1')));
    await assert.rejects(store.transaction(repo => {
      repo.insertClaim(claim('partial'));
      throw new Error('boom');
    }), /boom/);
    assert.equal(await store.transaction(repo => repo.getClaim('partial')), null);
    await store.transaction(repo => repo.insertClaim(claim('after')));
    assert.equal((await store.transaction(repo => repo.getClaim('after'))).claim_id, 'after');
  });

  test(`[${engine}] concurrent transactions in one process are serialized`, async t => {
    const store = open(await tempStateDir(t));
    t.after(() => store.close());
    await store.transaction(repo => { repo.insertWorkspace(workspace('ws_1')); repo.insertClaim(claim('c', fence(0))); });
    const attempts = await Promise.all(Array.from({ length: 20 }, (_, i) => store.transaction(async repo => {
      const row = repo.getClaim('c');
      await new Promise(r => setTimeout(r, i % 3));
      const next = fence(parseInt(row.fence_sha, 16) + 1);
      return repo.updateClaim('c', { fence_sha: next, updated_at: T }, row.fence_sha);
    })));
    assert.deepEqual(attempts, Array(20).fill(1));
    assert.equal((await store.transaction(repo => repo.getClaim('c'))).fence_sha, fence(20));
  });

  test(`[${engine}] foreign keys hold: a claim needs its workspace`, async t => {
    const store = open(await tempStateDir(t));
    t.after(() => store.close());
    await assert.rejects(store.transaction(repo => repo.insertClaim(claim('orphan'))), /FOREIGN KEY/i);
  });
  // Reader contract (#252): owner-wide reads across principals, by project and "changed since".
  test(`[${engine}] reader queries: every principal, project filter, since keeps live rows, event cursor`, async t => {
    const dir = await tempStateDir(t);
    const store = open(dir);
    t.after(() => store.close());
    await store.transaction(repo => {
      repo.insertWorkspace(workspace('ws_1'));
      repo.insertWorkspace({ ...workspace('ws_2'), principal: 'hub:owner', project_id: 'cuesheet', updated_at: T + 10 });
      repo.updateWorkspace('ws_2', { status: 'closed', closed_at: T + 10 });
      repo.insertClaim(claim('c1'));
      repo.insertClaim({ ...claim('c2'), workspace_id: 'ws_2', issue_ref: 'memolabs-dev/cuesheet#3' });
      repo.updateClaim('c2', { state: 'released', updated_at: T + 5 }, 'a'.repeat(40));
      repo.insertCheckpoint({ issue_ref: 'memolabs-dev/drop#7', claim_id: 'c1', workspace_id: 'ws_1', fence_sha: 'a'.repeat(40),
        branch: 'b', commit_sha: 'c'.repeat(40), durability: 'remote', at: T + 1 });
      repo.insertWorktree({ id: 'wt_1', workspace_id: 'ws_1', project_id: 'drop', host: 'mac', path: '/x', branch: 'b', base_ref: 'main',
        base_commit: 'a'.repeat(40), issue_ref: 'memolabs-dev/drop#7', created_at: T, updated_at: T });
      for (const [id, created] of [['job_a', T], ['job_b', T + 20]]) {
        repo.insertJob({ id, workspace_id: 'ws_1', worktree_id: 'wt_1', project_id: 'drop', host: 'mac', recipe: 'test', argv_json: '[]',
          timeout_ms: 1000, log_path: '/x', created_at: created });
      }
      repo.updateJob('job_a', { status: 'running', started_at: T }, 'queued');
      repo.updateJob('job_b', { status: 'succeeded', started_at: T + 20, ended_at: T + 30 }, 'queued');
      for (let i = 0; i < 4; i++) {
        repo.appendEvent({ at: T + i, principal: i % 2 ? 'hub:owner' : 'local:owner', workspace_id: i % 2 ? 'ws_2' : 'ws_1', op: 'x', outcome: 'ok' });
      }
      repo.appendEvent({ at: T + 9, principal: 'local:owner', op: 'y', outcome: 'denied' });
    });
    const read = fn => store.transaction(fn, { write: false });
    assert.deepEqual((await read(repo => repo.readerWorkspaces({ limit: 10 }))).map(w => w.id), ['ws_2', 'ws_1']);
    assert.deepEqual((await read(repo => repo.readerWorkspaces({ project_id: 'cuesheet', limit: 10 }))).map(w => w.id), ['ws_2']);
    assert.deepEqual((await read(repo => repo.readerWorkspaces({ since: T + 50, limit: 10 }))).map(w => w.id), ['ws_1'], 'active stays');
    const claims = await read(repo => repo.readerClaims({ limit: 10 }));
    assert.deepEqual(claims.map(c => [c.claim_id, c.project_id, c.principal]), [['c2', 'cuesheet', 'hub:owner'], ['c1', 'drop', 'local:owner']]);
    assert.deepEqual((await read(repo => repo.readerClaims({ since: T + 50, limit: 10 }))).map(c => c.claim_id), ['c1'], 'claimed stays');
    const jobs = await read(repo => repo.readerJobs({ project_id: 'drop', limit: 10 }));
    assert.deepEqual(jobs.map(j => [j.id, j.issue_ref, j.workspace_principal]), [['job_b', 'memolabs-dev/drop#7', 'local:owner'],
      ['job_a', 'memolabs-dev/drop#7', 'local:owner']]);
    assert.deepEqual((await read(repo => repo.readerJobs({ since: T + 25, live: ['running'], limit: 10 }))).map(j => j.id), ['job_b', 'job_a']);
    assert.deepEqual((await read(repo => repo.readerJobs({ since: T + 40, live: ['running'], limit: 10 }))).map(j => j.id), ['job_a']);
    assert.deepEqual((await read(repo => repo.readerJobs({ since: T + 40, limit: 10 }))).map(j => j.id), [], 'no live statuses given');
    const all = await read(repo => repo.readerEvents({ limit: 10 }));
    assert.equal(all.length, 5);
    const page = await read(repo => repo.readerEvents({ after_seq: all[1].seq, limit: 2 }));
    assert.deepEqual(page.map(e => e.seq), [all[2].seq, all[3].seq]);
    assert.deepEqual((await read(repo => repo.readerEvents({ project_id: 'drop', limit: 10 }))).map(e => e.workspace_id), ['ws_1', 'ws_1']);
    assert.deepEqual((await read(repo => repo.readerEvents({ since: T + 3, limit: 10 }))).map(e => e.op), ['x', 'y']);
    assert.equal((await read(repo => repo.readerLastCheckpoint('c1'))).commit_sha, 'c'.repeat(40));
    assert.equal(await read(repo => repo.readerLastCheckpoint('c2')), null);
  });
}

test('[sqlite] state stays private: 0700 directory, 0600 database', async t => {
  const store = openSqliteStore({ dir: await tempStateDir(t) });
  t.after(() => store.close());
  assert.deepEqual(store.permissions(), { dir: 0o700, file: 0o600 });
});

test('[sqlite] AC-09: refuses synced, repository, relative and shared locations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'memo-location-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => assertPrivateLocation(join(root, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'x')), /synced/);
  assert.throws(() => assertPrivateLocation(join(root, 'library', 'mobile documents', 'x')), /synced/);
  assert.throws(() => assertPrivateLocation(join(root, 'Library', 'CloudStorage', 'Dropbox', 'x')), /synced/);
  assert.throws(() => assertPrivateLocation('relative/state'), /not_absolute/);
  await mkdir(join(root, 'repo', '.git'), { recursive: true });
  assert.throws(() => openSqliteStore({ dir: join(root, 'repo', 'state') }), /git_repository/);
  await mkdir(join(root, 'bare.git', 'objects'), { recursive: true });
  await mkdir(join(root, 'bare.git', 'refs'), { recursive: true });
  await writeFile(join(root, 'bare.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.throws(() => assertPrivateLocation(join(root, 'bare.git', 'state')), /git_repository/);
  const { symlink } = await import('node:fs/promises');
  await symlink(join(root, 'repo'), join(root, 'link-to-repo'));
  assert.throws(() => assertPrivateLocation(join(root, 'link-to-repo', 'state')), /git_repository/);
  await mkdir(join(root, 'shared'), { mode: 0o755 });
  await chmod(join(root, 'shared'), 0o755);
  assert.throws(() => openSqliteStore({ dir: join(root, 'shared') }), /not_private/);
  assert.doesNotThrow(() => assertPrivateLocation(join(root, 'elsewhere')));
});

test('[sqlite] REQ-002: WAL, busy timeout, foreign keys and schema version are applied', async t => {
  const store = openSqliteStore({ dir: await tempStateDir(t) });
  t.after(() => store.close());
  assert.equal(SCHEMA_VERSION, 9);
  assert.deepEqual(store.settings(), { journal_mode: 'wal', busy_timeout: 5000, foreign_keys: 1, schema_version: SCHEMA_VERSION });
});

test('[sqlite] a version 1 store (Phase 2) is upgraded in place to version 2 without losing data', async t => {
  const dir = await tempStateDir(t);
  const first = openSqliteStore({ dir });
  await first.transaction(repo => repo.insertWorkspace(workspace('ws_v1')));
  await first.close();
  // Turn the file back into what a Phase 2 install left behind: no runner tables, user_version 1.
  const raw = new DatabaseSync(join(dir, 'coordinator.sqlite'));
  raw.exec('DROP TABLE job_events; DROP TABLE jobs; DROP TABLE worktrees; PRAGMA user_version = 1;');
  raw.close();
  const upgraded = openSqliteStore({ dir });
  t.after(() => upgraded.close());
  assert.equal(upgraded.settings().schema_version, SCHEMA_VERSION);
  assert.equal((await upgraded.transaction(repo => repo.getWorkspace('ws_v1'), { write: false })).id, 'ws_v1');
  assert.deepEqual(await upgraded.transaction(repo => repo.listWorktrees({ limit: 5 }), { write: false }), []);
});

test('[sqlite] readers are not blocked by a writer holding the lock in another connection', async t => {
  const dir = await tempStateDir(t);
  const writer = openSqliteStore({ dir });
  const reader = openSqliteStore({ dir, busyTimeoutMs: 0 });
  t.after(async () => { await writer.close(); await reader.close(); });
  await writer.transaction(repo => repo.insertWorkspace(workspace('ws_1')));
  let release;
  const held = writer.transaction(() => new Promise(r => { release = r; }));
  await new Promise(r => setTimeout(r, 20));
  const row = await reader.transaction(repo => repo.getWorkspace('ws_1'), { write: false });
  assert.equal(row.id, 'ws_1');
  await assert.rejects(reader.transaction(repo => repo.insertWorkspace(workspace('ws_blocked'))), /locked|busy/i);
  release();
  await held;
  await reader.transaction(repo => repo.insertWorkspace(workspace('ws_after_unlock')));
});

// v9: the store itself refuses a second live claim per Issue and a second active worktree per
// branch or path of one host. Rows in state released/removed never block reuse.
const worktree = (id, extra = {}) => ({ id, workspace_id: 'ws_1', project_id: 'drop', host: 'mac', path: `/wt/${id}`,
  branch: `feat/${id}`, base_ref: 'main', base_commit: 'a'.repeat(40), issue_ref: null, created_at: T, updated_at: T, ...extra });
const FUTURE = '2099-01-01T00:00:00+00:00';
const PAST = '2000-01-01T00:00:00+00:00';

test('v9: a second live claim on the same Issue is refused by the store', async t => {
  const store = openSqliteStore({ dir: await tempStateDir(t) });
  t.after(() => store.close());
  await store.transaction(repo => { repo.insertWorkspace(workspace('ws_1')); repo.insertClaim(claim('c1', fence(1))); });
  await assert.rejects(store.transaction(repo => repo.insertClaim(claim('c2', fence(2)))), /UNIQUE/i);
  const rows = await store.transaction(repo => repo.claimsOfIssue('memolabs-dev/drop#7'), { write: false });
  assert.deepEqual(rows.map(r => [r.claim_id, r.state]), [['c1', 'claimed']]);
  // Once the first claim is released the Issue can be claimed again.
  await store.transaction(repo => repo.updateClaim('c1', { state: 'released', outcome: 'cancelled', updated_at: T }, fence(1)));
  await store.transaction(repo => repo.insertClaim(claim('c3', fence(3))));
});

test('v9: a second active worktree on the same branch or path is refused; a removed one does not block reuse', async t => {
  const store = openSqliteStore({ dir: await tempStateDir(t) });
  t.after(() => store.close());
  await store.transaction(repo => { repo.insertWorkspace(workspace('ws_1')); repo.insertWorktree(worktree('w1')); });
  await assert.rejects(store.transaction(repo => repo.insertWorktree(worktree('w2', { path: '/wt/other', branch: 'feat/w1' }))), /UNIQUE/i);
  await assert.rejects(store.transaction(repo => repo.insertWorktree(worktree('w3', { branch: 'feat/other', path: '/wt/w1' }))), /UNIQUE/i);
  // Same branch name in another project or on another host is a different key.
  await store.transaction(repo => {
    repo.insertWorktree(worktree('w4', { project_id: 'cuesheet', branch: 'feat/w1' }));
    repo.insertWorktree(worktree('w5', { host: 'vps', branch: 'feat/w1', path: '/wt/w1' }));
  });
  await store.transaction(repo => repo.updateWorktree('w1', { status: 'removed', removed_at: T, updated_at: T }));
  await store.transaction(repo => repo.insertWorktree(worktree('w6', { branch: 'feat/w1', path: '/wt/w1' })));
  const active = await store.transaction(repo => repo.listWorktrees({ status: 'active' }), { write: false });
  assert.equal(active.length, 3);
});

// A v8 store as an older server left it: no partial unique indexes, user_version 8.
async function v8Store(t, seed) {
  const dir = await tempStateDir(t);
  const first = openSqliteStore({ dir });
  await first.transaction(repo => repo.insertWorkspace(workspace('ws_1')));
  await first.close();
  const raw = new DatabaseSync(join(dir, 'coordinator.sqlite'));
  raw.exec('DROP INDEX IF EXISTS claims_live_issue; DROP INDEX IF EXISTS worktrees_live_branch; DROP INDEX IF EXISTS worktrees_live_path;');
  seed(raw);
  raw.exec('PRAGMA user_version = 8');
  raw.close();
  return dir;
}
const rawClaim = (raw, id, { issue = 'memolabs-dev/drop#7', epoch = 1, expires = FUTURE, state = 'claimed', at = T } = {}) =>
  raw.prepare(`INSERT INTO claims (claim_id, workspace_id, issue_ref, fence_sha, epoch, expires_at, state, updated_at)
    VALUES (?, 'ws_1', ?, ?, ?, ?, ?, ?)`).run(id, issue, fence(epoch), epoch, expires, state, at);
const rawWorktree = (raw, id, { branch, path, status = 'active' }) =>
  raw.prepare(`INSERT INTO worktrees (id, workspace_id, project_id, host, path, branch, base_ref, base_commit, status, created_at, updated_at)
    VALUES (?, 'ws_1', 'drop', 'mac', ?, ?, 'main', ?, ?, ?, ?)`).run(id, path, branch, 'a'.repeat(40), status, T, T);
const userVersion = dir => {
  const raw = new DatabaseSync(join(dir, 'coordinator.sqlite'));
  try { return Number(raw.prepare('PRAGMA user_version').get().user_version); } finally { raw.close(); }
};

test('v9: a v8 store with an expired and a live claim on one Issue migrates and closes the expired row', async t => {
  const dir = await v8Store(t, raw => {
    rawClaim(raw, 'old', { epoch: 1, expires: PAST });
    rawClaim(raw, 'live', { epoch: 2, expires: FUTURE });
  });
  const store = openSqliteStore({ dir });
  t.after(() => store.close());
  assert.equal(store.settings().schema_version, 9);
  const old = await store.transaction(repo => repo.getClaim('old'), { write: false });
  assert.deepEqual([old.state, old.outcome], ['released', 'expired']);
  assert.equal((await store.transaction(repo => repo.getClaim('live'), { write: false })).state, 'claimed');
  await assert.rejects(store.transaction(repo => repo.insertClaim(claim('third', fence(3)))), /UNIQUE/i);
});

test('v9: duplicate expired claims keep only the newest by epoch', async t => {
  const dir = await v8Store(t, raw => {
    rawClaim(raw, 'e1', { epoch: 1, expires: PAST });
    rawClaim(raw, 'e3', { epoch: 3, expires: PAST });
    rawClaim(raw, 'e2', { epoch: 2, expires: PAST });
  });
  const store = openSqliteStore({ dir });
  t.after(() => store.close());
  const rows = await store.transaction(repo => repo.claimsOfIssue('memolabs-dev/drop#7'), { write: false });
  assert.deepEqual(rows.map(r => [r.claim_id, r.state]).sort(), [['e1', 'released'], ['e2', 'released'], ['e3', 'claimed']]);
});

test('v9: a v8 store with two unexpired claims on one Issue refuses to migrate and stays v8', async t => {
  const dir = await v8Store(t, raw => { rawClaim(raw, 'a', { epoch: 1 }); rawClaim(raw, 'b', { epoch: 2 }); });
  let error;
  try { openSqliteStore({ dir }); } catch (e) { error = e; }
  assert.equal(error?.message, 'state_duplicate_live_rows');
  assert.equal(error.rows.length, 1);
  assert.equal(error.rows[0].table, 'claims');
  assert.deepEqual([...error.rows[0].ids].sort(), ['a', 'b']);
  assert.equal(userVersion(dir), 8);
  const raw = new DatabaseSync(join(dir, 'coordinator.sqlite'));
  t.after(() => raw.close());
  assert.deepEqual(raw.prepare("SELECT claim_id, state FROM claims ORDER BY claim_id").all().map(r => [r.claim_id, r.state]),
    [['a', 'claimed'], ['b', 'claimed']]);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'claims_live_issue'").get().n, 0);
});

test('v9: a v8 store with two active worktrees on one branch or path refuses to migrate and stays v8', async t => {
  for (const [label, seed] of [
    ['branch', raw => { rawWorktree(raw, 'w1', { branch: 'feat/x', path: '/wt/1' }); rawWorktree(raw, 'w2', { branch: 'feat/x', path: '/wt/2' }); }],
    ['path', raw => { rawWorktree(raw, 'w1', { branch: 'feat/a', path: '/wt/1' }); rawWorktree(raw, 'w2', { branch: 'feat/b', path: '/wt/1' }); }]
  ]) {
    const dir = await v8Store(t, seed);
    let error;
    try { openSqliteStore({ dir }); } catch (e) { error = e; }
    assert.equal(error?.message, 'state_duplicate_live_rows', label);
    assert.equal(error.rows[0].table, 'worktrees', label);
    assert.deepEqual([...error.rows[0].ids].sort(), ['w1', 'w2'], label);
    assert.equal(userVersion(dir), 8, label);
  }
  // A removed duplicate is not a live row: it migrates.
  const dir = await v8Store(t, raw => {
    rawWorktree(raw, 'w1', { branch: 'feat/x', path: '/wt/1' });
    rawWorktree(raw, 'w2', { branch: 'feat/x', path: '/wt/1', status: 'removed' });
  });
  const store = openSqliteStore({ dir });
  t.after(() => store.close());
  assert.equal(store.settings().schema_version, 9);
});
