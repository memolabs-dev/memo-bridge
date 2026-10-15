// Durable hub state (inventory 2026-10-14 §4.9): the /freeze flag, /grant standing approvals,
// operator locks and the notification inbox survive a hub restart when the hub has a state
// directory; without one, the hub behaves as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createHubState } from '../bridge/hub-state.mjs';
import { createGrantStore } from '../bridge/operator-grants.mjs';
import { createOperatorLocks } from '../bridge/operator-locks.mjs';
import { createNotifier } from '../bridge/operator-notifications.mjs';
import { createHub } from '../bridge/hub.mjs';
import { makePrincipal } from '../server/coordinator/policy.mjs';
import { CAPABILITIES } from '../server/coordinator/policy.mjs';

const tempDir = t => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-hub-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// A fresh state module on the same directory: what a restarted hub sees.
const reopen = (dir, journal = []) => createHubState({ dir, record: (event, details) => journal.push({ event, ...details }) });

test('state: atomic 0600 documents, read back after a restart; no directory keeps everything in memory', t => {
  const dir = tempDir(t);
  const state = reopen(dir);
  assert.equal(state.durable, true);
  assert.deepEqual(state.load('freeze', null), null, 'nothing saved yet');
  assert.equal(state.save('freeze', { frozen: true, by: 'test' }).ok, true);
  assert.equal(statSync(join(dir, 'freeze.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).filter(n => n.endsWith('.tmp')), [], 'no temporary file left');
  assert.deepEqual(reopen(dir).load('freeze', null), { frozen: true, by: 'test' });

  const memory = createHubState();
  assert.equal(memory.durable, false);
  assert.deepEqual(memory.save('freeze', { frozen: true }), { ok: true, skipped: true });
  assert.equal(memory.load('freeze', 'fallback'), 'fallback');
  assert.throws(() => createHubState({ dir: 'relative/path' }), /absolute/);
});

test('state: a corrupt document is set aside and journaled, the table starts empty; an open directory is refused', t => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'grants.json'), '{not json', { mode: 0o600 });
  const journal = [];
  assert.deepEqual(reopen(dir, journal).load('grants', []), []);
  assert.ok(journal.some(e => e.event === 'hub_state_corrupt' && e.document === 'grants'));
  assert.equal(existsSync(join(dir, 'grants.json')), false);
  assert.equal(readdirSync(dir).filter(n => n.startsWith('grants.json.corrupt-')).length, 1);

  writeFileSync(join(dir, 'locks.json'), JSON.stringify({ version: 99, data: {} }), { mode: 0o600 });
  assert.equal(reopen(dir).load('locks', 'empty'), 'empty', 'an unknown version is not trusted');

  const open = tempDir(t);
  chmodSync(open, 0o755);
  assert.throws(() => createHubState({ dir: open }), /0700/);
  assert.throws(() => reopen(dir).save('unknown', {}), /unknown hub state document/);
});

test('grants: an active /grant still covers its calls after a restart; a revoke survives too', t => {
  const dir = tempDir(t);
  const clock = { t: 1_800_000_000_000 };
  const homes = { mac: '/Users/memo' };
  const open = () => {
    const state = reopen(dir);
    return createGrantStore({ now: () => clock.t, homes, initial: state.load('grants', []), onChange: rows => state.save('grants', rows) });
  };
  const call = { host: 'mac', op: 'operator_run', args: { argv: ['git', 'commit', '-am', 'x'], cwd: '/Users/memo/memolabs/x' }, principal: 'oidc:owner' };
  const before = open();
  const granted = before.grantByOwner({ host: 'mac', programs: ['git'], cwd_prefixes: ['~/memolabs'], ttl_hours: 8 }, 'telegram');
  assert.equal(granted.ok, true);
  const id = granted.grant.id;
  assert.equal(before.covers(call), id);

  const after = open();
  assert.equal(after.covers(call), id, 'the grant survived the restart');
  assert.equal(after.list().length, 1);
  assert.equal(after.revoke(id).ok, true);
  assert.equal(open().covers(call), null, 'the revoke survived the restart');
  clock.t += 9 * 3600_000;
  assert.equal(open().list().length, 0, 'an expired grant is not active after a restart either');
});

test('locks: an operator lock still blocks another conversation after a restart; an unlock survives; implicit locks are not kept', async t => {
  const dir = tempDir(t);
  const CHAT = makePrincipal('oidc:owner-sub', Object.values(CAPABILITIES), { client_type: 'chatgpt', via: 'hub' });
  const WS_A = 'ws_AAAAAAAAAAAAAAAA';
  const WS_B = 'ws_BBBBBBBBBBBBBBBB';
  const SA = 'a'.repeat(32);
  const SB = 'b'.repeat(32);
  const verifyWorkspace = async (principal, id) => ({ ok: true, workspace: { workspace_id: id, status: 'active', session_tag: null, project: 'drop' } });
  const open = () => {
    const state = reopen(dir);
    return createOperatorLocks({ verifyWorkspace, initial: state.load('locks', null), onChange: data => state.save('locks', data) });
  };
  const before = open();
  const taken = await before.handle('operator_lock', { host: 'vps', workspace_id: WS_A, kind: 'path', target: '/opt/stacks/drop', ttl_seconds: 900 },
    { principal: CHAT, clientSession: SA });
  assert.equal(taken.ok, true, JSON.stringify(taken));
  const implicit = before.acquireImplicit('vps', before.targetsOf('operator_edit', { host: 'vps', path: '/opt/other/file' }),
    { principal: CHAT, clientSession: SA, workspaceId: WS_A });
  assert.equal(implicit.ok, true);
  assert.equal(implicit.ids.length, 1);
  // A later explicit change saves the table while the implicit lock is still held.
  assert.equal((await before.handle('operator_lock', { host: 'vps', workspace_id: WS_A, kind: 'unit', target: 'drop.service' },
    { principal: CHAT, clientSession: SA })).ok, true);

  const after = open();
  const blocked = await after.handle('operator_lock', { host: 'vps', workspace_id: WS_B, kind: 'path', target: '/opt/stacks/drop/app' },
    { principal: CHAT, clientSession: SB });
  assert.equal(blocked.error, 'locked_by_other_session', 'the lock survived the restart');
  const free = await after.handle('operator_lock', { host: 'vps', workspace_id: WS_B, kind: 'path', target: '/opt/other' },
    { principal: CHAT, clientSession: SB });
  assert.equal(free.ok, true, 'the implicit per-call lock was not kept');
  assert.equal((await after.handle('operator_unlock', { host: 'vps', workspace_id: WS_A }, { principal: CHAT, clientSession: SA })).ok, true);
  const again = await open().handle('operator_lock', { host: 'vps', workspace_id: WS_B, kind: 'path', target: '/opt/stacks/drop/app' },
    { principal: CHAT, clientSession: SB });
  assert.equal(again.ok, true, 'the unlock survived the restart');
});

test('notifications: the inbox and its acks survive a restart; a watched job is polled again and notified once', async t => {
  const dir = tempDir(t);
  const status = new Map([['job_running000000001', { ok: true, job: { status: 'running' } }], ['job_done00000000001', { ok: true, job: { status: 'succeeded', exit_code: 0 } }]]);
  const open = () => {
    const state = reopen(dir);
    return createNotifier({ poll: async w => status.get(w.job_id), initial: state.load('notifications', null),
      onChange: data => state.save('notifications', data) });
  };
  const principal = { id: 'oidc:owner-sub', client_type: 'chatgpt', capabilities: new Set(['x']) };
  const before = open();
  before.watch({ kind: 'runtime', host: 'vps', job_id: 'job_done00000000001', label: 'test', principal, timeout_s: 900 });
  before.watch({ kind: 'runtime', host: 'vps', job_id: 'job_running000000001', label: 'test', principal, timeout_s: 900 });
  assert.equal(open().check(principal.id).watching, 2, 'a new watch is saved at once');
  assert.equal(await before.pollOnce(), 1);
  assert.equal(before.check(principal.id).unread, 1);

  const after = open();
  assert.deepEqual([after.check(principal.id).unread, after.check(principal.id).watching], [1, 1], 'inbox and the running watch survived');
  const saved = JSON.parse(readFileSync(join(dir, 'notifications.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.data.watches[0].principal).sort(), ['client_type', 'id'], 'only id and client type of the principal are kept');
  const listed = after.get(principal.id);
  assert.equal(after.ack(principal.id, { notification_ids: [listed.notifications[0].notification_id] }).acked, 1);
  assert.equal(open().check(principal.id).unread, 0, 'the ack is saved at once');
  status.set('job_running000000001', { ok: true, job: { status: 'failed', exit_code: 1 } });
  assert.equal(await after.pollOnce(), 1, 'the restored watch is polled and ends');
  const third = open();
  assert.deepEqual([third.check(principal.id).unread, third.check(principal.id).total, third.check(principal.id).watching], [1, 2, 0]);
});

test('hub: a /freeze survives a restart of the hub; /unfreeze survives too; without a state directory nothing is kept', t => {
  const dir = tempDir(t);
  const tlsDir = tempDir(t);
  const out = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(tlsDir, 'k'), '-out', join(tlsDir, 'c')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const base = { tlsKey: readFileSync(join(tlsDir, 'k'), 'utf8'), tlsCert: readFileSync(join(tlsDir, 'c'), 'utf8'),
    tokenSha256: createHash('sha256').update('owner-token-for-state-tests').digest('hex'), allowedAgentKeys: {} };
  const journal = [];
  const first = createHub({ ...base, stateDir: dir, audit: e => journal.push(e) });
  assert.equal(first.operatorFrozen(), false);
  first.setOperatorFrozen(true, 'telegram:test');
  assert.equal(first.operatorFrozen(), true);

  const restarted = createHub({ ...base, stateDir: dir, audit: e => journal.push(e) });
  assert.equal(restarted.operatorFrozen(), true, 'the emergency stop survived the restart');
  assert.ok(journal.some(e => e.event === 'operator_frozen' && e.by === 'restored'));
  restarted.setOperatorFrozen(false, 'telegram:test');
  assert.equal(createHub({ ...base, stateDir: dir }).operatorFrozen(), false, 'the unfreeze survived too');

  const memory = createHub(base);
  memory.setOperatorFrozen(true, 'x');
  assert.equal(createHub(base).operatorFrozen(), false, 'no state directory: in memory, as before');
});
