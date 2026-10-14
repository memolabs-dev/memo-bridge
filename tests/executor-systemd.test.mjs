// Systemd executor (Phase 4, TODO-P4-07): spool hand-off, status from root's status.json only,
// read-only `systemctl show` through a fake systemctl, and the VPS side of jobs_submit /
// job_cancel / job_results. Every test works in its own temporary tree; nothing here talks to
// systemd, the VPS or the user's state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../server/runtime.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { createJobService } from '../server/runners/jobs.mjs';
import { createLocalExecutor } from '../server/runners/executor-local.mjs';
import { assertExecutor, executorKindFromEnv } from '../server/runners/executor.mjs';
import { DISPATCH_ID_RE, SERVICE_RESULTS, createSystemdExecutor, dispatchIdFor, parseShowOutput, readStatusFile, spoolSpec,
  statusFromResult, unitFor } from '../server/runners/executor-systemd.mjs';

const OWNER = makePrincipal('local:owner', Object.values(CAPABILITIES));
const ISSUE = 'memolabs-dev/drop#7';
const UID = process.getuid();
const SHOW_PROPS = '--property=LoadState,ActiveState,SubState,Result';

const stubLedger = () => {
  const ok = async () => ({ ok: true, receipt: { state: 'claimed', fence_sha: 'f'.repeat(40) } });
  return { status: ok, claim: ok, verify: ok, heartbeat: ok, release: ok };
};

// A fake /usr/bin/systemctl: answers `show` from units.json next to it and logs its argv.
// execSystemctl passes a fixed environment, so the fake finds its files from its own path.
async function fakeSystemctl(dir) {
  const bin = join(dir, 'systemctl');
  await writeFile(join(dir, 'units.json'), '{}');
  await writeFile(bin, `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const here = path.dirname(fs.realpathSync(process.argv[1]));
fs.appendFileSync(path.join(here, 'calls.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
const units = JSON.parse(fs.readFileSync(path.join(here, 'units.json'), 'utf8'));
if (units.__fail) process.exit(1);
const unit = process.argv[process.argv.length - 1];
const u = units[unit] || {};
process.stdout.write(['LoadState=' + (u.LoadState || 'loaded'), 'ActiveState=' + (u.ActiveState || 'inactive'),
  'SubState=' + (u.SubState || 'dead'), 'Result=' + (u.Result || 'success')].join('\\n') + '\\n');
`);
  chmodSync(bin, 0o755);
  return {
    path: bin,
    set(unit, state) {
      const units = JSON.parse(readFileSync(join(dir, 'units.json'), 'utf8'));
      units[unit] = state;
      writeFileSync(join(dir, 'units.json'), JSON.stringify(units));
    },
    fail(on = true) { writeFileSync(join(dir, 'units.json'), JSON.stringify({ __fail: on })); },
    calls: () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [])
  };
}

async function runnerTree(t) {
  const base = await mkdtemp(join(tmpdir(), 'memo-sd-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'runner');
  for (const d of ['spool/queue', 'spool/cancel', 'jobs', 'worktrees']) await mkdir(join(root, d), { recursive: true, mode: 0o700 });
  await mkdir(join(base, 'bin'));
  const systemctl = await fakeSystemctl(join(base, 'bin'));
  const executor = createSystemdExecutor({ root, systemctl: systemctl.path, statusOwnerUid: UID, limits: { slice: 'memo-dev.slice', disk_budget_gib: 20 } });
  return { base, root, systemctl, executor };
}

function writeStatus(root, did, doc, mode = 0o640) {
  const dir = join(root, 'jobs', did);
  const path = join(dir, 'status.json');
  writeFileSync(path, typeof doc === 'string' ? doc : JSON.stringify(doc), { mode });
  chmodSync(path, mode);
  return path;
}
async function jobDir(root, did, log = null) {
  await mkdir(join(root, 'jobs', did, 'out'), { recursive: true });
  if (log !== null) await writeFile(join(root, 'jobs', did, 'out', 'job.log'), log);
}

// ---------------------------------------------------------------------------------------

test('executor selection: local by default, systemd only on Linux, anything else refused', () => {
  assert.deepEqual(executorKindFromEnv({}, 'darwin'), { ok: true, kind: 'local' });
  assert.deepEqual(executorKindFromEnv({ MEMO_BRIDGE_JOB_EXECUTOR: 'local' }, 'linux'), { ok: true, kind: 'local' });
  assert.deepEqual(executorKindFromEnv({ MEMO_BRIDGE_JOB_EXECUTOR: 'systemd' }, 'linux'), { ok: true, kind: 'systemd' });
  assert.equal(executorKindFromEnv({ MEMO_BRIDGE_JOB_EXECUTOR: 'systemd' }, 'darwin').ok, false);
  assert.equal(executorKindFromEnv({ MEMO_BRIDGE_JOB_EXECUTOR: 'docker' }, 'linux').error, 'invalid_configuration');
  // Both executors expose the same seam.
  assertExecutor(createLocalExecutor({ runnerPath: '/nonexistent' }));
  assertExecutor(createSystemdExecutor({ root: '/nonexistent' }));
});

test('dispatch ids fit the dispatcher pattern and the unit name; job ids do not', () => {
  const jobId = `job_${randomBytes(12).toString('base64url')}`;
  const did = dispatchIdFor(jobId);
  assert.match(did, DISPATCH_ID_RE);
  assert.equal(did, dispatchIdFor(jobId), 'deterministic: a re-dispatch writes the same name');
  assert.notEqual(did, dispatchIdFor(`${jobId}x`));
  assert.equal(unitFor(did), `memo-job@${did}.service`);
  assert.doesNotMatch('job_ABC_def-0123456789', DISPATCH_ID_RE);
  assert.throws(() => unitFor('../x'), /invalid_dispatch_id/);
  // The spool spec carries exactly these keys: no argv, no unit properties, no environment.
  assert.deepEqual(Object.keys(spoolSpec({ dispatchId: did, jobId, recipe: 'test', worktree: '/w', timeoutSeconds: 60 })).sort(),
    ['id', 'job_id', 'recipe', 'timeout_seconds', 'version', 'worktree']);
});

test('launch writes the spool file atomically; stop withdraws it and writes the cancel file', async t => {
  const { root, executor } = await runnerTree(t);
  const job = { id: `job_${'a'.repeat(16)}`, recipe: 'test', timeout_ms: 90_000, unit: unitFor(dispatchIdFor(`job_${'a'.repeat(16)}`)) };
  const did = dispatchIdFor(job.id);
  const launched = await executor.launch({ job, worktreePath: join(root, 'worktrees', 'wt') });
  assert.deepEqual(launched, { ok: true, unit: `memo-job@${did}.service`, dispatch_id: did });
  assert.deepEqual(readdirSync(join(root, 'spool', 'queue')), [`${did}.json`], 'no temporary file left behind');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'spool', 'queue', `${did}.json`), 'utf8')),
    { version: 1, id: did, job_id: job.id, recipe: 'test', worktree: join(root, 'worktrees', 'wt'), timeout_seconds: 90 });
  assert.equal(executor.pendingDispatch(job), true);
  // Idempotent: the same job writes the same file again.
  await executor.launch({ job, worktreePath: join(root, 'worktrees', 'wt') });
  assert.equal(readdirSync(join(root, 'spool', 'queue')).length, 1);

  assert.deepEqual(executor.stop(job), { ok: true, withdrawn: true });
  assert.deepEqual(readdirSync(join(root, 'spool', 'queue')), []);
  assert.deepEqual(readdirSync(join(root, 'spool', 'cancel')), [did]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'spool', 'cancel', did), 'utf8')), { version: 1, id: did, reason: 'cancelled' });
  // The reason the dispatcher hands to record-result: budget_exceeded ends the job as such.
  executor.stop(job, { reason: 'disk_budget' });
  assert.equal(JSON.parse(readFileSync(join(root, 'spool', 'cancel', did), 'utf8')).reason, 'budget_exceeded');
  executor.stop(job, { reason: 'claim_released' });
  assert.equal(JSON.parse(readFileSync(join(root, 'spool', 'cancel', did), 'utf8')).reason, 'cancelled', 'only reasons the dispatcher accepts');
  executor.stop(job, { reason: 'stale_lease' });
  assert.equal(JSON.parse(readFileSync(join(root, 'spool', 'cancel', did), 'utf8')).reason, 'stale_lease');
  assert.deepEqual(executor.stop(job), { ok: true, withdrawn: false }, 'stopping again is harmless');

  const gone = createSystemdExecutor({ root: join(root, 'missing'), statusOwnerUid: UID });
  assert.deepEqual(gone.sandbox(), { ok: false, error: 'runner_unavailable', detail: 'spool' });
  assert.equal((await gone.launch({ job, worktreePath: '/w' })).error, 'spool_unavailable');
  assert.deepEqual(executor.sandbox(), { ok: true, mode: 'systemd' });
});

test('status.json: only a regular file of the expected owner, not group/world writable, well formed, same id', async t => {
  const { root } = await runnerTree(t);
  const did = dispatchIdFor('job_status_file_1');
  await jobDir(root, did);
  const path = join(root, 'jobs', did, 'status.json');
  const good = { version: 1, id: did, service_result: 'exit-code', exit_code: 'exited', exit_status: '3', ended_at: '2026-10-14T10:00:00Z' };
  assert.deepEqual(readStatusFile(path, did, { ownerUid: UID }), { ok: false, error: 'absent' });
  writeStatus(root, did, good);
  const r = readStatusFile(path, did, { ownerUid: UID });
  assert.equal(r.ok, true);
  assert.deepEqual([r.result.service_result, r.result.exit_code, r.result.exit_status], ['exit-code', 'exited', '3']);
  assert.equal(r.result.ended_at, Date.parse('2026-10-14T10:00:00Z'));

  const reject = (doc, detail, opts = {}) => {
    writeStatus(root, did, doc, opts.mode);
    assert.deepEqual(readStatusFile(path, did, { ownerUid: opts.owner ?? UID }), { ok: false, error: 'untrusted', detail }, detail);
  };
  // The shape the dispatcher writes for a refusal (deploy/memo-runner-dispatch write_refusal_status).
  writeStatus(root, did, { version: 1, id: did, job_id: 'job_x', unit: null, service_result: 'dispatch_refused', exit_code: null,
    exit_status: null, status: 'failed', reason: 'argv_not_allowed', cancel_reason: null, invocation_id: null, started_at: null,
    ended_at: '2026-10-14T10:00:00.000Z' });
  const refused = readStatusFile(path, did, { ownerUid: UID });
  assert.deepEqual([refused.ok, refused.result.service_result, refused.result.reason], [true, 'dispatch_refused', 'argv_not_allowed']);
  reject(good, 'owner', { owner: UID + 1 });
  reject(good, 'mode', { mode: 0o666 });
  reject(good, 'mode', { mode: 0o660 });
  reject('{not json', 'json');
  reject('[]', 'json');
  reject({ ...good, version: 2 }, 'version');
  reject({ ...good, id: dispatchIdFor('another') }, 'id');
  reject({ ...good, service_result: 'pwned' }, 'service_result');
  reject({ ...good, exit_code: 'maybe' }, 'exit_code');
  reject({ ...good, exit_status: '0; rm -rf' }, 'exit_status');
  reject({ ...good, ended_at: 'yesterday' }, 'timestamps');
  reject(JSON.stringify({ ...good, pad: 'x'.repeat(5000) }), 'size');
  // A symlink planted at status.json is never followed.
  await rm(path);
  writeFileSync(join(root, 'elsewhere.json'), JSON.stringify(good), { mode: 0o640 });
  symlinkSync(join(root, 'elsewhere.json'), path);
  assert.deepEqual(readStatusFile(path, did, { ownerUid: UID }), { ok: false, error: 'untrusted', detail: 'not_a_regular_file' });
});

test('systemd result variables map to job statuses (systemd.exec(5), v257)', () => {
  const map = (service_result, exit_code = null, exit_status = null) => statusFromResult({ service_result, exit_code, exit_status });
  assert.deepEqual(map('success', 'exited', '0'), { status: 'succeeded', exit_code: 0 });
  assert.deepEqual(map('success', 'killed', 'TERM'), { status: 'interrupted', exit_code: null, reason: 'unit_stopped' });
  assert.deepEqual(map('exit-code', 'exited', '3'), { status: 'failed', exit_code: 3 });
  assert.deepEqual(map('timeout', 'killed', 'TERM'), { status: 'timed_out', exit_code: null, reason: 'runtime_max' });
  assert.deepEqual(map('oom-kill', 'killed', 'KILL'), { status: 'oom', exit_code: null, reason: 'oom_kill' });
  assert.deepEqual(map('signal', 'killed', 'KILL'), { status: 'interrupted', exit_code: null, reason: 'signal_KILL' });
  assert.deepEqual(map('signal', 'killed', 'SEGV'), { status: 'failed', exit_code: null, reason: 'signal_SEGV' });
  assert.deepEqual(map('core-dump', 'dumped', 'ABRT'), { status: 'failed', exit_code: null, reason: 'core_dump_ABRT' });
  assert.deepEqual(map('dispatch_refused'), { status: 'failed', exit_code: null, reason: 'dispatch_refused' });
  assert.deepEqual(statusFromResult({ service_result: 'dispatch_refused', reason: 'cancelled_before_start' }),
    { status: 'cancelled', exit_code: null, reason: 'cancelled_before_start' });
  for (const r of SERVICE_RESULTS) assert.ok(map(r, 'exited', '1').status, r);
  assert.equal(map('start-limit-hit').reason, 'unit_start-limit-hit');
});

test('systemctl show: fixed argv, read-only, parsed; failures are reported, never guessed', async t => {
  const { systemctl, executor } = await runnerTree(t);
  const job = { id: 'job_show_000000000000', unit: unitFor(dispatchIdFor('job_show_000000000000')) };
  assert.deepEqual(parseShowOutput('ActiveState=active\nSubState=running\nnoise\nActiveState=failed\n'), { ActiveState: 'active', SubState: 'running' });
  let s = await executor.show(job);
  assert.deepEqual(s, { ok: true, unit: job.unit, load: 'loaded', active_state: 'inactive', sub_state: 'dead', result: 'success', active: false });
  systemctl.set(job.unit, { ActiveState: 'active', SubState: 'running' });
  assert.equal(await executor.alive(job), true);
  systemctl.set(job.unit, { ActiveState: 'deactivating', SubState: 'stop-sigterm' });
  assert.equal((await executor.show(job)).active, true, 'still stopping counts as active');
  assert.deepEqual(systemctl.calls()[0], ['show', '--no-pager', SHOW_PROPS, job.unit]);
  assert.ok(systemctl.calls().every(argv => argv[0] === 'show'), 'only ever show');
  systemctl.fail();
  assert.deepEqual(await executor.show(job), { ok: false, error: 'systemctl_failed' });
  assert.equal(await executor.alive(job), null);
  const missing = createSystemdExecutor({ root: '/nonexistent', systemctl: '/nonexistent/systemctl' });
  assert.deepEqual(await missing.show(job), { ok: false, error: 'systemctl_missing' });
  assert.deepEqual(await executor.show({ id: 'x', unit: 'sshd.service' }), { ok: false, error: 'invalid_unit' });
});

test('job log: bounded tail, never through a symlink planted by the job', async t => {
  const { root, executor } = await runnerTree(t);
  const job = { id: 'job_log_0000000000000', unit: unitFor(dispatchIdFor('job_log_0000000000000')) };
  const did = dispatchIdFor(job.id);
  await jobDir(root, did, `${'x'.repeat(100)}\n`.repeat(400));
  const t1 = executor.readLog(job);
  assert.ok(t1.text.length <= 12 * 1024 && t1.cut === true && t1.size === 101 * 400);
  assert.ok(executor.summary(job).length <= 2000);
  await rm(executor.logPath(job));
  writeFileSync(join(root, 'secret'), 'runner state');
  symlinkSync(join(root, 'secret'), executor.logPath(job));
  assert.equal(executor.readLog(job), null);
  assert.equal(executor.summary(job), null);
});

// ---------------------------------------------------------------------------------------
// The VPS side of the job service, wired to the systemd executor.

async function vpsJobs(t) {
  const tree = await runnerTree(t);
  const stateDir = join(tree.base, 'state');
  const wt = join(tree.root, 'worktrees', 'wt');
  await mkdir(wt);
  await writeFile(join(wt, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { test: 'node -e 1' } }));
  const rt = createRuntime({ stateDir, principal: OWNER, ledger: stubLedger(), host: 'vps' });
  t.after(() => rt.close());
  const workspaceId = `ws_${randomBytes(12).toString('base64url')}`;
  const now = Date.now();
  await rt.store().transaction(repo => {
    repo.insertWorkspace({ id: workspaceId, principal: OWNER.id, client_type: 'cli', project_id: 'drop', host: 'vps', status: 'active', created_at: now, updated_at: now });
    repo.insertClaim({ claim_id: 'c'.repeat(32), workspace_id: workspaceId, issue_ref: ISSUE, fence_sha: 'f'.repeat(40), epoch: 1,
      expires_at: new Date(now + 1800_000).toISOString(), updated_at: now });
    repo.insertWorktree({ id: 'wt_vps', workspace_id: workspaceId, project_id: 'drop', host: 'vps', path: wt, branch: 'agent/7',
      base_ref: 'main', base_commit: 'a'.repeat(40), issue_ref: ISSUE, created_at: now, updated_at: now });
  });
  const jobs = createJobService(rt, { executor: tree.executor });
  return { ...tree, rt, jobs, workspaceId, base: { workspace_id: workspaceId, worktree_id: 'wt_vps', recipe: 'test' } };
}

test('AC-P4-04/20 (service): submit queues without starting anything; a queued job cancels without a unit', async t => {
  const { root, rt, jobs, base, systemctl } = await vpsJobs(t);
  const first = await jobs.submit({ ...base, timeout_seconds: 120 });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.job.status, 'queued');
  assert.match(first.job.unit, /^memo-job@j[0-9a-f]{31}\.service$/);
  assert.deepEqual(first.job.limits, { executor: 'systemd', slice: 'memo-dev.slice', disk_budget_gib: 20, timeout_seconds: 120 });
  const second = await jobs.submit(base);
  assert.equal(second.ok, true, 'a second submit is queued, not host_busy');
  assert.equal(second.job.status, 'queued');
  assert.deepEqual(readdirSync(join(root, 'spool', 'queue')), [], 'nothing is handed to the dispatcher by submit');

  const row = await rt.store().transaction(repo => repo.getJob(first.job.job_id), { write: false });
  assert.deepEqual([row.claim_id, row.principal, row.release_on_finish], ['c'.repeat(32), OWNER.id, 0]);

  const cancelled = await jobs.cancel({ job_id: second.job.job_id });
  assert.equal(cancelled.job.status, 'cancelled');
  assert.deepEqual(readdirSync(join(root, 'spool', 'cancel')), [], 'no unit to stop for a job that never started');
  const kinds = (await jobs.events({ job_id: second.job.job_id })).events.map(e => e.kind);
  assert.deepEqual(kinds, ['submitted', 'cancelled']);
  assert.equal(systemctl.calls().length, 0);

  const status = await jobs.status({ job_id: first.job.job_id });
  const { lease, ...context } = status.context;
  assert.deepEqual(context, { project: 'drop', issue: ISSUE, branch: 'agent/7', base_commit: 'a'.repeat(40), host: 'vps',
    unit: first.job.unit, claim_id: 'c'.repeat(32) });
  assert.deepEqual([lease.state, lease.fence], ['claimed', 'f'.repeat(40)], 'the current lease, so a client resumes with the renewed fence');
  // The queue itself is bounded.
  const capped = createJobService(rt, { executor: createSystemdExecutor({ root, statusOwnerUid: UID, maxQueue: 1 }) });
  const full = await capped.submit(base);
  assert.deepEqual([full.ok, full.error], [false, 'queue_full']);
  assert.deepEqual(await jobs.submit({ ...base, release_on_finish: 'yes' }), { ok: false, error: 'invalid_input', detail: 'release_on_finish' });
  assert.deepEqual(await jobs.submit({ ...base, client_request_id: 'bad id' }), { ok: false, error: 'invalid_input', detail: 'client_request_id' });
});

test('AC-P4-20 (service): cancelling a dispatched or running job writes the cancel file at once', async t => {
  const { root, rt, jobs, base } = await vpsJobs(t);
  const submitted = await jobs.submit(base);
  const id = submitted.job.job_id;
  const did = dispatchIdFor(id);
  await rt.store().transaction((repo, at = Date.now()) => {
    repo.updateJob(id, { status: 'running', started_at: at }, 'queued');
    repo.appendJobEvent({ job_id: id, at, kind: 'dispatched', detail: '{}' });
  });
  const r = await jobs.cancel({ job_id: id });
  assert.equal(r.job.status, 'cancelled');
  assert.deepEqual(readdirSync(join(root, 'spool', 'cancel')), [did]);
  const kinds = (await jobs.events({ job_id: id })).events.map(e => e.kind);
  assert.deepEqual(kinds, ['submitted', 'dispatched', 'cancelled', 'stop_requested']);
  // The unit's own verdict arrives later: the job stays cancelled and gains the exit facts.
  await jobDir(root, did, 'partial output\n');
  writeStatus(root, did, { version: 1, id: did, service_result: 'success', exit_code: 'killed', exit_status: 'TERM' });
  const after = await jobs.status({ job_id: id });
  assert.equal(after.job.status, 'cancelled');
  const exit = (await jobs.events({ job_id: id })).events.find(e => e.kind === 'exit');
  assert.deepEqual(exit.detail, { service_result: 'success', exit_code: 'killed', exit_status: 'TERM', status: 'cancelled', unit_status: 'interrupted' });
  assert.deepEqual((await jobs.cancel({ job_id: id })).error, 'job_finished');
});

test('job_status and job_results on the VPS take the status from status.json and the tail from the log', async t => {
  const { root, rt, jobs, base } = await vpsJobs(t);
  const id = (await jobs.submit(base)).job.job_id;
  const did = dispatchIdFor(id);
  await rt.store().transaction(repo => {
    repo.updateJob(id, { status: 'running', started_at: Date.now() }, 'queued');
    repo.appendJobEvent({ job_id: id, at: Date.now(), kind: 'dispatched', detail: '{}' });
  });
  // The job writes whatever it likes in its output, including a fake verdict: ignored.
  await jobDir(root, did, 'ok 1\nnot ok 2\n{"service_result":"success","exit_status":"0"}\n\u001b[31mred\u001b[0m\n');
  writeFileSync(join(root, 'jobs', did, 'out', 'status.json'), JSON.stringify({ version: 1, id: did, service_result: 'success', exit_code: 'exited', exit_status: '0' }));
  assert.equal((await jobs.status({ job_id: id })).job.status, 'running', 'out/status.json written by the job is not the status file');
  writeStatus(root, did, { version: 1, id: did, service_result: 'exit-code', exit_code: 'exited', exit_status: '1' });
  const done = await jobs.status({ job_id: id });
  assert.deepEqual([done.job.status, done.job.exit_code], ['failed', 1]);
  const results = await jobs.results({ job_id: id, tail_lines: 2 });
  assert.deepEqual(results.log.lines, ['{"service_result":"success","exit_status":"0"}', 'red']);
  assert.equal(results.log.truncated_to_tail, true);
  assert.equal(results.context.unit, `memo-job@${did}.service`);
  // A row whose log path was tampered with is never read.
  await rt.store().transaction(repo => repo.updateJob(id, { summary: null }, 'failed'));
  const db = (await import('node:sqlite')).DatabaseSync;
  const raw = new db(join(rt.stateDir, 'coordinator.sqlite'));
  raw.prepare('UPDATE jobs SET log_path = ? WHERE id = ?').run('/etc/passwd', id);
  raw.close();
  assert.deepEqual((await jobs.results({ job_id: id })).log.lines, []);
});
