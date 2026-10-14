// Job unit mode (Phase 4, VPS): what job-runner.mjs does inside memo-job@<id>.service.
// The checks run against temporary folders; the real runner is spawned as systemd would
// (cwd = worktree, environment from the dispatcher's drop-in). No systemd needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogSink } from '../server/runners/job-runner.mjs';
import { REFUSED_EXIT, parseAllowedArgv, planJobUnit, runJobUnit } from '../server/runners/job-unit.mjs';
import { INSTALL_ARGV, detectInstall } from '../server/runners/recipes.mjs';
import { dispatchIdFor } from '../server/runners/executor-systemd.mjs';

const RUNNER = new URL('../server/runners/job-runner.mjs', import.meta.url).pathname;

function fixture(t, script = "console.log('unit-ok', process.env.GH_TOKEN ?? 'no-token', process.env.MEMO_JOB_ALLOWED_ARGV ?? 'no-allow')") {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mb-unit-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const id = dispatchIdFor('job_unitfixture000001');
  const worktree = join(base, 'worktrees', 'demo', 'agent-1');
  const out = join(base, 'jobs', id, 'out');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(worktree, 'run.js'), script);
  writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'demo', private: true, scripts: { test: 'node run.js' } }));
  const env = {
    PATH: process.env.PATH, GH_TOKEN: 'test_token_should_never_reach_the_job',
    MEMO_JOB_ID: 'job_unitfixture000001', MEMO_JOB_DISPATCH_ID: id, MEMO_BRIDGE_JOB_ID: id, MEMO_JOB_RECIPE: 'test',
    MEMO_JOB_ALLOWED_ARGV: 'npm:test,python3:-m:pytest:-q', MEMO_JOB_WORKTREE: worktree, MEMO_JOB_OUT: out,
    MEMO_JOB_TIMEOUT_SECONDS: '60'
  };
  return { base, id, worktree, out, env, args: ['--executor=systemd', id], log: () => readFileSync(join(out, 'job.log'), 'utf8') };
}

test('allowed argv parsing is strict', () => {
  assert.deepEqual(parseAllowedArgv('npm:test,python3:-m:pytest:-q'), [['npm', 'test'], ['python3', '-m', 'pytest', '-q']]);
  for (const bad of ['', 'npm test', 'npm:te st', 'npm:$(id)', 'a::b', ',', undefined, 'x'.repeat(5000)]) {
    assert.equal(parseAllowedArgv(bad), null, String(bad).slice(0, 20));
  }
});

test('planJobUnit refuses every disagreement before anything runs', t => {
  const f = fixture(t);
  assert.equal(planJobUnit(f.args, f.env, { cwd: f.worktree }).ok, true);
  const cases = [
    [['--executor=local', f.id], {}, 'invalid_arguments'],
    [['--executor=systemd', 'BAD_ID'], {}, 'invalid_dispatch_id'],
    [f.args, { MEMO_JOB_DISPATCH_ID: 'jffffffffffffffffffffffffffffff' }, 'dispatch_id_mismatch'],
    [f.args, { MEMO_BRIDGE_JOB_ID: 'jffffffffffffffffffffffffffffff' }, 'dispatch_id_mismatch'],
    [f.args, { MEMO_JOB_RECIPE: 'deploy' }, 'unknown_recipe'],
    [f.args, { MEMO_JOB_TIMEOUT_SECONDS: '99999' }, 'invalid_timeout'],
    [f.args, { MEMO_JOB_WORKTREE: `${f.worktree}/../agent-1` }, 'worktree_invalid'],
    [f.args, { MEMO_JOB_OUT: join(f.base, 'jobs', 'jother000000000000000000000000000', 'out') }, 'out_invalid'],
    [f.args, { MEMO_JOB_ALLOWED_ARGV: 'make:test' }, 'recipe_not_allowed'],
    [f.args, { MEMO_JOB_ALLOWED_ARGV: 'npm test' }, 'allowed_argv_invalid'],
    [f.args, { MEMO_JOB_RECIPE: 'lint' }, 'recipe_not_detected']
  ];
  for (const [args, patch, error] of cases) {
    assert.deepEqual(planJobUnit(args, { ...f.env, ...patch }, { cwd: f.worktree }), { ok: false, error }, error);
  }
  // Working directory elsewhere than the worktree the dispatcher pinned.
  assert.deepEqual(planJobUnit(f.args, f.env, { cwd: f.base }), { ok: false, error: 'cwd_mismatch' });
  // A worktree reached through a symlink is refused (the dispatcher refuses it too).
  const link = join(f.base, 'link');
  symlinkSync(f.worktree, link);
  assert.deepEqual(planJobUnit(f.args, { ...f.env, MEMO_JOB_WORKTREE: link }, { cwd: link }), { ok: false, error: 'worktree_invalid' });
});

test('a job runs the allowed recipe with a clean environment and logs to out/job.log', async t => {
  const f = fixture(t);
  const journal = [];
  const r = await runJobUnit(f.args, { env: f.env, cwd: f.worktree, createLogSink, journal: e => journal.push(e) });
  assert.equal(r.code, 0);
  const log = f.log();
  assert.match(log, /unit-ok no-token no-allow/);
  assert.doesNotMatch(log, /test_token_should_never_reach_the_job/);
  assert.match(log, /\[memo-bridge\] exit 0/);
  assert.deepEqual(journal.map(e => e.event), ['job_unit_start', 'job_unit_end']);
  assert.ok(!JSON.stringify(journal).includes('test_token'));
});

test('the recipe exit code is the unit exit code; a refusal runs nothing and exits 2', async t => {
  const f = fixture(t, "require('fs').writeFileSync('ran', 'x'); process.exit(3)");
  assert.equal((await runJobUnit(f.args, { env: f.env, cwd: f.worktree, createLogSink })).code, 3);
  rmSync(join(f.worktree, 'ran'));
  const refused = await runJobUnit(f.args, { env: { ...f.env, MEMO_JOB_ALLOWED_ARGV: 'make:test' }, cwd: f.worktree, createLogSink });
  assert.deepEqual(refused, { code: REFUSED_EXIT, error: 'recipe_not_allowed' });
  assert.equal(existsSync(join(f.worktree, 'ran')), false, 'nothing ran');
  assert.match(f.log(), /job refused: recipe_not_allowed/);
});

test('a symlinked job.log is never followed', async t => {
  const f = fixture(t);
  const target = join(f.base, 'elsewhere.txt');
  writeFileSync(target, '');
  symlinkSync(target, join(f.out, 'job.log'));
  const r = await runJobUnit(f.args, { env: f.env, cwd: f.worktree, createLogSink });
  assert.deepEqual(r, { code: REFUSED_EXIT, error: 'log_unavailable' });
  assert.equal(readFileSync(target, 'utf8'), '');
});

test('the real runner in unit mode: exit status, and SIGTERM ends it by the same signal', async t => {
  const f = fixture(t);
  const run = (env, onSpawn) => new Promise(resolve => {
    const child = spawn(process.execPath, [RUNNER, ...f.args], { cwd: f.worktree, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    onSpawn?.(child);
    child.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
  const ok = await run(f.env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stderr, /"event":"job_unit_end"/);
  const refused = await run({ ...f.env, MEMO_JOB_DISPATCH_ID: 'jffffffffffffffffffffffffffffff' });
  assert.equal(refused.code, REFUSED_EXIT);
  assert.match(refused.stderr, /dispatch_id_mismatch/);

  writeFileSync(join(f.worktree, 'run.js'), "console.log('started'); setInterval(() => {}, 1000)");
  const stopped = await run(f.env, child => {
    const poll = setInterval(() => { if (/started/.test(f.log())) { clearInterval(poll); child.kill('SIGTERM'); } }, 50);
  });
  assert.equal(stopped.signal, 'SIGTERM', JSON.stringify(stopped));
  assert.match(f.log(), /exit (SIGTERM|143)/);
});

// Debian's dash does not pass SIGTERM on, and a recipe may leave a background process: a
// grandchild holding the output pipes must not keep the unit alive (CI hang on Linux).
const GRANDCHILD = `const { spawn } = require('child_process');
spawn(process.execPath, ['-e', "console.log('grandchild'); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
process.on('SIGTERM', () => process.exit(0));
console.log('started'); setInterval(() => {}, 1000);`;

test('SIGTERM reaches the whole recipe group, so a grandchild cannot hold the unit open', { timeout: 20000 }, async t => {
  const f = fixture(t, GRANDCHILD);
  let term;
  const running = runJobUnit(f.args, { env: f.env, cwd: f.worktree, createLogSink,
    onSignal: (sig, fn) => { term = fn; }, offSignal: () => {} });
  await new Promise(resolve => { const poll = setInterval(() => { try { if (/grandchild/.test(f.log())) { clearInterval(poll); resolve(); } } catch { /* not yet */ } }, 50); });
  term();
  const r = await running;
  assert.equal(r.signal, 'SIGTERM', JSON.stringify(r));
});

test('a background process left by a finished recipe does not keep the unit open', { timeout: 20000 }, async t => {
  const f = fixture(t, `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }).unref(); console.log('done');`);
  const r = await runJobUnit(f.args, { env: f.env, cwd: f.worktree, createLogSink });
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.match(f.log(), /done/);
});

// ---- Install phase (memo-job-install@<id>.service) and the recipe's private network ----------

const INSTALL_SHAPES = 'npm:ci:--ignore-scripts,pnpm:install:--frozen-lockfile:--ignore-scripts';

// A worktree with package.json and the given files, a cache folder next to out/, and fake npm
// and pnpm first on PATH that record their argv and the variables the install relies on.
function installFixture(t, files = { 'package-lock.json': '{}' }, { manifest = { name: 'demo', private: true }, exitCode = 0 } = {}) {
  const f = fixture(t);
  writeFileSync(join(f.worktree, 'package.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(f.worktree, name), content);
  const cache = join(f.base, 'jobs', f.id, 'cache');
  mkdirSync(cache);
  const bin = join(f.base, 'bin');
  mkdirSync(bin);
  const record = join(f.base, 'calls.jsonl');
  for (const tool of ['npm', 'pnpm']) {
    writeFileSync(join(bin, tool), `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: [${JSON.stringify(tool)}, ...process.argv.slice(2)],
  cwd: process.cwd(), COREPACK_HOME: process.env.COREPACK_HOME, store: process.env.pnpm_config_store_dir,
  npm_cache: process.env.npm_config_cache, xdg_cache: process.env.XDG_CACHE_HOME, GH_TOKEN: process.env.GH_TOKEN ?? null }) + '\\n');
console.log('fake ${tool} ran');
process.exit(${exitCode});
`);
    chmodSync(join(bin, tool), 0o755);
  }
  const env = { ...f.env, PATH: `${bin}:${process.env.PATH}`, MEMO_JOB_ALLOWED_ARGV: INSTALL_SHAPES };
  const calls = () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
  return { ...f, cache, env, args: ['--executor=systemd', '--phase=install', f.id], calls };
}

test('install argv: pnpm when packageManager or pnpm-lock.yaml says so, npm ci otherwise, nothing without a lockfile', t => {
  const f = fixture(t);
  const at = (files, manifest = { name: 'demo' }) => {
    rmSync(f.worktree, { recursive: true, force: true });
    mkdirSync(f.worktree, { recursive: true });
    if (manifest) writeFileSync(join(f.worktree, 'package.json'), JSON.stringify(manifest));
    for (const [name, content] of Object.entries(files)) {
      if (content === '->') symlinkSync(join(f.base, 'elsewhere'), join(f.worktree, name));
      else if (content === '/') mkdirSync(join(f.worktree, name));
      else writeFileSync(join(f.worktree, name), content);
    }
    return detectInstall(f.worktree);
  };
  const pnpm = { manager: 'pnpm', argv: INSTALL_ARGV.pnpm };
  const npm = { manager: 'npm', argv: INSTALL_ARGV.npm };
  assert.deepEqual([...INSTALL_ARGV.pnpm], ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']);
  assert.deepEqual([...INSTALL_ARGV.npm], ['npm', 'ci', '--ignore-scripts']);
  assert.deepEqual(at({ 'pnpm-lock.yaml': 'lockfileVersion: 9' }), pnpm);
  assert.deepEqual(at({ 'package-lock.json': '{}' }, { name: 'demo', packageManager: 'pnpm@12.10.1' }), pnpm);
  assert.deepEqual(at({ 'package-lock.json': '{}' }), npm);
  assert.deepEqual(at({ 'npm-shrinkwrap.json': '{}' }), npm);
  assert.deepEqual(at({ 'package-lock.json': '{}' }, { name: 'demo', packageManager: 'yarn@4.0.0' }), npm);
  // Nothing to install.
  assert.deepEqual(at({}), { skip: 'no_lockfile' });
  assert.deepEqual(at({ 'yarn.lock': '' }), { skip: 'no_lockfile' });
  assert.deepEqual(at({ 'pnpm-lock.yaml': '->' }), { skip: 'no_lockfile' }, 'a symlinked lockfile is not a lockfile');
  assert.deepEqual(at({ 'pnpm-lock.yaml': 'x' }, null), { skip: 'no_package_json' });
  // Rule: dependencies already installed (a folder, or a link) are never reinstalled.
  assert.deepEqual(at({ 'pnpm-lock.yaml': 'x', node_modules: '/' }), { skip: 'node_modules_present' });
  assert.deepEqual(at({ 'package-lock.json': '{}', node_modules: '->' }), { skip: 'node_modules_present' });
  // A large lockfile still counts (it is never read).
  assert.deepEqual(at({ 'package-lock.json': 'x'.repeat(2 * 1024 * 1024) }), npm);
});

test('install phase runs the fixed argv without a shell, with per-job caches, and its exit code is the unit exit code', async t => {
  const f = installFixture(t, { 'pnpm-lock.yaml': 'lockfileVersion: 9' });
  const journal = [];
  const r = await runJobUnit(f.args, { env: f.env, cwd: f.worktree, createLogSink, journal: e => journal.push(e) });
  assert.equal(r.code, 0);
  const [call] = f.calls();
  assert.deepEqual(call.argv, ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']);
  assert.equal(call.cwd, f.worktree);
  assert.equal(call.COREPACK_HOME, join(f.cache, 'corepack'));
  assert.equal(call.store, join(f.cache, 'pnpm-store'));
  assert.equal(call.npm_cache, join(f.cache, 'npm'));
  assert.equal(call.xdg_cache, join(f.cache, 'xdg-cache'));
  assert.equal(call.GH_TOKEN, null);
  const log = f.log();
  assert.match(log, /\[memo-bridge\] phase install \(network on, scripts off\): pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(log, /fake pnpm ran/);
  assert.match(log, /\[memo-bridge\] phase install: exit 0/);
  assert.equal(journal[0].phase, 'install');

  const failing = installFixture(t, { 'package-lock.json': '{}' }, { exitCode: 7 });
  assert.equal((await runJobUnit(failing.args, { env: failing.env, cwd: failing.worktree, createLogSink })).code, 7);
  assert.deepEqual(failing.calls()[0].argv, ['npm', 'ci', '--ignore-scripts']);
  assert.match(failing.log(), /phase install: exit 7/);
});

test('install phase skips when node_modules exists, and refuses without its cache or outside the pinned argv', async t => {
  const f = installFixture(t, { 'pnpm-lock.yaml': 'x' });
  mkdirSync(join(f.worktree, 'node_modules'));
  const journal = [];
  const r = await runJobUnit(f.args, { env: f.env, cwd: f.worktree, createLogSink, journal: e => journal.push(e) });
  assert.deepEqual(r, { code: 0 });
  assert.deepEqual(f.calls(), [], 'nothing ran');
  assert.match(f.log(), /\[memo-bridge\] phase install: skipped \(node_modules_present\)/);
  assert.deepEqual(journal.map(e => e.event), ['job_install_skipped']);

  const g = installFixture(t, { 'pnpm-lock.yaml': 'x' });
  assert.deepEqual(planJobUnit(g.args, { ...g.env, MEMO_JOB_ALLOWED_ARGV: 'npm:ci:--ignore-scripts' }, { cwd: g.worktree }),
    { ok: false, error: 'install_not_allowed' });
  rmSync(g.cache, { recursive: true });
  symlinkSync(g.base, g.cache);
  assert.deepEqual(planJobUnit(g.args, g.env, { cwd: g.worktree }), { ok: false, error: 'cache_invalid' });
  rmSync(g.cache);
  const refused = await runJobUnit(g.args, { env: g.env, cwd: g.worktree, createLogSink });
  assert.deepEqual(refused, { code: REFUSED_EXIT, error: 'cache_invalid' });
  assert.deepEqual(g.calls(), []);
  assert.deepEqual(planJobUnit(['--executor=systemd', '--phase=build', g.id], g.env, { cwd: g.worktree }), { ok: false, error: 'invalid_arguments' });
});

test('recipe phase: with MEMO_JOB_NETWORK=private it runs only when loopback is the only device', async t => {
  const f = fixture(t);
  const env = { ...f.env, MEMO_JOB_NETWORK: 'private' };
  const plan = names => planJobUnit(f.args, env, { cwd: f.worktree, interfaces: () => names });
  assert.equal(plan(['lo']).ok, true);
  assert.deepEqual(plan(['lo', 'eth0']), { ok: false, error: 'network_not_private' });
  assert.deepEqual(plan(null), { ok: false, error: 'network_not_private' }, 'unreadable: fail closed');
  assert.deepEqual(planJobUnit(f.args, { ...env, MEMO_JOB_NETWORK: 'host' }, { cwd: f.worktree, interfaces: () => ['lo'] }),
    { ok: false, error: 'network_mode_invalid' });
  // Without the variable (an older dispatcher), nothing is checked.
  assert.equal(planJobUnit(f.args, f.env, { cwd: f.worktree, interfaces: () => ['eth0'] }).ok, true);
  const refused = await runJobUnit(f.args, { env, cwd: f.worktree, createLogSink, interfaces: () => ['lo', 'eth0'] });
  assert.deepEqual(refused, { code: REFUSED_EXIT, error: 'network_not_private' });
  assert.match(f.log(), /job refused: network_not_private/);
  const ran = await runJobUnit(f.args, { env, cwd: f.worktree, createLogSink, interfaces: () => ['lo'] });
  assert.equal(ran.code, 0);
  assert.match(f.log(), /phase recipe \(network off, loopback only\)/);
});
