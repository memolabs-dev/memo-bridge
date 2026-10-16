import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { openSqliteStore, SCHEMA_VERSION } from '../server/coordinator/store.mjs';
import { recordSourceChange, sourceChange, sourceHistory } from '../server/source-engine/changes.mjs';
import { tempStateDir } from './helpers/coordinator-fixture.mjs';

const origin = {
  id: 'drop.7.change1',
  patch: {
    project_id: 'drop',
    issue_ref: 'memolabs-dev/drop#7',
    branch: 'agent/7-aabbccdd',
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
    ci_state: 'pending'
  },
  expected_revision: 0,
  event_id: 'registry-create-00001',
  observed_at: 100,
  at: 1000
};
const open = async t => {
  const dir = await tempStateDir(t);
  const store = openSqliteStore({ dir });
  t.after(() => store.close());
  return { dir, store };
};

test('source changes are append-only, durable and replay idempotently', async t => {
  const { store, dir } = await open(t);
  const initial = await recordSourceChange(store, origin);
  assert.equal(initial.ok, true);
  assert.equal(initial.change.revision, 1);
  assert.equal((await sourceHistory(store, origin.id)).events.length, 1);
  assert.deepEqual((await recordSourceChange(store, origin)).change, initial.change);
  assert.equal((await recordSourceChange(store, origin)).replayed, true);
  const incompatibleReplay = await recordSourceChange(store, {
    ...origin, patch: { ...origin.patch, ci_state: 'success' }
  });
  assert.equal(incompatibleReplay.error, 'idempotency_conflict');
  const next = await recordSourceChange(store, {
    id: origin.id, patch: { ci_state: 'success', pr_number: 12 }, event_id: 'registry-update-00002',
    expected_revision: 1, observed_at: 200, at: 2000
  });
  assert.equal(next.change.revision, 2);
  assert.equal(next.change.pr_number, 12);
  assert.equal((await sourceHistory(store, origin.id)).events.length, 2);
  const listing = await store.transaction(r => r.listSourceChanges({ project_id: 'drop' }), { write: false });
  assert.equal(listing[0].id, origin.id);
  // Independent connection sees committed state; WAL + permissions remain the Coordinator's.
  const another = openSqliteStore({ dir });
  assert.equal((await sourceChange(another, origin.id)).change.ci_state, 'success');
  await another.close();
  assert.equal(SCHEMA_VERSION, 8);
});

test('source optimistic locking serializes concurrent updates', async t => {
  const { store } = await open(t);
  assert.equal((await recordSourceChange(store, origin)).ok, true);
  const responses = await Promise.all(Array.from({ length: 12 }, (_, n) => recordSourceChange(store, {
    id: origin.id, patch: { pr_number: n + 1 }, expected_revision: 1, at: 2000 + n
  })));
  assert.equal(responses.filter(x => x.ok).length, 1);
  assert.equal(responses.filter(x => x.error === 'revision_conflict').length, 11);
  assert.equal((await sourceHistory(store, origin.id)).events.length, 2);
});

test('source registry rejects stale observations, invalid identities and terminal regressions', async t => {
  const { store } = await open(t);
  assert.equal((await recordSourceChange(store, origin)).ok, true);
  const change = ({ patch, observed_at = null, expected_revision = null, event_id = null }) =>
    recordSourceChange(store, { id: origin.id, patch, observed_at, expected_revision, event_id });
  assert.equal((await change({ patch: { issue_ref: 'memolabs-dev/drop#99' } })).error, 'immutable_identity');
  assert.equal((await change({ patch: { ci_state: 'success' }, observed_at: 99 })).error, 'stale_observation');
  assert.equal((await change({ patch: { project_id: 'wrong' } })).error, 'immutable_identity');
  assert.equal((await change({ patch: { token: 'super-secret' } })).error, 'invalid_input');
  assert.equal((await change({ patch: { branch: '../../secrets' } })).error, 'invalid_input');
  const landed = await change({ patch: { ci_state: 'success', landing_state: 'landed' }, observed_at: 200 });
  assert.equal(landed.ok, true);
  assert.equal((await change({ patch: { landing_state: 'open' } })).error, 'invalid_transition');
  assert.equal((await change({ patch: { head_sha: 'c'.repeat(40) } })).error, 'invalid_transition');
});

test('source registry supports bounded history cursor and verifies inputs', async t => {
  const { store } = await open(t);
  await recordSourceChange(store, origin);
  for (let n = 0; n < 3; n++) {
    await recordSourceChange(store, { id: origin.id, patch: { pr_number: n + 1 }, at: 2000 + n });
  }
  const first = await sourceHistory(store, origin.id, { after_seq: 0, limit: 2 });
  const second = await sourceHistory(store, origin.id, { after_seq: first.events.at(-1).seq, limit: 2 });
  assert.equal(first.events.length, 2);
  assert.equal(second.events.length, 2);
  assert.equal((await sourceHistory(store, origin.id, { limit: 1000 })).error, 'invalid_input');
  assert.equal((await sourceChange(store, 'not/valid')).error, 'invalid_input');
  assert.equal((await recordSourceChange(store, { id: 'new.change', patch: { ci_state: 'pending' } })).error, 'missing_identity');
});

test('coordinator v7 migrates source tables in place without losing data', async t => {
  const { dir, store } = await open(t);
  await store.transaction(repo => repo.insertWorkspace({
    id: 'ws_1', principal: 'local:owner', client_type: 'cli', project_id: 'drop',
    host: 'mac', status: 'active', created_at: 1000, updated_at: 1000
  }));
  await store.close();
  const db = new DatabaseSync(join(dir, 'coordinator.sqlite'));
  db.exec('DROP TABLE source_change_events; DROP TABLE source_changes; PRAGMA user_version = 7;');
  db.close();
  const reopened = openSqliteStore({ dir });
  assert.equal(reopened.settings().schema_version, 8);
  assert.equal((await reopened.transaction(repo => repo.getWorkspace('ws_1'), { write: false })).id, 'ws_1');
  assert.equal((await recordSourceChange(reopened, origin)).ok, true);
  await reopened.close();
});
