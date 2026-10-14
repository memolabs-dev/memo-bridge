// Phase 4 integration seams: the contracts between the memo-bridge modules and what lab-infra
// deploys (role memo-bridge, feat/memo-bridge-role 117ff83). Each test pins one seam that no
// single module test covers: runner.json shape, runner tree variables, supervisor start-up in
// the runner process, the askpass helper under a 0644 install, and the job tool contract the
// hub registry is built from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../server/runtime.mjs';
import { createJobService } from '../server/runners/jobs.mjs';
import { runnerRootFromEnv } from '../server/runners/executor-systemd.mjs';
import { loadRunnerConfig } from '../server/runners/resources.mjs';
import { startSupervisorFromEnv } from '../server/runners/supervisor.mjs';
import { ASKPASS_PATH, askpassProgram } from '../server/runners/worktrees.mjs';
import { runnerStatus } from '../server/runners/executor.mjs';
import { runnerInfo } from '../server/runners/hosts.mjs';
import { collectTools } from '../bridge/ops.mjs';

const GIB = 1024 ** 3;
const temp = t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mb-integ-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// /etc/memo-bridge/runner.json as lab-infra renders it (templates/runner.json.j2 with
// group_vars/lab.yml after the verifier fixes: dispatch section, running free-disk floor), with
// a few values moved off the defaults so the test sees them.
const LAB_INFRA_RUNNER_JSON = {
  version: 1, managed_by: 'lab-infra role memo-bridge', host: 'vps', concurrency: 1,
  pilot_repos: ['memolabs-dev/memo-bridge'], recipes: ['test', 'build', 'lint'],
  paths: { root: '/var/lib/memo-runner', worktrees: '/var/lib/memo-runner/worktrees', repos: '/var/lib/memo-runner/repos',
    spool: '/var/lib/memo-runner/spool', jobs: '/var/lib/memo-runner/jobs', governance: '/var/lib/memo-runner/governance' },
  job_unit: { template: 'memo-job@.service', slice: 'memo-dev.slice', dropin: '50-dispatch.conf', timeout_default_sec: 1800,
    timeout_max_sec: 3600, memory_max: '2560M', tasks_max: 256, stop_timeout_sec: 30 },
  budgets: { disk_bytes: 10 * GIB, du_interval_sec: 90, min_free_disk_running_bytes: 25 * GIB },
  dispatch: { root: '/var/lib/memo-runner', runner_user: 'memo-runner', job_user: 'memo-job', max_timeout_seconds: 2400,
    recipes: ['test', 'lint'] },
  admission: { min_free_disk_bytes: 42949672960, min_mem_available_bytes: 4294967296, psi_cpu_some_avg10_max: 50.0,
    psi_memory_full_avg10_max: 5.0, psi_io_full_avg10_max: 10.0, retry_sec: 45 }
};

test('runner.json written by lab-infra drives admission, the disk budget and the intervals', t => {
  const dir = temp(t);
  const file = join(dir, 'runner.json');
  writeFileSync(file, JSON.stringify(LAB_INFRA_RUNNER_JSON));
  const cfg = loadRunnerConfig(file);
  assert.deepEqual(cfg.errors, []);
  assert.equal(cfg.source, 'file');
  assert.deepEqual(cfg.admission, { min_free_disk_gib: 40, min_mem_available_gib: 4,
    max_psi: { cpu_some_avg10: 50, memory_full_avg10: 5, io_full_avg10: 10 } });
  assert.equal(cfg.disk_budget_gib, 10);
  assert.equal(cfg.defer_retry_seconds, 45);
  assert.equal(cfg.du_interval_seconds, 90);
  assert.equal(cfg.min_free_disk_running_gib, 25);
  assert.deepEqual([cfg.recipes, cfg.max_timeout_seconds], [['test', 'lint'], 2400], 'the dispatch section narrows the runtime too');
  // Both shapes for one setting: reported, the canonical key kept.
  writeFileSync(file, JSON.stringify({ disk_budget_gib: 5, budgets: { disk_bytes: GIB }, admission: { psi_cpu_some_avg10_max: 1, max_psi: {} } }));
  const both = loadRunnerConfig(file);
  assert.equal(both.disk_budget_gib, 5);
  assert.deepEqual(both.errors.sort(), ['admission.psi', 'budgets.disk_bytes']);
  // An unknown PSI key is reported, never silently checked or dropped as valid.
  writeFileSync(file, JSON.stringify({ admission: { psi_disk_some_avg10_max: 1 } }));
  assert.deepEqual(loadRunnerConfig(file).errors, ['admission.psi_disk_some_avg10_max']);
});

test('the runner tree variables lab-infra sets must match the dispatcher layout', () => {
  assert.deepEqual(runnerRootFromEnv({}), { ok: true, root: '/var/lib/memo-runner' });
  assert.deepEqual(runnerRootFromEnv({ MEMO_BRIDGE_SPOOL_DIR: '/var/lib/memo-runner/spool', MEMO_BRIDGE_JOBS_DIR: '/var/lib/memo-runner/jobs/' }),
    { ok: true, root: '/var/lib/memo-runner' });
  assert.equal(runnerRootFromEnv({ MEMO_BRIDGE_SPOOL_DIR: '/srv/spool' }).ok, false);
  assert.equal(runnerRootFromEnv({ MEMO_BRIDGE_JOBS_DIR: 'jobs' }).ok, false);
  assert.equal(runnerRootFromEnv({ MEMO_BRIDGE_RUNNER_ROOT: 'relative' }).ok, false);
  assert.equal(runnerRootFromEnv({ MEMO_BRIDGE_RUNNER_ROOT: '/var/lib/../lib/memo-runner' }).ok, false);
  // jobs_submit on such a host reports the configuration error instead of writing anywhere.
  const executorEnv = { MEMO_BRIDGE_JOB_EXECUTOR: 'systemd', MEMO_BRIDGE_SPOOL_DIR: '/srv/spool' };
  assert.equal(runnerRootFromEnv(executorEnv).detail, 'MEMO_BRIDGE_SPOOL_DIR must be /var/lib/memo-runner/spool');
});

test('the runner process starts the supervisor from the lab-infra environment (Linux path, faked)', async t => {
  const dir = temp(t);
  const root = join(dir, 'memo-runner');
  for (const p of ['spool/queue', 'spool/cancel', 'jobs', 'worktrees', 'state']) mkdirSync(join(root, p), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'runner.json'), JSON.stringify(LAB_INFRA_RUNNER_JSON));
  const env = { MEMO_BRIDGE_JOB_EXECUTOR: 'systemd', MEMO_BRIDGE_RUNNER_ROOT: root, MEMO_BRIDGE_SPOOL_DIR: join(root, 'spool'),
    MEMO_BRIDGE_JOBS_DIR: join(root, 'jobs'), MEMO_BRIDGE_RUNNER_CONFIG: join(dir, 'runner.json') };
  const rt = createRuntime({ stateDir: join(root, 'state'), host: 'vps', ledger: {} });
  t.after(() => rt.close());
  const run = async () => ({ code: 0, stdout: 'ActiveState=inactive\n' });
  const healthy = { pressure: { cpu: { some: { avg10: 1 } }, memory: { full: { avg10: 0 } }, io: { full: { avg10: 0 } } },
    memory: { available_bytes: 8 * GIB }, disk: { free_bytes: 100 * GIB } };
  const logs = [];
  const timers = { setInterval: () => ({}), clearInterval: () => {} };
  const supervisor = await startSupervisorFromEnv(rt, env, { os: 'linux', run, timers, log: e => logs.push(e),
    resources: { snapshot: () => healthy, usage: async () => ({ bytes: 0, partial: false }) } });
  t.after(() => supervisor?.stop());
  assert.ok(supervisor, 'started');
  assert.equal(supervisor.options.deferRetryMs, 45_000);
  assert.equal(supervisor.options.diskCheckMs, 90_000);
  // host_resources reads the same supervisor through the status provider.
  const status = runnerStatus();
  assert.equal(status.executor, 'systemd');
  assert.equal(status.queue_depth, 0);
  assert.ok(status.started_at);
  assert.deepEqual(logs, []);
  await supervisor.stop();
  assert.equal(runnerStatus(), null);

  // The Mac (local executor) never starts one; a bad tree or a non-Linux host refuses to start.
  assert.equal(await startSupervisorFromEnv(rt, {}, { os: 'linux' }), null);
  await assert.rejects(startSupervisorFromEnv(rt, { ...env, MEMO_BRIDGE_JOBS_DIR: '/tmp/jobs' }, { os: 'linux', run, timers }),
    /invalid_configuration: MEMO_BRIDGE_JOBS_DIR/);
  await assert.rejects(startSupervisorFromEnv(rt, env, { os: 'darwin' }), /invalid_configuration/);
});

test('git askpass works under a 0644 install: a private executable copy in the state directory', async t => {
  const dir = temp(t);
  const installed = join(dir, 'app', 'git-askpass.mjs');
  mkdirSync(join(dir, 'app'));
  copyFileSync(ASKPASS_PATH, installed);
  chmodSync(installed, 0o644);
  const state = join(dir, 'state');
  mkdirSync(state, { mode: 0o700 });
  const program = await askpassProgram({ MEMO_BRIDGE_STATE_DIR: state }, { source: installed });
  assert.equal(program, join(state, 'bin', 'git-askpass.mjs'));
  accessSync(program, constants.X_OK);
  assert.equal(statSync(program).mode & 0o777, 0o700);
  assert.equal(statSync(join(state, 'bin')).mode & 0o777, 0o700);
  assert.equal(readFileSync(program, 'utf8'), readFileSync(installed, 'utf8'));
  // A new release replaces the copy; an executable install is used in place; no state dir: fail closed.
  writeFileSync(installed, `${readFileSync(installed, 'utf8')}\n// next release\n`);
  await askpassProgram({ MEMO_BRIDGE_STATE_DIR: state }, { source: installed });
  assert.match(readFileSync(program, 'utf8'), /next release/);
  assert.equal(await askpassProgram({}, { source: ASKPASS_PATH }), ASKPASS_PATH);
  assert.equal(await askpassProgram({}, { source: installed }), null);
});

test('job tools: the hub registry sees client_request_id and release_on_finish; the Mac refuses release_on_finish', async t => {
  const dir = temp(t);
  const rt = createRuntime({ stateDir: join(dir, 'state'), host: 'mac', ledger: {} });
  t.after(() => rt.close());
  const tools = await collectTools(() => rt);
  const schema = tools.get('jobs_submit').inputSchema;
  const base = { workspace_id: 'ws_aaaaaaaaaaaaaaaa', worktree_id: 'wt_aaaaaaaaaaaaaaaa', recipe: 'test' };
  assert.equal(schema.safeParse({ ...base, client_request_id: 'retry-0001', release_on_finish: true }).success, true);
  assert.equal(schema.safeParse({ ...base, client_request_id: 'no spaces allowed' }).success, false);
  const jobs = createJobService(rt, { env: {} });
  const r = await jobs.submit({ ...base, release_on_finish: true });
  assert.deepEqual(r, { ok: false, error: 'invalid_input', detail: 'release_on_finish needs the VPS runner' });
  // bridge_info's runner block on the Mac: local executor, no queue, Phase 4 statuses listed.
  const info = runnerInfo({ env: {}, ops: [...tools.keys()] });
  assert.equal(info.executor, 'local');
  assert.equal(info.queueing, false);
  assert.ok(info.active_job_statuses.includes('deferred') && info.ops.includes('jobs_submit'));
});
