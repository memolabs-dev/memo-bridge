// VPS job queue (Phase 4, TODO-P4-08/09/16): store SCHEMA_V3, FIFO with concurrency 1,
// idempotent submission, admission (PSI, MemAvailable, free disk), the du disk budget,
// cancellation through the dispatcher, reconcile on start, and what host_resources reports.
// A fake clock, a fake systemctl, injected resource readings and a temporary runner tree:
// nothing touches systemd, /proc, the VPS or the user's state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRuntime } from '../server/runtime.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { SCHEMA_VERSION, openSqliteStore, requestKey } from '../server/coordinator/store.mjs';
import { createJobService, maxJobsFromEnv } from '../server/runners/jobs.mjs';
import { INSTALL_TIMEOUT_SECONDS, createSystemdExecutor, dispatchIdFor } from '../server/runners/executor-systemd.mjs';
import { runnerStatus } from '../server/runners/executor.mjs';
import { createSupervisor } from '../server/runners/supervisor.mjs';
import { DEFAULT_RUNNER_CONFIG, admit, createResourceReader, loadRunnerConfig, parseDu, parseMeminfo, parsePressure }
  from '../server/runners/resources.mjs';
import { createHostService, jobConcurrencyLimit, runnerInfo } from '../server/runners/hosts.mjs';

const OWNER = makePrincipal('local:owner', Object.values(CAPABILITIES));
const ISSUE = 'memolabs-dev/drop#7';
const GIB = 1024 ** 3;
const UID = process.getuid();

const okLedger = () => {
  const receipt = { state: 'claimed', fence_sha: 'f'.repeat(40) };
  const calls = [];
  const ok = name => async (...args) => { calls.push([name, ...args]); return { ok: true, receipt }; };
  return { calls, status: ok('status'), claim: ok('claim'), verify: ok('verify'), heartbeat: ok('heartbeat'), release: ok('release') };
};

const HEALTHY = () => ({
  pressure: { cpu: { some: { avg10: 2 } }, memory: { some: { avg10: 0 }, full: { avg10: 0 } }, io: { some: { avg10: 1 }, full: { avg10: 0.5 } } },
  memory: { available_bytes: 7 * GIB, total_bytes: 16 * GIB },
  disk: { path: '/', free_bytes: 178 * GIB, total_bytes: 300 * GIB }
});

async function fakeSystemctl(dir) {
  const bin = join(dir, 'systemctl');
  await writeFile(join(dir, 'units.json'), '{}');
  await writeFile(bin, `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const here = path.dirname(fs.realpathSync(process.argv[1]));
const units = JSON.parse(fs.readFileSync(path.join(here, 'units.json'), 'utf8'));
const named = process.argv.slice(2).filter(a => a.endsWith('.service'));
process.stdout.write(named.map(unit => { const u = units[unit] || {};
  return 'Id=' + unit + '\\nLoadState=loaded\\nActiveState=' + (u.ActiveState || 'inactive') + '\\nSubState=' + (u.SubState || 'dead') + '\\nResult=success\\n'; }).join('\\n'));
`);
  chmodSync(bin, 0o755);
  return {
    path: bin,
    set(unit, ActiveState) {
      const units = JSON.parse(readFileSync(join(dir, 'units.json'), 'utf8'));
      units[unit] = { ActiveState };
      writeFileSync(join(dir, 'units.json'), JSON.stringify(units));
    }
  };
}

// The VPS runner on a temporary tree: runtime (fake clock), job service, supervisor.
async function vps(t, { config = {}, ledger = okLedger(), worktrees = 1 } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'memo-queue-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'runner');
  for (const d of ['spool/queue', 'spool/cancel', 'jobs', 'worktrees']) await mkdir(join(root, d), { recursive: true, mode: 0o700 });
  await mkdir(join(base, 'bin'));
  const systemctl = await fakeSystemctl(join(base, 'bin'));
  const clock = { t: Date.now() };
  const rt = createRuntime({ stateDir: join(base, 'state'), principal: OWNER, ledger, host: 'vps', now: () => clock.t });
  const workspaceId = `ws_${randomBytes(12).toString('base64url')}`;
  const wts = [];
  await rt.store().transaction(repo => {
    repo.insertWorkspace({ id: workspaceId, principal: OWNER.id, client_type: 'cli', project_id: 'drop', host: 'vps', status: 'active',
      created_at: clock.t, updated_at: clock.t });
    repo.insertClaim({ claim_id: 'c'.repeat(32), workspace_id: workspaceId, issue_ref: ISSUE, fence_sha: 'f'.repeat(40), epoch: 1,
      expires_at: new Date(clock.t + 1800_000).toISOString(), updated_at: clock.t });
  });
  for (let i = 0; i < worktrees; i++) {
    const path = join(root, 'worktrees', `wt${i}`);
    await mkdir(path);
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { test: 'node -e 1', build: 'node -e 2' } }));
    await rt.store().transaction(repo => repo.insertWorktree({ id: `wt_${i}`, workspace_id: workspaceId, project_id: 'drop', host: 'vps',
      path, branch: `agent/7-${i}`, base_ref: 'main', base_commit: 'a'.repeat(40), issue_ref: ISSUE, created_at: clock.t, updated_at: clock.t }));
    wts.push(realpathSync(path));
  }
  const executor = createSystemdExecutor({ root, systemctl: systemctl.path, statusOwnerUid: UID });
  const reading = { snapshot: HEALTHY(), usage: { bytes: 1 * GIB, partial: false }, usageCalls: [] };
  const resources = {
    snapshot: () => reading.snapshot,
    usage: async paths => { reading.usageCalls.push(paths); return reading.usage; }
  };
  const cfg = { ...loadRunnerConfig('/nonexistent/runner.json'), ...config };
  const jobs = createJobService(rt, { executor });
  const supervisor = createSupervisor(rt, { executor, resources, config: cfg });
  t.after(async () => { await supervisor.stop(); await rt.close(); });
  const did = id => dispatchIdFor(id);
  const queued = () => readdirSync(join(root, 'spool', 'queue')).filter(n => !n.startsWith('.')).sort();
  const cancels = () => readdirSync(join(root, 'spool', 'cancel')).sort();
  // What the dispatcher and the unit would do, by hand.
  const startUnit = id => {
    const d = did(id);
    if (existsSync(join(root, 'spool', 'queue', `${d}.json`))) unlinkSync(join(root, 'spool', 'queue', `${d}.json`));
    systemctl.set(`memo-job@${d}.service`, 'active');
  };
  const finishUnit = async (id, result) => {
    const d = did(id);
    await mkdir(join(root, 'jobs', d, 'out'), { recursive: true });
    await writeFile(join(root, 'jobs', d, 'out', 'job.log'), 'tests passed\n');
    writeFileSync(join(root, 'jobs', d, 'status.json'), JSON.stringify({ version: 1, id: d, ...result }), { mode: 0o640 });
    systemctl.set(`memo-job@${d}.service`, 'inactive');
  };
  const row = id => rt.store().transaction(repo => repo.getJob(id), { write: false });
  const kinds = async id => (await rt.store().transaction(repo => repo.listJobEvents(id, 0, 500), { write: false })).map(e => e.kind);
  const base0 = { workspace_id: workspaceId, worktree_id: 'wt_0', recipe: 'test' };
  return { base, root, rt, clock, jobs, supervisor, executor, systemctl, reading, ledger, workspaceId, wts, did, queued, cancels,
    startUnit, finishUnit, row, kinds, submitArgs: base0 };
}
const SUCCESS = { service_result: 'success', exit_code: 'exited', exit_status: '0' };

// ---------------------------------------------------------------------------------------

test('store SCHEMA_V3: a version 2 store is rebuilt in place, rows and job events kept, new statuses accepted', async t => {
  const dir = join(await mkdtemp(join(tmpdir(), 'memo-v3-')), 'state');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const T = 1_700_000_000_000;
  let store = openSqliteStore({ dir });
  await store.transaction(repo => {
    repo.insertWorkspace({ id: 'ws_1', principal: 'local:owner', client_type: 'cli', project_id: 'drop', host: 'mac', status: 'active', created_at: T, updated_at: T });
    repo.insertWorktree({ id: 'wt_1', workspace_id: 'ws_1', project_id: 'drop', host: 'mac', path: '/x', branch: 'b', base_ref: 'main',
      base_commit: 'a'.repeat(40), created_at: T, updated_at: T });
    for (const id of ['job_a', 'job_b']) {
      repo.insertJob({ id, workspace_id: 'ws_1', worktree_id: 'wt_1', project_id: 'drop', host: 'mac', recipe: 'test', argv_json: '[]',
        timeout_ms: 1000, log_path: '/l', created_at: T });
      repo.appendJobEvent({ job_id: id, at: T, kind: 'submitted' });
    }
    repo.updateJob('job_b', { status: 'succeeded', exit_code: 0, ended_at: T }, 'queued');
  });
  await store.close();
  // Turn the file back into what Phase 3 left: the v2 jobs table (old statuses, old columns), user_version 2.
  const raw = new DatabaseSync(join(dir, 'coordinator.sqlite'));
  raw.exec(`PRAGMA foreign_keys = OFF; BEGIN;
    CREATE TABLE jobs_v2 (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), worktree_id TEXT NOT NULL REFERENCES worktrees(id),
      project_id TEXT NOT NULL, host TEXT NOT NULL, recipe TEXT NOT NULL, argv_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','timed_out','interrupted')),
      exit_code INTEGER, pid INTEGER, timeout_ms INTEGER NOT NULL, log_path TEXT NOT NULL, created_at INTEGER NOT NULL,
      started_at INTEGER, ended_at INTEGER, summary TEXT);
    INSERT INTO jobs_v2 SELECT id, workspace_id, worktree_id, project_id, host, recipe, argv_json, status, exit_code, pid, timeout_ms,
      log_path, created_at, started_at, ended_at, summary FROM jobs;
    DROP TABLE jobs; ALTER TABLE jobs_v2 RENAME TO jobs; DROP TABLE requests; PRAGMA user_version = 2; COMMIT;`);
  assert.throws(() => raw.prepare("UPDATE jobs SET status = 'deferred' WHERE id = 'job_a'").run(), /CHECK/);
  raw.close();

  store = openSqliteStore({ dir });
  t.after(() => store.close());
  assert.equal(store.settings().schema_version, SCHEMA_VERSION);
  assert.equal(store.settings().foreign_keys, 1, 'foreign keys are back on after the rebuild');
  const kept = await store.transaction(repo => [repo.getJob('job_a'), repo.getJob('job_b'), repo.listJobEvents('job_a')], { write: false });
  assert.deepEqual([kept[0].status, kept[1].status, kept[1].exit_code], ['queued', 'succeeded', 0]);
  assert.deepEqual([kept[0].claim_id, kept[0].unit, kept[0].limits_json, kept[0].release_on_finish, kept[0].principal, kept[0].status_reason],
    [null, null, null, 0, null, null]);
  assert.equal(kept[2].length, 1);
  for (const status of ['deferred', 'dispatched', 'running', 'oom', 'budget_exceeded']) {
    const from = (await store.transaction(repo => repo.getJob('job_a'))).status;
    assert.equal(await store.transaction(repo => repo.updateJob('job_a', { status, status_reason: 'x' }, from)), 1, status);
  }
  await assert.rejects(store.transaction(repo => repo.updateJob('job_a', { status: 'exploded' }, 'budget_exceeded')), /CHECK/);
  await assert.rejects(store.transaction(repo => repo.appendJobEvent({ job_id: 'job_nope', at: T, kind: 'x' })), /FOREIGN KEY/i,
    'job_events still references jobs after the rename');
  // requests: first insert wins.
  const key = requestKey('local:owner', 'jobs_submit', 'retry-0001');
  assert.equal(key, requestKey('local:owner', 'jobs_submit', 'retry-0001'));
  assert.notEqual(key, requestKey('local:other', 'jobs_submit', 'retry-0001'));
  await store.transaction(repo => {
    assert.equal(repo.insertRequest({ key, principal: 'local:owner', op: 'jobs_submit', result_json: '{"job_id":"job_a"}', created_at: T }), 1);
    assert.equal(repo.insertRequest({ key, principal: 'local:owner', op: 'jobs_submit', result_json: '{"job_id":"job_b"}', created_at: T }), 0);
  });
  assert.equal(JSON.parse((await store.transaction(repo => repo.getRequest(key))).result_json).job_id, 'job_a');
  assert.equal(await store.transaction(repo => repo.pruneRequests(T + 1)), 1);
});

test('AC-P4-04: two jobs run one at a time, in submission order, and outlive the client', async t => {
  const v = await vps(t);
  const first = await v.jobs.submit(v.submitArgs);
  const second = await v.jobs.submit({ ...v.submitArgs, recipe: 'build' });
  assert.deepEqual([first.job.status, second.job.status], ['queued', 'queued']);

  await v.supervisor.tick();
  assert.deepEqual(v.queued(), [`${v.did(first.job.job_id)}.json`], 'only the head is handed to the dispatcher');
  assert.equal((await v.row(first.job.job_id)).status, 'dispatched');
  assert.equal((await v.row(second.job.job_id)).status, 'queued');
  const spec = JSON.parse(readFileSync(join(v.root, 'spool', 'queue', `${v.did(first.job.job_id)}.json`), 'utf8'));
  assert.deepEqual(spec, { version: 1, id: v.did(first.job.job_id), job_id: first.job.job_id, recipe: 'test', worktree: v.wts[0], timeout_seconds: 900 });

  v.startUnit(first.job.job_id);
  await v.supervisor.tick();
  assert.equal((await v.row(first.job.job_id)).status, 'running');
  assert.deepEqual(v.queued(), [], 'the second waits while the first runs (concurrency 1)');
  assert.equal(v.supervisor.status().active.job_id, first.job.job_id);
  assert.equal(v.supervisor.status().queue_depth, 1);

  await v.finishUnit(first.job.job_id, SUCCESS);
  await v.supervisor.tick();
  const done = await v.row(first.job.job_id);
  assert.deepEqual([done.status, done.exit_code, done.summary], ['succeeded', 0, 'tests passed']);
  assert.deepEqual(v.queued(), [`${v.did(second.job.job_id)}.json`], 'then the next one, FIFO');
  assert.deepEqual(await v.kinds(first.job.job_id), ['submitted', 'dispatched', 'started', 'exit']);
  assert.deepEqual(v.supervisor.status().last_result.job_id, first.job.job_id);
  assert.ok(v.ledger.calls.some(c => c[0] === 'verify'), 'the ledger confirms the lease before dispatch');
});

test('AC-P4-07: a retried jobs_submit returns the same job and only one unit is ever handed off', async t => {
  const v = await vps(t);
  const args = { ...v.submitArgs, client_request_id: 'req-0001-abcdef' };
  const [a, b] = await Promise.all([v.jobs.submit(args), v.jobs.submit(args)]);
  const c = await v.jobs.submit(args);
  assert.equal(a.ok && b.ok && c.ok, true);
  assert.equal(a.job.job_id, b.job.job_id);
  assert.equal(a.job.job_id, c.job.job_id);
  assert.equal([a, b, c].filter(r => r.replayed).length, 2);
  const all = await v.rt.store().transaction(repo => repo.listJobs({ host: 'vps', limit: 100 }), { write: false });
  assert.equal(all.length, 1);
  await v.supervisor.tick();
  await v.supervisor.tick();
  assert.deepEqual(v.queued(), [`${v.did(a.job.job_id)}.json`]);
  // A retry after the job moved on still answers with that job, not a new one.
  v.startUnit(a.job.job_id);
  await v.supervisor.tick();
  const late = await v.jobs.submit(args);
  assert.deepEqual([late.job.job_id, late.job.status, late.replayed], [a.job.job_id, 'running', true]);
  const other = await v.jobs.submit({ ...args, client_request_id: 'req-0002-abcdef' });
  assert.notEqual(other.job.job_id, a.job.job_id);
});

test('AC-P4-17: admission defers on disk, memory or PSI, says why, and re-evaluates every 30 s', async t => {
  const v = await vps(t);
  const { job } = await v.jobs.submit(v.submitArgs);
  const status = async () => (await v.jobs.status({ job_id: job.job_id })).job;
  const cases = [
    [s => { s.disk.free_bytes = 39 * GIB; }, 'deferred_disk', 'free_disk_below_minimum'],
    [s => { s.memory.available_bytes = 3 * GIB; }, 'deferred_pressure', 'mem_available_below_minimum'],
    [s => { s.pressure.io.full.avg10 = 42; }, 'deferred_pressure', 'psi_io_full_avg10_above_maximum'],
    [s => { s.pressure.cpu.some.avg10 = 99; }, 'deferred_pressure', 'psi_cpu_some_avg10_above_maximum'],
    [s => { s.pressure = null; }, 'deferred_pressure', 'psi_unreadable'],
    [s => { s.disk = null; }, 'deferred_disk', 'disk_unreadable']
  ];
  for (const [mutate, reason, detail] of cases) {
    const s = HEALTHY(); mutate(s); v.reading.snapshot = s;
    v.clock.t += 31_000;
    await v.supervisor.tick();
    const j = await status();
    assert.deepEqual([j.status, j.status_reason], ['deferred', reason], detail);
    assert.equal(v.supervisor.status().admission.detail, detail);
    assert.deepEqual(v.queued(), []);
  }
  // Within 30 s nothing is re-evaluated, even if the host recovered.
  v.reading.snapshot = HEALTHY();
  v.clock.t += 5_000;
  await v.supervisor.tick();
  assert.equal((await status()).status, 'deferred');
  v.clock.t += 30_000;
  await v.supervisor.tick();
  const j = await status();
  assert.equal(j.status, 'dispatched');
  assert.equal(j.status_reason, undefined, 'the reason is cleared once admitted');
  const deferrals = (await v.jobs.events({ job_id: job.job_id })).events.filter(e => e.kind === 'deferred').map(e => e.detail.reason);
  assert.deepEqual(deferrals, ['deferred_disk', 'deferred_pressure', 'deferred_disk'], 'one event per change of reason');

  // Thresholds come from runner.json; the same snapshot is admitted or not.
  const strict = { ...DEFAULT_RUNNER_CONFIG.admission, min_free_disk_gib: 500 };
  assert.deepEqual(admit(HEALTHY(), strict), { ok: false, reason: 'deferred_disk', detail: 'free_disk_below_minimum' });
  assert.deepEqual(admit(HEALTHY(), { ...strict, min_free_disk_gib: 1, max_psi: {} }), { ok: true });
});

test('AC-P4-18: a job whose worktree plus output outgrows the budget is stopped as budget_exceeded', async t => {
  const v = await vps(t, { config: { disk_budget_gib: 1 } });
  const { job } = await v.jobs.submit(v.submitArgs);
  await v.supervisor.tick();
  v.startUnit(job.job_id);
  await v.supervisor.tick();
  assert.equal((await v.row(job.job_id)).status, 'running');
  assert.deepEqual(v.reading.usageCalls.at(-1), [v.wts[0], join(v.root, 'jobs', v.did(job.job_id), 'out')]);
  v.reading.usage = { bytes: 1.5 * GIB, partial: false };
  v.clock.t += 30_000;
  await v.supervisor.tick();
  assert.equal((await v.row(job.job_id)).status, 'running', 'du runs once a minute, not every tick');
  v.clock.t += 31_000;
  await v.supervisor.tick();
  const r = await v.row(job.job_id);
  assert.deepEqual([r.status, r.status_reason], ['budget_exceeded', 'disk_budget']);
  assert.deepEqual(v.cancels(), [v.did(job.job_id)], 'the dispatcher is asked to stop the unit');
  // systemd's verdict after the stop does not change it.
  await v.finishUnit(job.job_id, { service_result: 'success', exit_code: 'killed', exit_status: 'TERM' });
  await v.supervisor.tick();
  assert.equal((await v.row(job.job_id)).status, 'budget_exceeded');
  assert.deepEqual(await v.kinds(job.job_id), ['submitted', 'dispatched', 'started', 'budget_exceeded', 'stop_requested', 'exit']);
  const ev = (await v.jobs.events({ job_id: job.job_id })).events.find(e => e.kind === 'budget_exceeded');
  assert.deepEqual([ev.detail.used_bytes, ev.detail.budget_bytes], [1.5 * GIB, GIB]);
});

test('AC-P4-18 fails closed: du that times out or is partial, N times in a row, stops the job (verifier finding 1)', async t => {
  const v = await vps(t, { config: { disk_budget_gib: 1, max_unmeasured_readings: 3 } });
  const { job } = await v.jobs.submit(v.submitArgs);
  await v.supervisor.tick();
  v.startUnit(job.job_id);
  await v.supervisor.tick();
  assert.equal((await v.row(job.job_id)).status, 'running');
  // The job made part of its tree unreadable to memo-runner (du partial) then outran du (timeout, null).
  const readings = [{ bytes: 0.1 * GIB, partial: true }, null, { bytes: 0.2 * GIB, partial: true }];
  for (const [i, reading] of readings.entries()) {
    v.reading.usage = reading;
    v.clock.t += 61_000;
    await v.supervisor.tick();
    const r = await v.row(job.job_id);
    if (i < readings.length - 1) assert.equal(r.status, 'running', `reading ${i + 1} alone does not stop it`);
    else assert.deepEqual([r.status, r.status_reason], ['budget_exceeded', 'disk_unmeasurable']);
  }
  assert.deepEqual(v.cancels(), [v.did(job.job_id)], 'the dispatcher is asked to stop the unit');
  const kinds = await v.kinds(job.job_id);
  assert.equal(kinds.filter(k => k === 'disk_unmeasured').length, 2);

  // A complete reading in between resets the count; a partial reading already over the budget stops at once.
  const w = await vps(t, { config: { disk_budget_gib: 1, max_unmeasured_readings: 2 } });
  const second = (await w.jobs.submit(w.submitArgs)).job;
  await w.supervisor.tick();
  w.startUnit(second.job_id);
  await w.supervisor.tick();
  for (const reading of [null, { bytes: 0.1 * GIB, partial: false }, null]) {
    w.reading.usage = reading;
    w.clock.t += 61_000;
    await w.supervisor.tick();
  }
  assert.equal((await w.row(second.job_id)).status, 'running', 'unmeasured readings must be consecutive');
  w.reading.usage = { bytes: 1.2 * GIB, partial: true };
  w.clock.t += 61_000;
  await w.supervisor.tick();
  assert.deepEqual([(await w.row(second.job_id)).status, (await w.row(second.job_id)).status_reason], ['budget_exceeded', 'disk_budget']);
});

test('AC-P4-18 free-disk floor: a running job is stopped as soon as free disk falls below the floor (verifier finding 1)', async t => {
  const v = await vps(t, { config: { min_free_disk_running_gib: 20 } });
  const { job } = await v.jobs.submit(v.submitArgs);
  await v.supervisor.tick();
  v.startUnit(job.job_id);
  await v.supervisor.tick();
  // du says the job is tiny (it hid its tree), but the shared disk is filling up.
  v.reading.usage = { bytes: 0, partial: false };
  v.reading.snapshot = { ...HEALTHY(), disk: { path: '/', free_bytes: 25 * GIB, total_bytes: 300 * GIB } };
  v.clock.t += 5_000;
  await v.supervisor.tick();
  assert.equal((await v.row(job.job_id)).status, 'running');
  v.reading.snapshot = { ...HEALTHY(), disk: { path: '/', free_bytes: 19 * GIB, total_bytes: 300 * GIB } };
  v.clock.t += 5_000;
  await v.supervisor.tick();
  const r = await v.row(job.job_id);
  assert.deepEqual([r.status, r.status_reason], ['budget_exceeded', 'disk_floor'], 'checked every tick, not only at the du interval');
  assert.deepEqual(v.cancels(), [v.did(job.job_id)]);
  assert.equal(v.supervisor.status().disk_free.floor_gib, 20);
  // runner.json in the lab-infra shape sets the floor in bytes.
  const dir = await mkdtemp(join(tmpdir(), 'memo-floor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'runner.json'), JSON.stringify({ budgets: { disk_bytes: 2 * GIB, du_interval_sec: 60, min_free_disk_running_bytes: 30 * GIB } }));
  const cfg = loadRunnerConfig(join(dir, 'runner.json'));
  assert.deepEqual([cfg.min_free_disk_running_gib, cfg.max_unmeasured_readings, cfg.errors], [30, 3, []]);
});

test('runner.json recipes and timeout ceiling reach jobs_submit (verifier finding 2)', async t => {
  const v = await vps(t);
  const dir = await mkdtemp(join(tmpdir(), 'memo-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The lab-infra shape: top-level recipe names, job_unit ceiling, and the dispatch section it renders from the same vars.
  await writeFile(join(dir, 'runner.json'), JSON.stringify({ recipes: ['test', 'lint'], job_unit: { timeout_max_sec: 1200 },
    dispatch: { max_timeout_seconds: 1800, recipes: ['test', 'build', 'lint'] } }));
  const cfg = loadRunnerConfig(join(dir, 'runner.json'));
  assert.deepEqual([cfg.recipes, cfg.max_timeout_seconds, cfg.errors], [['test', 'lint'], 1200, []], 'the narrowest source wins');
  const executor = createSystemdExecutor({ root: v.root, systemctl: v.systemctl.path, statusOwnerUid: UID,
    policy: { recipes: cfg.recipes, max_timeout_seconds: cfg.max_timeout_seconds } });
  const jobs = createJobService(v.rt, { executor });
  const build = await jobs.submit({ ...v.submitArgs, recipe: 'build' });
  assert.equal(build.error, 'recipe_not_allowed', JSON.stringify(build));
  const long = await jobs.submit({ ...v.submitArgs, timeout_seconds: 1201 });
  assert.equal(long.error, 'invalid_input', JSON.stringify(long));
  assert.match(long.detail, /maximum \(1200\)/);
  const ok = await jobs.submit({ ...v.submitArgs, timeout_seconds: 1200 });
  assert.equal(ok.job?.status, 'queued', JSON.stringify(ok));
  // Defaults: every recipe, the dispatcher's hard ceiling; malformed values narrow to nothing.
  const none = loadRunnerConfig('/nonexistent/runner.json');
  assert.deepEqual([none.recipes, none.max_timeout_seconds], [null, 3600]);
  await writeFile(join(dir, 'bad.json'), JSON.stringify({ recipes: 'test', job_unit: { timeout_max_sec: 7200 } }));
  const bad = loadRunnerConfig(join(dir, 'bad.json'));
  assert.deepEqual([bad.recipes, bad.max_timeout_seconds, bad.errors], [[], 3600, ['recipes', 'job_unit.timeout_max_sec']]);
});

test('AC-P4-20: cancel reaches the unit through the dispatcher, even when it came from task_release', async t => {
  const v = await vps(t);
  const { job } = await v.jobs.submit(v.submitArgs);
  await v.supervisor.tick();
  v.startUnit(job.job_id);
  await v.supervisor.tick();
  // A Coordinator path (task_release, workspace_close) cancels in the store only: the sweep stops the unit.
  const { cancelActiveJobs } = await import('../server/runners/jobs.mjs');
  await v.rt.store().transaction((repo, at = v.clock.t) => cancelActiveJobs(repo, { workspaceId: v.workspaceId, issueRef: ISSUE }, at, OWNER.id));
  assert.deepEqual(v.cancels(), []);
  await v.supervisor.tick();
  assert.deepEqual(v.cancels(), [v.did(job.job_id)]);
  // Still active a minute later (the dispatcher missed it): asked again.
  await rm(join(v.root, 'spool', 'cancel', v.did(job.job_id)));
  v.clock.t += 61_000;
  await v.supervisor.tick();
  assert.deepEqual(v.cancels(), [v.did(job.job_id)]);
  const stops = (await v.jobs.events({ job_id: job.job_id })).events.filter(e => e.kind === 'stop_requested');
  assert.deepEqual(stops.map(e => e.detail.retry), [false, true]);
  // Once the unit is gone without a status file, the follow-up ends.
  v.systemctl.set(`memo-job@${v.did(job.job_id)}.service`, 'inactive');
  v.clock.t += 61_000;
  await v.supervisor.tick();
  v.clock.t += 31_000;
  await v.supervisor.tick();
  assert.equal((await v.row(job.job_id)).status, 'cancelled');
  assert.ok((await v.kinds(job.job_id)).includes('no_unit'));
});

test('the next job waits until a stopped unit has really ended (the dispatcher would refuse it as host_busy)', async t => {
  const v = await vps(t, { worktrees: 2 });
  const a = (await v.jobs.submit(v.submitArgs)).job;
  const b = (await v.jobs.submit({ ...v.submitArgs, worktree_id: 'wt_1' })).job;
  await v.supervisor.tick();
  v.startUnit(a.job_id);
  await v.supervisor.tick();
  await v.jobs.cancel({ job_id: a.job_id });
  v.systemctl.set(`memo-job@${v.did(a.job_id)}.service`, 'deactivating');
  await v.supervisor.tick();
  assert.equal((await v.row(b.job_id)).status, 'queued', 'a is still stopping');
  assert.deepEqual(v.queued(), []);
  await v.finishUnit(a.job_id, { service_result: 'success', exit_code: 'killed', exit_status: 'TERM', reason: 'cancelled' });
  await v.supervisor.tick();
  assert.equal((await v.row(a.job_id)).status, 'cancelled');
  assert.deepEqual(v.queued(), [`${v.did(b.job_id)}.json`]);
});

test('a job settled while its unit is still deactivating holds the next dispatch until systemd says inactive (verifier finding 6)', async t => {
  const v = await vps(t, { worktrees: 2 });
  const a = (await v.jobs.submit(v.submitArgs)).job;
  const b = (await v.jobs.submit({ ...v.submitArgs, worktree_id: 'wt_1' })).job;
  await v.supervisor.tick();
  v.startUnit(a.job_id);
  await v.supervisor.tick();
  // record-result wrote status.json; the unit is still deactivating (ExecStopPost, cgroup teardown).
  await v.finishUnit(a.job_id, SUCCESS);
  v.systemctl.set(`memo-job@${v.did(a.job_id)}.service`, 'deactivating');
  await v.supervisor.tick();
  assert.equal((await v.row(a.job_id)).status, 'succeeded', 'the result is recorded at once');
  assert.equal((await v.row(b.job_id)).status, 'queued', 'but the dispatcher would refuse b as host_busy now');
  assert.deepEqual(v.queued(), []);
  assert.equal(v.supervisor.status().waiting_for_unit.state, 'deactivating');
  v.systemctl.set(`memo-job@${v.did(a.job_id)}.service`, 'inactive');
  await v.supervisor.tick();
  assert.deepEqual(v.queued(), [`${v.did(b.job_id)}.json`]);
  assert.equal((await v.row(b.job_id)).status, 'dispatched');
  assert.equal(v.supervisor.status().waiting_for_unit, null);
});

test('AC-P4-08: reconcile on start follows a running unit, settles a finished one, and reports a vanished one interrupted', async t => {
  const v = await vps(t, { worktrees: 1 });
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await v.jobs.submit(v.submitArgs)).job.job_id);
  // Simulate what a previous runner left behind: four started jobs.
  await v.rt.store().transaction(repo => {
    for (const id of ids) {
      repo.updateJob(id, { status: 'running', started_at: v.clock.t }, 'queued');
      repo.appendJobEvent({ job_id: id, at: v.clock.t, kind: 'dispatched', detail: '{}' });
    }
  });
  v.systemctl.set(`memo-job@${v.did(ids[0])}.service`, 'active');
  await v.finishUnit(ids[1], SUCCESS);
  // Killed while the runner was down: root's ended_at is before the new supervisor started.
  await v.finishUnit(ids[2], { service_result: 'signal', exit_code: 'killed', exit_status: 'KILL', ended_at: new Date(v.clock.t).toISOString() });
  // ids[3]: unit inactive and no status file (lost across a reboot)
  v.clock.t += 60_000; // the runner restarts a minute later
  const fresh = createSupervisor(v.rt, { executor: v.executor, resources: { snapshot: () => HEALTHY(), usage: async () => ({ bytes: 0, partial: false }) },
    config: loadRunnerConfig('/nonexistent') });
  await fresh.reconcileOnStart();
  const statuses = await Promise.all(ids.map(async id => (await v.row(id)).status));
  assert.deepEqual(statuses, ['running', 'succeeded', 'interrupted', 'interrupted']);
  assert.equal((await v.row(ids[2])).status_reason, 'signal_KILL');
  assert.equal((await v.row(ids[3])).status_reason, 'no_unit_status');
  // A job a client cancels while the runner is down is still stopped on start.
  assert.deepEqual(v.cancels(), []);
});

test('a job that kills itself (SIGKILL, or SIGTERM which systemd counts clean) ends failed, not interrupted (verifier finding 3)', async t => {
  const v = await vps(t, { worktrees: 2 });
  const a = (await v.jobs.submit(v.submitArgs)).job;
  await v.supervisor.tick();
  v.startUnit(a.job_id);
  await v.supervisor.tick();
  v.clock.t += 10_000;
  await v.finishUnit(a.job_id, { service_result: 'signal', exit_code: 'killed', exit_status: 'KILL', reason: 'signal',
    ended_at: new Date(v.clock.t).toISOString() });
  await v.supervisor.tick();
  const ra = await v.row(a.job_id);
  assert.deepEqual([ra.status, ra.status_reason], ['failed', 'signal_KILL']);
  const b = (await v.jobs.submit({ ...v.submitArgs, worktree_id: 'wt_1' })).job;
  await v.supervisor.tick();
  v.startUnit(b.job_id);
  await v.supervisor.tick();
  v.clock.t += 10_000;
  await v.finishUnit(b.job_id, { service_result: 'success', exit_code: 'killed', exit_status: 'TERM', reason: 'stopped_by_signal',
    ended_at: new Date(v.clock.t).toISOString() });
  await v.supervisor.tick();
  const rb = await v.row(b.job_id);
  assert.deepEqual([rb.status, rb.status_reason], ['failed', 'signal_TERM']);
});

test('a crash between the spool write and the compare-and-set never starts a unit twice', async t => {
  const v = await vps(t);
  const { job } = await v.jobs.submit(v.submitArgs);
  // The spool file was written and the unit ran to completion, but the store still says queued.
  await v.executor.launch({ job: await v.row(job.job_id), worktreePath: v.wts[0] });
  v.startUnit(job.job_id);
  await v.finishUnit(job.job_id, SUCCESS);
  await v.supervisor.tick();
  assert.deepEqual(v.queued(), [], 'not handed to the dispatcher again');
  assert.equal((await v.row(job.job_id)).status, 'succeeded');
  const dispatched = (await v.jobs.events({ job_id: job.job_id })).events.find(e => e.kind === 'dispatched');
  assert.equal(dispatched.detail.recovered, true);
});

test('safety net behind RuntimeMaxSec: a unit still active well past its timeout is timed out and stopped', async t => {
  const v = await vps(t);
  const { job } = await v.jobs.submit({ ...v.submitArgs, timeout_seconds: 60 });
  await v.supervisor.tick();
  v.startUnit(job.job_id);
  await v.supervisor.tick();
  // The deadline is timeout + install bound (the recipe's RuntimeMaxSec= starts after the
  // install unit) + margin: 60 s + 600 s + 60 s.
  v.clock.t += 100_000 + INSTALL_TIMEOUT_SECONDS * 1000;
  await v.supervisor.tick();
  assert.equal((await v.row(job.job_id)).status, 'running', 'within timeout plus install plus margin systemd is trusted to act');
  v.clock.t += 30_000;
  await v.supervisor.tick();
  const r = await v.row(job.job_id);
  assert.deepEqual([r.status, r.status_reason], ['timed_out', 'deadline_exceeded']);
  assert.deepEqual(v.cancels(), [v.did(job.job_id)]);
  const { startSupervisorFromEnv } = await import('../server/runners/supervisor.mjs');
  assert.equal(await startSupervisorFromEnv(v.rt, {}), null, 'no supervisor on a host with the local executor');
});

test('dispatcher stalls and refusals are visible, never silent', async t => {
  const v = await vps(t);
  const { job } = await v.jobs.submit(v.submitArgs);
  await v.supervisor.tick();
  v.clock.t += 121_000;
  await v.supervisor.tick();
  assert.equal((await v.row(job.job_id)).status, 'dispatched', 'a stalled dispatcher does not fail the job');
  assert.equal(v.supervisor.status().dispatcher.stalled, true);
  assert.ok((await v.kinds(job.job_id)).includes('dispatch_stalled'));
  // The dispatcher took the file but started nothing and wrote nothing: refused.
  await rm(join(v.root, 'spool', 'queue', `${v.did(job.job_id)}.json`));
  await v.supervisor.tick();
  v.clock.t += 61_000;
  await v.supervisor.tick();
  const r = await v.row(job.job_id);
  assert.deepEqual([r.status, r.status_reason], ['failed', 'dispatch_refused']);
});

test('resources: PSI, meminfo and du parsing; runner.json thresholds with safe fallbacks', async t => {
  const psi = parsePressure('some avg10=1.50 avg60=0.80 avg300=0.20 total=12345\nfull avg10=0.96 avg60=0.40 avg300=0.10 total=999\n');
  assert.deepEqual(psi, { some: { avg10: 1.5, avg60: 0.8, avg300: 0.2, total: 12345 }, full: { avg10: 0.96, avg60: 0.4, avg300: 0.1, total: 999 } });
  assert.equal(parsePressure('garbage'), null);
  assert.deepEqual(parseMeminfo('MemTotal:       16000000 kB\nMemAvailable:    7000000 kB\nSwapTotal: 4 kB\nSwapFree: 1 kB\n'),
    { available_bytes: 7000000 * 1024, total_bytes: 16000000 * 1024, swap_total_bytes: 4096, swap_free_bytes: 1024 });
  assert.equal(parseMeminfo('MemTotal: 1 kB\n'), null);
  assert.equal(parseDu('1024\t/a\n2048\t/b\n'), 3072 * 1024);
  assert.equal(parseDu(''), null);

  const proc = await mkdtemp(join(tmpdir(), 'memo-proc-'));
  t.after(() => rm(proc, { recursive: true, force: true }));
  await mkdir(join(proc, 'pressure'));
  for (const r of ['cpu', 'memory', 'io']) await writeFile(join(proc, 'pressure', r), 'some avg10=3.00 avg60=0 avg300=0 total=1\nfull avg10=0.50 avg60=0 avg300=0 total=1\n');
  await writeFile(join(proc, 'meminfo'), 'MemTotal: 8000000 kB\nMemAvailable: 6000000 kB\n');
  const reader = createResourceReader({ procRoot: proc, statfs: () => ({ bavail: 50 * 1024 ** 2, bsize: 1024, blocks: 100 * 1024 ** 2 }),
    run: async (cmd, args) => ({ code: 0, stdout: `${args.length}\n` }) });
  const snap = reader.snapshot({ diskPath: proc });
  assert.equal(snap.pressure.io.full.avg10, 0.5);
  assert.equal(snap.memory.available_bytes, 6000000 * 1024);
  assert.equal(snap.disk.free_bytes, 50 * GIB);
  assert.deepEqual(admit(snap, { min_free_disk_gib: 40, min_mem_available_gib: 4, max_psi: { io_full_avg10: 10 } }), { ok: true });
  // du: fixed flags, existing absolute paths only, after `--`.
  const seen = [];
  const du = createResourceReader({ run: async (cmd, args) => { seen.push([cmd, args]); return { code: 1, stdout: '10\t/x\n' }; } });
  assert.deepEqual(await du.usage([proc, 'relative', join(proc, 'missing')]), { bytes: 10240, partial: true });
  assert.deepEqual(seen, [['/usr/bin/du', ['-s', '-k', '-x', '-P', '--', proc]]]);
  assert.equal(await createResourceReader({ run: async () => ({ timedOut: true }) }).usage([proc]), null);

  const cfgFile = join(proc, 'runner.json');
  await writeFile(cfgFile, JSON.stringify({ admission: { min_free_disk_gib: 50, max_psi: { io_full_avg10: 'high', cpu_some_avg10: 70 } },
    disk_budget_gib: -1, lease_ttl_seconds: 900, recipes: ['test'], unit: { MemoryMax: '3G' } }));
  const cfg = loadRunnerConfig(cfgFile);
  assert.equal(cfg.source, 'file');
  assert.equal(cfg.admission.min_free_disk_gib, 50);
  assert.deepEqual(cfg.admission.max_psi, { cpu_some_avg10: 70, io_full_avg10: 10 });
  assert.equal(cfg.disk_budget_gib, 20, 'an invalid value falls back to the default');
  assert.equal(cfg.lease_ttl_seconds, 900);
  assert.deepEqual(cfg.errors.sort(), ['admission.max_psi.io_full_avg10', 'disk_budget_gib']);
  await writeFile(cfgFile, '{oops');
  assert.deepEqual(loadRunnerConfig(cfgFile).errors, ['runner_config_unreadable']);
  assert.equal(loadRunnerConfig('/nonexistent/runner.json').source, 'defaults');
});

test('TODO-P4-16: one concurrency source, runner info, and host_resources with the supervisor view', async t => {
  // The Mac keeps MEMO_BRIDGE_MAX_JOBS (default 2); the VPS executor is always 1.
  assert.equal(jobConcurrencyLimit({}), 2);
  assert.equal(jobConcurrencyLimit({ MEMO_BRIDGE_MAX_JOBS: '3' }), 3);
  assert.equal(jobConcurrencyLimit({ MEMO_BRIDGE_JOB_CONCURRENCY: '5' }), 2, 'the other name is not read');
  assert.equal(maxJobsFromEnv({ MEMO_BRIDGE_MAX_JOBS: '4' }), 4, 'jobs.mjs enforces the same number');
  if (process.platform === 'linux') assert.equal(jobConcurrencyLimit({ MEMO_BRIDGE_JOB_EXECUTOR: 'systemd', MEMO_BRIDGE_MAX_JOBS: '4' }), 1);
  const info = runnerInfo({ env: {}, ops: ['jobs_submit', 'job_status', 'worktree_create', 'task_claim', 'host_resources', 'bridge_info'] });
  assert.deepEqual(info.ops, ['host_resources', 'job_status', 'jobs_submit', 'worktree_create']);
  assert.equal(info.executor, 'local');
  assert.ok(info.job_statuses.includes('deferred') && info.active_job_statuses.includes('dispatched'));
  assert.equal(runnerInfo({ env: { MEMO_BRIDGE_JOB_EXECUTOR: 'nope' } }).executor_error, 'invalid_configuration');

  const v = await vps(t);
  await v.jobs.submit(v.submitArgs);
  await v.supervisor.start();
  assert.equal(runnerStatus().queue_depth, 0);
  assert.equal(runnerStatus().active.status, 'dispatched');
  const linux = { platform: () => 'linux', arch: () => 'x64', release: () => '6.12', hostname: () => 'lab', loadavg: () => [1, 1, 1],
    cpus: () => new Array(8).fill({}), freemem: () => 2 * GIB, totalmem: () => 16 * GIB };
  const reader = { pressure: () => HEALTHY().pressure, meminfo: () => ({ available_bytes: 7 * GIB, swap_total_bytes: 4 * GIB, swap_free_bytes: GIB }) };
  const hosts = createHostService({ run: async () => ({ missing: true }), os: linux, env: {}, resourceReader: reader });
  const r = await hosts.resources('vps', { localHost: 'vps', stateDir: v.base, projectsRoot: v.base, jobs: { running: 0, queued: 0 } });
  assert.deepEqual(r.pressure.avg10_percent, { cpu_some: 2, memory_some: 0, memory_full: 0, io_some: 1, io_full: 0.5 });
  assert.equal(r.memory.available_bytes, 7 * GIB);
  assert.equal(r.runner.executor, 'systemd');
  assert.equal(r.runner.active.unit, `memo-job@${v.did(r.runner.active.job_id)}.service`);
  assert.equal(r.runner.admission.ok, true);
  await v.supervisor.stop();
  assert.equal(runnerStatus(), null, 'stopping the supervisor removes its view');
  const mac = createHostService({ run: async () => ({ missing: true }), os: { ...linux, platform: () => 'darwin' }, env: {} });
  const m = await mac.resources('mac', { localHost: 'mac', stateDir: v.base, projectsRoot: v.base, jobs: null });
  assert.equal('pressure' in m || 'runner' in m || 'available_bytes' in m.memory, false, 'a Mac answer keeps its Phase 3 shape');
  assert.ok(!existsSync(join(v.root, 'nothing')));
});
