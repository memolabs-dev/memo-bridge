// Engine-independent contract for Coordinator storage. A future Postgres adapter is added
// to STORES and must pass unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPrivateLocation, openSqliteStore } from '../server/coordinator/store.mjs';
import { tempStateDir } from './helpers/coordinator-fixture.mjs';

const STORES = [{ engine: 'sqlite', open: dir => openSqliteStore({ dir }) }];
const T = 1_700_000_000_000;
const workspace = id => ({ id, principal: 'local:owner', client_type: 'cli', project_id: 'drop', host: 'mac',
  status: 'active', created_at: T, updated_at: T });
const task = id => ({ id, project_id: 'drop', title: 't', created_by: 'local:owner', created_at: T, updated_at: T });

for (const { engine, open } of STORES) {
  test(`[${engine}] round trip, compare-and-set on generation, persistence`, async t => {
    const dir = await tempStateDir(t);
    let store = open(dir);
    await store.transaction(repo => {
      repo.insertWorkspace(workspace('ws_1'));
      repo.insertTask(task('task_1'));
      repo.appendEvent({ at: T, principal: 'local:owner', op: 'task_create', outcome: 'ok', task_id: 'task_1' });
    });
    const changed = await store.transaction(repo =>
      repo.updateTask('task_1', { lease_workspace: 'ws_1', lease_generation: 1, lease_expires_at: T + 1, updated_at: T }, 0));
    assert.equal(changed, 1);
    const lost = await store.transaction(repo => repo.updateTask('task_1', { lease_generation: 2, updated_at: T }, 0));
    assert.equal(lost, 0, 'an outdated generation must never overwrite the lease');
    await assert.rejects(store.transaction(repo => repo.updateTask('task_1', { title: 'nope' }, 1)), /invalid_patch/);
    await store.close();

    store = open(dir);
    t.after(() => store.close());
    const row = await store.transaction(repo => repo.getTask('task_1'));
    assert.equal(row.lease_generation, 1);
    assert.equal(row.lease_workspace, 'ws_1');
    assert.equal((await store.transaction(repo => repo.listEvents({ limit: 10 }))).length, 1);
  });

  test(`[${engine}] a failing transaction leaves no partial write`, async t => {
    const store = open(await tempStateDir(t));
    t.after(() => store.close());
    await assert.rejects(store.transaction(repo => {
      repo.insertTask(task('task_partial'));
      throw new Error('boom');
    }), /boom/);
    assert.equal(await store.transaction(repo => repo.getTask('task_partial')), null);
    // The store is still usable after a rollback.
    await store.transaction(repo => repo.insertTask(task('task_after')));
    assert.equal((await store.transaction(repo => repo.getTask('task_after'))).id, 'task_after');
  });

  test(`[${engine}] concurrent transactions in one process are serialized`, async t => {
    const store = open(await tempStateDir(t));
    t.after(() => store.close());
    await store.transaction(repo => repo.insertTask(task('task_c')));
    const attempts = await Promise.all(Array.from({ length: 20 }, (_, i) => store.transaction(async repo => {
      const row = repo.getTask('task_c');
      await new Promise(r => setTimeout(r, i % 3));
      return repo.updateTask('task_c', { lease_generation: row.lease_generation + 1, updated_at: T }, row.lease_generation);
    })));
    assert.deepEqual(attempts, Array(20).fill(1));
    assert.equal((await store.transaction(repo => repo.getTask('task_c'))).lease_generation, 20);
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
  assert.deepEqual(store.settings(), { journal_mode: 'wal', busy_timeout: 5000, foreign_keys: 1, schema_version: 1 });
});

test('[sqlite] readers are not blocked by a writer holding the lock in another connection', async t => {
  const dir = await tempStateDir(t);
  const writer = openSqliteStore({ dir });
  const reader = openSqliteStore({ dir, busyTimeoutMs: 0 });
  t.after(async () => { await writer.close(); await reader.close(); });
  await writer.transaction(repo => repo.insertTask(task('task_r')));
  let release;
  const held = writer.transaction(() => new Promise(r => { release = r; }));
  await new Promise(r => setTimeout(r, 20));
  const row = await reader.transaction(repo => repo.getTask('task_r'), { write: false });
  assert.equal(row.id, 'task_r');
  await assert.rejects(reader.transaction(repo => repo.insertTask(task('task_blocked'))), /locked|busy/i);
  release();
  await held;
  await reader.transaction(repo => repo.insertTask(task('task_after_unlock')));
});
