import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, chmodSync, readFileSync, rmSync,
  symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAcpRecoveryJournal } from '../server/runners/acp-recovery-journal.mjs';

const row = (state = 'running') => ({
  session_id: randomUUID(), workspace_id: 'ws_ABCDEFGHIJKLMNOP',
  worktree_id: 'wt_ABCDEFGHIJKLMNOP', issue: 'memolabs-dev/memo-orbit#174',
  state, reason: null, started_at: 1000, ended_at: null
});
const fixture = async run => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-journal-'));
  try { await run(createAcpRecoveryJournal(dir), dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};

test('reopened journal never claims a former running session is live', async () => {
 await fixture(async (journal, dir) => {
  const session = row();
  journal.save(session);
  const rebooted = createAcpRecoveryJournal(dir);
  const result = rebooted.read(session.session_id);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'acp_recovery_required');
  assert.equal(result.state, 'recovery_required');
  assert.equal(result.reason, 'supervisor_restarted');
  assert.equal(result.session_id, session.session_id);
  assert.equal(result.worktree_id, session.worktree_id);
  assert.equal(result.pid, undefined);
  assert.equal(result.claim_id, undefined);
 });
});

test('stopped sessions remain stopped on a new controller, without pretending control', async () => {
 await fixture(async (journal, dir) => {
  const session = row('stopped');
  session.reason = 'user_cancelled';
  session.ended_at = 2000;
  journal.save(session);
  const result = createAcpRecoveryJournal(dir).read(session.session_id);
  assert.equal(result.ok, true);
  assert.equal(result.state, 'stopped');
  assert.equal(result.reason, 'user_cancelled');
  assert.equal(result.ended_at, 2000);
 });
});

test('atomic updates preserve last state and record no prompt, credentials or path', async () => {
 await fixture(async (journal, dir) => {
  const session = row('starting');
  journal.save(session);
  session.state = 'running';
  journal.save(session);
  session.state = 'stopped';
  session.ended_at = 3000;
  journal.save(session);
  const written = readFileSync(join(dir,'acp-session-receipts',
    session.session_id+'.json'), 'utf8');
  assert.deepEqual(JSON.parse(written), session);
  assert.equal(written.includes('prompt'), false);
  assert.equal(written.includes('/Users/'), false);
  assert.equal(written.includes('token'), false);
 });
});

test('unknown sessions and invalid IDs cannot escape private state directory', async () => {
 await fixture(async journal => {
  assert.equal(journal.read(randomUUID()),null);
  for (const bad of ['', '../secrets', '/etc/passwd', 'x'.repeat(200)]) {
    assert.throws(() => journal.read(bad), /acp_recovery_invalid_id/);
  }
 });
});

test('a symlink or world-readable journal directory fails closed', async () => {
 await fixture(async (journal, dir) => {
  const folder = join(dir, 'acp-session-receipts');
  symlinkSync(dir, folder);
  assert.throws(() => journal.save(row()), /acp_recovery_unsafe_directory/);
  rmSync(folder);
  mkdirSync(folder, { mode: 0o700 });
  chmodSync(folder, 0o755); // defeat the test runner's restrictive umask
  assert.throws(() => journal.save(row()), /acp_recovery_unsafe_directory/);
  chmodSync(folder,0o700);
  const session=row();
  journal.save(session);
  assert.equal(journal.read(session.session_id).state,'recovery_required');
 });
});

test('tampered, unsafe or symlinked receipts never become valid evidence', async () => {
 await fixture(async (journal, dir) => {
  const session = row();
  journal.save(session);
  const path = join(dir, 'acp-session-receipts', session.session_id+'.json');
  writeFileSync(path, '{"session_id":"wrong"}');
  assert.throws(() => journal.read(session.session_id),/acp_recovery_unavailable/);
  rmSync(path);
  symlinkSync('/etc/hosts',path);
  assert.throws(() => journal.read(session.session_id),/acp_recovery_unavailable/);
 });
});

test('invalid issue paths or secret-bearing reasons cannot be persisted', async () => {
 await fixture(async journal => {
  const invalid = row();
  invalid.issue = '../../other';
  assert.throws(() => journal.save(invalid), /acp_recovery_invalid_record/);
  const secret = row();
  secret.reason = 'token=secret';
  assert.throws(() => journal.save(secret), /acp_recovery_invalid_record/);
 });
});

test('the journal cannot be created outside an absolute state directory', () => {
 assert.throws(()=>createAcpRecoveryJournal('../state'), /acp_recovery_invalid_directory/);
});
