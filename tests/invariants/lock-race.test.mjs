// Invariant: an operator lock is exclusive. However many conversations ask for the same target at
// once, exactly one holds it and every other one is refused locked_by_other_session; a held lock
// survives a hub restart; a hub that cannot read its saved locks refuses every lock instead of
// starting from an empty table (fail closed).
//
// The locks live in one hub process, so the race is N concurrent locks.handle() calls whose
// verifyWorkspace awaits a random 0 to 5 ms: the calls interleave at that await, exactly where
// two real conversations would. The restart cases build the real hub (createHub, not started)
// on a real state directory, so the wiring under test is the one the hub ships with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHub } from '../../bridge/hub.mjs';
import { createOperatorLocks } from '../../bridge/operator-locks.mjs';
import { CAPABILITIES, makePrincipal } from '../../server/coordinator/policy.mjs';
import { tempDir, tempStateDir } from './lib/fixture.mjs';

const PRINCIPAL = makePrincipal('oidc:owner-sub', Object.values(CAPABILITIES), { client_type: 'chatgpt', via: 'hub' });
const SIZES = [6, 12]; // the plan's sizes
const N = 8; // the refusal cases below only need several sessions
const ROUNDS = 25;
const workspaceOf = i => `ws_${String(i).padStart(16, 'W')}`;
const sessionOf = i => String(i).padStart(32, 'a');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const jitter = () => wait(Math.random() * 5);
const verifyWorkspace = async (principal, id) => {
  await jitter();
  return { ok: true, workspace: { workspace_id: id, status: 'active', session_tag: null, project: 'drop' } };
};
const lockArgs = (i, target = '/opt/stacks/drop') => ({ host: 'vps', workspace_id: workspaceOf(i), kind: 'path', target, ttl_seconds: 900 });
const ask = (locks, i, target) => locks.handle('operator_lock', lockArgs(i, target), { principal: PRINCIPAL, clientSession: sessionOf(i) });

for (const n of SIZES) {
  test(`${n} sessions take the same lock: one holder, the rest locked_by_other_session`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const locks = createOperatorLocks({ verifyWorkspace });
      const answers = await Promise.all(Array.from({ length: n }, (_, i) => ask(locks, i)));
      const holders = answers.filter(a => a.ok === true);
      const refused = answers.filter(a => a.ok !== true);
      assert.equal(holders.length, 1, `round ${round}: ${JSON.stringify(answers)}`);
      assert.equal(refused.length, n - 1);
      for (const r of refused) {
        assert.equal(r.error, 'locked_by_other_session', JSON.stringify(r));
        assert.equal(r.holder.workspace_id, holders[0].lock.workspace_id);
      }
      assert.equal(locks.size, 1, 'one lock in the table');
    }
  });

  test(`${n} sessions take overlapping paths: the table never holds two overlapping locks of different workspaces`, async () => {
    const targets = ['/opt/stacks', '/opt/stacks/drop', '/opt/stacks/drop/app', '/opt/stacks/drop/app/src', '/opt/stacks/other'];
    for (let round = 0; round < ROUNDS; round++) {
      const locks = createOperatorLocks({ verifyWorkspace });
      const answers = await Promise.all(Array.from({ length: n }, (_, i) => ask(locks, i, targets[i % targets.length])));
      for (const a of answers) assert.ok(a.ok === true || a.error === 'locked_by_other_session', JSON.stringify(a));
      const held = answers.filter(a => a.ok === true).map(a => a.lock);
      assert.ok(held.length >= 1);
      // /opt/stacks covers every drop path, so a holder of it is alone; /opt/stacks/other only
      // overlaps /opt/stacks.
      const inside = p => p === '/opt/stacks/drop' || p.startsWith('/opt/stacks/drop/');
      for (const a of held) {
        for (const b of held) {
          if (a === b) continue;
          const overlap = a.target === '/opt/stacks' || b.target === '/opt/stacks' || (inside(a.target) && inside(b.target));
          assert.equal(overlap, false, `${a.target} (${a.workspace_id}) and ${b.target} (${b.workspace_id}) are both held`);
        }
      }
    }
  });
}

// The real hub on a state directory, not started: its own wiring of the locks to hub-state.
let tls = null;
async function tlsPair(t) {
  if (tls) return tls;
  const dir = await tempDir(t, 'memo-invariant-tls-');
  const out = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  tls = { tlsKey: readFileSync(join(dir, 'k'), 'utf8'), tlsCert: readFileSync(join(dir, 'c'), 'utf8') };
  return tls;
}
async function hubOn(t, stateDir) {
  const { privateKey } = generateKeyPairSync('ed25519');
  return createHub({ ...(await tlsPair(t)), tokenSha256: createHash('sha256').update('lock-race-token').digest('hex'), port: 0, stateDir,
    allowedAgentKeys: {}, operator: { signingKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), anchorIntervalMs: 0, verifyWorkspace } });
}

test('a held lock survives a hub restart', async t => {
  const dir = await tempStateDir(t);
  const before = await hubOn(t, dir);
  const taken = await ask(before.operatorLocks, 1);
  assert.equal(taken.ok, true, JSON.stringify(taken));
  assert.ok(existsSync(join(dir, 'locks.json')), 'the table is on disk');

  const after = await hubOn(t, dir);
  assert.equal(after.operatorLocks.size, 1, 'the new hub read the lock back');
  const other = await ask(after.operatorLocks, 2, '/opt/stacks/drop/app');
  assert.equal(other.error, 'locked_by_other_session', JSON.stringify(other));
  assert.equal(other.holder.workspace_id, workspaceOf(1));
  // The holder keeps it: its own call renews instead of conflicting.
  const same = await ask(after.operatorLocks, 1);
  assert.equal(same.ok, true, JSON.stringify(same));
  assert.equal(same.renewed, true);
});

test('a hub that cannot read its saved locks refuses every lock, and serves again once they can be read', async t => {
  const dir = await tempStateDir(t);
  const seeded = await hubOn(t, dir);
  assert.equal((await ask(seeded.operatorLocks, 1)).ok, true);
  const file = join(dir, 'locks.json');
  writeFileSync(file, '{ not json', { mode: 0o600 });

  const hub = await hubOn(t, dir);
  for (let i = 2; i < 2 + N; i++) {
    const out = await ask(hub.operatorLocks, i, `/srv/free-${i}`);
    assert.equal(out.ok, false, JSON.stringify(out));
    assert.equal(out.error, 'locks_state_unavailable', JSON.stringify(out));
  }
  // Checking and unlocking are refused too: an empty table must not read as "nobody holds anything".
  const call = { principal: PRINCIPAL, clientSession: sessionOf(2) };
  assert.equal(hub.operatorLocks.check('operator_edit', { host: 'vps', path: '/opt/stacks/drop/x', workspace_id: workspaceOf(2) }, call).error,
    'locks_state_unavailable');
  assert.equal((await hub.operatorLocks.handle('operator_unlock', { host: 'vps', workspace_id: workspaceOf(1) }, call)).error, 'locks_state_unavailable');
  // Refusing never overwrites the document it could not read, and nothing is set aside.
  assert.equal(readdirSync(dir).filter(n => n.includes('.corrupt-')).length, 0);
  assert.equal(readFileSync(file, 'utf8'), '{ not json');

  // A valid document again: the same hub serves, with the table it holds .
  writeFileSync(file, JSON.stringify({ version: 1, data: { locks: [], families: [] } }), { mode: 0o600 });
  const back = await ask(hub.operatorLocks, 2, '/srv/free-2');
  assert.equal(back.ok, true, JSON.stringify(back));
  const conflict = await ask(hub.operatorLocks, 3, '/srv/free-2/sub');
  assert.equal(conflict.error, 'locked_by_other_session');
});

test('removing an unreadable locks file resets the table and restores service; overview and the refusal say what is wrong', async t => {
  const dir = await tempStateDir(t);
  const seeded = await hubOn(t, dir);
  assert.equal((await ask(seeded.operatorLocks, 1)).ok, true);
  const file = join(dir, 'locks.json');
  writeFileSync(file, '{ not json', { mode: 0o600 });

  const hub = await hubOn(t, dir);
  const refused = await ask(hub.operatorLocks, 2);
  assert.equal(refused.error, 'locks_state_unavailable');
  assert.match(refused.detail, /locks\.json/);
  assert.match(refused.detail, /remove it to reset every lock/);
  const unknown = hub.operatorLocks.overview(PRINCIPAL, sessionOf(2));
  assert.equal(unknown.locks_state, 'unavailable');
  assert.deepEqual(unknown.locks, []);

  unlinkSync(file);
  const back = await ask(hub.operatorLocks, 2);
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(hub.operatorLocks.size, 1, 'an empty table: only the new lock');
  assert.equal(Object.hasOwn(hub.operatorLocks.overview(PRINCIPAL, sessionOf(2)), 'locks_state'), false);
  // Workspace 2 now holds /opt/stacks/drop although workspace 1 held it before the corruption: the removal freed it.
  assert.equal((await ask(hub.operatorLocks, 1, '/opt/stacks/other')).ok, true);
});

test('a locks file of an unknown version also refuses', async t => {
  const dir = await tempStateDir(t);
  await hubOn(t, dir); // creates the directory
  writeFileSync(join(dir, 'locks.json'), JSON.stringify({ version: 99, data: {} }), { mode: 0o600 });
  const hub = await hubOn(t, dir);
  assert.equal((await ask(hub.operatorLocks, 1)).error, 'locks_state_unavailable');
});
