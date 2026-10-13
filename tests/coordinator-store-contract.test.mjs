// Engine-independent contract for Coordinator storage. A future Postgres adapter is added
// to STORES and must pass unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

test('[sqlite] AC-09: refuses iCloud and repository locations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'memo-location-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => assertPrivateLocation(join(root, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'x')), /icloud/);
  await mkdir(join(root, 'repo', '.git'), { recursive: true });
  assert.throws(() => openSqliteStore({ dir: join(root, 'repo', 'state') }), /git_repository/);
  assert.doesNotThrow(() => assertPrivateLocation(join(root, 'elsewhere')));
});
