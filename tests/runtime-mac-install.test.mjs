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
  // Public repos are never auto-enrolled. One can opt in explicitly after GitHub attestation.
  const publicOne = await enroll({ projects: registry, explicit: ['memolabs-dev/cuesheet'], ...deps });
  assert.equal(publicOne.ok, true);
  assert.deepEqual(publicOne.projects, []);
  assert.deepEqual(publicOne.publicProjects, [{ name: 'cuesheet', repo: 'memolabs-dev/cuesheet' }]);
  assert.deepEqual(all.publicProjects, [], 'registry discovery never grants public repo execution');
  // No checkout, an archived or unverified repository, or another owner's origin is refused.
  for (const repo of ['memolabs-dev/not-here', 'memolabs-dev/old', 'memolabs-dev/ghost']) {
    assert.equal((await enroll({ projects: registry, explicit: [repo], ...deps })).error, 'repo_not_enrolled', repo);
  }
  assert.equal((await enroll({ projects: registry, explicit: ['someone/perso'], ...deps })).error, 'invalid_repo');
  // #257: the owner's own account is an owner namespace; a look-alike is not.
  assert.equal((await enroll({ projects: registry, explicit: ['guillaume-flambard-x/perso'], ...deps })).error, 'invalid_repo');
  const many = Array.from({ length: 101 }, (_, i) => project(`p${i}`));
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
  const mixed = parseRemotePolicy(JSON.parse(renderRemotePolicy({ ownerSub: SUB, projects,
    publicProjects: [{ name: 'cuesheet', repo: 'memolabs-dev/cuesheet' }] })));
  assert.deepEqual(mixed.projects, ['emargo', 'cuesheet']);
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
    MEMO_BRIDGE_OWNER_EXTERNAL_PROJECTS_FILE: '/Users/owner/.local/share/memo-bridge/owner-policy/external-projects.json',
    MEMO_BRIDGE_GOVERNANCE_ROOT: `${L.base}/governance/def`, MEMOLABS_ROOT: '/Users/owner/memolabs', HOME: home,
    PATH: '/opt/node/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' });
  assert.match(text, /runtime-releases\/abc\/bridge\/agent-cli\.mjs/);
  // --github-app (owner console D-A2-2): the App ids and the purpose gate, never the key.
  const withApp = plistEnv(renderPlist({ home, node: '/opt/node/bin/node', release: `${L.base}/runtime-releases/abc`,
    governance: `${L.base}/governance/def`, ownerSub: SUB, githubApp: true }));
  assert.equal(withApp.MEMO_BRIDGE_GITHUB_APP_ID, '5298579');
  assert.equal(withApp.MEMO_BRIDGE_GITHUB_APP_INSTALLATION_ID, '170927025');
  assert.equal(withApp.MEMO_BRIDGE_GITHUB_APP_PURPOSES, 'repo_create,repo_admin');
  assert.equal(Object.keys(withApp).length, Object.keys(env).length + 3);
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
  const allowlist = '# fixture\nimport pwd\n# the account home, not $HOME: pwd.getpwuid(uid).pw_dir (incident E-16)\n';
  for (const f of ['issue_lease.py', 'issue_preflight.py']) writeFileSync(p('gov/scripts', f), '# fixture\n');
  writeFileSync(p('gov/scripts/private_owner_allowlist.py'), allowlist);
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
    const publicOnly = run(home, ['--owner-sub', SUB, '--governance-ref', govRef, '--governance-src', p('gov'),
      '--repo', 'memolabs-dev/open-app']);
    assert.equal(publicOnly.status, 0, publicOnly.stderr + publicOnly.stdout);
    assert.deepEqual(publicOnly.steps.configure.enrolled, []);
    assert.deepEqual(publicOnly.steps.configure.public_enrolled,
      [{ name: 'open-app', repo: 'memolabs-dev/open-app' }]);
    const publicPolicy = parseRemotePolicy(JSON.parse(readFileSync(L.remotePolicy, 'utf8')));
    assert.deepEqual(publicPolicy.projects, ['open-app']);
    const emptyPrivate = parseOwnerPrivatePolicy(JSON.parse(readFileSync(L.privatePolicy, 'utf8')),
      { expectedOwnerSub: SUB });
    assert.deepEqual(emptyPrivate, { ok: true, repos: [] });
    assert.equal(existsSync(join(home, 'Library/LaunchAgents/dev.memolabs.memo-bridge-agent.plist')), false);
    const refused = run(home, ['--owner-sub', SUB, '--governance-ref', govRef, '--governance-src', p('gov'),
      '--repo', 'memolabs-dev/not-here']);
    assert.notEqual(refused.status, 0);
    assert.equal(refused.steps.configure?.error, 'repo_not_enrolled');
    assert.deepEqual(parseRemotePolicy(JSON.parse(readFileSync(L.remotePolicy, 'utf8'))).projects, ['open-app'],
      'a refused enrollment must not overwrite the previous policy');

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
    const combined = run(home, ['--owner-sub', SUB, '--governance-ref', govRef, '--governance-src', p('gov'),
      '--from-registry', '--repo', 'memolabs-dev/open-app']);
    assert.equal(combined.status, 0, combined.stderr + combined.stdout);
    assert.deepEqual(combined.steps.configure.enrolled, [{ name: 'secret-app', repo: 'memolabs-dev/secret-app' }]);
    assert.deepEqual(combined.steps.configure.public_enrolled, [{ name: 'open-app', repo: 'memolabs-dev/open-app' }]);
    assert.deepEqual(parseRemotePolicy(JSON.parse(readFileSync(L.remotePolicy, 'utf8'))).projects,
      ['secret-app', 'open-app']);
    assert.deepEqual(parseOwnerPrivatePolicy(JSON.parse(readFileSync(L.privatePolicy, 'utf8')),
      { expectedOwnerSub: SUB }), { ok: true, repos: ['memolabs-dev/secret-app'] },
    'public projects must never enter the private repository governance allowlist');
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
    assert.equal(plistEnv(staged).MEMO_BRIDGE_GITHUB_APP_ID, undefined);

    // --app-key (owner console D-A2-2): the key becomes the 0600 app-key credential, the plist gets
    // the App ids and the purpose gate; a later run without it removes the key again.
    const pemLine = kind => `-----${kind} RSA ${'PRIVATE'} KEY-----`;
    writeFileSync(p('app.pem'), `${pemLine('BEGIN')}\nfixture\n${pemLine('END')}\n`);
    const withKey = run(home, ['--owner-sub', SUB, '--governance-ref', govRef, '--governance-src', p('gov'), '--from-registry',
      '--app-key', p('app.pem')]);
    assert.equal(withKey.status, 0, withKey.stderr + withKey.stdout);
    assert.equal(mode(join(L.credentials, 'app-key')), 0o600);
    assert.ok(!withKey.stdout.includes('fixture'), 'the key is never printed');
    const appPlist = plistEnv(readFileSync(join(L.base, 'launchd', 'dev.memolabs.memo-bridge-agent.plist'), 'utf8'));
    assert.equal(appPlist.MEMO_BRIDGE_GITHUB_APP_PURPOSES, 'repo_create,repo_admin');
    assert.notEqual(run(home, ['--owner-sub', SUB, '--governance-ref', govRef, '--governance-src', p('gov'), '--from-registry',
      '--app-key', 'relative.pem']).status, 0);
    const again = run(home, ['--owner-sub', SUB, '--governance-ref', govRef, '--governance-src', p('gov'), '--from-registry']);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.equal(existsSync(join(L.credentials, 'app-key')), false);
  });

test('a governance pin that resolves the owner home from $HOME is refused (incident E-16)',
  { skip: process.platform !== 'darwin' && 'the installer runs on macOS only', timeout: 120_000 }, async t => {
    const { home, p, govRef } = macHome(t);
    const L = runtimeLayout(home);
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const git = (...args) => {
      const out = spawnSync('git', args, { cwd: p('gov'), encoding: 'utf8', env: gitEnv });
      assert.equal(out.status, 0, out.stderr);
      return out.stdout.trim();
    };
    // The shape that refused every private repository on 2026-10-18: the ledger child points
    // HOME at a private gh configuration directory, so an allowlist that reads it never sees
    // the owner's real home and answers False for every enrolled repository.
    writeFileSync(p('gov/scripts/private_owner_allowlist.py'),
      '# fixture\nimport os\nhome = os.environ["HOME"]\n');
    git('add', '.');
    git('commit', '-qm', 'resolve the home from the environment');
    const badRef = git('rev-parse', 'HEAD');
    assert.notEqual(badRef, govRef);

    const refused = run(home, ['--owner-sub', SUB, '--governance-ref', badRef, '--governance-src', p('gov'),
      '--from-registry']);
    assert.notEqual(refused.status, 0, refused.stderr + refused.stdout);
    assert.match(refused.stderr, /E-16/);
    assert.match(refused.stderr, /lease_denied/);
    assert.equal(existsSync(join(L.base, 'governance', badRef)), false, 'the bad pin is never installed');
    assert.equal(existsSync(join(home, 'Library/LaunchAgents/dev.memolabs.memo-bridge-agent.plist')), false,
      'launchd is never called');

    // The pin that carries the fix installs, which is what makes the refusal a check and not a
    // permanent block.
    const accepted = run(home, ['--owner-sub', SUB, '--governance-ref', govRef, '--governance-src', p('gov'),
      '--from-registry']);
    assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
    assert.ok(existsSync(join(accepted.steps.governance.root, 'scripts', 'private_owner_allowlist.py')));
  });
