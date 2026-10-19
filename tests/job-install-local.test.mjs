// The install phase of local (Mac) jobs: the plan (recipes.mjs planLocalInstall), the
// 'install' sandbox profile and environment (sandbox.mjs), the phase order and the refusal
// paths of the runner (job-runner.mjs), and the deadline of the safety net (executor-local.mjs).
// Spec: .agent/project/mac-job-install/spec.md.
//
// Package managers are fake shell scripts put first on PATH, so nothing here needs the network.
// The Seatbelt tests run on macOS only. MEMO_BRIDGE_LIVE_INSTALL=1 adds a live check that runs
// the real npm, pnpm (through corepack) and go inside the sandbox, with the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../server/runtime.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { RUNNER_PROTOCOL, createJobService, leaderStartOf, logPathFor } from '../server/runners/jobs.mjs';
import { DEADLINE_GRACE_MS, INSTALL_TIMEOUT_MS, reconcileLocalJob } from '../server/runners/executor-local.mjs';
import { INSTALL_TIMEOUT_SECONDS } from '../server/runners/executor-systemd.mjs';
import { runJob } from '../server/runners/job-runner.mjs';
import { INSTALL_ARGV, LOCAL_INSTALL_ARGV, detectLocalInstall, planLocalInstall } from '../server/runners/recipes.mjs';
import { GO_INSTALL_PROXY, MDNS_SOCKET, jobEnvironment, localPhaseEnvironment, sandboxCommand, sandboxPaths, sandboxProfile,
  toolRoots } from '../server/runners/sandbox.mjs';

const DARWIN = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
// As in tests/jobs.test.mjs: there is no sandbox off macOS, so the runner tests run unsandboxed there.
const SANDBOX_ENV = DARWIN ? {} : { MEMO_BRIDGE_JOB_SANDBOX: 'off' };
const OWNER = makePrincipal('local:owner', Object.values(CAPABILITIES));
const ISSUE = 'memolabs-dev/drop#7';
const RUNNER = new URL('../server/runners/job-runner.mjs', import.meta.url).pathname;

async function tempDir(t, prefix) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function files(dir, entries) {
  for (const [name, body] of Object.entries(entries)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), body);
  }
}

// ---------------------------------------------------------------------------------------
// The plan

test('plan: Node exactly as on the VPS, Go by recipe, nothing outside the pinned list', async t => {
  assert.deepEqual(LOCAL_INSTALL_ARGV.pnpm, INSTALL_ARGV.pnpm, 'the VPS shapes are unchanged');
  assert.deepEqual(LOCAL_INSTALL_ARGV.npm, INSTALL_ARGV.npm);
  assert.deepEqual(Object.keys(LOCAL_INSTALL_ARGV).sort(), ['go', 'npm', 'pnpm']);
  assert.deepEqual(LOCAL_INSTALL_ARGV.go, ['go', 'mod', 'download']);
  assert.ok(Object.isFrozen(LOCAL_INSTALL_ARGV) && Object.isFrozen(LOCAL_INSTALL_ARGV.go));
  assert.equal(INSTALL_TIMEOUT_MS, INSTALL_TIMEOUT_SECONDS * 1000, 'same install bound as the VPS');

  const npmTest = ['npm', 'test']; const goTest = ['go', 'test', './...'];
  const dir = async entries => { const d = await tempDir(t, 'memo-plan-'); await files(d, entries); return d; };
  const pkg = JSON.stringify({ name: 'x', scripts: { test: 'node t.js' } });
  assert.deepEqual(planLocalInstall(await dir({ 'package.json': pkg, 'package-lock.json': '{}' }), npmTest),
    { manager: 'npm', argv: ['npm', 'ci', '--ignore-scripts'] });
  assert.deepEqual(planLocalInstall(await dir({ 'package.json': pkg, 'pnpm-lock.yaml': '' }), npmTest),
    { manager: 'pnpm', argv: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'] });
  assert.deepEqual(planLocalInstall(await dir({ 'package.json': pkg }), npmTest), { skip: 'no_lockfile' });
  assert.deepEqual(planLocalInstall(await dir({ 'package.json': pkg, 'package-lock.json': '{}', 'node_modules/x': '' }), npmTest),
    { skip: 'node_modules_present' });
  assert.deepEqual(planLocalInstall(await dir({ 'go.mod': 'module x\n\ngo 1.22\n' }), goTest),
    { manager: 'go', argv: ['go', 'mod', 'download'] });
  assert.deepEqual(planLocalInstall(await dir({ 'go.mod': 'module x\n', 'vendor/modules.txt': '' }), goTest), { skip: 'vendored' });
  assert.deepEqual(planLocalInstall(await dir({ 'Makefile': 'test:\n\tgo test ./...\n' }), goTest), { skip: 'no_go_mod' });
  // A go.mod that is a link is never trusted (it could point anywhere).
  const linked = await dir({ 'real.mod': 'module x\n' });
  await symlink(join(linked, 'real.mod'), join(linked, 'go.mod'));
  assert.deepEqual(detectLocalInstall(linked, goTest), { skip: 'no_go_mod' });
  // Not a Go recipe: the VPS decision, which ignores go.mod.
  assert.deepEqual(planLocalInstall(await dir({ 'go.mod': 'module x\n' }), ['make', 'test']), { skip: 'no_package_json' });

  // Refusals: anything detection returns outside the pinned list.
  for (const argv of [['npm', 'install'], ['npm', 'ci'], ['sh', '-c', 'npm ci'], ['go', 'mod', 'download', '-x'], ['go', 'get', './...']]) {
    assert.deepEqual(planLocalInstall('/w', npmTest, { detect: () => ({ manager: 'x', argv }) }), { error: 'install_not_allowed' }, argv.join(' '));
  }
  assert.deepEqual(planLocalInstall('/w', npmTest, { detect: () => { throw new Error('boom'); } }), { skip: 'install_not_detected' });
  assert.deepEqual(planLocalInstall('/w', npmTest, { detect: () => null }), { skip: 'nothing_to_install' });
  const plan = planLocalInstall('/w', goTest, { detect: () => ({ manager: 'go', argv: LOCAL_INSTALL_ARGV.go }) });
  plan.argv.push('-x');
  assert.deepEqual(LOCAL_INSTALL_ARGV.go, ['go', 'mod', 'download'], 'the plan is a copy');
});

// ---------------------------------------------------------------------------------------
// The profiles

const sha = text => createHash('sha256').update(text).digest('hex');

test('recipe profile: byte for byte the profile of origin/main before the install phase', () => {
  // Hashes of sandboxProfile({ denyReadCount: 2, gitCommon }) at 59e9e85.
  assert.equal(sha(sandboxProfile({ denyReadCount: 2, gitCommon: true })), 'fe6d9bbc330670f8cd377d6a67b436a4d69d8608cd224f7fe02e3d801a3e7ee6');
  assert.equal(sha(sandboxProfile({ denyReadCount: 2, gitCommon: false })), 'ee41caca66ecbe87d3ceaab3dc659b24d00daa77bc3e39ddcb3e754e5fd79811');
  assert.equal(sandboxProfile({ denyReadCount: 2, gitCommon: true, phase: 'recipe', toolRootCount: 3 }),
    sandboxProfile({ denyReadCount: 2, gitCommon: true }), 'tool roots never reach the recipe profile');
  assert.throws(() => sandboxProfile({ denyReadCount: 0, gitCommon: false, phase: 'network' }), /sandbox_phase_invalid/);
});

test('install profile: HTTPS out, no loopback, home closed except tool roots, denylist on top, no path inside', () => {
  const profile = sandboxProfile({ denyReadCount: 2, gitCommon: true, phase: 'install', toolRootCount: 2 });
  assert.doesNotMatch(profile.replace(/"\/dev\/[a-z]+"|#"\^\/dev\/[a-z]+\/?"/g, ''), /"\//, 'paths only come in through -D parameters');
  const lines = profile.split('\n');
  const at = text => { const i = lines.indexOf(text); assert.ok(i >= 0, `missing: ${text}`); return i; };
  // Network, in this order (Seatbelt: the last matching rule wins).
  const denyNet = at('(deny network-outbound)');
  const https = at('(allow network-outbound (remote ip "*:443"))');
  const noLoopback = at('(deny network-outbound (remote ip "localhost:*"))');
  assert.ok(denyNet < https && https < noLoopback);
  assert.match(profile, /\(remote unix-socket \(literal \(param "MDNS_SOCKET"\)\)\)/);
  assert.ok(!lines.slice(noLoopback + 1).some(line => line.includes('remote ip')), 'no later rule allows an address back');
  assert.doesNotMatch(profile, /com\.apple\.dnssd\.service/, 'DNS is allowed in the install');
  // Reads, in this order.
  const home = at('(deny file-read-data file-read-xattr (subpath (param "HOME")))');
  const tools = at('(allow file-read-data file-read-xattr (subpath (param "TOOL_ROOT_0")) (subpath (param "TOOL_ROOT_1")))');
  const deny = at('(deny file-read-data file-read-xattr (subpath (param "DENY_READ_0")) (subpath (param "DENY_READ_1")))');
  const own = at('(allow file-read-data file-read-xattr (subpath (param "WORKTREE")) (subpath (param "JOB_TMP")))');
  const state = at('(deny file-read-data file-read-xattr file-write* (subpath (param "STATE_DIR")))');
  assert.ok(home < tools && tools < deny && deny < own && own < state);
  assert.doesNotMatch(profile, /GIT_COMMON/, 'the repository Git data is not needed to install');
  // Everything else is the recipe's.
  for (const rule of ['(deny job-creation)', '(deny signal)', '(allow signal (target same-sandbox))', '(deny lsopen)', '(deny appleevent-send)',
    '(deny file-write*)', '(deny file-write* (literal (param "WORKTREE_GIT")) (subpath (param "WORKTREE_GIT")))']) at(rule);
  assert.match(profile, /com\.apple\.SecurityServer.*com\.apple\.pasteboard\.1/);
  assert.equal(sandboxProfile({ denyReadCount: 0, gitCommon: false, phase: 'install' }).includes('TOOL_ROOT'), false);
});

test('install command: its parameters, and a home that cannot be closed is refused', () => {
  const paths = { worktree: '/w', worktreeGit: '/w/.git', jobTmp: '/j', stateDir: '/s', gitCommon: '/r/.git', home: '/Users/o',
    toolRoots: ['/Users/o/.nvm/versions/node/v24'], denyRead: ['/Users/o/.ssh'] };
  const [, args] = sandboxCommand(['nice', '-n', '10', 'npm', 'ci', '--ignore-scripts'], paths, { phase: 'install' });
  assert.deepEqual(args.slice(-6), ['nice', '-n', '10', 'npm', 'ci', '--ignore-scripts']);
  for (const p of ['HOME=/Users/o', `MDNS_SOCKET=${MDNS_SOCKET}`, 'TOOL_ROOT_0=/Users/o/.nvm/versions/node/v24', 'DENY_READ_0=/Users/o/.ssh']) {
    assert.ok(args.includes(p), p);
  }
  assert.ok(!args.some(a => a.startsWith('GIT_COMMON=')));
  const [, recipeArgs] = sandboxCommand(['npm', 'test'], paths);
  assert.ok(recipeArgs.includes('GIT_COMMON=/r/.git'));
  assert.ok(!recipeArgs.some(a => /^(HOME|MDNS_SOCKET|TOOL_ROOT_\d+)=/.test(a)), 'the recipe command is unchanged');
  assert.throws(() => sandboxCommand(['npm', 'ci'], { ...paths, home: '/' }, { phase: 'install' }), /sandbox_home_invalid/);
  assert.throws(() => sandboxCommand(['npm', 'ci'], { ...paths, home: undefined }, { phase: 'install' }), /sandbox_home_invalid/);
  assert.throws(() => sandboxCommand(['npm', 'ci'], paths, { phase: 'other' }), /sandbox_phase_invalid/);
});

test('toolRoots: a toolchain prefix two levels below home, otherwise the PATH folder itself', async t => {
  const home = await tempDir(t, 'memo-home-');
  for (const d of ['.nvm/versions/node/v24/bin', '.local/bin', 'bin', 'Library/pnpm/bin', 'opt/real/bin']) await mkdir(join(home, d), { recursive: true });
  await symlink(join(home, 'opt', 'real', 'bin'), join(home, 'linked-bin'));
  const roots = toolRoots([join(home, '.nvm/versions/node/v24/bin'), join(home, '.local/bin'), join(home, 'bin'), join(home, 'Library/pnpm/bin'),
    join(home, 'linked-bin'), '/usr/bin', '/opt/homebrew/bin', 'relative/bin', '', join(home, 'missing', 'bin')].join(':'), home);
  assert.deepEqual(roots, [join(home, '.local/bin'), join(home, '.nvm/versions/node/v24'), join(home, 'Library/pnpm'), join(home, 'bin'),
    join(home, 'missing/bin'), join(home, 'opt/real')].sort());
  assert.ok(!roots.includes(home) && !roots.includes(join(home, '.local')), 'never home, never a one-level folder such as ~/.local');
  assert.deepEqual(toolRoots(undefined, home), []);
});

// ---------------------------------------------------------------------------------------
// The environment

test('environment: caches in the job folder, offline recipe, never -mod=mod, secrets still dropped', () => {
  const base = { PATH: '/bin', HOME: '/Users/o', GITHUB_TOKEN: 'x', NPM_TOKEN: 'n', GOFLAGS: '-mod=mod', GOPROXY: 'https://evil.example',
    GONOSUMDB: '*', GOPRIVATE: '*', COREPACK_NPM_REGISTRY: 'https://evil.example', npm_config_registry: 'https://evil.example' };
  const at = { jobId: 'job_x', home: '/j/home', tmp: '/j/tmp', cache: '/j/cache' };
  const install = localPhaseEnvironment('install', base, at);
  const recipe = localPhaseEnvironment('recipe', base, at);
  const shared = { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', COREPACK_ENABLE_AUTO_PIN: '0', COREPACK_HOME: '/j/cache/corepack',
    XDG_RUNTIME_DIR: '/j/cache/xdg-runtime',
    GOMODCACHE: '/j/cache/gomod', GOFLAGS: '-modcacherw', GOTOOLCHAIN: 'local' };
  assert.deepEqual(install, { ...jobEnvironment(base, at), ...shared, XDG_CACHE_HOME: '/j/cache/xdg-cache', XDG_DATA_HOME: '/j/cache/xdg-data',
    XDG_STATE_HOME: '/j/cache/xdg-state', pnpm_config_store_dir: '/j/cache/pnpm-store', npm_config_cache: '/j/cache/npm',
    npm_config_audit: 'false', npm_config_fund: 'false', GOPROXY: GO_INSTALL_PROXY });
  assert.deepEqual(recipe, { ...jobEnvironment(base, at), ...shared, COREPACK_ENABLE_NETWORK: '0', GOPROXY: 'off' });
  assert.equal(GO_INSTALL_PROXY, 'https://proxy.golang.org', 'no direct fallback, so no version control tool runs');
  for (const env of [install, recipe]) {
    assert.doesNotMatch(env.GOFLAGS, /-mod=/);
    for (const key of ['GITHUB_TOKEN', 'NPM_TOKEN', 'GONOSUMDB', 'GOPRIVATE', 'COREPACK_NPM_REGISTRY', 'npm_config_registry']) assert.equal(env[key], undefined, key);
    assert.equal(env.HOME, '/j/home');
  }
  assert.throws(() => localPhaseEnvironment('other', base, at), /sandbox_phase_invalid/);
});

// ---------------------------------------------------------------------------------------
// Seatbelt (macOS)

test('install sandbox on macOS: port 443 only, no loopback, home closed except tool roots, writes to the worktree only', { skip: !DARWIN && 'Seatbelt is macOS only' }, async t => {
  const base = await tempDir(t, 'memo-isbx-');
  const home = join(base, 'home');
  const worktree = join(base, 'worktrees', 'drop', 'agent-7');
  const stateDir = join(base, 'state');
  const jobTmp = join(base, 'job');
  for (const d of [worktree, stateDir, jobTmp]) await mkdir(d, { recursive: true });
  await files(home, { 'notes.txt': 'private\n', '.zshrc': 'export TOKEN=secret\n', '.tool/versions/v1/lib/tool.js': 'tool\n',
    '.config/gh/hosts.yml': 'oauth_token: secret\n', '.config/gh/bin/gh-helper': '' });
  await files(worktree, { 'package.json': '{}\n' });
  await writeFile(join(stateDir, 'store.sqlite'), 'private');
  // PATH: a toolchain under home, and a PATH entry whose prefix is a denylisted folder.
  const path = [join(home, '.tool/versions/v1/bin'), join(home, '.config/gh/bin'), process.env.PATH].join(':');
  await mkdir(join(home, '.tool/versions/v1/bin'), { recursive: true });
  const paths = sandboxPaths({ worktree, stateDir, jobTmp, worktreesRoot: join(base, 'worktrees'), home, path });
  assert.deepEqual(paths.toolRoots, [join(home, '.config/gh'), join(home, '.tool/versions/v1')]);
  const run = (phase, ...argv) => {
    const [command, args] = sandboxCommand(argv, paths, { phase });
    return spawnSync(command, args, { cwd: worktree, encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, HOME: jobTmp } });
  };
  const connect = (host, port) => `require('net').connect(${port},'${host}').setTimeout(1500,()=>{console.log('TIMEOUT');process.exit(0)})` +
    ".on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(0)})";
  // Network: port 443 leaves (TEST-NET-1 never answers: a timeout or an unreachable network,
  // never EPERM); port 80 and loopback, port 443 included, are refused by the sandbox.
  assert.doesNotMatch(run('install', process.execPath, '-e', connect('192.0.2.1', 443)).stdout, /EPERM/);
  assert.match(run('install', process.execPath, '-e', connect('192.0.2.1', 80)).stdout, /EPERM/);
  assert.match(run('install', process.execPath, '-e', connect('127.0.0.1', 443)).stdout, /EPERM/);
  assert.match(run('install', process.execPath, '-e', connect('127.0.0.1', 9443)).stdout, /EPERM/);
  // The recipe profile still refuses port 443.
  assert.match(run('recipe', process.execPath, '-e', connect('192.0.2.1', 443)).stdout, /EPERM/);
  // Reads.
  assert.equal(run('install', '/bin/cat', 'package.json').stdout, '{}\n', 'the worktree is readable');
  assert.equal(run('install', '/bin/cat', join(home, '.tool/versions/v1/lib/tool.js')).stdout, 'tool\n', 'a tool root is readable');
  for (const secret of [join(home, 'notes.txt'), join(home, '.zshrc'), join(home, '.config/gh/hosts.yml'), join(stateDir, 'store.sqlite')]) {
    const r = run('install', '/bin/cat', secret);
    assert.notEqual(r.status, 0, `install read ${secret}`);
    assert.match(r.stderr, /Operation not permitted/, secret);
  }
  assert.equal(run('recipe', '/bin/cat', join(home, '.zshrc')).status, 0, 'the recipe profile is unchanged: it reads what the denylist does not name');
  // Writes.
  assert.equal(run('install', '/usr/bin/touch', join(worktree, 'node_modules.txt')).status, 0);
  assert.equal(run('install', '/usr/bin/touch', join(jobTmp, 'cache')).status, 0);
  for (const target of [join(home, 'planted'), join(stateDir, 'store.sqlite'), join(base, 'worktrees', 'drop', 'planted')]) {
    assert.notEqual(run('install', '/usr/bin/touch', target).status, 0, `write ${target}`);
  }
});

// ---------------------------------------------------------------------------------------
// The runner

// Fake package managers: they record their arguments in the worktree's calls.log and read
// what to do from the worktree (the job environment is an allow-list, so no test variable
// reaches them).
const FAKE_NPM = `#!/bin/sh
echo "npm $*" >> calls.log
if [ "$1" = ci ]; then
  echo "install env: cache=$npm_config_cache corepack_net=\${COREPACK_ENABLE_NETWORK:-on}"
  case "$(cat install-mode 2>/dev/null)" in
    fail) echo install-broke; exit 7 ;;
    sleep) exec /bin/sleep 60 ;;
  esac
  mkdir node_modules && echo ok > node_modules/marker && echo "$npm_config_cache" > cache-path
  exit 0
fi
if [ "$1" = test ]; then
  [ -f node_modules/marker ] && echo recipe-sees-deps
  echo "recipe env: corepack_net=$COREPACK_ENABLE_NETWORK"
  exit 0
fi
exit 9
`;
const FAKE_GO = `#!/bin/sh
echo "go $*" >> calls.log
if [ "$1 $2" = "mod download" ]; then
  echo "install env: proxy=$GOPROXY flags=$GOFLAGS toolchain=$GOTOOLCHAIN modcache=$GOMODCACHE/"
  mkdir -p "$GOMODCACHE/example.com/dep@v1" && echo dep > "$GOMODCACHE/example.com/dep@v1/dep.go" && chmod 0555 "$GOMODCACHE/example.com/dep@v1"
  exit 0
fi
if [ "$1" = test ]; then
  [ -f "$GOMODCACHE/example.com/dep@v1/dep.go" ] && echo recipe-sees-modules
  echo "recipe env: proxy=$GOPROXY"
  exit 0
fi
exit 9
`;

async function fakeBin(t) {
  const bin = await tempDir(t, 'memo-fakebin-');
  for (const [name, body] of [['npm', FAKE_NPM], ['go', FAKE_GO]]) {
    await writeFile(join(bin, name), body);
    await chmod(join(bin, name), 0o755);
  }
  return bin;
}

const stubLedger = () => {
  const receipt = { state: 'claimed', fence_sha: 'f'.repeat(40) };
  const ok = async () => ({ ok: true, receipt });
  return { status: ok, claim: ok, verify: ok, heartbeat: ok, release: ok };
};

// A runtime with an active workspace, a live claim and a worktree holding `entries`. Jobs are
// submitted without starting a runner; each test runs runJob in this process.
async function setup(t, entries) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'memo-ijobs-')));
  const stateDir = join(base, 'state');
  const repoDir = join(base, 'repo');
  await mkdir(repoDir);
  await files(repoDir, entries);
  const rt = createRuntime({ stateDir, principal: OWNER, ledger: stubLedger(), host: 'mac' });
  const workspaceId = `ws_${randomBytes(12).toString('base64url')}`;
  const worktreeId = `wt_${randomBytes(9).toString('base64url')}`;
  const now = Date.now();
  await rt.store().transaction(repo => {
    repo.insertWorkspace({ id: workspaceId, principal: OWNER.id, client_type: 'claude-code', project_id: 'drop', host: 'mac',
      status: 'active', created_at: now, updated_at: now });
    repo.insertClaim({ claim_id: randomBytes(16).toString('hex'), workspace_id: workspaceId, issue_ref: ISSUE,
      fence_sha: 'f'.repeat(40), epoch: 1, expires_at: new Date(now + 3600_000).toISOString(), updated_at: now });
    repo.insertWorktree({ id: worktreeId, workspace_id: workspaceId, project_id: 'drop', host: 'mac', path: repoDir,
      branch: 'agent/drop-7', base_ref: 'main', base_commit: 'a'.repeat(40), issue_ref: ISSUE, created_at: now, updated_at: now });
  });
  const jobs = createJobService(rt, { spawnRunner: async () => ({ ok: true, pid: process.pid }), env: { ...process.env, ...SANDBOX_ENV } });
  const bin = await fakeBin(t);
  const env = { ...process.env, ...SANDBOX_ENV, PATH: `${bin}:${process.env.PATH}` };
  t.after(async () => { await rt.close(); await rm(base, { recursive: true, force: true }); });
  const submit = async (recipe = 'test') => {
    const r = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.job.job_id;
  };
  const raw = id => rt.store().transaction(repo => repo.getJob(id), { write: false });
  const kinds = async id => (await jobs.events({ job_id: id })).events.map(e => e.kind);
  const calls = () => { try { return readFileSync(join(repoDir, 'calls.log'), 'utf8').trim().split('\n'); } catch { return []; } };
  const log = id => readFileSync(logPathFor(stateDir, id), 'utf8');
  return { rt, stateDir, repoDir, jobs, env, submit, raw, kinds, calls, log };
}

const NPM_REPO = { 'package.json': JSON.stringify({ name: 'x', private: true, scripts: { test: 'node t.js' } }), 'package-lock.json': '{}\n' };
// The job folder a fake package manager reported (…/memo-bridge-job-XXXX/cache/…).
const jobRootIn = text => /(\/\S*\/memo-bridge-job-[^/\s]+)\/cache\//.exec(text)?.[1] ?? null;

test('phase order: install with network, then the recipe offline; the job folder and its caches are deleted', async t => {
  const s = await setup(t, NPM_REPO);
  const id = await s.submit();
  const result = await runJob(s.stateDir, id, { env: s.env });
  assert.deepEqual(result, { ok: true, status: 'succeeded' }, s.log(id));
  assert.deepEqual(s.calls(), ['npm ci --ignore-scripts', 'npm test']);
  assert.deepEqual(await s.kinds(id), ['submitted', 'install_started', 'install_exit', 'started', 'exit']);
  const text = s.log(id);
  assert.match(text, /phase install \(network on, scripts off\): npm ci --ignore-scripts/);
  assert.match(text, /install env: cache=.*memo-bridge-job-[^/]+\/cache\/npm corepack_net=on/);
  assert.match(text, /phase install: exit 0\n/);
  assert.match(text, /recipe test: npm test/);
  assert.match(text, /recipe-sees-deps/);
  assert.match(text, /recipe env: corepack_net=0/);
  assert.ok(text.indexOf('phase install') < text.indexOf('recipe test'));
  const cachePath = readFileSync(join(s.repoDir, 'cache-path'), 'utf8').trim();
  assert.ok(jobRootIn(text) && cachePath.startsWith(`${jobRootIn(text)}/cache/`), cachePath);
  assert.equal(existsSync(jobRootIn(text)), false, 'the job folder and its caches are gone');
  // The job's pid and leader are the recipe's, the last phase.
  const events = (await s.jobs.events({ job_id: id })).events;
  const started = events.find(e => e.kind === 'started').detail;
  const installStarted = events.find(e => e.kind === 'install_started').detail;
  assert.deepEqual(installStarted.argv, ['npm', 'ci', '--ignore-scripts']);
  assert.equal((await s.raw(id)).pid, started.pid);
  assert.equal(await s.rt.store().transaction(repo => leaderStartOf(repo, id), { write: false }), started.pid_start);
  assert.equal(events.find(e => e.kind === 'install_exit').detail.status, 'succeeded');
});

test('without a lockfile the install is skipped and the job keeps its former events', async t => {
  const s = await setup(t, { 'package.json': NPM_REPO['package.json'] });
  const id = await s.submit();
  assert.deepEqual(await runJob(s.stateDir, id, { env: s.env }), { ok: true, status: 'succeeded' });
  assert.deepEqual(s.calls(), ['npm test']);
  assert.deepEqual(await s.kinds(id), ['submitted', 'started', 'exit']);
  assert.match(s.log(id), /phase install: skipped \(no_lockfile\)/);
});

test('a failed install ends the job: install_failed, the install exit code, the recipe never runs', async t => {
  const s = await setup(t, { ...NPM_REPO, 'install-mode': 'fail' });
  const id = await s.submit();
  assert.deepEqual(await runJob(s.stateDir, id, { env: s.env }), { ok: true, status: 'failed' });
  assert.deepEqual(s.calls(), ['npm ci --ignore-scripts']);
  const job = await s.raw(id);
  assert.equal(job.status_reason, 'install_failed');
  assert.equal(job.exit_code, 7);
  assert.match(job.summary, /install-broke/);
  assert.deepEqual(await s.kinds(id), ['submitted', 'install_started', 'install_exit', 'exit']);
  const exit = (await s.jobs.events({ job_id: id })).events.at(-1).detail;
  assert.equal(exit.phase, 'install');
  assert.equal(exit.reason, 'install_failed');
  assert.match(s.log(id), /phase install: exit 7: install_failed/);
  assert.doesNotMatch(s.log(id), /recipe test:/);
  const status = await s.jobs.status({ job_id: id });
  assert.equal(status.job.status_reason, 'install_failed', 'job_status says why');
});

test('an install past its bound ends the job as install_timeout; the recipe never runs', async t => {
  const s = await setup(t, { ...NPM_REPO, 'install-mode': 'sleep' });
  const id = await s.submit();
  const started = Date.now();
  assert.deepEqual(await runJob(s.stateDir, id, { env: s.env, installTimeoutMs: 1500 }), { ok: true, status: 'failed' });
  assert.ok(Date.now() - started < 30_000);
  assert.deepEqual(s.calls(), ['npm ci --ignore-scripts']);
  const job = await s.raw(id);
  assert.equal(job.status_reason, 'install_timeout');
  assert.deepEqual(await s.kinds(id), ['submitted', 'install_started', 'timeout', 'install_exit', 'exit']);
  assert.match(s.log(id), /phase install: timeout after 2 s: stopping the install/);
});

test('job_cancel during the install stops it; the recipe never runs', async t => {
  const s = await setup(t, { ...NPM_REPO, 'install-mode': 'sleep' });
  const id = await s.submit();
  // The real runner, in its own process, as jobs_submit starts it (two store connections in
  // one process would wait on each other).
  const runner = spawn(process.execPath, [RUNNER, `--protocol=${RUNNER_PROTOCOL}`, s.stateDir, id], { env: s.env, stdio: 'ignore' });
  const exited = new Promise(resolve => runner.once('exit', resolve));
  t.after(() => { try { runner.kill('SIGKILL'); } catch { /* gone */ } });
  const deadline = Date.now() + 20_000;
  // Wait for the install itself to run, not only for its event.
  while (!(await s.kinds(id)).includes('install_started') || !s.calls().length) {
    assert.ok(Date.now() < deadline, 'install never started');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const cancelled = await s.jobs.cancel({ job_id: id });
  assert.equal(cancelled.job.status, 'cancelled', JSON.stringify(cancelled));
  assert.equal(await exited, 0, 'the runner ended cleanly');
  assert.equal((await s.raw(id)).status, 'cancelled');
  assert.deepEqual(s.calls(), ['npm ci --ignore-scripts']);
  assert.ok(!(await s.kinds(id)).includes('started'), 'the recipe never started');
});

test('refusal: an install argv outside the pinned list fails the job before anything runs', async t => {
  const s = await setup(t, NPM_REPO);
  const id = await s.submit();
  const planInstall = (wt, argv) => planLocalInstall(wt, argv, { detect: () => ({ manager: 'npm', argv: ['npm', 'install'] }) });
  assert.deepEqual(await runJob(s.stateDir, id, { env: s.env, planInstall }), { ok: false, error: 'install_not_allowed' });
  const job = await s.raw(id);
  assert.equal(job.status, 'failed');
  assert.equal(job.summary, 'install_not_allowed');
  assert.deepEqual(await s.kinds(id), ['submitted', 'rejected']);
  assert.deepEqual((await s.jobs.events({ job_id: id })).events[1].detail, { reason: 'install_not_allowed', phase: 'install' });
  assert.deepEqual(s.calls(), [], 'nothing ran');
});

test('Go: go mod download into the job folder, then go test offline with the same module cache', async t => {
  const s = await setup(t, { 'go.mod': 'module example.com/x\n\ngo 1.22\n' });
  const id = await s.submit();
  assert.deepEqual(await runJob(s.stateDir, id, { env: s.env }), { ok: true, status: 'succeeded' }, s.log(id));
  assert.deepEqual(s.calls(), ['go mod download', 'go test ./...']);
  const text = s.log(id);
  assert.match(text, /install env: proxy=https:\/\/proxy\.golang\.org flags=-modcacherw toolchain=local/);
  assert.match(text, /recipe-sees-modules/);
  assert.match(text, /recipe env: proxy=off/);
  assert.ok(jobRootIn(text), text);
  assert.equal(existsSync(jobRootIn(text)), false, 'a read-only module folder does not keep the job folder alive');
});

test('deadline safety net: a job that ran an install gets the install bound on top of its timeout', () => {
  const at = 10_000_000;
  const job = { id: 'job_x', status: 'running', started_at: at - (60_000 + DEADLINE_GRACE_MS + 1000), timeout_ms: 60_000, pid: 4242 };
  const repoWith = kinds => {
    const events = kinds.map((kind, i) => ({ seq: i + 1, kind, detail: JSON.stringify({ runner_pid: 4243, pid_start: 'x' }) }));
    const updates = [];
    return { updates, listJobEvents: () => events, appendJobEvent: e => events.push(e), getJob: () => job,
      updateJob: (id, patch, from) => { updates.push({ patch, from }); return 1; } };
  };
  const options = { alive: () => true, aliveGroup: () => true, signal: () => true };
  const plain = repoWith(['submitted', 'started']);
  assert.equal(reconcileLocalJob(plain, job, at, options).status, 'timed_out', 'no install: the deadline is unchanged');
  const installed = repoWith(['submitted', 'install_started', 'started']);
  assert.equal(reconcileLocalJob(installed, job, at, options).status, 'running', 'an install ran: 600 s more');
  assert.deepEqual(installed.updates, []);
  const late = { ...job, started_at: at - (INSTALL_TIMEOUT_MS + 60_000 + DEADLINE_GRACE_MS + 1000) };
  assert.equal(reconcileLocalJob(repoWith(['submitted', 'install_started', 'started']), late, at, options).status, 'timed_out');
});

// ---------------------------------------------------------------------------------------
// Live (opt-in): real package managers, real network, real sandbox.

const LIVE = DARWIN && process.env.MEMO_BRIDGE_LIVE_INSTALL === '1';
const have = cmd => spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;

test('live: npm ci, pnpm through corepack and go mod download in the sandbox, then the recipe offline', { skip: !LIVE && 'set MEMO_BRIDGE_LIVE_INSTALL=1 on macOS (network)' }, async t => {
  const cases = [];
  // Lockfiles are produced outside the sandbox, with the owner's tools and network, as a
  // repository would carry them.
  const npmRepo = {
    'package.json': JSON.stringify({ name: 'live-npm', private: true, dependencies: { 'is-number': '7.0.0' }, scripts: { test: 'node t.js' } }),
    't.js': "if (require('is-number')(5) !== true) process.exit(1); console.log('live-npm-ok');\n"
  };
  cases.push(['npm', npmRepo, dir => execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir }), /live-npm-ok/]);
  if (have('pnpm')) {
    const pnpmRepo = { ...npmRepo, 'package.json': JSON.stringify({ ...JSON.parse(npmRepo['package.json']), name: 'live-pnpm',
      packageManager: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).packageManager }) };
    cases.push(['pnpm', pnpmRepo, dir => execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], { cwd: dir }), /live-npm-ok/]);
  }
  if (have('go')) {
    const goRepo = {
      'go.mod': 'module example.com/live\n\ngo 1.22\n\nrequire github.com/google/uuid v1.6.0\n',
      'live_test.go': 'package live\n\nimport (\n\t"testing"\n\n\t"github.com/google/uuid"\n)\n\nfunc TestUUID(t *testing.T) {\n\tif uuid.New().String() == "" {\n\t\tt.Fatal("empty")\n\t}\n\tt.Log("live-go-ok")\n}\n'
    };
    cases.push(['go', goRepo, dir => execFileSync('go', ['mod', 'tidy'], { cwd: dir }), /ok\s+example\.com\/live/]);
  }
  for (const [name, entries, lock, expected] of cases) {
    const s = await setup(t, entries);
    lock(s.repoDir);
    const id = await s.submit();
    const result = await runJob(s.stateDir, id, { env: { ...process.env, MEMO_BRIDGE_JOB_SANDBOX: 'on' } });
    const text = s.log(id);
    assert.deepEqual(result, { ok: true, status: 'succeeded' }, `${name}:\n${text}`);
    assert.match(text, /phase install \(network on, scripts off\).*\(sandboxed\)/, name);
    assert.match(text, expected, name);
  }
});
