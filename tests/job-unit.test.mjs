// Job unit mode (Phase 4, VPS): what job-runner.mjs does inside memo-job@<id>.service.
// The checks run against temporary folders; the real runner is spawned as systemd would
// (cwd = worktree, environment from the dispatcher's drop-in). No systemd needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogSink } from '../server/runners/job-runner.mjs';
import { REFUSED_EXIT, parseAllowedArgv, planJobUnit, runJobUnit } from '../server/runners/job-unit.mjs';
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
