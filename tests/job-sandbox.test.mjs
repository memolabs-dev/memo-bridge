// The job sandbox (server/runners/sandbox.mjs) and the honesty of the security contract.
// Regression tests for findings 3 and 4 of the adversarial review of 933e759: a job used to run
// as the owner with full file, network and credential access, and the docs said otherwise.
//
// The Seatbelt tests run on macOS only (there is no sandbox elsewhere yet, and jobs are refused
// there unless MEMO_BRIDGE_JOB_SANDBOX=off). Everything uses temporary directories: the "home"
// with private notes is a fake one passed to sandboxPaths, never the user's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../server/runtime.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { createJobService } from '../server/runners/jobs.mjs';
import { safeToSignalGroup } from '../server/runners/processes.mjs';
import { HOME_DENY_READ, sandboxCommand, sandboxMode, sandboxPaths, sandboxProfile, worktreeCommonDir } from '../server/runners/sandbox.mjs';

const DARWIN = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const OWNER = makePrincipal('local:owner', Object.values(CAPABILITIES));
const ISSUE = 'memolabs-dev/drop#7';
const root = new URL('..', import.meta.url).pathname;

// Git must not read the user's configuration here either.
const GIT_HOME = await mkdtemp(join(tmpdir(), 'memo-sbx-gitconfig-'));
await writeFile(join(GIT_HOME, 'gitconfig'), '[user]\n\tname = Test Owner\n\temail = owner@example.test\n[init]\n\tdefaultBranch = main\n');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(GIT_HOME, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
test.after(() => rm(GIT_HOME, { recursive: true, force: true }));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A projects root with the repository (and a sibling repository holding a secret), a bare
// origin, a linked worktree, a private state directory and a fake home with private notes.
async function world(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'memo-sbx-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const projects = join(base, 'projects');
  const repo = join(projects, 'drop');
  const sibling = join(projects, 'other');
  await mkdir(repo, { recursive: true });
  await mkdir(sibling);
  await writeFile(join(sibling, '.env'), 'DATABASE_URL=postgres://u:hunter2@db/x\n');
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# drop\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'initial');
  const origin = join(base, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: gitEnv });
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  const worktrees = join(base, 'worktrees');
  const worktree = join(worktrees, 'drop', 'agent-7');
  await mkdir(join(worktrees, 'drop'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/7', worktree, 'main');
  await mkdir(join(worktrees, 'drop', 'agent-8'));
  await writeFile(join(worktrees, 'drop', 'agent-8', 'notes.txt'), 'another agent\n');
  const stateDir = join(base, 'state');
  await mkdir(stateDir, { mode: 0o700 });
  await writeFile(join(stateDir, 'store.sqlite'), 'private');
  const home = join(base, 'home');
  await mkdir(join(home, '.agent'), { recursive: true });
  await writeFile(join(home, '.agent', 'LIVE-STATE.md'), 'job-search: secret line\n');
  const icloud = join(base, 'icloud', 'Vault');
  await mkdir(icloud, { recursive: true });
  await writeFile(join(icloud, 'note.md'), 'private note\n');
  await symlink(icloud, join(home, 'Vault'));
  await mkdir(join(home, '.ssh'));
  await writeFile(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY\n');
  const jobTmp = join(base, 'jobtmp');
  await mkdir(jobTmp, { mode: 0o700 });
  return { base, projects, repo, sibling, origin, worktrees, worktree, stateDir, home, icloud, jobTmp };
}

test('sandboxMode: on by default, macOS only, explicit off switch, anything else refused', () => {
  assert.deepEqual(sandboxMode({}, { os: 'darwin', exists: () => true }), { ok: true, mode: 'seatbelt' });
  assert.deepEqual(sandboxMode({ MEMO_BRIDGE_JOB_SANDBOX: 'on' }, { os: 'darwin', exists: () => true }), { ok: true, mode: 'seatbelt' });
  assert.equal(sandboxMode({}, { os: 'linux', exists: () => true }).error, 'sandbox_unavailable');
  assert.equal(sandboxMode({}, { os: 'darwin', exists: () => false }).error, 'sandbox_unavailable');
  assert.deepEqual(sandboxMode({ MEMO_BRIDGE_JOB_SANDBOX: 'off' }, { os: 'linux' }), { ok: true, mode: 'off' });
  assert.equal(sandboxMode({ MEMO_BRIDGE_JOB_SANDBOX: '0' }, { os: 'darwin', exists: () => true }).error, 'invalid_configuration');
});

test('the profile never contains a path, and the plan denies private data around the worktree', async t => {
  const w = await world(t);
  const profile = sandboxProfile({ denyReadCount: 3, gitCommon: true });
  assert.doesNotMatch(profile.replace(/"\/dev\/[a-z]+"|#"\^\/dev\/[a-z]+\/?"/g, ''), /"\//, 'paths only come in through -D parameters');
  const paths = sandboxPaths({ worktree: w.worktree, stateDir: w.stateDir, jobTmp: w.jobTmp, worktreesRoot: w.worktrees, home: w.home });
  assert.equal(worktreeCommonDir(w.worktree), join(w.repo, '.git'));
  assert.equal(paths.gitCommon, join(w.repo, '.git'));
  for (const denied of [join(w.home, '.agent'), join(w.home, 'Vault'), w.icloud, join(w.home, '.ssh'), w.projects, w.worktrees]) {
    assert.ok(paths.denyRead.includes(denied), denied);
  }
  assert.ok(HOME_DENY_READ.includes('.agent') && HOME_DENY_READ.includes('Library/Keychains'));
  const [command, args] = sandboxCommand(['nice', '-n', '10', 'npm', 'test'], paths);
  assert.equal(command, '/usr/bin/sandbox-exec');
  assert.deepEqual(args.slice(-5), ['nice', '-n', '10', 'npm', 'test']);
  assert.ok(args.includes(`STATE_DIR=${w.stateDir}`));
});

test('safeToSignalGroup never signals a reused process group id', () => {
  const at = start => ({ startOf: () => start, exists: () => true });
  assert.equal(safeToSignalGroup(4242, 'Mon Oct 13 10:00:00 2026', at('Mon Oct 13 10:00:00 2026')), true);
  assert.equal(safeToSignalGroup(4242, 'Mon Oct 13 10:00:00 2026', at('Mon Oct 13 11:00:00 2026')), false, 'pid reused');
  assert.equal(safeToSignalGroup(4242, null, at('Mon Oct 13 10:00:00 2026')), false, 'nothing to compare with');
  assert.equal(safeToSignalGroup(4242, 'x', { startOf: () => null, exists: () => true }), true, 'leader gone, group still reserved');
  assert.equal(safeToSignalGroup(4242, 'x', { startOf: () => null, exists: () => false }), false, 'nothing left');
  assert.equal(safeToSignalGroup(1, 'x', at('x')), false);
});

test('finding 3: inside the sandbox a job reads and writes only its worktree, has no network and no credentials', { skip: !DARWIN && 'Seatbelt is macOS only' }, async t => {
  const w = await world(t);
  const paths = sandboxPaths({ worktree: w.worktree, stateDir: w.stateDir, jobTmp: w.jobTmp, worktreesRoot: w.worktrees, home: w.home });
  const run = (...argv) => {
    const [command, args] = sandboxCommand(argv, paths);
    return spawnSync(command, args, { cwd: w.worktree, encoding: 'utf8', timeout: 20000,
      env: { PATH: process.env.PATH, HOME: join(w.jobTmp), GIT_CONFIG_GLOBAL: join(GIT_HOME, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } });
  };
  // Reads.
  assert.equal(run('/bin/cat', 'README.md').stdout, '# drop\n', 'the worktree is readable');
  for (const secret of [join(w.home, '.agent', 'LIVE-STATE.md'), join(w.home, 'Vault', 'note.md'), join(w.icloud, 'note.md'),
    join(w.home, '.ssh', 'id_ed25519'), join(w.stateDir, 'store.sqlite'), join(w.sibling, '.env'),
    join(w.worktrees, 'drop', 'agent-8', 'notes.txt')]) {
    const r = run('/bin/cat', secret);
    assert.notEqual(r.status, 0, `read ${secret}`);
    assert.match(r.stderr, /Operation not permitted/, secret);
  }
  assert.equal(run('git', 'log', '-1', '--format=%s').stdout.trim(), 'initial', 'git can read the repository data');
  // Writes.
  assert.equal(run('/usr/bin/touch', join(w.worktree, 'built.txt')).status, 0);
  assert.equal(run('/usr/bin/touch', join(w.jobTmp, 'scratch')).status, 0);
  for (const target of [join(w.worktree, '.git'), join(w.projects, 'planted'), join(w.repo, '.git', 'config'), join(w.stateDir, 'store.sqlite'),
    join(w.origin, 'refs', 'heads', 'main')]) {
    assert.notEqual(run('/usr/bin/touch', target).status, 0, `write ${target}`);
  }
  // The pD repro: a forced push to main from inside the job. The bare origin is a local
  // folder outside the worktree, so it cannot be written (and a remote one is unreachable).
  const mainBefore = git(w.origin, 'rev-parse', 'refs/heads/main');
  git(w.worktree, 'commit', '-q', '--allow-empty', '-m', 'agent commit');
  const pushed = run('git', 'push', '--force', 'origin', 'HEAD:refs/heads/main');
  assert.notEqual(pushed.status, 0, pushed.stderr);
  assert.equal(git(w.origin, 'rev-parse', 'refs/heads/main'), mainBefore, 'origin main never moved');
  assert.equal(git(w.repo, 'rev-parse', 'refs/heads/main'), mainBefore, 'local main never moved');
  // Network: loopback works, a remote address does not (TEST-NET-1 never routes anyway).
  const remote = run(process.execPath, '-e',
    "require('net').connect(80,'192.0.2.1').on('connect',()=>{console.log('connected');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(1)})");
  assert.match(remote.stdout, /EPERM/, remote.stdout + remote.stderr);
  const local = run(process.execPath, '-e',
    "const n=require('net');const s=n.createServer(c=>c.end('ok')).listen(0,'127.0.0.1',()=>n.connect(s.address().port,'127.0.0.1').on('data',d=>{console.log('local '+d);process.exit(0)}))");
  assert.equal(local.stdout.trim(), 'local ok', local.stderr);
  const dns = run(process.execPath, '-e', "require('dns').lookup('example.com',(e)=>{console.log(e?e.code:'resolved');process.exit(0)})");
  assert.doesNotMatch(dns.stdout, /resolved/, 'no DNS either');
  // Nothing started outside the sandbox.
  assert.notEqual(run('/bin/launchctl', 'submit', '-l', `memo.sbx.${randomBytes(4).toString('hex')}`, '--', '/usr/bin/true').status, 0);
  assert.notEqual(run('/usr/bin/pbpaste').status, 0);
});

test('finding 3: end to end, a job a model wrote cannot reach main, the store, secrets or the network', { skip: !DARWIN && 'Seatbelt is macOS only' }, async t => {
  const w = await world(t);
  // The model's "test" script: every attack of the review's pD and pF probes, reported on stdout.
  await writeFile(join(w.worktree, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { test: 'node t.js' } }));
  await writeFile(join(w.worktree, 't.js'), `
const { execFileSync } = require('child_process'); const fs = require('fs'); const os = require('os');
const tryIt = (name, fn) => { try { fn(); console.log(name + ': DONE'); } catch (e) { console.log(name + ': blocked'); } };
tryIt('push-main', () => execFileSync('git', ['push', '--force', 'origin', 'HEAD:refs/heads/main'], { stdio: 'ignore' }));
tryIt('read-store', () => fs.readdirSync(${JSON.stringify(join(w.base, 'mbstate'))}));
tryIt('read-job-log', () => fs.readdirSync(${JSON.stringify(join(w.base, 'mbstate', 'jobs'))}));
tryIt('write-store', () => fs.writeFileSync(${JSON.stringify(join(w.base, 'mbstate', 'evil'))}, 'x'));
tryIt('read-sibling-env', () => fs.readFileSync(${JSON.stringify(join(w.sibling, '.env'))}));
tryIt('rewrite-git-link', () => fs.writeFileSync('.git', 'gitdir: /tmp/evil\\n'));
console.log('env-database-url: ' + (process.env.DATABASE_URL ? 'LEAKED' : 'absent'));
console.log('home-is-job-folder: ' + (os.homedir() !== ${JSON.stringify(process.env.HOME ?? '')}));
`);
  const prior = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://u:hunter2@db/x';
  t.after(() => { if (prior === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prior; });
  const ledger = { status: async () => ({ ok: true, receipt: {} }), claim: async () => ({ ok: true, receipt: {} }),
    verify: async () => ({ ok: true, receipt: {} }), heartbeat: async () => ({ ok: true, receipt: {} }), release: async () => ({ ok: true, receipt: {} }) };
  const rt = createRuntime({ stateDir: join(w.base, 'mbstate'), principal: OWNER, ledger, host: 'mac' });
  const workspaceId = `ws_${randomBytes(12).toString('base64url')}`;
  const worktreeId = `wt_${randomBytes(12).toString('base64url')}`;
  const now = Date.now();
  await rt.store().transaction(repo => {
    repo.insertWorkspace({ id: workspaceId, principal: OWNER.id, client_type: 'claude-code', project_id: 'drop', host: 'mac',
      status: 'active', created_at: now, updated_at: now });
    repo.insertClaim({ claim_id: randomBytes(16).toString('hex'), workspace_id: workspaceId, issue_ref: ISSUE,
      fence_sha: 'f'.repeat(40), epoch: 1, expires_at: new Date(now + 600_000).toISOString(), updated_at: now });
    repo.insertWorktree({ id: worktreeId, workspace_id: workspaceId, project_id: 'drop', host: 'mac', path: w.worktree,
      branch: 'agent/7', base_ref: 'main', base_commit: 'a'.repeat(40), issue_ref: ISSUE, created_at: now, updated_at: now });
  });
  // The runner inherits this environment: sandbox on (the default), worktrees root known.
  const env = { ...process.env, MEMO_BRIDGE_WORKTREES_ROOT: w.worktrees };
  delete env.MEMO_BRIDGE_JOB_SANDBOX;
  const jobs = createJobService(rt, { env });
  t.after(() => rt.close());
  git(w.worktree, 'commit', '-q', '--allow-empty', '-m', 'agent commit');
  const mainBefore = git(w.origin, 'rev-parse', 'refs/heads/main');
  const submitted = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test', timeout_seconds: 120 });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  let job;
  for (let i = 0; i < 300; i++) {
    job = (await jobs.status({ job_id: submitted.job.job_id })).job;
    if (!['queued', 'running'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(job.status, 'succeeded', JSON.stringify(job));
  const text = (await jobs.results({ job_id: job.job_id })).log.lines.join('\n');
  for (const line of ['push-main: blocked', 'read-store: blocked', 'read-job-log: blocked', 'write-store: blocked', 'read-sibling-env: blocked',
    'rewrite-git-link: blocked', 'env-database-url: absent', 'home-is-job-folder: true']) {
    assert.ok(text.includes(line), `${line}\n${text}`);
  }
  assert.match(text, /\(sandboxed\)/);
  assert.equal(git(w.origin, 'rev-parse', 'refs/heads/main'), mainBefore, 'origin main never moved');
  assert.equal(existsSync(join(w.base, 'mbstate', 'evil')), false);
  assert.match(readFileSync(join(w.worktree, '.git'), 'utf8'), /^gitdir: /);
  const started = (await jobs.events({ job_id: job.job_id })).events.find(e => e.kind === 'started');
  assert.equal(started.detail.sandbox, 'seatbelt');
});

test('finding 4: the security contract no longer claims what jobs could break', async () => {
  const read = file => readFile(join(root, file), 'utf8');
  const security = await read('SECURITY.md');
  const readme = await read('README.md');
  const runner = await read('docs/RUNNER.md');
  const index = await read('server/index.mjs');
  const plugin = JSON.parse(await read('plugin/plugin.json'));
  const longDescription = plugin.interface?.longDescription ?? plugin.longDescription ?? JSON.stringify(plugin);
  for (const [name, text] of [['SECURITY.md', security], ['README.md', readme], ['docs/RUNNER.md', runner], ['server/index.mjs', index],
    ['plugin.json', longDescription]]) {
    assert.doesNotMatch(text, /No arbitrary command execution|never runs arbitrary commands|No arbitrary shell:|A job is not a sandbox/i, name);
    assert.match(text, /sandbox/i, `${name} explains the job sandbox`);
    assert.match(text, /owner-equivalent|MEMO_BRIDGE_JOB_SANDBOX=off/i, `${name} says what the opt-out means`);
  }
  assert.match(security, /residual/i, 'SECURITY.md lists the residual risks');
});
