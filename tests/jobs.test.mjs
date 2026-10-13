// Jobs: recipe detection, the detached runner, timeouts, cancellation, interruption, refusals.
// Every test uses its own temporary state directory and repository; nothing touches the
// user's state, real projects or GitHub. The ledger is a stub: jobs only check the mirror.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../server/runtime.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { detectRecipes } from '../server/runners/recipes.mjs';
import { RUNNER_PROTOCOL, createJobService, groupAlive, logPathFor, processAlive } from '../server/runners/jobs.mjs';
import { commandFor, createLogSink, jobEnv } from '../server/runners/job-runner.mjs';
import { JOB_TOOLS, registerJobTools } from '../server/tools/job-tools.mjs';

// Jobs run only inside the macOS job sandbox. Elsewhere (Linux CI) there is none yet, so these
// tests run the recipes unsandboxed, the owner's explicit opt-out; the sandbox itself is
// covered by tests/job-sandbox.test.mjs on macOS.
if (process.platform !== 'darwin') process.env.MEMO_BRIDGE_JOB_SANDBOX = 'off';
const RUNNER = new URL('../server/runners/job-runner.mjs', import.meta.url).pathname;

const OWNER = makePrincipal('local:owner', Object.values(CAPABILITIES));
const OTHER = makePrincipal('local:other', Object.values(CAPABILITIES));
const READER = makePrincipal('local:reader', [CAPABILITIES.READ]);
const ISSUE = 'memolabs-dev/drop#7';

const stubLedger = () => {
  const receipt = { state: 'claimed', fence_sha: 'f'.repeat(40) };
  const ok = async () => ({ ok: true, receipt });
  return { status: ok, claim: ok, verify: ok, heartbeat: ok, release: ok };
};
const wsId = () => `ws_${randomBytes(12).toString('base64url')}`;

// Scripts the temporary repository's package.json can point its test script at.
const SCRIPTS = {
  'pass.js': "console.log('hello-ok'); console.log('ci=' + process.env.CI + ' secret=' + (process.env.MEMO_TEST_API_TOKEN ?? 'none'));\n",
  'fail.js': "console.error('boom'); process.exit(3);\n",
  'sleep.js': "console.log('sleeping'); setTimeout(() => {}, 120000);\n",
  // Starts a grandchild in its own process group (it leaves the job's group), records its pid,
  // and keeps the job alive.
  'escape.js': "const { spawn } = require('child_process'); const fs = require('fs');\n" +
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });\n" +
    "g.unref(); fs.writeFileSync('grandchild.pid', String(g.pid)); console.log('escaped ' + g.pid); setTimeout(() => {}, 120000);\n",
  'noisy.js': "for (let i = 0; i < 600; i++) console.log('\\u001b[31mline ' + i + '\\u001b[0m \\u202eevil\\u0007 ' + 'x'.repeat(150));\n"
};

async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeRepo(dir, scripts = { test: 'node pass.js' }) {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'tmp', version: '1.0.0', private: true, scripts }));
  for (const [name, body] of Object.entries(SCRIPTS)) await writeFile(join(dir, name), body);
  return dir;
}

// A runtime on a private state dir, an active workspace with a live claim, and a worktree.
async function setup(t, { scripts, principal = OWNER, claimExpiresIn = 3600_000, service = {} } = {}) {
  // Directories are removed by the single cleanup hook below, after the jobs are stopped
  // (node:test runs after-hooks in registration order).
  const base = await mkdtemp(join(tmpdir(), 'memo-jobs-'));
  const stateDir = join(base, 'state');
  const repoDir = join(base, 'repo');
  await mkdir(repoDir);
  await makeRepo(repoDir, scripts);
  const rt = createRuntime({ stateDir, principal: OWNER, ledger: stubLedger(), host: 'mac' });
  const workspaceId = wsId();
  const worktreeId = `wt_${randomBytes(9).toString('base64url')}`;
  const claimId = randomBytes(16).toString('hex');
  const now = Date.now();
  await rt.store().transaction(repo => {
    repo.insertWorkspace({ id: workspaceId, principal: OWNER.id, client_type: 'claude-code', project_id: 'drop', host: 'mac',
      status: 'active', created_at: now, updated_at: now });
    repo.insertClaim({ claim_id: claimId, workspace_id: workspaceId, issue_ref: ISSUE,
      fence_sha: 'f'.repeat(40), epoch: 1, expires_at: new Date(now + claimExpiresIn).toISOString(), updated_at: now });
    repo.insertWorktree({ id: worktreeId, workspace_id: workspaceId, project_id: 'drop', host: 'mac', path: repoDir,
      branch: 'agent/drop-7', base_ref: 'main', base_commit: 'a'.repeat(40), issue_ref: ISSUE, created_at: now, updated_at: now });
  });
  // The service under test may run as another principal on the same store.
  const callerRt = principal === OWNER ? rt : createRuntime({ stateDir, principal, ledger: stubLedger(), host: 'mac' });
  const jobs = createJobService(callerRt, service);
  const ownerJobs = callerRt === rt ? jobs : createJobService(rt, service);
  t.after(async () => {
    try {
      // Never leave a job behind: cancel anything still active, then wait for its runner.
      const runners = await rt.store().transaction(repo => repo.listJobs({ limit: 1000 }).flatMap(job =>
        repo.listJobEvents(job.id, 0, 50).map(e => JSON.parse(e.detail ?? 'null')?.runner_pid)
          .filter(pid => Number.isInteger(pid) && pid !== process.pid)), { write: false });
      const listed = await ownerJobs.list({ limit: 200 });
      for (const job of listed.jobs ?? []) {
        if (job.status === 'running' || job.status === 'queued') await ownerJobs.cancel({ job_id: job.job_id });
      }
      await waitFor(() => runners.every(pid => !processAlive(pid)), { timeoutMs: 15000, what: 'runners to exit' });
    } finally {
      if (callerRt !== rt) await callerRt.close();
      await rt.close();
      await rm(base, { recursive: true, force: true });
    }
  });
  return { rt, base, stateDir, repoDir, workspaceId, worktreeId, claimId, jobs, ownerJobs };
}

async function waitFor(fn, { timeoutMs = 30000, intervalMs = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
const waitStatus = (jobs, jobId, statuses, opts) => waitFor(async () => {
  const r = await jobs.status({ job_id: jobId });
  return statuses.includes(r.job?.status) ? r.job : null;
}, { what: `job ${jobId} in ${statuses}`, ...opts });

const auditOf = rt => rt.store().transaction(repo => repo.listEvents({ limit: 200 }), { write: false });
const rawJob = (rt, id) => rt.store().transaction(repo => repo.getJob(id), { write: false });

// ---------------------------------------------------------------------------------------

test('detectRecipes: fixed argv per ecosystem, npm first, symlinks ignored', async t => {
  const dir = await tempDir(t, 'memo-recipes-');
  assert.deepEqual(detectRecipes(dir), {});

  await writeFile(join(dir, 'Makefile'), 'VAR := 1\ntest:\n\techo t\nbuild := nope\n');
  assert.deepEqual(detectRecipes(dir), { test: ['make', 'test'] }, '"build :=" is a variable, not a target');

  await writeFile(join(dir, 'go.mod'), 'module x\n');
  assert.deepEqual(detectRecipes(dir), { test: ['go', 'test', './...'], build: ['go', 'build', './...'] });

  await writeFile(join(dir, 'Cargo.toml'), '[package]\n');
  assert.deepEqual(detectRecipes(dir), { test: ['cargo', 'test'], build: ['cargo', 'build'] });

  await writeFile(join(dir, 'pytest.ini'), '[pytest]\n');
  assert.deepEqual(detectRecipes(dir).test, ['python3', '-m', 'pytest', '-q']);
  assert.deepEqual(detectRecipes(dir).build, ['cargo', 'build'], 'python has no build recipe');

  await writeFile(join(dir, 'Package.swift'), '// swift-tools-version:5.9\n');
  assert.deepEqual(detectRecipes(dir), { test: ['swift', 'test'], build: ['swift', 'build'] });

  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x', build: 'y', lint: 'z' } }));
  assert.deepEqual(detectRecipes(dir), { test: ['npm', 'test'], build: ['npm', 'run', 'build'], lint: ['npm', 'run', 'lint'] });

  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'z', test: '' } }));
  assert.deepEqual(detectRecipes(dir), { test: ['swift', 'test'], build: ['swift', 'build'], lint: ['npm', 'run', 'lint'] },
    'an empty npm test script falls through to the next ecosystem');

  const other = await tempDir(t, 'memo-recipes-link-');
  await writeFile(join(other, 'real.json'), JSON.stringify({ scripts: { test: 'x' } }));
  symlinkSync(join(other, 'real.json'), join(other, 'package.json'));
  assert.deepEqual(detectRecipes(other), {}, 'a symlinked manifest is not read');
  await writeFile(join(other, 'pyproject.toml'), '[project]\n');
  assert.deepEqual(detectRecipes(other), { test: ['python3', '-m', 'pytest', '-q'] });
});

test('runner helpers: nice wrapper, secret-free env, capped log with marker', async t => {
  assert.deepEqual(commandFor(['npm', 'test'], 'darwin'), ['nice', ['-n', '10', 'npm', 'test']]);
  assert.deepEqual(commandFor(['npm', 'test'], 'linux'), ['nice', ['-n', '10', 'npm', 'test']]);
  assert.deepEqual(commandFor(['npm', 'test'], 'win32'), ['npm', ['test']]);

  // An allow-list: secrets whose names do not look like secrets (DATABASE_URL) are dropped too,
  // HOME and TMPDIR are the job's own folder, and Git ignores the owner's configuration.
  const env = jobEnv({ PATH: '/bin', HOME: '/h', LANG: 'C.UTF-8', GITHUB_TOKEN: 'x', GH_HOST: 'y', AWS_ACCESS_KEY_ID: 'z', MY_API_KEY: 'k',
    SSH_AUTH_SOCK: '/s', MEMO_BRIDGE_STATE_DIR: '/d', OPENAI_API_KEY: 'o', DB_PASSWORD: 'p',
    DATABASE_URL: 'postgres://u:hunter2@db/x', GIT_ASKPASS: '/a', NODE_OPTIONS: '--require /evil.js' }, 'job_x', { home: '/j/home', tmp: '/j/tmp' });
  assert.deepEqual(env, { PATH: '/bin', LANG: 'C.UTF-8', HOME: '/j/home', TMPDIR: '/j/tmp', XDG_CONFIG_HOME: '/j/home/.config',
    XDG_CACHE_HOME: '/j/home/.cache', CI: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', npm_config_update_notifier: 'false', MEMO_BRIDGE_JOB_ID: 'job_x' });

  const file = join(await tempDir(t, 'memo-jobs-log-'), 'x.log');
  const fd = openSync(file, 'a');
  const sink = createLogSink(fd, 100);
  sink.write(Buffer.from('a'.repeat(60)));
  sink.write(Buffer.from('b'.repeat(60)));
  sink.write(Buffer.from('c'.repeat(60)));
  closeSync(fd);
  const text = readFileSync(file, 'utf8');
  assert.equal(sink.capped, true);
  assert.ok(text.startsWith('a'.repeat(60) + 'b'.repeat(40) + '\n[memo-bridge] log truncated at 100 bytes'), text);
  assert.ok(!text.includes('ccc'), 'output past the cap is dropped');
  assert.ok(sink.tail().endsWith('c'.repeat(60)), 'the summary tail still sees the end of the output');
});

test('a passing job runs detached and succeeds; log is private; results are clean', async t => {
  process.env.MEMO_TEST_API_TOKEN = 'must-not-leak';
  t.after(() => { delete process.env.MEMO_TEST_API_TOKEN; });
  const { rt, stateDir, workspaceId, worktreeId, jobs } = await setup(t);
  const submitted = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const id = submitted.job.job_id;
  assert.match(id, /^job_[A-Za-z0-9_-]{16}$/);
  assert.deepEqual(submitted.job.argv, ['npm', 'test']);
  assert.equal(submitted.job.timeout_seconds, 900);

  const done = await waitStatus(jobs, id, ['succeeded', 'failed', 'timed_out', 'interrupted']);
  assert.equal(done.status, 'succeeded', JSON.stringify(done));
  assert.equal(done.exit_code, 0);
  assert.ok(done.started_at && done.ended_at);
  assert.match(done.summary, /hello-ok/);

  const log = logPathFor(stateDir, id);
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(statSync(join(stateDir, 'jobs')).mode & 0o777, 0o700);
  const results = await jobs.results({ job_id: id });
  assert.equal(results.ok, true);
  const text = results.log.lines.join('\n');
  assert.match(text, /hello-ok/);
  assert.match(text, /ci=1 secret=none/, 'CI is set and secret-looking variables are not passed to the recipe');
  assert.match(text, /recipe test: npm test/);

  const events = await jobs.events({ job_id: id });
  const kinds = events.events.map(e => e.kind);
  assert.deepEqual(kinds, ['submitted', 'started', 'exit']);
  const started = events.events[1].detail;
  assert.ok(Number.isInteger(started.pid) && Number.isInteger(started.runner_pid));
  assert.equal(events.events[2].detail.status, 'succeeded');
  const later = await jobs.events({ job_id: id, after_seq: events.next_after_seq });
  assert.deepEqual(later.events, []);

  const listed = await jobs.list({ workspace_id: workspaceId });
  assert.deepEqual(listed.jobs.map(j => j.job_id), [id]);
  assert.deepEqual((await jobs.list({ status: 'failed' })).jobs, []);

  const audit = (await auditOf(rt)).filter(e => e.op === 'jobs_submit');
  assert.deepEqual(audit.map(e => `${e.outcome}:${e.workspace_id}:${e.issue_ref}`), [`ok:${workspaceId}:${ISSUE}`]);
});

test('a failing job is failed with its exit code', async t => {
  const { workspaceId, worktreeId, jobs } = await setup(t, { scripts: { test: 'node fail.js' } });
  const submitted = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const done = await waitStatus(jobs, submitted.job.job_id, ['succeeded', 'failed', 'timed_out', 'interrupted']);
  assert.equal(done.status, 'failed');
  assert.notEqual(done.exit_code, 0);
  assert.match(done.summary, /boom/);
});

test('timeout kills the whole process group and records timed_out', async t => {
  const { rt, workspaceId, worktreeId, jobs } = await setup(t, { scripts: { test: 'node sleep.js' } });
  const submitted = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test', timeout_seconds: 1 });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const id = submitted.job.job_id;
  const done = await waitStatus(jobs, id, ['succeeded', 'failed', 'timed_out', 'interrupted']);
  assert.equal(done.status, 'timed_out');
  const { pid } = await rawJob(rt, id);
  await waitFor(() => !groupAlive(pid), { timeoutMs: 10000, what: 'process group gone' });
  const kinds = (await jobs.events({ job_id: id })).events.map(e => e.kind);
  assert.deepEqual(kinds, ['submitted', 'started', 'timeout', 'exit']);
});

test('job_cancel stops a running job and its processes; a finished job cannot be cancelled', async t => {
  const { rt, workspaceId, worktreeId, jobs } = await setup(t, { scripts: { test: 'node sleep.js' } });
  const submitted = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' });
  const id = submitted.job.job_id;
  await waitStatus(jobs, id, ['running']);
  // Wait until the recipe actually printed, so the whole npm -> sh -> node chain exists.
  await waitFor(async () => (await jobs.results({ job_id: id })).log.lines.some(l => l.includes('sleeping')), { what: 'job output' });
  const { pid } = await rawJob(rt, id);
  assert.equal(groupAlive(pid), true);

  const cancelled = await jobs.cancel({ job_id: id });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(cancelled.job.status, 'cancelled');
  await waitFor(() => !groupAlive(pid), { timeoutMs: 10000, what: 'process group gone' });
  // The runner records the exit but keeps the cancelled status.
  await waitFor(async () => (await jobs.events({ job_id: id })).events.some(e => e.kind === 'exit'), { what: 'exit event' });
  assert.equal((await jobs.status({ job_id: id })).job.status, 'cancelled');
  assert.deepEqual((await jobs.events({ job_id: id })).events.map(e => e.kind), ['submitted', 'started', 'cancelled', 'exit']);

  const again = await jobs.cancel({ job_id: id });
  assert.deepEqual(again, { ok: false, error: 'job_finished', detail: 'cancelled' });
  const audit = (await auditOf(rt)).filter(e => e.op === 'job_cancel').map(e => `${e.outcome}:${e.code}`);
  assert.deepEqual(audit.sort(), ['error:job_finished', 'ok:null']);
});

test('host concurrency limit refuses with host_busy; queued jobs can be cancelled before they start', async t => {
  const { rt, stateDir, workspaceId, worktreeId, jobs } = await setup(t, { scripts: { test: 'node sleep.js' }, service: { maxJobs: 1 } });
  const first = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'host_busy');
  assert.match(second.detail, /queueing is not available yet/);
  await jobs.cancel({ job_id: first.job.job_id });

  // A queued job whose runner never picked it up is cancelled directly, and a runner started
  // afterwards does nothing.
  const fake = createJobService(rt, { spawnRunner: async () => ({ ok: true, pid: process.pid }) });
  const queued = await fake.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' });
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(queued.job.status, 'queued');
  const cancelled = await fake.cancel({ job_id: queued.job.job_id });
  assert.equal(cancelled.job.status, 'cancelled');
  const runner = spawn(process.execPath, [RUNNER, `--protocol=${RUNNER_PROTOCOL}`, stateDir, queued.job.job_id], { stdio: 'ignore' });
  const code = await new Promise(resolve => runner.once('exit', resolve));
  assert.equal(code, 1, 'runner refuses a job that is not queued');
  const kinds = (await jobs.events({ job_id: queued.job.job_id })).events.map(e => e.kind);
  assert.deepEqual(kinds, ['submitted', 'cancelled']);
});

test('a job whose processes are gone is reported interrupted (running and queued)', async t => {
  const { rt, stateDir, workspaceId, worktreeId, jobs } = await setup(t, { service: { runnerPath: '/nonexistent/job-runner.mjs' } });
  // Injected runner path that cannot start: the runner process dies, the job stays queued,
  // and the next read reports it interrupted.
  const submitted = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const done = await waitStatus(jobs, submitted.job.job_id, ['interrupted']);
  assert.equal(done.summary, 'runner_gone');

  // A running job whose recorded pid (and runner) no longer exist.
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = await new Promise(resolve => dead.once('exit', () => resolve(dead.pid)));
  const id = 'job_' + randomBytes(12).toString('base64url');
  await rt.store().transaction(repo => {
    repo.insertJob({ id, workspace_id: workspaceId, worktree_id: worktreeId, project_id: 'drop', host: 'mac', recipe: 'test',
      argv_json: '["npm","test"]', timeout_ms: 60000, log_path: logPathFor(stateDir, id), created_at: Date.now() });
    repo.updateJob(id, { status: 'running', pid: deadPid, started_at: Date.now() }, 'queued');
    repo.appendJobEvent({ job_id: id, at: Date.now(), kind: 'started', detail: JSON.stringify({ pid: deadPid, runner_pid: deadPid }) });
  });
  const listed = await jobs.list({ workspace_id: workspaceId, status: 'interrupted' });
  assert.ok(listed.jobs.some(j => j.job_id === id), 'list reconciles before filtering');
  assert.equal((await jobs.status({ job_id: id })).job.status, 'interrupted');
  const results = await jobs.results({ job_id: id });
  assert.deepEqual(results.log.lines, [], 'missing log reads as empty');
});

test('job_results is bounded and strips control and bidi characters', async t => {
  const { workspaceId, worktreeId, jobs } = await setup(t, { scripts: { test: 'node noisy.js' } });
  const submitted = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' });
  const id = submitted.job.job_id;
  await waitStatus(jobs, id, ['succeeded']);
  const full = await jobs.results({ job_id: id, tail_lines: 400 });
  assert.equal(full.ok, true);
  assert.ok(full.log.lines.length <= 400 && full.log.lines.length > 100);
  assert.equal(full.log.truncated_to_tail, true);
  assert.ok(Buffer.byteLength(full.log.lines.join('\n')) <= 64 * 1024);
  for (const line of full.log.lines) assert.doesNotMatch(line, /[\u0000-\u001f\u007f\u202e]/);
  assert.ok(full.log.lines.some(l => l.includes('line 599 evil')), 'the end of the log is returned');
  const few = await jobs.results({ job_id: id, tail_lines: 3 });
  assert.equal(few.log.lines.length, 3);
  assert.deepEqual(await jobs.results({ job_id: id, tail_lines: 401 }), { ok: false, error: 'invalid_input', detail: 'tail_lines' });
  assert.doesNotMatch(full.job.summary, /[\u0000-\u0009\u000b-\u001f\u202e]/);
});

test('refusals: capability, ownership, closed workspace, claim, recipe, worktree, input bounds', async t => {
  const env = await setup(t, { claimExpiresIn: 3600_000 });
  const { rt, workspaceId, worktreeId, jobs } = env;
  const base = { workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' };

  assert.deepEqual(await jobs.submit({ ...base, recipe: 'deploy' }), { ok: false, error: 'unknown_recipe', detail: 'allowed: test, build, lint' });
  assert.deepEqual(await jobs.submit({ ...base, recipe: 'build' }), { ok: false, error: 'unknown_recipe', detail: 'available: test' });
  assert.deepEqual(await jobs.submit({ ...base, timeout_seconds: 3601 }), { ok: false, error: 'invalid_input', detail: 'timeout_seconds' });
  assert.deepEqual(await jobs.submit({ ...base, worktree_id: '../x' }), { ok: false, error: 'invalid_input', detail: 'worktree_id' });
  assert.deepEqual(await jobs.submit({ ...base, worktree_id: 'wt_missing' }), { ok: false, error: 'unknown_worktree' });

  // A reader principal (no runner:execute) is refused before anything else, and journaled.
  const readerRt = createRuntime({ stateDir: env.stateDir, principal: READER, ledger: stubLedger(), host: 'mac' });
  t.after(() => readerRt.close());
  const reader = createJobService(readerRt);
  assert.deepEqual(await reader.submit(base), { ok: false, error: 'forbidden' });
  assert.deepEqual(await reader.cancel({ job_id: 'job_' + 'a'.repeat(16) }), { ok: false, error: 'forbidden' });

  // Another principal with every capability still cannot use the owner's workspace or jobs.
  const otherRt = createRuntime({ stateDir: env.stateDir, principal: OTHER, ledger: stubLedger(), host: 'mac' });
  t.after(() => otherRt.close());
  const other = createJobService(otherRt);
  assert.deepEqual(await other.submit(base), { ok: false, error: 'forbidden' });
  const fake = createJobService(rt, { spawnRunner: async () => ({ ok: true, pid: process.pid }) });
  const owned = await fake.submit(base);
  assert.equal(owned.ok, true, JSON.stringify(owned));
  for (const method of ['status', 'events', 'results', 'cancel']) {
    assert.deepEqual(await other[method]({ job_id: owned.job.job_id }), { ok: false, error: 'forbidden' }, method);
  }
  assert.deepEqual(await other.list({ workspace_id: workspaceId }), { ok: false, error: 'forbidden' });
  assert.deepEqual((await other.list({})).jobs, [], 'list without a workspace only shows the caller\'s jobs');
  await fake.cancel({ job_id: owned.job.job_id });
  assert.deepEqual(await jobs.status({ job_id: 'job_' + 'b'.repeat(16) }), { ok: false, error: 'unknown_job' });
  assert.deepEqual(await jobs.status({ job_id: 'nope' }), { ok: false, error: 'invalid_input', detail: 'job_id' });

  // Worktree of another workspace of the same principal: unknown, not described.
  const second = wsId();
  await rt.store().transaction(repo => repo.insertWorkspace({ id: second, principal: OWNER.id, client_type: 'cli', project_id: 'drop',
    host: 'mac', status: 'active', created_at: Date.now(), updated_at: Date.now() }));
  assert.deepEqual(await jobs.submit({ ...base, workspace_id: second }), { ok: false, error: 'unknown_worktree' });

  // Worktree on another host.
  await rt.store().transaction(repo => repo.insertWorktree({ id: 'wt_vps', workspace_id: workspaceId, project_id: 'drop', host: 'vps',
    path: env.repoDir, branch: 'b', base_ref: 'main', base_commit: 'a'.repeat(40), issue_ref: ISSUE, created_at: 1, updated_at: 1 }));
  assert.deepEqual(await jobs.submit({ ...base, worktree_id: 'wt_vps' }), { ok: false, error: 'wrong_host', detail: 'vps' });

  // Expired, then released claims.
  await rt.store().transaction(repo => {
    for (const c of repo.claimsOf(workspaceId, 'claimed')) {
      repo.updateClaim(c.claim_id, { expires_at: new Date(Date.now() - 1000).toISOString() }, c.fence_sha);
    }
  });
  assert.equal((await jobs.submit(base)).error, 'no_live_claim');
  await rt.store().transaction(repo => {
    for (const c of repo.claimsOf(workspaceId, 'claimed')) {
      repo.updateClaim(c.claim_id, { state: 'released', expires_at: new Date(Date.now() + 3600_000).toISOString() }, c.fence_sha);
    }
  });
  assert.equal((await jobs.submit(base)).error, 'no_live_claim');

  // Removed worktree, then closed workspace.
  await rt.store().transaction(repo => repo.updateWorktree(worktreeId, { status: 'removed', removed_at: Date.now() }));
  assert.equal((await jobs.submit(base)).error, 'worktree_removed');
  await rt.store().transaction(repo => repo.updateWorkspace(workspaceId, { status: 'closed', closed_at: Date.now() }));
  assert.equal((await jobs.submit(base)).error, 'workspace_closed');

  const audit = await auditOf(rt);
  const submits = audit.filter(e => e.op === 'jobs_submit').map(e => `${e.outcome}:${e.code}`);
  for (const expected of ['denied:forbidden', 'error:unknown_recipe', 'error:invalid_input', 'error:unknown_worktree',
    'denied:wrong_host', 'denied:no_live_claim', 'denied:worktree_removed', 'denied:workspace_closed', 'ok:null']) {
    assert.ok(submits.includes(expected), `journaled ${expected}: ${submits.join(', ')}`);
  }
  assert.ok(audit.some(e => e.op === 'job_status' && e.outcome === 'denied' && e.principal === OTHER.id), 'read refusals are journaled');
  assert.ok(!audit.some(e => e.op === 'job_status' && e.outcome === 'ok'), 'successful reads are not journaled');
});

test('MCP registration: the six tools, JSON results, store failures reported as codes', async t => {
  const { rt, workspaceId } = await setup(t);
  const tools = new Map();
  const server = { registerTool: (name, config, handler) => tools.set(name, { config, handler }) };
  registerJobTools(server, () => rt);
  assert.deepEqual([...tools.keys()], [...JOB_TOOLS]);
  assert.deepEqual(JOB_TOOLS, ['jobs_submit', 'jobs_list', 'job_status', 'job_events', 'job_results', 'job_cancel']);
  assert.equal(tools.get('jobs_list').config.annotations.readOnlyHint, true);
  assert.equal(tools.get('jobs_submit').config.annotations.readOnlyHint, false);
  assert.match(tools.get('jobs_submit').config.description, /repository's own scripts on the owner's machine/);

  const listed = await tools.get('jobs_list').handler({ workspace_id: workspaceId });
  assert.deepEqual(JSON.parse(listed.content[0].text), { ok: true, jobs: [] });
  assert.equal(tools.get('jobs_submit').config.inputSchema.safeParse({ workspace_id: workspaceId, worktree_id: 'x', recipe: 'rm' }).success, false);

  const broken = new Map();
  registerJobTools({ registerTool: (name, config, handler) => broken.set(name, handler) }, () => { throw new Error('state_dir_not_private'); });
  const failed = JSON.parse((await broken.get('job_status')({ job_id: 'job_' + 'a'.repeat(16) })).content[0].text);
  assert.deepEqual(failed, { ok: false, error: 'store_unavailable', detail: 'state_dir_not_private' });
});

test('recipes run only what detectRecipes chooses now: a tampered job row is rejected by the runner', async t => {
  const { rt, stateDir, workspaceId, worktreeId, jobs } = await setup(t);
  const id = 'job_' + randomBytes(12).toString('base64url');
  await mkdir(join(stateDir, 'jobs'), { recursive: true, mode: 0o700 });
  await writeFile(logPathFor(stateDir, id), '', { mode: 0o600 });
  await rt.store().transaction(repo => repo.insertJob({ id, workspace_id: workspaceId, worktree_id: worktreeId, project_id: 'drop',
    host: 'mac', recipe: 'test', argv_json: '["sh","-c","echo pwned"]', timeout_ms: 60000, log_path: logPathFor(stateDir, id),
    created_at: Date.now() }));
  const runner = spawn(process.execPath, [RUNNER, `--protocol=${RUNNER_PROTOCOL}`, stateDir, id], { stdio: 'ignore' });
  assert.equal(await new Promise(resolve => runner.once('exit', resolve)), 1);
  const job = (await jobs.status({ job_id: id })).job;
  assert.equal(job.status, 'failed');
  assert.equal(job.summary, 'recipe_changed');
  assert.equal(readFileSync(logPathFor(stateDir, id), 'utf8'), '', 'nothing ran');
});

// ---------------------------------------------------------------------------------------
// Regressions from the adversarial review of 933e759 (finding numbers in the test names).

const startedDetail = async (jobs, id) => {
  const events = await waitFor(async () => {
    const e = (await jobs.events({ job_id: id })).events;
    return e.some(x => x.kind === 'started') ? e : null;
  }, { what: 'started event' });
  return events.find(e => e.kind === 'started').detail;
};

test('finding 5: a process that leaves the job\'s group is stopped by job_cancel too', async t => {
  const { repoDir, workspaceId, worktreeId, jobs } = await setup(t, { scripts: { test: 'node escape.js' } });
  const submitted = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const id = submitted.job.job_id;
  await waitFor(async () => (await jobs.results({ job_id: id })).log.lines.some(l => l.includes('escaped')), { what: 'grandchild' });
  const grandchild = Number(readFileSync(join(repoDir, 'grandchild.pid'), 'utf8'));
  t.after(() => { try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone */ } });
  const { pid } = await startedDetail(jobs, id);
  assert.notEqual(grandchild, pid);
  assert.equal(processAlive(grandchild), true);
  // Give the runner's process tracking a few polls to see it.
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((await jobs.cancel({ job_id: id })).ok, true);
  await waitFor(() => !processAlive(grandchild), { timeoutMs: 15000, what: 'detached grandchild gone' });
  await waitFor(() => !groupAlive(pid), { timeoutMs: 15000, what: 'job group gone' });
});

test('finding 5: processes left behind by a job that exited are stopped too', async t => {
  const { repoDir, workspaceId, worktreeId, jobs } = await setup(t, { scripts: { test: 'node escape.js && true' } });
  await writeFile(join(repoDir, 'escape.js'), SCRIPTS['escape.js'].replace('setTimeout(() => {}, 120000);', 'setTimeout(() => {}, 1500);'));
  const submitted = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const done = await waitStatus(jobs, submitted.job.job_id, ['succeeded', 'failed', 'timed_out', 'interrupted']);
  assert.equal(done.status, 'succeeded', JSON.stringify(done));
  const grandchild = Number(readFileSync(join(repoDir, 'grandchild.pid'), 'utf8'));
  t.after(() => { try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone */ } });
  await waitFor(() => !processAlive(grandchild), { timeoutMs: 15000, what: 'detached grandchild gone' });
});

test('finding 6: SIGTERM to the runner stops the job and records it interrupted', async t => {
  const { workspaceId, worktreeId, jobs } = await setup(t, { scripts: { test: 'node sleep.js' } });
  const submitted = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test', timeout_seconds: 600 });
  const id = submitted.job.job_id;
  await waitFor(async () => (await jobs.results({ job_id: id })).log.lines.some(l => l.includes('sleeping')), { what: 'job output' });
  const { pid, runner_pid: runnerPid } = await startedDetail(jobs, id);
  process.kill(runnerPid, 'SIGTERM');
  const done = await waitStatus(jobs, id, ['interrupted', 'succeeded', 'failed', 'timed_out', 'cancelled'], { timeoutMs: 15000 });
  assert.equal(done.status, 'interrupted');
  assert.equal(done.summary, 'runner_terminated');
  await waitFor(() => !groupAlive(pid) && !processAlive(runnerPid), { timeoutMs: 15000, what: 'job and runner gone' });
});

test('finding 6: a running job past its deadline is killed and timed out by the next read; a reused group id is never signalled', async t => {
  const { rt, stateDir, workspaceId, worktreeId, jobs } = await setup(t);
  const { processStart } = await import('../server/runners/processes.mjs');
  const { DEADLINE_GRACE_MS } = await import('../server/runners/jobs.mjs');
  const spawnGroup = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
    return child.pid;
  };
  const ours = spawnGroup(); const reused = spawnGroup();
  await waitFor(() => processStart(ours) && processStart(reused), { what: 'processes started' });
  const insert = (pid, pidStart) => rt.store().transaction(repo => {
    const id = 'job_' + randomBytes(12).toString('base64url');
    const started = Date.now() - 60_000 - DEADLINE_GRACE_MS - 1000;
    repo.insertJob({ id, workspace_id: workspaceId, worktree_id: worktreeId, project_id: 'drop', host: 'mac', recipe: 'test',
      argv_json: '["npm","test"]', timeout_ms: 60_000, log_path: logPathFor(stateDir, id), created_at: started });
    repo.updateJob(id, { status: 'running', pid, started_at: started }, 'queued');
    repo.appendJobEvent({ job_id: id, at: started, kind: 'started', detail: JSON.stringify({ pid, pid_start: pidStart, runner_pid: 999999 }) });
    return id;
  });
  const ownJob = await insert(ours, processStart(ours));
  // A recorded start time that does not match: the group id now belongs to someone else.
  const staleJob = await insert(reused, 'Thu Jan  1 00:00:00 1970');
  const own = (await jobs.status({ job_id: ownJob })).job;
  assert.equal(own.status, 'timed_out');
  assert.equal(own.summary, 'deadline_exceeded');
  await waitFor(() => !groupAlive(ours), { timeoutMs: 10000, what: 'overdue job group killed' });
  assert.equal((await jobs.status({ job_id: staleJob })).job.status, 'timed_out');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(groupAlive(reused), true, 'an unrelated process group with a reused id is left alone');
  const kinds = (await jobs.events({ job_id: ownJob })).events.map(e => `${e.kind}:${e.detail?.by ?? ''}`);
  assert.deepEqual(kinds, ['started:', 'timeout:deadline']);
});

test('finding 7: workspace_close cancels the workspace\'s running jobs', async t => {
  const { rt, workspaceId, worktreeId, jobs } = await setup(t, { scripts: { test: 'node sleep.js' } });
  const submitted = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' });
  const id = submitted.job.job_id;
  await waitFor(async () => (await jobs.results({ job_id: id })).log.lines.some(l => l.includes('sleeping')), { what: 'job output' });
  const { pid } = await startedDetail(jobs, id);
  const closed = await rt.coordinator().workspaceClose({ workspace_id: workspaceId });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.deepEqual(closed.cancelled_jobs, [id]);
  assert.equal((await jobs.status({ job_id: id })).job.status, 'cancelled');
  await waitFor(() => !groupAlive(pid), { timeoutMs: 15000, what: 'job group gone' });
  const cancelled = (await jobs.events({ job_id: id })).events.find(e => e.kind === 'cancelled');
  assert.equal(cancelled.detail.reason, 'workspace_closed');
});

test('finding 7: task_release cancels the jobs running under that claim', async t => {
  const { rt, workspaceId, worktreeId, claimId, jobs } = await setup(t, { scripts: { test: 'node sleep.js' } });
  const submitted = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' });
  const id = submitted.job.job_id;
  await waitStatus(jobs, id, ['running']);
  const { pid } = await startedDetail(jobs, id);
  const released = await rt.coordinator().taskRelease({ workspace_id: workspaceId, issue: ISSUE, claim_id: claimId,
    fence: 'f'.repeat(40), outcome: 'cancelled' });
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.deepEqual(released.cancelled_jobs, [id]);
  await waitFor(() => !groupAlive(pid), { timeoutMs: 15000, what: 'job group gone' });
  assert.equal((await jobs.status({ job_id: id })).job.status, 'cancelled');
});

test('finding 7: the runner stops a job once its claim has expired', async t => {
  const { workspaceId, worktreeId, jobs } = await setup(t, { scripts: { test: 'node sleep.js' }, claimExpiresIn: 4000 });
  const submitted = await jobs.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const id = submitted.job.job_id;
  const done = await waitStatus(jobs, id, ['cancelled', 'succeeded', 'failed', 'timed_out', 'interrupted'], { timeoutMs: 25000 });
  assert.equal(done.status, 'cancelled');
  const cancelled = (await jobs.events({ job_id: id })).events.find(e => e.kind === 'cancelled');
  assert.deepEqual(cancelled.detail, { from: 'running', by: 'runner', reason: 'no_live_claim' });
  const { pid } = await startedDetail(jobs, id);
  await waitFor(() => !groupAlive(pid), { timeoutMs: 15000, what: 'job group gone' });
});

test('version skew: a runner refuses a job launched by a server of another protocol', async t => {
  const { rt, stateDir, workspaceId, worktreeId, jobs } = await setup(t);
  const fake = createJobService(rt, { spawnRunner: async () => ({ ok: true, pid: process.pid }) });
  for (const args of [[], ['--protocol=1']]) {
    const queued = await fake.submit({ workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' });
    assert.equal(queued.ok, true, JSON.stringify(queued));
    // [] is how a 0.4.0 server starts the runner: `node job-runner.mjs <stateDir> <jobId>`.
    const runner = spawn(process.execPath, [RUNNER, ...args, stateDir, queued.job.job_id], { stdio: 'ignore' });
    assert.equal(await new Promise(resolve => runner.once('exit', resolve)), 1);
    const job = (await jobs.status({ job_id: queued.job.job_id })).job;
    assert.equal(job.status, 'failed', args.join(' '));
    assert.equal(job.summary, 'runner_version_mismatch');
    assert.equal(readFileSync(logPathFor(stateDir, queued.job.job_id), 'utf8'), '', 'nothing ran');
  }
});

test('jobs_submit asks the ledger, not only the local mirror, and refuses without a sandbox', async t => {
  const { rt, workspaceId, worktreeId, jobs } = await setup(t);
  const base = { workspace_id: workspaceId, worktree_id: worktreeId, recipe: 'test' };
  const verify = rt.ledger.verify;
  rt.ledger.verify = async () => ({ ok: false, error: 'stale_lease', detail: 'Missing or superseded lease' });
  assert.deepEqual(await jobs.submit(base), { ok: false, error: 'stale_lease', detail: 'Missing or superseded lease' });
  rt.ledger.verify = async () => { throw new Error('python crashed'); };
  assert.deepEqual(await jobs.submit(base), { ok: false, error: 'ledger_unavailable' });
  rt.ledger.verify = verify;
  const misconfigured = createJobService(rt, { env: { ...process.env, MEMO_BRIDGE_JOB_SANDBOX: 'maybe' } });
  assert.equal((await misconfigured.submit(base)).error, 'invalid_configuration');
  if (process.platform !== 'darwin') {
    const strict = createJobService(rt, { env: { ...process.env, MEMO_BRIDGE_JOB_SANDBOX: 'on' } });
    assert.equal((await strict.submit(base)).error, 'sandbox_unavailable');
  }
  const audit = (await auditOf(rt)).filter(e => e.op === 'jobs_submit').map(e => `${e.outcome}:${e.code}`);
  assert.ok(audit.includes('denied:stale_lease'), audit.join(', '));
  assert.ok(audit.includes('error:ledger_unavailable'), audit.join(', '));
  assert.deepEqual((await jobs.list({})).jobs, [], 'nothing was recorded');
});
