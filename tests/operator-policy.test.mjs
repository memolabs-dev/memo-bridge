// Phase 6, TODO-P6-01 (R-P6-02): the operator policy file. Schema with unknown keys refused,
// the trust check on the file and its directory (fail closed), and the summary the model sees.
// Temporary directories only; "root" ownership is emulated with the trustedUids option.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOperatorPolicy, parseOperatorPolicy, policySummary, trustProblem } from '../bridge/operator-policy.mjs';
import { basePolicy } from './helpers/operator-fixture.mjs';

const ME = process.getuid();
const OTHER = ME + 4242; // the agent user when the file is "root-owned" (owned by a trusted uid that is not the agent)


function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'memo-op-policy-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  chmodSync(dir, 0o755);
  return dir;
}

test('policy schema: a valid file parses into canonical roots, defaults and frozen fields', t => {
  const dir = tempDir(t);
  const p = parseOperatorPolicy(basePolicy({ roots: { read: [dir, '/does/not/exist'], write: [join(dir, '.')] } }));
  assert.equal(p.host, 'vps');
  assert.equal(p.maxTier, 0);
  assert.deepEqual([...p.readRoots], [dir]);
  assert.deepEqual([...p.writeRoots], [dir]);
  assert.deepEqual([...p.missingRoots], ['/does/not/exist']);
  assert.deepEqual({ ...p.rateLimits }, { write: 120, exec: 60, root: 20 });
  assert.equal(p.approvalMode, 'dangerous');
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.readRoots));
  const summary = policySummary(p);
  assert.equal(summary.max_tier, 'read');
  assert.equal(JSON.stringify(summary).includes('frozen_file'), false, 'paths of the switch are not part of the summary');
});

test('policy schema: unknown keys, bad values and impossible grants are refused (fail closed)', () => {
  const bad = [
    basePolicy({ extra: true }), basePolicy({ version: 2 }), basePolicy({ host: 'lab' }), basePolicy({ max_tier: 'admin' }),
    basePolicy({ host: 'mac', max_tier: 'root' }), basePolicy({ roots: { read: ['relative/path'] } }),
    basePolicy({ roots: { read: ['/etc/../root'] } }), basePolicy({ roots: { read: ['/'], exec: ['/'] } }),
    basePolicy({ roots: { read: ['~/x'] } }), basePolicy({ units: ['x; id'] }), basePolicy({ units: ['-p.service'] }),
    basePolicy({ units: ['traefik'] }), basePolicy({ containers: ['--privileged'] }), basePolicy({ approval_mode: 'none' }),
    basePolicy({ denylist: ['relative/*'] }), basePolicy({ denylist: ['~/x'] }), basePolicy({ rate_limits: { read: 5 } }),
    basePolicy({ rate_limits: { write: 0 } }), basePolicy({ rate_limits: { write: 1.5 } }), basePolicy({ frozen_file: 'FROZEN' }),
    basePolicy({ repositories: { projects_root: '/srv', registry: '/x' } }), basePolicy({ repositories: {} }),
    { ...basePolicy(), audit_file: undefined }, null, [], 'policy'
  ];
  for (const raw of bad) assert.throws(() => parseOperatorPolicy(raw), /invalid_operator_policy/, JSON.stringify(raw));
  // "~/" is a Mac form, expanded with the agent's home.
  const mac = parseOperatorPolicy(basePolicy({ host: 'mac', max_tier: 'exec', roots: { read: ['~/x'] }, denylist: ['~/private/**'],
    frozen_file: '~/.memo-operator/FROZEN', repositories: { projects_root: '~/projects' } }), { home: '/Users/owner', realpath: p => p });
  assert.deepEqual([...mac.readRoots], ['/Users/owner/x']);
  assert.equal(mac.frozenFile, '/Users/owner/.memo-operator/FROZEN');
});

test('policy trust: owner, mode and directory are checked on the open descriptor', t => {
  const dir = tempDir(t);
  const path = join(dir, 'policy.json');
  writeFileSync(path, JSON.stringify(basePolicy()));
  // Owned by a trusted uid that is not the agent ("root"), 0644: accepted.
  chmodSync(path, 0o644);
  assert.equal(loadOperatorPolicy({ path, agentUid: OTHER, trustedUids: [ME] }).host, 'vps');
  // Group or other writable: refused.
  chmodSync(path, 0o664);
  assert.throws(() => loadOperatorPolicy({ path, agentUid: OTHER, trustedUids: [ME] }), /policy_writable_by_others/);
  chmodSync(path, 0o646);
  assert.throws(() => loadOperatorPolicy({ path, agentUid: OTHER, trustedUids: [ME] }), /policy_writable_by_others/);
  // Owned by an untrusted uid (on lab: anything but root): refused.
  chmodSync(path, 0o644);
  assert.throws(() => loadOperatorPolicy({ path, agentUid: OTHER, trustedUids: [0] }), /policy_owner_untrusted/);
  // The agent owns it (the Mac case): only a read-only file is accepted.
  assert.throws(() => loadOperatorPolicy({ path, agentUid: ME, trustedUids: [ME] }), /policy_writable_by_agent/);
  chmodSync(path, 0o444);
  assert.equal(loadOperatorPolicy({ path, agentUid: ME, trustedUids: [ME] }).host, 'vps');
  // A host other than the agent's own: refused.
  assert.throws(() => loadOperatorPolicy({ path, agentUid: ME, trustedUids: [ME], expectedHost: 'mac' }), /invalid_operator_policy:host/);
  // A writable directory lets the agent swap the file by rename: refused.
  chmodSync(dir, 0o777);
  assert.throws(() => loadOperatorPolicy({ path, agentUid: OTHER, trustedUids: [ME] }), /policy_dir_writable_by_others/);
  chmodSync(dir, 0o755);
  // A symlink to a good file is refused (O_NOFOLLOW), and so is a missing file.
  const link = join(dir, 'link.json');
  symlinkSync(path, link);
  assert.throws(() => loadOperatorPolicy({ path: link, agentUid: OTHER, trustedUids: [ME] }), /policy_is_symlink/);
  assert.throws(() => loadOperatorPolicy({ path: join(dir, 'none.json'), agentUid: OTHER, trustedUids: [ME] }), /policy_unreadable/);
  // Not JSON: refused.
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{', { mode: 0o644 });
  assert.throws(() => loadOperatorPolicy({ path: broken, agentUid: OTHER, trustedUids: [ME] }), /invalid_operator_policy:json/);
  // A directory in place of the file.
  mkdirSync(join(dir, 'd.json'), { mode: 0o755 });
  assert.throws(() => loadOperatorPolicy({ path: join(dir, 'd.json'), agentUid: OTHER, trustedUids: [ME] }));
});

test('policy trust: trustProblem decision table', () => {
  const stat = (uid, mode, file = true) => ({ uid, mode, isFile: () => file, isDirectory: () => !file });
  const dirOk = stat(0, 0o40755, false);
  assert.equal(trustProblem(stat(0, 0o100644), dirOk, { agentUid: 999, trustedUids: [0] }), null);
  assert.equal(trustProblem(stat(999, 0o100644), dirOk, { agentUid: 999, trustedUids: [0] }), 'policy_owner_untrusted');
  assert.equal(trustProblem(stat(0, 0o100666), dirOk, { agentUid: 999, trustedUids: [0] }), 'policy_writable_by_others');
  assert.equal(trustProblem(stat(501, 0o100600), stat(501, 0o40755, false), { agentUid: 501, trustedUids: [0, 501] }), 'policy_writable_by_agent');
  assert.equal(trustProblem(stat(501, 0o100400), stat(501, 0o40755, false), { agentUid: 501, trustedUids: [0, 501] }), null);
  assert.equal(trustProblem(stat(0, 0o100644), stat(999, 0o40755, false), { agentUid: 999, trustedUids: [0] }), 'policy_dir_owner_untrusted');
  assert.equal(trustProblem(stat(0, 0o100644), stat(0, 0o40775, false), { agentUid: 999, trustedUids: [0] }), 'policy_dir_writable_by_others');
});
