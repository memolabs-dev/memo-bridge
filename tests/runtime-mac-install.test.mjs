// Mac runtime install (issues #110, #114, #147): deploy/mac/runtime-mac.mjs and
// deploy/mac/install-runtime-agent.sh. The enrollment rules run everywhere; the script itself is
// run for real (without --install, so launchd is never called) against a temporary HOME on macOS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_URL, enroll, renderPlist, renderPrivatePolicy, renderRemotePolicy, runtimeLayout } from '../deploy/mac/runtime-mac.mjs';
import { parseRemotePolicy } from '../bridge/write-gate.mjs';
import { loadOwnerPrivatePolicy, parseOwnerPrivatePolicy } from '../server/coordinator/owner-private-repos.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'deploy', 'mac', 'install-runtime-agent.sh');
const SUB = '7f0c2a51-3b8e-4d7a-9c11-2f4e5a6b7c8d';
const mode = path => statSync(path).mode & 0o777;

const project = (name, extra = {}) => ({ name, kind: 'repo', available: true, path: `/m/${name}`, ...extra });
const origins = { '/m/emargo': 'memolabs-dev/emargo', '/m/cdkf': 'memolabs-dev/clinical-data-knowledge-foundation',
  '/m/cuesheet': 'memolabs-dev/cuesheet', '/m/old': 'memolabs-dev/old', '/m/perso': 'someone/perso', '/m/ghost': 'memolabs-dev/ghost',
  '/m/twin': 'memolabs-dev/emargo' };
const github = { 'memolabs-dev/emargo': { private: true, archived: false },
  'memolabs-dev/clinical-data-knowledge-foundation': { private: true, archived: false },
  'memolabs-dev/cuesheet': { private: false, archived: false }, 'memolabs-dev/old': { private: true, archived: true } };
const deps = { origin: async path => origins[path] ?? null, visibility: async repo => github[repo] ?? null };
const registry = [project('emargo'), project('cdkf'), project('cuesheet'), project('old'), project('perso'), project('ghost'),
  project('twin'), project('folder', { kind: 'folder' }), project('absent', { available: false, path: null })];

test('enrollment: only registered Mac checkouts that GitHub reports private and live', async () => {
  const all = await enroll({ projects: registry, fromRegistry: true, ...deps });
  assert.equal(all.ok, true);
  assert.deepEqual(all.projects, [
    { name: 'cdkf', repo: 'memolabs-dev/clinical-data-knowledge-foundation' },
    { name: 'emargo', repo: 'memolabs-dev/emargo' }]);
  assert.deepEqual(all.skipped, [
    { name: 'old', reason: 'archived' }, { name: 'ghost', reason: 'github_unverified' },
    { name: 'twin', reason: 'origin_already_enrolled' }]);
  const one = await enroll({ projects: registry, explicit: ['memolabs-dev/emargo'], ...deps });
  assert.deepEqual(one.projects, [{ name: 'emargo', repo: 'memolabs-dev/emargo' }]);
  // A repository with no registered Mac checkout, a public one, or another owner's is refused.
  for (const repo of ['memolabs-dev/not-here', 'memolabs-dev/cuesheet', 'memolabs-dev/old']) {
    assert.equal((await enroll({ projects: registry, explicit: [repo], ...deps })).error, 'repo_not_enrolled', repo);
  }
  assert.equal((await enroll({ projects: registry, explicit: ['someone/perso'], ...deps })).error, 'invalid_repo');
  const many = Array.from({ length: 51 }, (_, i) => project(`p${i}`));
  const wide = await enroll({ projects: many, fromRegistry: true, origin: async p => `memolabs-dev/${p.slice(3)}`,
    visibility: async () => ({ private: true, archived: false }) });
  assert.equal(wide.error, 'too_many_repos');
});

test('policy files are the ones the coordinator, the remote policy and the ledger accept', async () => {
  const projects = [{ name: 'emargo', repo: 'memolabs-dev/emargo' }];
  const remote = parseRemotePolicy(JSON.parse(renderRemotePolicy({ ownerSub: SUB, projects })));
  assert.equal(remote.configured, true);
  assert.equal(remote.allow_mac_runtime, true);
  assert.equal(remote.owner_sub, SUB);
  assert.equal(remote.remote_writes, 'enabled');
  assert.equal(remote.session_binding, 'enforce');
  assert.deepEqual(remote.projects, ['emargo']);
  const priv = parseOwnerPrivatePolicy(JSON.parse(renderPrivatePolicy({ ownerSub: SUB, projects })), { expectedOwnerSub: SUB });
  assert.deepEqual(priv, { ok: true, repos: ['memolabs-dev/emargo'] });
  assert.throws(() => renderRemotePolicy({ ownerSub: 'not-a-uuid', projects }), /owner_sub_invalid/);
});

const plistEnv = text => Object.fromEntries([...text.split('<key>EnvironmentVariables</key>')[1].split('</dict>')[0]
  .matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)].map(m => [m[1], m[2]]));

test('plist: runtime mode with every variable the runtime and the ledger read, no secret', () => {
  const home = '/Users/owner';
  const L = runtimeLayout(home);
  const text = renderPlist({ home, node: '/opt/node/bin/node', release: `${L.base}/runtime-releases/abc`,
    governance: `${L.base}/governance/def`, ownerSub: SUB, extraPath: ['/opt/homebrew/bin'] });
  const env = plistEnv(text);
  assert.deepEqual(env, {
    MEMO_BRIDGE_AGENT_MODE: 'runtime', MEMO_BRIDGE_MAC_RUNTIME_ENABLED: 'enabled', MEMO_BRIDGE_HOST: 'mac',
    MEMO_BRIDGE_AGENT_URL: AGENT_URL, MEMO_BRIDGE_AGENT_CONFIG: '/Users/owner/.config/memo-bridge',
    CREDENTIALS_DIRECTORY: L.credentials, MEMO_BRIDGE_REMOTE_CONFIG: L.remotePolicy, MEMO_BRIDGE_OWNER_SUB: SUB,
    MEMO_BRIDGE_OWNER_PRIVATE_REPOS_FILE: '/Users/owner/.local/share/memo-bridge/owner-policy/private-repos.json',
    MEMO_BRIDGE_GOVERNANCE_ROOT: `${L.base}/governance/def`, MEMOLABS_ROOT: '/Users/owner/memolabs', HOME: home,
    PATH: '/opt/node/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' });
  assert.match(text, /runtime-releases\/abc\/bridge\/agent-cli\.mjs/);
  assert.throws(() => renderPlist({ home, node: 'node', release: '/r', governance: '/g', ownerSub: SUB }), /not_absolute/);
});

// A Mac home with a registry of one private and one public checkout, a fake `gh` that knows them,
// and a local governance repository; the real pnpm installs the bundle's production dependencies.
function macHome(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'memo-rt-mac-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const p = (...parts) => join(home, ...parts);
  const git = (cwd, ...args) => {
    const out = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  for (const d of ['memolabs/products/secret-app', 'memolabs/products/open-app', '.config/memo-bridge', 'bin', 'tmp', 'gov/scripts']) {
    mkdirSync(p(d), { recursive: true });
  }
  git(p('memolabs/products/secret-app'), 'init', '-q');
  git(p('memolabs/products/secret-app'), 'remote', 'add', 'origin', 'git@github.com:memolabs-dev/secret-app.git');
  git(p('memolabs/products/open-app'), 'init', '-q');
  git(p('memolabs/products/open-app'), 'remote', 'add', 'origin', 'https://github.com/memolabs-dev/open-app.git');
  writeFileSync(p('memolabs/PROJECTS.md'), ['# Registre', '## Projets appartenant à Memo Labs',
    '| Name | Path | Kind | Status | Nature | Stack | Vault note |', '|---|---|---|---|---|---|---|',
    '| secret-app | products/secret-app | repo | active | product | JS | - |',
    '| open-app | products/open-app | repo | active | product | JS | - |', ''].join('\n'));
  writeFileSync(p('.config/memo-bridge/agent.key'), 'probe-identity\n');
  writeFileSync(p('.config/memo-bridge/hub-ca.crt'), 'ca\n');
  for (const f of ['issue_lease.py', 'issue_preflight.py', 'private_owner_allowlist.py']) writeFileSync(p('gov/scripts', f), '# fixture\n');
  git(p('gov'), 'init', '-q');
  git(p('gov'), 'add', '.');
  git(p('gov'), 'commit', '-qm', 'fixture');
  const govRef = git(p('gov'), 'rev-parse', 'HEAD');
  writeFileSync(p('bin/gh'), ['#!/bin/bash',
    'if [ "$1" = auth ]; then echo gho_fixtureTOKENfixtureTOKEN0123; exit 0; fi',
    'case "$4" in',
    '  repos/memolabs-dev/secret-app) echo \'{"full_name":"memolabs-dev/secret-app","private":true,"archived":false}\' ;;',
    '  repos/memolabs-dev/open-app) echo \'{"full_name":"memolabs-dev/open-app","private":false,"archived":false}\' ;;',
    '  *) exit 1 ;;',
    'esac', ''].join('\n'));
  chmodSync(p('bin/gh'), 0o755);
  return { home, p, govRef };
}

// The temporary HOME has no pnpm store: point pnpm at the real one so the install stays offline.
const pnpmStore = () => {
  const out = spawnSync('pnpm', ['store', 'path'], { encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim() : null;
};
function run(home, args) {
  const store = pnpmStore();
  const out = spawnSync('/bin/bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 170_000,
    env: { PATH: `${join(home, 'bin')}:${process.env.PATH}`, HOME: home, TMPDIR: join(home, 'tmp'),
      ...(store ? { npm_config_store_dir: store } : {}) } });
  const steps = Object.fromEntries(out.stdout.trim().split('\n').filter(l => l.startsWith('{'))
    .map(l => JSON.parse(l)).map(o => [o.step ?? (o.ok !== undefined ? 'configure' : 'other'), o]));
  return { ...out, steps };
}

test('dry run on a Mac: bundle, pinned governance, 0600 credentials and policies, staged plist, launchd untouched',
  { skip: process.platform !== 'darwin' && 'the installer runs on macOS only', timeout: 180_000 }, async t => {
    const { home, p, govRef } = macHome(t);
    const L = runtimeLayout(home);
    const refused = run(home, ['--owner-sub', SUB, '--governance-ref', govRef, '--governance-src', p('gov'),
      '--repo', 'memolabs-dev/open-app']);
    assert.notEqual(refused.status, 0, 'a public repository is not an owner enrollment');
    assert.equal(refused.steps.configure?.error, 'repo_not_enrolled', refused.stdout + refused.stderr);
    assert.equal(existsSync(join(home, 'Library/LaunchAgents/dev.memolabs.memo-bridge-agent.plist')), false);

    const out = run(home, ['--owner-sub', SUB, '--governance-ref', govRef, '--governance-src', p('gov'), '--from-registry']);
    assert.equal(out.status, 0, out.stderr + out.stdout);
    assert.deepEqual(out.steps.configure.enrolled, [{ name: 'secret-app', repo: 'memolabs-dev/secret-app' }]);
    assert.ok(!out.stdout.includes('gho_fixture') && !out.stderr.includes('gho_fixture'), 'the token is never printed');
    const release = out.steps.bundle.release;
    assert.ok(existsSync(join(release, 'server', 'runtime.mjs')) && existsSync(join(release, 'node_modules', 'ws')));
    assert.ok(existsSync(join(out.steps.governance.root, 'scripts', 'private_owner_allowlist.py')));
    for (const f of ['agent-key', 'ledger-gh', 'push-gh']) assert.equal(mode(join(L.credentials, f)), 0o600, f);
    assert.equal(mode(L.credentials), 0o700);
    assert.equal(mode(L.policyDir), 0o700);
    assert.equal(mode(L.privatePolicy), 0o600);
    assert.equal(mode(L.remotePolicy), 0o600);
    const remote = parseRemotePolicy(JSON.parse(readFileSync(L.remotePolicy, 'utf8')));
    assert.deepEqual(remote.projects, ['secret-app']);
    // The coordinator's own loader accepts the file for the owner only.
    const loaded = await loadOwnerPrivatePolicy({ file: L.privatePolicy, principal: { id: `oidc:${SUB}` }, remotePolicy: remote,
      host: 'mac', home });
    assert.deepEqual(loaded, { ok: true, repos: ['memolabs-dev/secret-app'] });
    assert.equal((await loadOwnerPrivatePolicy({ file: L.privatePolicy, principal: { id: 'oidc:someone-else' },
      remotePolicy: remote, host: 'mac', home })).error, 'private_policy_owner_only');
    const staged = readFileSync(join(L.base, 'launchd', 'dev.memolabs.memo-bridge-agent.plist'), 'utf8');
    assert.equal(plistEnv(staged).MEMO_BRIDGE_GOVERNANCE_ROOT, out.steps.governance.root);
    assert.ok(!staged.includes('gho_fixture'));
    assert.equal(existsSync(join(home, 'Library/LaunchAgents/dev.memolabs.memo-bridge-agent.plist')), false, 'launchd untouched');
  });
