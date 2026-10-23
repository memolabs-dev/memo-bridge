// Mac root helper (owner decision 2026-10-14, spec §13 "Mac root follow-up", R-MR-01 to 09).
// Root cannot be exercised here: the uid check and every path are injected, the root directory is
// a temporary directory whose ancestors pass the same ownership check with the test user added to
// the trusted uids, and the programs really run (as the test user). launchd is never called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macRootLayout, startMacRootHelper, untrustedAncestor } from '../bridge/operator-root-mac.mjs';
import { createRootHelperClient, runArgvGroup } from '../bridge/operator-root-helper.mjs';
import { createOperatorOperations } from '../bridge/operator-agent.mjs';
import { createOperatorGuard } from '../bridge/operator-guard.mjs';
import { createOperatorVerifier } from '../bridge/operator-signing.mjs';
import { parseOperatorPolicy } from '../bridge/operator-policy.mjs';
import { verifyChain } from '../bridge/operator-audit.mjs';
import { dangerReason, needsApproval } from '../bridge/operator-dangerous.mjs';
import { macLayout, writePolicy } from '../deploy/mac/operator-mac.mjs';
import { operatorKeys, signingPair } from './helpers/operator-fixture.mjs';
import { createHub } from '../bridge/hub.mjs';
import { createAgent } from '../bridge/agent.mjs';
import { generateAgentIdentity } from '../bridge/crypto.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UID = process.getuid();
const GID = process.getgid();
const TRUSTED = [0, UID];
const PRINCIPAL = 'oidc:owner';
const APPROVAL = `ap_${'b'.repeat(24)}`;
const mode = path => statSync(path).mode & 0o777;
let n = 0;
const nextId = () => `req_${String(++n).padStart(16, '0')}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A base directory whose every ancestor is owned by root or the test user and not group or other
// writable (macOS: the per-user temporary directory; Linux CI: /tmp is 1777, so the home folder).
function trustedBase(t) {
  for (const candidate of [tmpdir(), homedir()]) {
    let real;
    try { real = realpathSync(candidate); } catch { continue; }
    if (untrustedAncestor(real, { trustedUids: TRUSTED }) === null) {
      const base = mkdtempSync(join(real, 'memo-op-root-'));
      chmodSync(base, 0o755);
      t.after(() => rmSync(base, { recursive: true, force: true }));
      return base;
    }
  }
  return null;
}

// The installed layout, in a temporary directory: root dir with a node and a script stand-in,
// a root policy (host mac, root, dangerous), the hub key, and a short socket path.
function macRoot(t, { policy: overrides = {}, hubKeyMode = 0o444 } = {}) {
  const base = trustedBase(t);
  if (!base) { t.skip('no temporary directory with a trusted ancestry'); return null; }
  const sockBase = realpathSync(mkdtempSync(join('/tmp', 'mopr-')));
  t.after(() => rmSync(sockBase, { recursive: true, force: true }));
  const L = macRootLayout(join(base, 'operator-root'));
  for (const d of [join(L.dir, 'bin'), join(L.dir, 'bridge'), join(base, 'projects'), join(base, 'home', '.memo-operator'), join(base, 'work')]) {
    mkdirSync(d, { recursive: true, mode: 0o755 });
  }
  writeFileSync(join(base, 'projects', 'PROJECTS.md'), ['# registry', '## Projets appartenant à Memo Labs',
    '| Name | Path | Kind | Status | Nature | Stack | Vault note |', '|---|---|---|---|---|---|---|'].join('\n'));
  writeFileSync(L.node, '#!/bin/sh\n', { mode: 0o555 });
  writeFileSync(L.script, '// stand-in\n', { mode: 0o444 });
  const pair = signingPair({ host: 'mac', clock: { t: Date.now() } });
  const raw = { version: 1, host: 'mac', max_tier: 'root', approval_mode: 'dangerous', roots: { read: [base, '/tmp'], write: [] },
    frozen_file: L.frozen, audit_file: join(base, 'log', 'audit.jsonl'), state_dir: join(base, 'state'),
    repositories: { projects_root: join(base, 'projects'), layout_root: join(base, 'projects') },
    root_helper: { socket: join(sockBase, 'run', 'root.sock') }, ...overrides };
  writeFileSync(L.policy, `${JSON.stringify(raw)}\n`, { mode: 0o444 });
  writeFileSync(L.hubPub, pair.keys.publicKeyPem, { mode: hubKeyMode });
  chmodSync(L.hubPub, hubKeyMode);
  const userFrozen = join(base, 'home', '.memo-operator', 'FROZEN');
  const env = { MEMO_OPERATOR_ROOT_DIR: L.dir, MEMO_OPERATOR_AGENT_UID: String(UID === 0 ? 501 : UID), MEMO_OPERATOR_AGENT_GID: String(GID || 20),
    MEMO_OPERATOR_USER_FROZEN: userFrozen };
  const start = (opts = {}) => startMacRootHelper({ env, getuid: () => 0, trustedUids: TRUSTED, execPath: L.node, scriptPath: L.script, ...opts });
  const sign = (op, args, { tier = 3, approval = null, signer = pair.signer } = {}) => {
    const id = nextId();
    return { type: 'call', id, op, args, principal: PRINCIPAL, operator: signer.sign({ id, op, host: 'mac', tier, principal: PRINCIPAL, args, approval }) };
  };
  return { base, L, raw, pair, env, start, sign, userFrozen, socket: raw.root_helper?.socket ?? null, auditFile: raw.audit_file };
}

test('R-MR-01: the helper refuses to start unless it is root, runs from a root-owned tree, and its policy grants root with approval', async t => {
  const r = macRoot(t);
  if (!r) return;
  await assert.rejects(r.start({ check: true, getuid: () => UID || 501 }), /runs as root/);
  // A group-writable root directory: whoever is in the group could swap the code under root.
  chmodSync(r.L.dir, 0o775);
  await assert.rejects(r.start({ check: true }), /root_dir_untrusted:writable_by_others/);
  chmodSync(r.L.dir, 0o755);
  // The node and the script launchd runs must be the copies inside the root directory.
  await assert.rejects(r.start({ check: true, execPath: process.execPath }), /node_outside_root_dir/);
  await assert.rejects(r.start({ check: true, scriptPath: join(ROOT, 'bridge', 'operator-root-mac-cli.mjs') }), /script_outside_root_dir/);
  // The hub key must pass the same trust check as the policy.
  chmodSync(r.L.hubPub, 0o666);
  await assert.rejects(r.start({ check: true }), /policy_writable_by_others/);
  chmodSync(r.L.hubPub, 0o444);
  // The agent user must be named, and never root.
  await assert.rejects(r.start({ check: true, env: { ...r.env, MEMO_OPERATOR_AGENT_UID: '0' } }), /AGENT_UID/);
  const ok = await r.start({ check: true });
  assert.equal(ok.summary.approval_mode, 'dangerous');
  assert.equal(existsSync(r.socket), false, '--check opens no socket');
  assert.equal(mode(r.raw.state_dir), 0o700);
  assert.equal(mode(dirname(r.auditFile)), 0o700);
  assert.equal(mode(dirname(r.socket)), 0o755);
});

test('R-MR-01: a root policy without root is refused at start', async t => {
  for (const [overrides, pattern] of [[{ max_tier: 'exec', root_helper: undefined }, /does not grant root/],
    [{ frozen_file: '/tmp/FROZEN' }, /frozen_file_outside_root_dir/]]) {
    const r = macRoot(t, { policy: overrides });
    if (!r) return;
    await assert.rejects(r.start({ check: true }), pattern);
  }
});

test('R-MR-02, R-MR-06: over the socket, only signed fresh T3 calls run; every call lands in the root chain (0600)', async t => {
  const r = macRoot(t);
  if (!r) return;
  const { server, guard } = await r.start({ check: false });
  t.after(() => server.stop());
  // The socket belongs to the agent user, 0600 (DEV-P6-34).
  assert.equal(mode(r.socket), 0o600);
  assert.equal(statSync(r.socket).uid, Number(r.env.MEMO_OPERATOR_AGENT_UID === String(UID) ? UID : r.env.MEMO_OPERATOR_AGENT_UID));
  const client = createRootHelperClient({ socketPath: r.socket, timeoutMs: 10_000 });
  // argv without a shell (R-MR-04): ";" and "$(id)" are bytes.
  const echo = await client.request(r.sign('operator_run', { host: 'mac', argv: ['echo', 'a;id $(id)'], as_root: true }));
  assert.deepEqual([echo.ok, echo.host, echo.as_root, echo.untrusted_content.stdout], [true, 'mac', true, 'a;id $(id)\n']);
  // Unsigned, wrong key, replayed, tampered, a T2 call, an op that is not the helper's.
  const unsigned = { type: 'call', id: nextId(), op: 'operator_run', args: { host: 'mac', argv: ['id'], as_root: true }, principal: PRINCIPAL };
  assert.equal((await client.request(unsigned)).error, 'signature_missing');
  const other = signingPair({ host: 'mac', clock: r.pair.clock });
  assert.equal((await client.request(r.sign('operator_run', { host: 'mac', argv: ['id'], as_root: true }, { signer: other.signer }))).error, 'unknown_key');
  const once = r.sign('operator_run', { host: 'mac', argv: ['true'], as_root: true });
  assert.equal((await client.request(once)).ok, true);
  assert.equal((await client.request(once)).error, 'replayed');
  const tampered = r.sign('operator_run', { host: 'mac', argv: ['true'], as_root: true });
  tampered.args = { ...tampered.args, argv: ['rm', '-rf', '/'] };
  assert.equal((await client.request(tampered)).error, 'args_mismatch');
  assert.equal((await client.request(r.sign('operator_run', { host: 'mac', argv: ['id'] }, { tier: 2 }))).error, 'tier_mismatch');
  assert.equal((await client.request(r.sign('operator_run', { host: 'mac', argv: ['id'], as_root: true }, { tier: 2 }))).error, 'tier_mismatch');
  assert.equal((await client.request(r.sign('operator_edit', { host: 'mac', path: '/etc/hosts', mode: 'append', new_text: 'x' }, { tier: 1 }))).error,
    'unsupported_op');
  // Five signature or tier refusals: the helper froze itself.
  assert.equal(guard.status().auto, true);
  assert.equal((await client.request(r.sign('operator_run', { host: 'mac', argv: ['true'], as_root: true }))).error, 'frozen');
  guard.clearAuto();
  // Dangerous mode: a script or a Mac root tool without a signed approval is refused.
  assert.equal((await client.request(r.sign('operator_run', { host: 'mac', argv: ['diskutil', 'eraseDisk'], as_root: true }))).error, 'approval_required');
  assert.equal((await client.request(r.sign('operator_script', { host: 'mac', as_root: true, interpreter: 'bash', content: 'id' }))).error, 'approval_required');
  // A host other than the helper's own.
  assert.equal((await client.request(r.sign('operator_run', { host: 'vps', argv: ['true'], as_root: true }))).error, 'invalid_arguments');
  // The journal: root-owned on the Mac (here the test user), 0600, chained, every call in it.
  assert.equal(mode(r.auditFile), 0o600);
  const text = readFileSync(r.auditFile, 'utf8');
  const lines = text.trim().split('\n').map(l => JSON.parse(l));
  assert.equal(verifyChain(text).ok, true);
  assert.ok(lines.every(l => l.source === 'root-helper'));
  assert.deepEqual(lines.filter(l => l.outcome === 'ok').map(l => l.args.argv[0]), ['echo', 'true']);
  for (const code of ['signature_missing', 'unknown_key', 'replayed', 'args_mismatch', 'tier_mismatch', 'unsupported_op', 'frozen', 'approval_required']) {
    assert.ok(lines.some(l => l.code === code), code);
  }
  // The agent user may connect, but cannot add lines to the root chain (the Mac agent journals itself).
  assert.deepEqual(await client.request({ type: 'audit_append', fields: { op: 'operator_run', outcome: 'ok' } }), { ok: false, error: 'invalid_request' });
  assert.equal(readFileSync(r.auditFile, 'utf8'), text);
  // One edited line breaks the chain at that line.
  const edited = text.split('\n');
  edited[1] = edited[1].replace('"denied"', '"ok"');
  const broken = verifyChain(edited.join('\n'));
  assert.deepEqual([broken.ok, broken.first_broken_line], [false, 2]);
});

test('R-MR-03: FROZEN in the root directory, or the owner\'s ~/.memo-operator/FROZEN, stops every root call', async t => {
  const r = macRoot(t);
  if (!r) return;
  const { helper } = await r.start({ check: true });
  const call = () => helper.handle(r.sign('operator_run', { host: 'mac', argv: ['true'], as_root: true }));
  assert.equal((await call()).ok, true);
  writeFileSync(r.L.frozen, '');
  assert.equal((await call()).error, 'frozen');
  rmSync(r.L.frozen);
  writeFileSync(r.userFrozen, '');
  assert.equal((await call()).error, 'frozen');
  rmSync(r.userFrozen);
  assert.equal((await call()).ok, true);
});

test('R-MR-04: system PATH only, scripts from a root-only file removed after, background runs in their own group', async t => {
  const r = macRoot(t);
  if (!r) return;
  const seen = [];
  const executor = async (argv, opts) => {
    const script = argv[1];
    seen.push({ argv, opts, script, scriptMode: argv[0] === '/bin/bash' ? mode(script) : null });
    return { code: 0, stdout: 'ok', stderr: '' };
  };
  const { helper } = await r.start({ check: true, executor });
  const run = await helper.handle(r.sign('operator_run', { host: 'mac', argv: ['ls'], as_root: true, cwd: join(r.base, 'work'), env: { LANG: 'C' } }));
  assert.equal(run.ok, true);
  assert.deepEqual(seen[0].argv, ['ls'], 'no systemd-run, no shell: the argv itself');
  assert.equal(seen[0].opts.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin', 'never /opt/homebrew or /usr/local for root');
  assert.equal(seen[0].opts.env.LANG, 'C');
  assert.equal(seen[0].opts.cwd, join(r.base, 'work'));
  assert.equal(seen[0].opts.timeoutMs, 30_000);
  const script = await helper.handle(r.sign('operator_script', { host: 'mac', as_root: true, interpreter: 'bash', content: 'echo "$1"', args: ['a b'] },
    { approval: APPROVAL }));
  assert.equal(script.ok, true);
  assert.deepEqual(seen[1].argv.slice(2), ['a b']);
  assert.equal(seen[1].argv[0], '/bin/bash');
  assert.equal(seen[1].scriptMode, 0o700);
  assert.equal(existsSync(seen[1].script), false, 'the script file is removed after the run');
  // Background: a job whose supervisor kills the process group.
  const bg = await helper.handle(r.sign('operator_run', { host: 'mac', argv: ['true'], as_root: true, background: true }));
  assert.match(bg.job_id, /^rj_/);
  const job = JSON.parse(readFileSync(join(r.raw.state_dir, 'jobs', bg.job_id, 'job.json'), 'utf8'));
  assert.deepEqual([job.argv, job.process_group, job.env.PATH], [['true'], true, '/usr/bin:/bin:/usr/sbin:/sbin']);
});

test('R-MR-05: the timeout kills the whole process group; leftovers die when the program exits', async () => {
  // sh starts a grandchild, prints its pid, then waits on it: only a group kill stops both.
  const started = Date.now();
  const r = await runArgvGroup(['/bin/sh', '-c', 'sleep 30 & echo $!; wait'], { timeoutMs: 700, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 10_000);
  const grandchild = Number(r.stdout.trim());
  assert.ok(grandchild > 0);
  await sleep(200);
  assert.equal(alive(grandchild), false, 'the grandchild died with its group');
  // The program exits and leaves a background child behind: the group goes with it.
  const left = await runArgvGroup(['/bin/sh', '-c', 'sleep 30 & echo $!'], { timeoutMs: 20_000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(left.timedOut, false);
  assert.equal(left.code, 0);
  await sleep(200);
  assert.equal(alive(Number(left.stdout.trim())), false, 'nothing outlives the call in its group');
  // No shell: the argv is passed as is.
  const echo = await runArgvGroup(['echo', 'a;id'], { env: { PATH: '/usr/bin:/bin' } });
  assert.equal(echo.stdout, 'a;id\n');
});

test('R-MR-07: the Mac agent forwards as_root only while the helper socket exists', async t => {
  const r = macRoot(t);
  if (!r) return;
  const agentRaw = { ...r.raw, frozen_file: join(r.base, 'home', '.memo-operator', 'FROZEN'), audit_file: join(r.base, 'agent', 'audit.jsonl'),
    state_dir: join(r.base, 'agent') };
  mkdirSync(join(r.base, 'agent'), { recursive: true });
  const policy = parseOperatorPolicy(agentRaw);
  const verifier = createOperatorVerifier({ publicKeys: [r.pair.keys.publicKeyPem], host: 'mac' });
  const guard = createOperatorGuard(policy);
  const client = createRootHelperClient({ socketPath: r.socket, timeoutMs: 10_000, checkSocket: true });
  const { handlers } = createOperatorOperations({ policy, verifier, guard, tools: {}, rootHelper: client });
  const call = () => {
    const args = { host: 'mac', argv: ['echo', 'root'], as_root: true };
    const id = nextId();
    return handlers.operator_run(args, { id, op: 'operator_run', principal: { id: PRINCIPAL },
      operator: r.pair.signer.sign({ id, op: 'operator_run', host: 'mac', tier: 3, principal: PRINCIPAL, args }) });
  };
  assert.equal(client.available(), false);
  assert.equal((await call()).error, 'root_unavailable_on_host');
  // The helper starts: same signature, its own nonce cache, so the agent's forward is accepted.
  const { server } = await r.start({ check: false });
  t.after(() => server.stop());
  assert.equal(client.available(), true);
  const out = await call();
  assert.deepEqual([out.ok, out.as_root, out.untrusted_content.stdout], [true, true, 'root\n']);
  const helperLines = readFileSync(r.auditFile, 'utf8').trim().split('\n');
  assert.equal(helperLines.length, 1, 'only the call made while the socket existed reached the helper');
  // Without checkSocket (lab), the client has no available(): the agent always forwards.
  assert.equal('available' in createRootHelperClient({ socketPath: r.socket }), false);
});

test('R-MR-07: the agent policy is exec without the root policy, root with its socket once the root policy exists', async t => {
  const base = trustedBase(t);
  if (!base) return t.skip('no trusted temporary directory');
  const home = join(base, 'home');
  for (const d of ['memolabs', 'Desktop', 'Documents', 'Downloads']) mkdirSync(join(home, d), { recursive: true });
  const rootLayout = macRootLayout(join(base, 'operator-root'));
  const read = async () => ({ projects: [{ available: true, path: join(home, 'memolabs', 'app') }] });
  const first = await writePolicy(home, { read, rootLayout });
  assert.deepEqual([first.max_tier, first.root_helper], ['exec', null]);
  mkdirSync(rootLayout.dir, { recursive: true });
  writeFileSync(rootLayout.policy, '{}\n', { mode: 0o444 });
  const second = await writePolicy(home, { read, rootLayout, now: () => 1 });
  assert.deepEqual([second.max_tier, second.root_helper], ['root', '/var/run/memo-operator/root.sock']);
  const written = JSON.parse(readFileSync(macLayout(home).policyFile, 'utf8'));
  assert.deepEqual([written.max_tier, written.approval_mode, written.root_helper.socket], ['root', 'off', '/var/run/memo-operator/root.sock']);
});

test('R-MR-08: Mac root tools and paths ask for approval; reads stay free', () => {
  const asks = [['diskutil', 'eraseDisk', 'APFS', 'x', 'disk2'], ['/usr/bin/csrutil', 'disable'], ['nvram', 'boot-args=-v'], ['fdesetup', 'disable'],
    ['dscl', '.', '-create', '/Users/x'], ['dscl', '.', '-passwd', '/Users/memo', 'x'], ['dseditgroup', '-o', 'edit', '-a', 'x', 'admin'],
    ['sysadminctl', '-addUser', 'x'], ['pfctl', '-d'], ['tccutil', 'reset', 'All'], ['launchctl', 'bootout', 'system/x'], ['rm', '-r', '/tmp/x'],
    ['cp', 'x', '/Library/LaunchDaemons/evil.plist'], ['tee', '/private/etc/sudoers.d/x'], ['cp', 'x', '/private/etc/pam.d/sudo'],
    ['cp', 'x', '/Library/Application Support/MemoBridge/operator-root/policy.json'], ['truncate', '-s0', '/var/log/memo-operator/audit.jsonl'],
    ['cp', 'x', '/private/var/db/dslocal/nodes/Default/users/x.plist'], ['mv', 'x', '/var/run/memo-operator/root.sock']];
  for (const argv of asks) {
    assert.notEqual(dangerReason('operator_run', { argv, as_root: true }), null, argv.join(' '));
    assert.equal(needsApproval('dangerous', 'operator_run', { argv, as_root: true }, 3), true, argv.join(' '));
  }
  for (const argv of [['dscl', '.', '-read', '/Users/memo'], ['dscl', '.', '-list', '/Users'], ['ls', '/private/tmp'], ['id', '-u'],
    ['cat', '/Library/Application Support/Other/x.txt']]) {
    assert.equal(dangerReason('operator_run', { argv, as_root: true }), null, argv.join(' '));
  }
  assert.equal(dangerReason('operator_edit', { path: '/private/etc/sudoers' }), 'sensitive_path');
  assert.equal(dangerReason('operator_edit', { path: '/Library/LaunchDaemons/x.plist' }), 'sensitive_path');
});

test('R-MR-09: the install script dry run prints root-owned targets only, renders the policy and plist, and writes nothing', t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'memo-op-root-home-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.memo-operator'), { recursive: true });
  writeFileSync(join(home, '.memo-operator', 'operator-hub.pub'), operatorKeys().publicKeyPem);
  const listing = () => spawnSync('find', [home], { encoding: 'utf8' }).stdout.split('\n').sort().join('\n');
  const before = listing();
  const script = join(ROOT, 'deploy', 'mac', 'install-operator-root.sh');
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: tmpdir() };
  const out = spawnSync('/bin/bash', [script, '--node', process.execPath], { encoding: 'utf8', env, timeout: 60_000 });
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trim().split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  const plan = lines.filter(l => l.step === 'plan');
  assert.ok(plan.length >= 15);
  for (const step of plan) {
    assert.ok(!step.path.startsWith(`${home}/`) && step.path !== home, `target under $HOME: ${step.path}`);
    if (step.path !== '/var/run/memo-operator/root.sock') assert.match(step.owner, /^root(:wheel)?$/, step.path);
  }
  const paths = plan.map(s => s.path);
  for (const p of ['/Library/Application Support/MemoBridge/operator-root/bin/node', '/Library/Application Support/MemoBridge/operator-root/policy.json',
    '/Library/Application Support/MemoBridge/operator-root/operator-hub.pub', '/Library/LaunchDaemons/dev.memolabs.memo-operator-root.plist',
    '/var/log/memo-operator', '/var/db/memo-operator-root']) {
    assert.ok(paths.includes(p), p);
  }
  assert.equal(plan.find(s => s.path.endsWith('/bin/node')).mode, '0555');
  assert.equal(plan.find(s => s.path.endsWith('/policy.json')).mode, '0444');
  assert.equal(plan.find(s => s.path.endsWith('.plist')).mode, '0644');
  const sock = plan.find(s => s.path === '/var/run/memo-operator/root.sock');
  assert.deepEqual([sock.owner, sock.mode], [`${UID}:${GID}`, '0600']);
  // The policy: root, approval off, its switch and journal outside the home.
  const policy = lines.find(l => l.step === 'root-policy').content;
  assert.deepEqual([policy.host, policy.max_tier, policy.approval_mode], ['mac', 'root', 'off']);
  assert.equal(policy.frozen_file, '/Library/Application Support/MemoBridge/operator-root/FROZEN');
  assert.equal(policy.audit_file, '/var/log/memo-operator/audit.jsonl');
  assert.equal(policy.root_helper.socket, '/var/run/memo-operator/root.sock');
  // The plist: root, the root-owned node and bundle; the only home path is the owner's FROZEN switch.
  const plist = lines.find(l => l.step === 'root-plist').content;
  const strings = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]);
  assert.match(plist, /<key>UserName<\/key>\s*<string>root<\/string>/);
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Library\/Application Support\/MemoBridge\/operator-root\/bin\/node<\/string>\s*<string>\/Library\/Application Support\/MemoBridge\/operator-root\/bridge\/operator-root-mac-cli\.mjs<\/string>/);
  assert.deepEqual(strings.filter(s => s.startsWith(home)), [join(home, '.memo-operator', 'FROZEN')]);
  assert.match(lines.find(l => l.step === 'hub-pub').key_ids[0], /^[0-9a-f]{16}$/);
  assert.equal(listing(), before, 'the dry run wrote nothing in the home folder');
  // --install and --uninstall need root, and refuse before any change.
  for (const flag of ['--install', '--uninstall']) {
    const refused = spawnSync('/bin/bash', [script, flag], { encoding: 'utf8', env, timeout: 60_000 });
    if (UID === 0) continue;
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /needs root: run {2}sudo/);
    assert.equal(refused.stdout, '');
  }
  assert.equal(listing(), before);
  assert.equal(readdirSync(home).join(','), '.memo-operator');
});

// The hub rules of multi-session (#32) hold for Mac root as for lab root: an explicit host (never
// defaulted to the connected Mac), the caller's workspace and a global lock, Telegram approval for
// the dangerous list; the workspace_id never reaches the Mac.
test('hub: Mac root calls need host "mac", a workspace and a global lock, and approval when dangerous', async t => {
  const { tlsKey, tlsCert } = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'memo-mr-tls-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const out = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return { tlsKey: readFileSync(join(dir, 'k'), 'utf8'), tlsCert: readFileSync(join(dir, 'c'), 'utf8') };
  })();
  const id = generateAgentIdentity();
  const verifyWorkspace = async (principal, ws) => ({ ok: true, workspace: { workspace_id: ws, status: 'active', session_tag: null, project: 'drop' } });
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: 'a'.repeat(64), port: 0, audit: () => {},
    allowedAgentKeys: { mac: generateAgentIdentity().publicKey, vps: generateAgentIdentity().publicKey, 'operator-mac': id.publicKey },
    operator: { signingKeyPem: operatorKeys().privateKeyPem, anchorIntervalMs: 0, verifyWorkspace } });
  const { port } = await hub.start();
  t.after(() => hub.stop());
  const seen = [];
  const agent = createAgent({ host: 'operator-mac', url: `wss://127.0.0.1:${port}/agent`, privateKey: id.privateKey, ca: tlsCert, reconnectMs: 100_000,
    operations: { host_status: async () => ({ host: 'operator-mac', online: true }),
      operator_run: async (args, ctx) => { seen.push({ args, signed: ctx.operator }); return { ok: true, as_root: true, exit_code: 0 }; } } });
  t.after(() => agent.stop());
  const end = Date.now() + 5000;
  while (hub.agentInfo('operator-mac')?.version !== 2) { if (Date.now() > end) throw new Error('agent not connected'); await sleep(20); }
  const CHAT = makePrincipal('oidc:owner-sub', Object.values(CAPABILITIES), { client_type: 'chatgpt', via: 'hub' });
  const S = 'a'.repeat(64);
  const WS = 'ws_MACROOT000000001';
  const call = (host, args) => hub.requestOperator(host, 'operator_run', { args, principal: CHAT, clientSession: S });
  // No host: refused, even with the Mac connected (a root call is never defaulted).
  assert.equal((await call(undefined, { argv: ['id'], as_root: true })).error, 'host_required');
  assert.equal((await call(undefined, { argv: ['diskutil', 'list'] })).error, 'host_required', 'the Mac dangerous list reaches the hub');
  // Named, without workspace or lock (repatriation D-R14): the conversation's workspace and an
  // implicit global lock for this call only, released after it.
  const implicit = await call('mac', { host: 'mac', argv: ['id'], as_root: true });
  assert.deepEqual([implicit.ok, implicit.host, implicit.auto?.lock], [true, 'mac', 'implicit, released after this call']);
  assert.equal(hub.operatorLocks.size, 0);
  seen.length = 0;
  const lock = await hub.requestOperator('mac', 'operator_lock', { args: { host: 'mac', workspace_id: WS, kind: 'global', reason: 'mac root' },
    principal: CHAT, clientSession: S });
  assert.equal(lock.ok, true, JSON.stringify(lock));
  const out = await call('mac', { host: 'mac', workspace_id: WS, argv: ['id'], as_root: true });
  assert.deepEqual([out.ok, out.host], [true, 'mac']);
  assert.equal(seen.length, 1);
  assert.equal('workspace_id' in seen[0].args, false, 'the workspace never reaches the Mac or its signature');
  assert.deepEqual([seen[0].signed.host, seen[0].signed.tier], ['mac', 3]);
  // Dangerous on the Mac, no Telegram bot here: fail closed before anything is signed.
  assert.equal((await call('mac', { host: 'mac', workspace_id: WS, argv: ['diskutil', 'eraseDisk', 'x'], as_root: true })).error, 'approval_unavailable');
  assert.equal(seen.length, 1);
});
