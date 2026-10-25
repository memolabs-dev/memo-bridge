// Issue #290: decisions stay with the policy and the hub state, never with the agent, and a
// sensitive call stops when the source that decides is gone. Adversarial cases on a temporary
// host tree: the policy file removed, truncated, re-owned, made writable, swapped by a symlink or
// for another host's after start; the hub state unreadable or corrupt; writes and commands aimed
// at the policy, the FROZEN switches, the hub state and the coordinator store, directly, through
// a symlink, a relative path, an option value, a shell line or a script. Nothing here needs root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { loadPolicyAuthority, controlRefusal } from '../bridge/operator-authority.mjs';
import { createDenylist, resolveOperatorPath } from '../bridge/operator-paths.mjs';
import { parseOperatorPolicy, readTrustedFile } from '../bridge/operator-policy.mjs';
import { createOperatorOperations } from '../bridge/operator-agent.mjs';
import { createOperatorGuard } from '../bridge/operator-guard.mjs';
import { createAuditChain, memoryAuditStore } from '../bridge/operator-audit.mjs';
import { createOperatorTools } from '../bridge/operator-tools.mjs';
import { createOperatorWriteTools } from '../bridge/operator-write.mjs';
import { createOperatorExecTools } from '../bridge/operator-exec.mjs';
import { createOperatorVerifier } from '../bridge/operator-signing.mjs';
import { createRootHelper } from '../bridge/operator-root-helper.mjs';
import { createJobStore } from '../bridge/operator-jobs.mjs';
import { createHubState } from '../bridge/hub-state.mjs';
import { createOperatorLocks } from '../bridge/operator-locks.mjs';
import { createHub } from '../bridge/hub.mjs';
import { OPERATOR_SCHEMAS } from '../server/tools/operator-tools.mjs';
import { CAPABILITIES, makePrincipal, operatorCallTier } from '../server/coordinator/policy.mjs';
import { makeHost, signingPair } from './helpers/operator-fixture.mjs';

const PRINCIPAL = 'oidc:owner';
const UID = process.getuid();
let seq = 0;
const nextId = () => `req_${String(++seq).padStart(16, '0')}`;
const asRoot = UID === 0;

// The policy of a host tree written to a trusted file (0444, owner-only directory), loaded through
// loadPolicyAuthority. owner.uids stands for the uids the file's owner must be among: switching it
// to [0] after load is the file passing to another owner, through the real trusted read.
function trustedPolicy(t, h, { host = 'vps' } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'memo-op-policy-')));
  t.after(() => { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'policy.json');
  const write = raw => {
    if (existsSync(path)) chmodSync(path, 0o644);
    writeFileSync(path, typeof raw === 'string' ? raw : JSON.stringify(raw));
    chmodSync(path, 0o444);
  };
  write(h.raw);
  const owner = { uids: [UID] };
  const read = (p, o) => readTrustedFile(p, { ...o, trustedUids: owner.uids });
  const authority = loadPolicyAuthority({ path, expectedHost: host, trustedUids: [UID], home: h.p('home/op'), read });
  return { dir, path, write, owner, authority };
}

// The agent's pipeline over a host tree, with the policy authority and an extra T1 op.
function agent(t, { host = 'vps', policy: overrides = {}, roots = null } = {}) {
  const h = makeHost(t, { host, policy: { max_tier: 'exec', approval_mode: 'off', ...overrides } });
  if (roots) h.raw = { ...h.raw, roots: roots(h.p) };
  const files = trustedPolicy(t, h, { host });
  const policy = files.authority.policy;
  const clock = { t: 1_800_000_000_000 };
  const { signer, verifier } = signingPair({ host, clock });
  const now = () => clock.t;
  const guard = createOperatorGuard(policy, { autoFrozenFile: h.p('state/AUTO-FROZEN'), now, writeMarker: (p, text) => writeFileSync(p, text) });
  const store = memoryAuditStore();
  const chain = createAuditChain({ store, now });
  const runs = [];
  const run = async (argv, opts) => { runs.push({ argv, cwd: opts?.cwd }); return { code: 0, stdout: 'ran\n', stderr: '', truncated: false }; };
  const tools = { ...createOperatorTools(policy, { guard, chain, projects: async () => [], platform: 'linux', now }),
    ...createOperatorWriteTools(policy, { stateDir: h.p('state') }),
    ...createOperatorExecTools(policy, { run, jobs: createJobStore({ dir: h.p('state/jobs') }) }) };
  let writes = 0;
  tools.operator_test_write = async () => { writes++; return { ok: true }; };
  const tierOf = (op, args) => (op === 'operator_test_write' ? 1 : operatorCallTier(op, args));
  const schemas = { ...OPERATOR_SCHEMAS, operator_test_write: z.object({ host: z.enum(['mac', 'vps']) }) };
  const { handlers } = createOperatorOperations({ policy, verifier, guard, chain, tools, tierOf, schemas, now, authority: files.authority,
    ops: [...Object.keys(OPERATOR_SCHEMAS), 'operator_test_write'] });
  const call = (op, args) => {
    const id = nextId();
    const operator = signer.sign({ id, op, host, tier: tierOf(op, args), principal: PRINCIPAL, args });
    return handlers[op](args, { id, op, principal: { id: PRINCIPAL }, operator, meta: null });
  };
  const journal = () => store.read().trim().split('\n').map(l => JSON.parse(l));
  return { ...h, ...files, policy, call, guard, runs, journal, clock, writes: () => writes };
}

test('#290: policy removed, truncated, re-owned, writable, a symlink, another host or edited: above T0 refused and journaled, T0 still reads', { skip: asRoot }, async t => {
  const a = agent(t);
  const read = () => a.call('operator_read', { host: 'vps', path: a.p('srv/app/notes.md') });
  assert.deepEqual(await a.call('operator_test_write', { host: 'vps' }), { ok: true }, 'the policy in force: the call runs');
  const cases = [
    ['removed', () => rmSync(a.path), 'policy_unavailable', 'policy_unreadable'],
    ['truncated', () => a.write(JSON.stringify(a.raw).slice(0, 40)), 'policy_unavailable', 'invalid_operator_policy:json'],
    ['another owner', () => { a.owner.uids = [0]; }, 'policy_unavailable', 'policy_owner_untrusted'],
    ['writable by the agent', () => chmodSync(a.path, 0o644), 'policy_unavailable', 'policy_writable_by_agent'],
    ['writable by the group', () => chmodSync(a.path, 0o464), 'policy_unavailable', 'policy_writable_by_others'],
    ['swapped for a symlink', () => { const other = join(a.dir, 'other.json'); writeFileSync(other, JSON.stringify(a.raw)); rmSync(a.path, { force: true }); symlinkSync(other, a.path); },
      'policy_unavailable', 'policy_is_symlink'],
    ['another host', () => a.write({ ...a.raw, host: 'mac' }), 'policy_unavailable', 'policy_host_mismatch'],
    ['valid but edited after start', () => a.write({ ...a.raw, rate_limits: { write: 999 } }), 'policy_changed', 'restart_to_apply']
  ];
  for (const [name, breakIt, error, reason] of cases) {
    breakIt();
    assert.deepEqual(await a.call('operator_test_write', { host: 'vps' }), { ok: false, error, reason }, name);
    assert.deepEqual(await a.call('operator_run', { host: 'vps', argv: ['true'] }), { ok: false, error, reason }, `${name}: commands too`);
    assert.equal((await read()).ok, true, `${name}: T0 reads keep working`);
    const denied = a.journal().filter(l => l.outcome === 'denied').at(-1);
    assert.deepEqual([denied.op, denied.code], ['operator_run', error], `${name}: journaled`);
    // Back to the original file before the next case.
    a.owner.uids = [UID];
    rmSync(a.path, { force: true });
    a.write(a.raw);
    assert.deepEqual(await a.call('operator_test_write', { host: 'vps' }), { ok: true }, `${name}: the restored file is accepted again`);
  }
  assert.equal(a.writes(), cases.length + 1, 'only calls under the policy in force ran');
  assert.deepEqual(a.runs, [], 'no command ran without its policy');
  assert.equal(a.guard.status().auto, false, 'a lost policy does not count towards auto-freeze');
});

test('#290: the root helper reads its own policy again and refuses without it, whatever the agent decided', { skip: asRoot }, async t => {
  const sockDir = realpathSync(mkdtempSync(join('/tmp', 'mop-')));
  t.after(() => rmSync(sockDir, { recursive: true, force: true }));
  const h = makeHost(t, { policy: { max_tier: 'root', approval_mode: 'off', root_helper: { socket: join(sockDir, 'root.sock') } } });
  const files = trustedPolicy(t, h);
  const pair = signingPair({ clock: { t: Date.now() } });
  const calls = [];
  const store = memoryAuditStore();
  const helper = createRootHelper({ policy: files.authority.policy, authority: files.authority,
    verifier: createOperatorVerifier({ publicKeys: [pair.keys.publicKeyPem], host: 'vps', now: () => pair.clock.t }),
    guard: createOperatorGuard(files.authority.policy, {}), chain: createAuditChain({ store }), scriptDir: h.p('state/scripts'),
    jobs: createJobStore({ dir: h.p('state/rjobs'), prefix: 'rj' }), now: () => pair.clock.t,
    executor: async argv => { calls.push(argv); return { code: 0, stdout: '', stderr: '', truncated: false }; } });
  const sign = (op, args) => {
    const id = nextId();
    return { type: 'call', id, op, args, principal: PRINCIPAL, operator: pair.signer.sign({ id, op, host: 'vps', tier: 3, principal: PRINCIPAL, args }) };
  };
  assert.equal((await helper.handle(sign('operator_run', { host: 'vps', argv: ['id'], as_root: true }))).ok, true);
  rmSync(files.path);
  assert.deepEqual(await helper.handle(sign('operator_run', { host: 'vps', argv: ['id'], as_root: true })),
    { ok: false, error: 'policy_unavailable', reason: 'policy_unreadable' });
  assert.equal(calls.length, 1, 'the second root call never reached systemd-run');
  const last = store.read().trim().split('\n').map(l => JSON.parse(l)).at(-1);
  assert.deepEqual([last.outcome, last.code, last.source], ['denied', 'policy_unavailable', 'root-helper']);
  // And its own control-path check: a root command naming the hub state never runs either.
  files.write(h.raw);
  const fresh = loadPolicyAuthority({ path: files.path, expectedHost: 'vps', trustedUids: [UID], home: h.p('home/op') });
  const again = createRootHelper({ policy: fresh.policy, authority: fresh, guard: createOperatorGuard(fresh.policy, {}),
    verifier: createOperatorVerifier({ publicKeys: [pair.keys.publicKeyPem], host: 'vps', now: () => pair.clock.t }),
    chain: createAuditChain({ store: memoryAuditStore() }), scriptDir: h.p('state/scripts'), now: () => pair.clock.t,
    executor: async argv => { calls.push(argv); return { code: 0, stdout: '', stderr: '', truncated: false }; } });
  for (const args of [{ argv: ['tee', '/var/lib/memo-bridge-hub/grants.json'], as_root: true },
    { argv: ['rm', '-f', 'memo-operator/FROZEN'], cwd: '/etc', as_root: true }]) {
    assert.equal((await again.handle(sign('operator_run', { host: 'vps', ...args }))).error, 'control_path_protected', args.argv.join(' '));
  }
  const script = { host: 'vps', interpreter: 'bash', content: 'printf "{}" > /var/lib/memo-bridge-hub/freeze.json\n', as_root: true };
  assert.equal((await again.handle(sign('operator_script', script))).error, 'control_path_protected');
  assert.equal(calls.length, 1);
});

test('#290: hub state unreadable or corrupt: the hub starts frozen above T0, locks are refused, nothing is reset to defaults', { skip: asRoot }, async t => {
  const tlsDir = realpathSync(mkdtempSync(join(tmpdir(), 'memo-hub-tls-')));
  t.after(() => rmSync(tlsDir, { recursive: true, force: true }));
  const out = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(tlsDir, 'k'), '-out', join(tlsDir, 'c')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const base = { tlsKey: readFileSync(join(tlsDir, 'k'), 'utf8'), tlsCert: readFileSync(join(tlsDir, 'c'), 'utf8'),
    tokenSha256: createHash('sha256').update('owner-token-for-authority-tests').digest('hex'), allowedAgentKeys: {} };
  const stateDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'memo-hub-state-'));
    t.after(() => { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); });
    return dir;
  };

  // 1. A corrupt freeze.json: frozen, journaled, the file kept where it is.
  const corrupt = stateDir();
  writeFileSync(join(corrupt, 'freeze.json'), '{"version":1,"data":{"frozen":tr', { mode: 0o600 });
  const journal = [];
  const hub = createHub({ ...base, stateDir: corrupt, audit: e => journal.push(e) });
  assert.equal(hub.operatorFrozen(), true, 'a freeze flag that cannot be read is a freeze');
  assert.ok(journal.some(e => e.event === 'operator_frozen' && e.by === 'state_unavailable' && e.reason === 'unparsable'));
  assert.deepEqual(readdirSync(corrupt), ['freeze.json'], 'not set aside: the evidence stays');
  // The owner's /unfreeze writes a good document; the next start reads it.
  hub.setOperatorFrozen(false, 'telegram:owner');
  assert.equal(createHub({ ...base, stateDir: corrupt }).operatorFrozen(), false);

  // A document that parses but holds no boolean flag is malformed: frozen as well.
  for (const data of [{ frozen: 'yes' }, null, [], 'no']) {
    const odd = stateDir();
    writeFileSync(join(odd, 'freeze.json'), JSON.stringify({ version: 1, data }), { mode: 0o600 });
    assert.equal(createHub({ ...base, stateDir: odd }).operatorFrozen(), true, JSON.stringify(data));
  }
  assert.equal(createHub({ ...base, stateDir: stateDir() }).operatorFrozen(), false, 'no document yet: not frozen');
  assert.equal(createHub(base).operatorFrozen(), false, 'no state directory: not frozen, as before');

  // 2. An unreadable freeze.json, then an unreadable state directory.
  const locked = stateDir();
  writeFileSync(join(locked, 'freeze.json'), JSON.stringify({ version: 1, data: { frozen: false } }), { mode: 0o600 });
  chmodSync(join(locked, 'freeze.json'), 0o000);
  assert.equal(createHub({ ...base, stateDir: locked }).operatorFrozen(), true, 'unreadable file: frozen');
  chmodSync(join(locked, 'freeze.json'), 0o600);
  assert.equal(createHub({ ...base, stateDir: locked }).operatorFrozen(), false, 'readable again: the saved flag is believed');
  chmodSync(locked, 0o000);
  const records = [];
  const state = createHubState({ dir: locked, record: (event, details) => records.push({ event, ...details }) });
  assert.deepEqual(state.read('freeze'), { ok: false, error: 'unreadable' });
  assert.equal(createHub({ ...base, stateDir: locked }).operatorFrozen(), true, 'unreadable directory: frozen');
  const locks = createOperatorLocks({ verifyWorkspace: async (p, id) => ({ ok: true, workspace: { workspace_id: id, status: 'active', project: 'drop' } }),
    reload: () => state.read('locks'), onChange: data => state.save('locks', data) });
  const owner = makePrincipal('oidc:owner-sub', Object.values(CAPABILITIES), { client_type: 'chatgpt', via: 'hub' });
  const taken = await locks.handle('operator_lock', { host: 'vps', workspace_id: 'ws_AAAAAAAAAAAAAAAA', kind: 'path', target: '/opt/stacks/drop' },
    { principal: owner, clientSession: 'a'.repeat(32) });
  assert.equal(taken.error, 'locks_state_unavailable', 'no lock granted on a table that cannot be read');
  assert.ok(records.some(r => r.event === 'hub_state_corrupt' && r.kept === true));
  chmodSync(locked, 0o700);
});

test('#290: writes aimed at control paths are refused on both hosts, directly, through a symlink or ".."', { skip: asRoot }, async t => {
  // vps: the write roots of the lab policy include /etc, so the lexical check carries the real paths.
  const vps = agent(t, { policy: { max_tier: 'write' } });
  // Six minutes between calls: each case is judged alone, below the auto-freeze burst.
  const edit = async (a, host, path) => {
    const out = await a.call('operator_edit', { host, path, mode: 'write', new_text: '{}', create: true });
    a.clock.t += 6 * 60_000;
    return out;
  };
  for (const [path, error] of [['/var/lib/memo-bridge-hub/grants.json', 'control_path_protected'], ['/var/lib/memo-bridge-hub/freeze.json', 'control_path_protected'],
    ['/etc/memo-bridge/remote.json', 'control_path_protected'], ['/etc/systemd/system/memo-operator-agent.service.d/90-x.conf', 'control_path_protected'],
    ['/etc/memo-operator/policy.json', 'path_secret'], ['/var/lib/memo-operator/AUTO-FROZEN', 'control_path_protected']]) {
    assert.equal((await edit(vps, 'vps', path)).error, error, path);
  }
  // The policy's own FROZEN and state directory (here the fixture's state/), via a symlink planted
  // in a write root and via "..": the canonical path is what is checked.
  symlinkSync(vps.p('state'), vps.p('srv/rw/ctl'));
  assert.equal((await edit(vps, 'vps', vps.p('srv/rw/ctl/AUTO-FROZEN'))).error, 'control_path_protected', 'through a symlink');
  assert.equal((await edit(vps, 'vps', `${vps.p('srv/rw')}/../../state/FROZEN`)).error, 'control_path_protected', 'through ..');
  assert.equal((await edit(vps, 'vps', vps.p('srv/rw/ok.txt'))).ok, true, 'an ordinary write still works');
  assert.equal(existsSync(vps.p('state/AUTO-FROZEN')) || existsSync(vps.p('state/FROZEN')), false);

  // mac: the owner's home is a write root; the coordinator store and the agents' launchd jobs are not.
  const mac = agent(t, { host: 'mac', policy: { max_tier: 'write' }, roots: p => ({ read: [p('home')], write: [p('home')] }) });
  mkdirSync(mac.p('home/op/Library/Application Support/memo-bridge'), { recursive: true });
  mkdirSync(mac.p('home/op/Library/LaunchAgents'), { recursive: true });
  mkdirSync(mac.p('home/op/.memo-operator'), { recursive: true });
  for (const [path, error] of [['~/Library/Application Support/memo-bridge/coordinator.sqlite', 'control_path_protected'],
    ['~/Library/LaunchAgents/dev.memolabs.memo-operator.plist', 'control_path_protected'], ['~/.memo-operator/policy.json', 'path_secret']]) {
    assert.equal((await edit(mac, 'mac', path)).error, error, path);
  }
  symlinkSync(mac.p('home/op/Library/Application Support/memo-bridge'), mac.p('home/op/innocent-dir'));
  assert.equal((await edit(mac, 'mac', '~/innocent-dir/coordinator.sqlite')).error, 'control_path_protected', 'mac, through a symlink');
  assert.equal((await edit(mac, 'mac', '~/notes.txt')).ok, true);
});

test('#290: commands and scripts naming a control path are refused whatever the approval mode; ordinary commands run', { skip: asRoot }, async t => {
  const a = agent(t);
  symlinkSync(a.p('state'), a.p('srv/rw/ctl'));
  const refused = [
    { argv: ['tee', '/var/lib/memo-bridge-hub/grants.json'] },
    { argv: ['cp', 'x', '/etc/memo-operator/policy.json'] },
    { argv: ['rm', 'memo-operator/FROZEN'], cwd: '/etc' },
    { argv: ['touch', '../../state/FROZEN'], cwd: a.p('srv/rw') },
    { argv: ['rm', a.p('srv/rw/ctl/AUTO-FROZEN')] },
    { argv: ['touch', 'x'], cwd: a.p('srv/rw/ctl') },
    { argv: ['install', '--target-directory=/var/lib/memo-bridge-hub', 'x'] },
    { argv: ['bash', '-c', 'echo {} > /var/lib/memo-bridge-hub/freeze.json'] },
    { argv: ['systemctl', 'restart', 'memo-operator-agent.service'] },
    { argv: ['/usr/bin/env', 'VAR=1', 'sh', '-c', 'chmod 0644 /ETC/MEMO-OPERATOR/policy.json'] }
  ];
  // Six minutes between calls: each case is judged alone, below the auto-freeze burst.
  const spaced = async (op, args) => { const out = await a.call(op, args); a.clock.t += 6 * 60_000; return out; };
  for (const args of refused) {
    assert.equal((await spaced('operator_run', { host: 'vps', ...args })).error, 'control_path_protected', JSON.stringify(args));
  }
  // An operator_script is refused on its text, and on its arguments.
  assert.equal((await spaced('operator_script', { host: 'vps', interpreter: 'bash', content: 'rm -f /var/lib/memo-operator/AUTO-FROZEN\n' })).error,
    'control_path_protected');
  assert.equal((await spaced('operator_script', { host: 'vps', interpreter: 'bash', content: 'rm -f "$1"\n', args: ['/etc/memo-operator/FROZEN'] })).error,
    'control_path_protected');
  assert.deepEqual(a.runs, [], 'none of them ran');
  assert.equal(a.guard.status().auto, false);
  // A text match can be an innocent mention: a burst of command refusals does not freeze...
  for (let i = 0; i < 6; i++) await a.call('operator_run', { host: 'vps', argv: ['tee', '/var/lib/memo-bridge-hub/grants.json'] });
  assert.equal(a.guard.status().auto, false);
  // ...a burst of writes aimed at control paths does, like a secret-path burst.
  for (let i = 0; i < 5; i++) await a.call('operator_edit', { host: 'vps', path: '/var/lib/memo-bridge-hub/grants.json', mode: 'write', new_text: '{}', create: true });
  assert.equal(a.guard.status().auto, true);
  assert.equal((await a.call('operator_run', { host: 'vps', argv: ['true'] })).error, 'frozen');
});

// The live shapes: lab (read root "/", write roots /srv /opt /etc ...) and the Mac (the home).
// Paths are checked as strings: the realpath is the identity, nothing on this machine is read.
const LIVE = {
  vps: { version: 1, host: 'vps', max_tier: 'root', approval_mode: 'off', roots: { read: ['/'], write: ['/srv', '/opt', '/etc', '/var/www', '/home', '/root', '/tmp'] },
    frozen_file: '/etc/memo-operator/FROZEN', audit_file: '/var/log/memo-operator/audit.jsonl', state_dir: '/var/lib/memo-operator',
    root_helper: { socket: '/run/memo-operator/root.sock' } },
  mac: { version: 1, host: 'mac', max_tier: 'root', approval_mode: 'off', roots: { read: ['/Users/memo'], write: ['/Users/memo', '/tmp'] },
    frozen_file: '/Users/memo/.memo-operator/FROZEN', audit_file: '/Users/memo/Library/Logs/memo-operator/audit.jsonl',
    state_dir: '/Users/memo/.memo-operator/state', root_helper: { socket: '/var/run/memo-operator/root.sock' } }
};
const live = host => {
  const policy = parseOperatorPolicy(LIVE[host], { home: '/Users/memo', realpath: p => p });
  const deny = createDenylist(policy);
  return args => controlRefusal(deny, policy, args, { realpath: async p => p });
};

test('#290 review: bare names from the cwd, a "~/" cwd, glued options and odd spellings are resolved; agent units by name', async () => {
  const vps = live('vps');
  const mac = live('mac');
  const refused = [
    [vps, { argv: ['cp', '/tmp/x', 'sudoers'], cwd: '/etc' }],
    [vps, { argv: ['cp', '/tmp/u', 'memo-bridge-hub.service'], cwd: '/etc/systemd/system' }],
    [vps, { argv: ['cp', '/tmp/r', '10-memo.rules'], cwd: '/etc/polkit-1/rules.d' }],
    [vps, { argv: ['dd', 'if=/tmp/x', 'of=/var/lib//memo-bridge-hub/freeze.json'] }],
    [vps, { argv: ['tar', '-xf', '/tmp/a.tar', '-C/opt//memo-bridge'] }],
    [vps, { argv: ['make', 'install', 'DESTDIR=/opt/./memo-bridge'] }],
    [vps, { argv: ['systemctl', 'edit', '--stdin', 'memo-bridge-hub'] }],
    [vps, { argv: ['systemctl', 'stop', 'memo-operator-agent'] }],
    [mac, { argv: ['cp', '/tmp/x.plist', 'dev.memolabs.memo-bridge-agent.plist'], cwd: '/Users/memo/Library/LaunchAgents' }],
    [mac, { argv: ['rm', 'audit.jsonl'], cwd: '~/Library/Logs/memo-operator' }],
    [mac, { argv: ['rm', 'coordinator.sqlite'], cwd: '~/Library/Application Support/memo-bridge' }],
    [mac, { argv: ['dd', 'if=/tmp/x', 'of=/Users/memo/./.memo-operator/FROZEN'] }],
    [mac, { argv: ['sort', '-o/Users/memo//.memo-operator/policy.json', 'x'] }],
    [mac, { argv: ['sort', '-o../.local/share/memo-bridge/bridge/operator-agent.mjs', 'x'], cwd: '~/memolabs' }],
    [mac, { argv: ['launchctl', 'kickstart', '-k', 'gui/501/dev.memolabs.memo-operator-agent'] }],
    // A file reader keeps its path check: were it misclassified, it would still not reach one.
    [vps, { argv: ['cat', '/var/log/memo-operator/audit.jsonl'] }],
    [vps, { argv: ['sort', '-o', '/var/lib/memo-bridge-hub/freeze.json', 'x'] }],
    [mac, { argv: ['tail', '-n', '5', 'audit.jsonl'], cwd: '~/Library/Logs/memo-operator' }]
  ];
  for (const [check, args] of refused) assert.equal((await check(args))?.error, 'control_path_protected', JSON.stringify(args));
  // Reads that take no file stay reads, agent units included; a file reader may name a unit; a neighbour is not a control path.
  const allowed = [
    [vps, { argv: ['journalctl', '-u', 'memo-operator-agent', '-n', '50'] }],
    [vps, { argv: ['systemctl', 'status', 'memo-operator-root'] }],
    [vps, { argv: ['ls', '/opt/memo-bridge-staging'] }],
    [vps, { argv: ['mkdir', '-p', '/opt/memo-bridge-staging/x'] }],
    [vps, { argv: ['cp', '/tmp/r', '50-other.rules'], cwd: '/etc/polkit-1/rules.d' }],
    [vps, { argv: ['systemctl', 'restart', 'traefik.service'] }],
    [mac, { argv: ['grep', '-rn', 'memo-operator-root', 'bridge/'], cwd: '~/memolabs/os/core/bridge' }],
    [mac, { argv: ['git', 'commit', '-m', 'fix'], cwd: '~/memolabs/os/core/bridge' }],
    [mac, { argv: ['touch', 'notes.txt'], cwd: '~' }]
  ];
  for (const [check, args] of allowed) assert.equal(await check(args), null, JSON.stringify(args));
  // A FROZEN switch placed straight in the home protects that file, not the whole home.
  const broad = parseOperatorPolicy({ ...LIVE.mac, frozen_file: '/Users/memo/FROZEN' }, { home: '/Users/memo', realpath: p => p });
  const deny = createDenylist(broad);
  assert.deepEqual([deny.controlled('/Users/memo/FROZEN'), deny.controlled('/Users/memo/notes.txt')], [true, false]);
});

test('#290: ordinary commands are not caught by the control-path check', { skip: asRoot }, async t => {
  const h = makeHost(t, { policy: { max_tier: 'exec', approval_mode: 'off' } });
  const deny = createDenylist(h.policy);
  for (const args of [{ argv: ['ls', '-la', h.p('srv/app')] }, { argv: ['systemctl', 'status', 'traefik.service'] },
    { argv: ['journalctl', '-u', 'memo-bridge-hub.service', '-n', '50'] }, { argv: ['git', 'status'], cwd: h.p('srv/app') },
    { argv: ['df', '-h', '/'] }, { argv: ['cat', 'sub/deep.txt'], cwd: h.p('srv/app') }]) {
    assert.equal(await controlRefusal(deny, h.policy, args), null, JSON.stringify(args));
  }
  // Reads are not control-path checked (the secret denylist governs them).
  assert.equal((await resolveOperatorPath(h.policy, h.p('srv/app/notes.md'), { access: 'r', denylist: deny })).ok, true);
  // macOS: /etc and /var resolve into /private; both forms are control paths.
  const mac = parseOperatorPolicy({ ...h.raw, host: 'mac', max_tier: 'exec' }, { home: h.p('home/op') });
  const macDeny = createDenylist(mac);
  assert.equal(macDeny.controlled('/private/var/run/memo-operator/root.sock'), true);
  assert.equal(macDeny.controlled('/var/run/memo-operator/root.sock'), true);
  assert.equal(macDeny.controlled(h.p('home/op/Library/Application Support/memo-bridge/coordinator.sqlite')), true);
  assert.equal(macDeny.controlled(h.p('home/op/memolabs/drop/README.md')), false);
});
