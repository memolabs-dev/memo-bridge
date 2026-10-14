// Phase 6, TODO-P6-13 (R-P6-01, R-P6-14): the Mac install script of operator-mac,
// deploy/mac/install-operator-agent.sh, run for real against a temporary HOME. Without --install
// it never calls launchd; the --install path is only checked for refusing early. The last test
// starts the installed bundle against a real hub on loopback TLS, the way launchd will.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey } from 'node:crypto';
import { loadOperatorPolicy } from '../bridge/operator-policy.mjs';
import { catalogProjects, createDenylist, repositoryGuard, resolveOperatorPath } from '../bridge/operator-paths.mjs';
import { createHub } from '../bridge/hub.mjs';
import { generateAgentIdentity } from '../bridge/crypto.mjs';
import { HUB_PRINCIPALS, PRINCIPAL_IDS } from '../bridge/ops.mjs';
import { AGENT_URL, LABEL, macLayout, renderPlist } from '../deploy/mac/operator-mac.mjs';
import { operatorKeys } from './helpers/operator-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'deploy', 'mac', 'install-operator-agent.sh');
const UID = process.getuid();
const mode = path => statSync(path).mode & 0o777;

function tls(dir) {
  const out = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'tls.key'), '-out', join(dir, 'tls.crt')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return { tlsKey: readFileSync(join(dir, 'tls.key'), 'utf8'), tlsCert: readFileSync(join(dir, 'tls.crt'), 'utf8') };
}

// A Mac home: the registry layout of 2026-10-14 (~/memolabs/PROJECTS.md, ~/memolabs/.links/<name>
// -> the checkout), one registered checkout on main, the probe agent's hub CA, and a hub
// operator signing key given to the script with --hub-pub.
function macHome(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'memo-op-mac-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const p = (...parts) => join(home, ...parts);
  for (const d of ['memolabs/.links', 'memolabs/os/app/.git', 'Desktop', 'Documents', 'Downloads', '.config/memo-bridge', 'outside', 'tmp']) {
    mkdirSync(p(d), { recursive: true });
  }
  writeFileSync(p('memolabs/os/app/.git/HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(p('memolabs/os/app/README.md'), 'tracked\n');
  symlinkSync(p('memolabs/os/app'), p('memolabs/.links/app'));
  writeFileSync(p('memolabs/PROJECTS.md'), ['# Registre', '## Projets appartenant à Memo Labs',
    '| Name | Path | Kind | Status | Nature | Stack | Vault note |', '|---|---|---|---|---|---|---|',
    '| app | app | repo | active | tool | JS | - |', ''].join('\n'));
  writeFileSync(p('Documents/note.txt'), 'hello from the Mac\n');
  const { tlsKey, tlsCert } = tls(p('outside'));
  writeFileSync(p('.config/memo-bridge/hub-ca.crt'), tlsCert);
  const opKeys = operatorKeys();
  writeFileSync(p('outside/operator-hub.pub'), opKeys.publicKeyPem);
  return { home, p, tlsKey, tlsCert, opKeys };
}

function run(home, args = []) {
  const out = spawnSync('/bin/bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 120_000,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: join(home, 'tmp'), MEMO_OPERATOR_NODE: process.execPath } });
  const lines = out.stdout.trim().split('\n').filter(Boolean);
  const steps = Object.fromEntries(lines.filter(l => l.startsWith('{')).map(l => JSON.parse(l)).map(o => [o.step, o]));
  return { ...out, steps };
}

const plistStrings = text => [...text.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]);
function plistEnv(text) {
  const dict = text.split('<key>EnvironmentVariables</key>')[1].split('</dict>')[0];
  return Object.fromEntries([...dict.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)].map(m => [m[1], m[2]]));
}

test('dry run: key 0600 never printed, policy 0444 that operator-policy.mjs loads, absolute plist, launchd untouched', async t => {
  const { home, p } = macHome(t);
  const L = macLayout(home);
  const out = run(home, ['--hub-pub', p('outside/operator-hub.pub')]);
  assert.equal(out.status, 0, out.stderr);
  // Key: created once, private, only the public path printed.
  assert.equal(out.steps.keygen.key_created, true);
  assert.equal(out.steps.keygen.public_key, join(home, '.memo-operator', 'operator-mac.pub'));
  assert.equal(mode(L.conf), 0o700);
  assert.equal(mode(L.keyFile), 0o600);
  assert.equal(createPrivateKey(readFileSync(L.keyFile)).asymmetricKeyType, 'ed25519');
  const keyBody = readFileSync(L.keyFile, 'utf8').split('\n')[1];
  for (const text of [out.stdout, out.stderr]) {
    assert.equal(text.includes('PRIVATE KEY'), false);
    assert.equal(text.includes(keyBody), false, 'no part of the private key is printed');
  }
  for (const f of [L.pubFile, L.hubCa, L.hubPub, L.policyFile]) assert.equal(mode(f), 0o444, f);
  // Policy: loaded exactly as the agent loads it, and what it grants.
  const policy = loadOperatorPolicy({ path: L.policyFile, expectedHost: 'mac', trustedUids: [0, UID], home });
  assert.deepEqual([policy.maxTierName, policy.approvalMode, policy.rootHelper], ['exec', 'dangerous', null]);
  assert.deepEqual([...policy.declaredRoots.read], [home]);
  assert.deepEqual([...policy.declaredRoots.write], ['memolabs', 'Desktop', 'Downloads', 'Documents'].map(d => join(home, d)).concat('/tmp'));
  assert.deepEqual([policy.frozenFile, policy.auditFile, policy.stateDir], [L.frozenFile, L.auditFile, L.stateDir]);
  assert.equal(mode(L.stateDir), 0o700);
  assert.equal(mode(L.logs), 0o700);
  // D11 through the catalog's own reader: the registered checkout on main answers use_dev_flow.
  assert.equal(out.steps.policy.registered_projects, 1);
  const projects = catalogProjects(policy.repositories);
  assert.deepEqual(await repositoryGuard(p('memolabs/os/app/README.md'), { projects }), { error: 'use_dev_flow', project: 'app', branch: 'main' });
  assert.deepEqual(await resolveOperatorPath(policy, '~/memolabs/os/app/README.md', { access: 'rw' }), { ok: false, error: 'use_dev_flow', project: 'app', branch: 'main' });
  assert.equal((await resolveOperatorPath(policy, '~/Documents/note.txt', { access: 'rw' })).ok, true);
  // Secrets of the brief, denied on the lexical path.
  const denied = createDenylist(policy).denied;
  for (const rel of ['Library/Keychains/login.keychain-db', '.ssh/config', '.gnupg/pubring.kbx', '.config/memolabs/secrets/memo-bridge/x.pub',
    'Library/Application Support/Slack/Cookies', 'Library/Application Support/Google/Chrome/Default/Login Data', 'Library/Safari/History.db',
    '.aws/config', '.netrc', 'Documents/AuthKey_ABC.p8', 'Downloads/cert.pem', '.memo-operator', '.memo-operator/policy.json',
    '.memo-operator/agent.key', '.config/memo-bridge/hub-ca.crt']) assert.equal(denied(join(home, rel)), true, rel);
  assert.equal(denied(join(home, 'Documents/note.txt')), false);
  // Plist: staged, every path absolute, no "~", node and script as resolved, the existing tunnel.
  const plistPath = join(L.runtime, 'launchd', `${LABEL}.plist`);
  assert.equal(out.steps.plist.path, plistPath);
  const plist = readFileSync(plistPath, 'utf8');
  assert.equal(plist.includes('~'), false);
  const strings = plistStrings(plist);
  for (const s of strings.filter(s => s.includes('/') && !s.startsWith('wss:') && !s.includes(':/'))) assert.ok(isAbsolute(s), s);
  const args = plist.split('<key>ProgramArguments</key>')[1].split('</array>')[0];
  assert.deepEqual(plistStrings(args), [process.execPath, L.script]);
  assert.deepEqual(plistEnv(plist), { MEMO_OPERATOR_HOST: 'mac', MEMO_OPERATOR_CONFIG: L.conf, MEMO_OPERATOR_POLICY: L.policyFile,
    MEMO_BRIDGE_AGENT_URL: 'wss://127.0.0.1:9444/agent', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
  assert.ok(strings.includes(join(home, 'Library/Logs/memo-operator/stderr.log')));
  assert.equal(plist, renderPlist({ home, node: process.execPath }));
  // Bundle in place, read-only; launchd never touched without --install.
  for (const rel of ['bridge/operator-agent-cli.mjs', 'bridge/operator-job-supervisor.mjs', 'package.json']) assert.equal(mode(join(L.runtime, rel)), 0o444);
  assert.equal(existsSync(join(home, 'Library', 'LaunchAgents')), false);
  assert.equal(out.steps.done.installed, false);
});

test('rerun is idempotent: same key, every step unchanged; a loosened key mode is tightened; an edited policy is replaced with a backup', t => {
  const { home, p } = macHome(t);
  const L = macLayout(home);
  assert.equal(run(home, ['--hub-pub', p('outside/operator-hub.pub')]).status, 0);
  const key = readFileSync(L.keyFile);
  const again = run(home);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.steps.keygen.key_created, false);
  assert.deepEqual([again.steps.keygen.public_key_state, again.steps['hub-ca'].state, again.steps.policy.state, again.steps.plist.state],
    ['unchanged', 'unchanged', 'unchanged', 'unchanged']);
  assert.ok(Object.values(again.steps.runtime.files).every(s => s === 'unchanged'), JSON.stringify(again.steps.runtime.files));
  assert.equal(again.steps['hub-pub'], undefined, 'an installed hub key is kept when --hub-pub is not given');
  assert.ok(readFileSync(L.keyFile).equals(key));
  assert.deepEqual(readdirSync(L.conf).filter(n => n.includes('.bak') || n.endsWith('.tmp')), []);
  // Drift: the key readable by others, the policy edited by hand.
  chmodSync(L.keyFile, 0o644);
  chmodSync(L.policyFile, 0o644);
  writeFileSync(L.policyFile, '{"version":1}\n');
  chmodSync(L.policyFile, 0o444);
  const fixed = run(home);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(mode(L.keyFile), 0o600);
  assert.ok(readFileSync(L.keyFile).equals(key), 'the key is never regenerated');
  assert.equal(fixed.steps.policy.state, 'written');
  assert.ok(fixed.steps.policy.backup && readFileSync(fixed.steps.policy.backup, 'utf8') === '{"version":1}\n');
  assert.equal(mode(L.policyFile), 0o444);
});

test('--install refuses before launchd when the hub key is missing; an empty registry refuses the policy', t => {
  const { home, p } = macHome(t);
  const out = run(home, ['--install']);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, process.platform === 'darwin' ? /operator-hub\.pub/ : /macOS only/);
  assert.equal(existsSync(join(home, 'Library', 'LaunchAgents')), false);
  // D11 needs a registry with at least one checkout: a write tier without it is refused.
  writeFileSync(p('memolabs/PROJECTS.md'), ['# Registre', '## Projets appartenant à Memo Labs',
    '| Name | Path | Kind | Status | Nature | Stack | Vault note |', '|---|---|---|---|---|---|---|', ''].join('\n'));
  const empty = run(home);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /registry_has_no_available_project/);
});

test('live: the installed bundle connects as operator-mac through a real hub and serves signed calls under the Mac policy', async t => {
  const { home, p, tlsKey, tlsCert, opKeys } = macHome(t);
  const L = macLayout(home);
  assert.equal(run(home, ['--hub-pub', p('outside/operator-hub.pub')]).status, 0);
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: 'a'.repeat(64), port: 0, audit: () => {},
    allowedAgentKeys: { mac: generateAgentIdentity().publicKey, vps: generateAgentIdentity().publicKey,
      'operator-mac': readFileSync(L.pubFile, 'utf8') },
    operator: { signingKeyPem: opKeys.privateKeyPem, freezeFile: p('outside/HUB-FROZEN') } });
  const { port } = await hub.start();
  t.after(() => hub.stop());
  // The plist's environment, with the hub's test port instead of the tunnel.
  const env = { ...plistEnv(readFileSync(join(L.runtime, 'launchd', `${LABEL}.plist`), 'utf8')), HOME: home };
  assert.equal(env.MEMO_BRIDGE_AGENT_URL, AGENT_URL);
  env.MEMO_BRIDGE_AGENT_URL = `wss://127.0.0.1:${port}/agent`;
  const child = spawn(process.execPath, [L.script], { cwd: L.runtime, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  t.after(() => child.kill('SIGTERM'));
  const expire = Date.now() + 15_000;
  while (hub.agentInfo('operator-mac')?.version !== 2) {
    if (Date.now() > expire || child.exitCode !== null) assert.fail(`operator-mac did not connect: ${stderr}`);
    await new Promise(r => setTimeout(r, 25));
  }
  assert.match(stderr, /"event":"operator_ready","host":"operator-mac","max_tier":"exec"/);
  const OWNER = HUB_PRINCIPALS[PRINCIPAL_IDS.owner];
  const policy = await hub.requestOperator('mac', 'operator_policy', { args: { host: 'mac' }, principal: OWNER });
  assert.deepEqual([policy.ok, policy.host, policy.policy.max_tier, policy.policy.approval_mode, policy.policy.repository_guard,
    policy.policy.root_helper], [true, 'mac', 'exec', 'dangerous', true, false]);
  const note = await hub.requestOperator('mac', 'operator_read', { args: { host: 'mac', path: '~/Documents/note.txt' }, principal: OWNER });
  assert.equal(note.ok, true);
  assert.match(note.untrusted_content.content, /hello from the Mac/);
  assert.deepEqual(await hub.requestOperator('mac', 'operator_read', { args: { host: 'mac', path: '~/.memo-operator/agent.key' }, principal: OWNER }),
    { ok: false, error: 'path_secret' });
  // The host journal is where the policy says, private, chained.
  assert.equal(mode(L.auditFile) & 0o077, 0);
  assert.equal(readFileSync(L.auditFile, 'utf8').trim().split('\n').length, 3);
});
