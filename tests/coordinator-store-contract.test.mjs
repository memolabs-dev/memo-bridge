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
  assert.equal(SCHEMA_VERSION, 6);
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
