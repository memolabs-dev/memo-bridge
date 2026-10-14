// Phase 5, TODO-P5-07: store schema v4 (events.via/client_type/request_id,
// workspaces.client_session). The migration is additive: an existing v3 database (Phase 4) keeps
// every row, gains the columns as NULL, and is usable at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { SCHEMA_VERSION, openSqliteStore } from '../server/coordinator/store.mjs';
import { tempStateDir } from './helpers/coordinator-fixture.mjs';

const T = Date.parse('2026-10-14T10:00:00Z');
const V3_EVENT_COLUMNS = ['seq', 'at', 'principal', 'workspace_id', 'issue_ref', 'op', 'outcome', 'code'];
const V3_WORKSPACE_COLUMNS = ['id', 'principal', 'client_type', 'client_label', 'project_id', 'host', 'branch', 'status',
  'created_at', 'updated_at', 'closed_at'];
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

// A database exactly as Phase 4 (v3) left it: the v4 columns and index removed, user_version 3,
// with rows in every table the migration touches.
async function v3Database(t) {
  const dir = await tempStateDir(t);
  const store = openSqliteStore({ dir });
  await store.transaction(repo => {
    repo.insertWorkspace({ id: 'ws_AAAAAAAAAAAAAAAA', principal: 'hub:owner', client_type: 'claude-code', project_id: 'drop',
      host: 'vps', status: 'active', created_at: T, updated_at: T });
    repo.insertClaim({ claim_id: 'a'.repeat(32), workspace_id: 'ws_AAAAAAAAAAAAAAAA', issue_ref: 'memolabs-dev/drop#7',
      fence_sha: 'b'.repeat(40), epoch: 1, expires_at: '2099-01-01T00:00:00+00:00', updated_at: T });
    repo.insertRequest({ key: 'c'.repeat(64), principal: 'hub:owner', op: 'jobs_submit', result_json: '{"job_id":"job_x"}', created_at: T });
  });
  await store.close();
  const raw = new DatabaseSync(join(dir, 'coordinator.sqlite'));
  raw.exec(`BEGIN; DROP INDEX events_request;
    ALTER TABLE events DROP COLUMN via; ALTER TABLE events DROP COLUMN client_type; ALTER TABLE events DROP COLUMN request_id;
    ALTER TABLE workspaces DROP COLUMN client_session;
    INSERT INTO events (at, principal, workspace_id, issue_ref, op, outcome, code)
      VALUES (${T}, 'hub:owner', 'ws_AAAAAAAAAAAAAAAA', 'memolabs-dev/drop#7', 'task_claim', 'ok', NULL);
    PRAGMA user_version = 3; COMMIT;`);
  assert.deepEqual(columns(raw, 'events'), V3_EVENT_COLUMNS);
  assert.deepEqual(columns(raw, 'workspaces'), V3_WORKSPACE_COLUMNS);
  raw.close();
  return dir;
}

test('schema v4: a v3 database migrates in place, keeps every row, and the new columns work', async t => {
  assert.equal(SCHEMA_VERSION, 4);
  const dir = await v3Database(t);
  const store = openSqliteStore({ dir });
  t.after(() => store.close());
  assert.equal(store.settings().schema_version, 4);

  const kept = await store.transaction(repo => ({
    workspace: repo.getWorkspace('ws_AAAAAAAAAAAAAAAA'), claim: repo.getClaim('a'.repeat(32)),
    request: repo.getRequest('c'.repeat(64)), events: repo.listEvents({ limit: 10 })
  }), { write: false });
  assert.equal(kept.workspace.client_type, 'claude-code');
  assert.equal(kept.workspace.client_session, null);
  assert.equal(kept.claim.issue_ref, 'memolabs-dev/drop#7');
  assert.equal(JSON.parse(kept.request.result_json).job_id, 'job_x');
  assert.equal(kept.events.length, 1);
  assert.deepEqual([kept.events[0].op, kept.events[0].via, kept.events[0].client_type, kept.events[0].request_id], ['task_claim', null, null, null]);

  const session = 'd'.repeat(32);
  await store.transaction(repo => {
    repo.updateWorkspace('ws_AAAAAAAAAAAAAAAA', { client_session: session });
    repo.appendEvent({ at: T + 1, principal: 'oidc:owner', workspace_id: 'ws_AAAAAAAAAAAAAAAA', op: 'task_renew', outcome: 'ok',
      via: 'hub', client_type: 'chatgpt', request_id: 'req-mig-0001' });
  });
  const after = await store.transaction(repo => ({ ws: repo.getWorkspace('ws_AAAAAAAAAAAAAAAA'),
    tagged: repo.listEvents({ request_id: 'req-mig-0001', limit: 5 }) }), { write: false });
  assert.equal(after.ws.client_session, session);
  assert.deepEqual([after.tagged[0].via, after.tagged[0].client_type, after.tagged[0].principal], ['hub', 'chatgpt', 'oidc:owner']);
});

test('schema v4: migrating twice, or from an older user_version with the columns already present, is harmless', async t => {
  const dir = await tempStateDir(t);
  await openSqliteStore({ dir }).close();
  // A store rewound to v3 without dropping anything (a partial restore): ADD COLUMN must be skipped.
  const raw = new DatabaseSync(join(dir, 'coordinator.sqlite'));
  raw.exec('PRAGMA user_version = 3');
  raw.close();
  const store = openSqliteStore({ dir });
  t.after(() => store.close());
  assert.equal(store.settings().schema_version, 4);
  const db = new DatabaseSync(join(dir, 'coordinator.sqlite'));
  assert.deepEqual(columns(db, 'events').filter(c => ['via', 'client_type', 'request_id'].includes(c)), ['via', 'client_type', 'request_id']);
  assert.equal(columns(db, 'workspaces').filter(c => c === 'client_session').length, 1);
  db.close();
});

test('a database newer than the code is refused, as before', async t => {
  const dir = await tempStateDir(t);
  await openSqliteStore({ dir }).close();
  const raw = new DatabaseSync(join(dir, 'coordinator.sqlite'));
  raw.exec('PRAGMA user_version = 5');
  raw.close();
  assert.throws(() => openSqliteStore({ dir }), /state_schema_newer_than_code/);
});
