// Lease supervision (Phase 4, TODO-P4-09, REQ-P4-05): the supervisor keeps the claim of every
// waiting or running VPS job alive, cancels the jobs when the ledger says the lease is gone,
// rides out ledger outages without guessing, releases the claim when asked to, and never lets
// code wait or run without a live claim, workspace and worktree.
// A fake ledger with a fence chain and a fake clock; nothing touches GitHub or systemd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../server/runtime.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { createJobService } from '../server/runners/jobs.mjs';
import { createSystemdExecutor, dispatchIdFor } from '../server/runners/executor-systemd.mjs';
import { SUPERVISOR_PRINCIPAL, createSupervisor } from '../server/runners/supervisor.mjs';
import { loadRunnerConfig } from '../server/runners/resources.mjs';

const OWNER = makePrincipal('local:owner', Object.values(CAPABILITIES));
const ISSUE = 'memolabs-dev/drop#7';
const CLAIM = 'c'.repeat(32);
const GIB = 1024 ** 3;
const MIN = 60_000;

// The ledger as issue_lease.py behaves for one lease: every heartbeat moves the fence, an old
// fence is stale, a takeover makes ours stale. `mode` forces an answer (outage, unknown outcome).
function fakeLedger(clock, { ttlAtClaim = 1800 } = {}) {
  const lease = { fence: 'f'.repeat(40), expires: clock.t + ttlAtClaim * 1000, holder: null, released: null };
  const calls = [];
  let mode = 'ok';
  let n = 0;
  const receipt = () => ({ state: lease.released ? 'released' : 'claimed', claim_id: CLAIM, worker: lease.holder, fence_sha: lease.fence,
    expires_at: new Date(lease.expires).toISOString(), expired: lease.expires <= clock.t });
  const mine = (worker, claimId, fence) => {
    lease.holder ??= worker;
    if (lease.taken || lease.released || claimId !== CLAIM || fence !== lease.fence || lease.expires <= clock.t) return false;
    return lease.holder === worker;
  };
  return {
    lease, calls,
    set mode(m) { mode = m; },
    takeOver() { lease.taken = true; lease.fence = createHash('sha1').update('thief').digest('hex'); },
    async status() { calls.push(['status']); return mode === 'ledger_unavailable' ? { ok: false, error: mode } : { ok: true, receipt: receipt() }; },
    async verify(issue, worker, claimId, fence) {
      calls.push(['verify', fence]);
      if (mode === 'ledger_unavailable') return { ok: false, error: mode };
      return mine(worker, claimId, fence) ? { ok: true, receipt: receipt() } : { ok: false, error: 'stale_lease' };
    },
    async heartbeat(issue, worker, claimId, fence, ttl) {
      calls.push(['heartbeat', fence, ttl]);
      if (mode === 'ledger_unavailable') return { ok: false, error: mode };
      if (!mine(worker, claimId, fence)) return { ok: false, error: 'stale_lease' };
      lease.fence = createHash('sha1').update(`fence-${++n}`).digest('hex');
      lease.expires = clock.t + ttl * 1000;
      // The write landed, but the answer was lost.
      if (mode === 'ledger_outcome_unknown') return { ok: false, error: mode };
      return { ok: true, receipt: receipt() };
    },
    async release(issue, worker, claimId, fence, outcome) {
      calls.push(['release', fence, outcome]);
      if (mode === 'ledger_unavailable') return { ok: false, error: mode };
      if (!mine(worker, claimId, fence)) return { ok: false, error: 'stale_lease' };
      lease.released = outcome;
      lease.fence = createHash('sha1').update(`release-${++n}`).digest('hex');
      return { ok: true, receipt: receipt() };
    },
    async claim() { return { ok: false, error: 'lease_held' }; }
  };
}

async function setup(t, { worktrees = 1 } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'memo-lease-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'runner');
  for (const d of ['spool/queue', 'spool/cancel', 'jobs', 'worktrees']) await mkdir(join(root, d), { recursive: true, mode: 0o700 });
  const bin = join(base, 'systemctl');
  await writeFile(join(base, 'units.json'), '{}');
  await writeFile(bin, `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const units = JSON.parse(fs.readFileSync(path.join(path.dirname(fs.realpathSync(process.argv[1])), 'units.json'), 'utf8'));
const named = process.argv.slice(2).filter(a => a.endsWith('.service'));
process.stdout.write(named.map(unit => 'Id=' + unit + '\\nActiveState=' + (units[unit] || 'inactive') + '\\n').join('\\n'));
`);
  chmodSync(bin, 0o755);
  const setUnit = (unit, state) => {
    const units = JSON.parse(readFileSync(join(base, 'units.json'), 'utf8'));
    units[unit] = state;
    writeFileSync(join(base, 'units.json'), JSON.stringify(units));
  };
  const clock = { t: Date.now() };
  const ledger = fakeLedger(clock);
  const rt = createRuntime({ stateDir: join(base, 'state'), principal: OWNER, ledger, host: 'vps', now: () => clock.t });
  const workspaceId = `ws_${randomBytes(12).toString('base64url')}`;
  await rt.store().transaction(repo => {
    repo.insertWorkspace({ id: workspaceId, principal: OWNER.id, client_type: 'cli', project_id: 'drop', host: 'vps', status: 'active',
      created_at: clock.t, updated_at: clock.t });
    repo.insertClaim({ claim_id: CLAIM, workspace_id: workspaceId, issue_ref: ISSUE, fence_sha: ledger.lease.fence, epoch: 1,
      expires_at: new Date(ledger.lease.expires).toISOString(), updated_at: clock.t });
  });
  for (let i = 0; i < worktrees; i++) {
    const path = join(root, 'worktrees', `wt${i}`);
    await mkdir(path);
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { test: 'node -e 1' } }));
    await rt.store().transaction(repo => repo.insertWorktree({ id: `wt_${i}`, workspace_id: workspaceId, project_id: 'drop', host: 'vps',
      path, branch: `agent/7-${i}`, base_ref: 'main', base_commit: 'a'.repeat(40), issue_ref: ISSUE, created_at: clock.t, updated_at: clock.t }));
  }
  const executor = createSystemdExecutor({ root, systemctl: bin, statusOwnerUid: process.getuid() });
  const healthy = { pressure: { cpu: { some: { avg10: 1 } }, memory: { full: { avg10: 0 } }, io: { full: { avg10: 0 } } },
    memory: { available_bytes: 8 * GIB }, disk: { free_bytes: 100 * GIB } };
  const supervisor = createSupervisor(rt, { executor, resources: { snapshot: () => healthy, usage: async () => ({ bytes: 0, partial: false }) },
    config: loadRunnerConfig('/nonexistent/runner.json') });
  const jobs = createJobService(rt, { executor });
  t.after(async () => { await supervisor.stop(); await rt.close(); });
  const unitOf = id => `memo-job@${dispatchIdFor(id)}.service`;
  const run = async id => {
    await supervisor.tick();
    setUnit(unitOf(id), 'active');
    await supervisor.tick();
  };
  const finish = (id, result) => {
    const d = dispatchIdFor(id);
    return mkdir(join(root, 'jobs', d, 'out'), { recursive: true }).then(() => {
      writeFileSync(join(root, 'jobs', d, 'status.json'), JSON.stringify({ version: 1, id: d, ...result }), { mode: 0o640 });
      setUnit(unitOf(id), 'inactive');
    });
  };
  const row = id => rt.store().transaction(repo => repo.getJob(id), { write: false });
  const claim = () => rt.store().transaction(repo => repo.getClaim(CLAIM), { write: false });
  const audit = () => rt.store().transaction(repo => repo.listEvents({ principal: SUPERVISOR_PRINCIPAL, limit: 100 }), { write: false });
  const cancels = () => readdirSync(join(root, 'spool', 'cancel'));
  // An hour-long timeout: these tests advance the clock by tens of minutes.
  const args = (i = 0) => ({ workspace_id: workspaceId, worktree_id: `wt_${i}`, recipe: 'test', timeout_seconds: 3600 });
  return { rt, clock, ledger, jobs, supervisor, run, finish, row, claim, audit, cancels, args, workspaceId };
}

// ---------------------------------------------------------------------------------------

test('AC-P4-05: a job running 45 minutes under an 1800 s lease keeps it; the expiry advances, the fence chain holds', async t => {
  const s = await setup(t);
  const { job } = await s.jobs.submit({ ...s.args(), timeout_seconds: 3600 });
  await s.run(job.job_id);
  assert.equal((await s.row(job.job_id)).status, 'running');
  const expiries = [];
  // Renewal rounds every 5 minutes here (60 s in production), for 60 minutes: past the
  // 45 minutes of AC-P4-05 and twice past the original expiry.
  for (let minute = 5; minute <= 60; minute += 5) {
    s.clock.t += 5 * MIN;
    await s.supervisor.renewLeases();
    await s.supervisor.tick();
    const c = await s.claim();
    assert.ok(Date.parse(c.expires_at) > s.clock.t, `lease alive at minute ${minute}`);
    assert.equal(c.fence_sha, s.ledger.lease.fence, 'the mirror follows the ledger fence');
    expiries.push(Date.parse(c.expires_at));
    assert.equal((await s.row(job.job_id)).status, 'running', `still running at minute ${minute}`);
  }
  const beats = s.ledger.calls.filter(c => c[0] === 'heartbeat');
  // Renewed only once less than a third of the TTL was left (minutes 25 and 50), never on every round.
  assert.equal(beats.length, 2, `renewed ${beats.length} times`);
  assert.ok(beats.every(b => b[2] === 1800));
  assert.ok(expiries.at(-1) > expiries[0], 'the ledger expiry advanced');
  const renewed = (await s.jobs.events({ job_id: job.job_id })).events.filter(e => e.kind === 'lease_renewed');
  assert.equal(renewed.length, beats.length);
  assert.ok((await s.audit()).some(e => e.op === 'task_renew' && e.outcome === 'ok'));
});

test('AC-P4-05: after a takeover the next renewal is stale_lease and the job is cancelled and stopped', async t => {
  const s = await setup(t);
  const { job } = await s.jobs.submit(s.args());
  await s.run(job.job_id);
  s.ledger.takeOver();
  s.clock.t += 21 * MIN;
  await s.supervisor.renewLeases();
  const r = await s.row(job.job_id);
  assert.deepEqual([r.status, r.status_reason], ['cancelled', 'stale_lease']);
  assert.deepEqual(s.cancels(), [dispatchIdFor(job.job_id)], 'the unit is stopped through the dispatcher at once');
  const denied = (await s.audit()).find(e => e.op === 'task_renew');
  assert.deepEqual([denied.outcome, denied.code, denied.issue_ref], ['denied', 'stale_lease', ISSUE]);
  const cancelled = (await s.jobs.events({ job_id: job.job_id })).events.find(e => e.kind === 'cancelled');
  assert.deepEqual(cancelled.detail, { from: 'running', by: 'supervisor', reason: 'stale_lease' });
});

test('a ledger outage is retried, not guessed; the job stops only once the lease has really expired', async t => {
  const s = await setup(t);
  const { job } = await s.jobs.submit(s.args());
  await s.run(job.job_id);
  s.ledger.mode = 'ledger_unavailable';
  s.clock.t += 21 * MIN;
  await s.supervisor.renewLeases();
  await s.supervisor.tick();
  assert.equal((await s.row(job.job_id)).status, 'running', 'an unreachable ledger does not cancel');
  assert.deepEqual(s.supervisor.status().ledger.reachable, false);
  assert.ok((await s.audit()).some(e => e.op === 'task_renew' && e.outcome === 'error' && e.code === 'ledger_unavailable'));
  // Still unreachable when the lease runs out: code never runs without a live claim.
  s.clock.t += 10 * MIN;
  await s.supervisor.renewLeases();
  await s.supervisor.tick();
  const r = await s.row(job.job_id);
  assert.deepEqual([r.status, r.status_reason], ['cancelled', 'no_live_claim']);
  assert.deepEqual(s.cancels(), [dispatchIdFor(job.job_id)]);
});

test('an unknown heartbeat outcome is resolved by asking the ledger who holds the lease', async t => {
  const s = await setup(t);
  const { job } = await s.jobs.submit(s.args());
  await s.run(job.job_id);
  s.ledger.mode = 'ledger_outcome_unknown';
  s.clock.t += 21 * MIN;
  await s.supervisor.renewLeases();
  const c = await s.claim();
  assert.equal(c.fence_sha, s.ledger.lease.fence, 'the heartbeat that landed is recognised as ours');
  assert.ok(Date.parse(c.expires_at) > s.clock.t + 25 * MIN);
  assert.deepEqual(s.ledger.calls.slice(-2).map(c => c[0]), ['heartbeat', 'status']);
  s.ledger.mode = 'ok';
  s.clock.t += 21 * MIN;
  await s.supervisor.renewLeases();
  assert.equal((await s.row(job.job_id)).status, 'running', 'the next renewal uses the recovered fence');
});

test('a queued or deferred job keeps its claim alive while it waits', async t => {
  const s = await setup(t, { worktrees: 2 });
  const first = (await s.jobs.submit(s.args(0))).job;
  const second = (await s.jobs.submit(s.args(1))).job;
  await s.run(first.job_id);
  assert.equal((await s.row(second.job_id)).status, 'queued');
  for (let i = 0; i < 12; i++) { s.clock.t += 5 * MIN; await s.supervisor.renewLeases(); await s.supervisor.tick(); }
  assert.equal((await s.row(second.job_id)).status, 'queued', 'one hour later it still waits, with its lease');
  assert.ok(Date.parse((await s.claim()).expires_at) > s.clock.t);
});

test('release_on_finish releases the claim once the last job of that claim has ended', async t => {
  const s = await setup(t, { worktrees: 2 });
  const a = (await s.jobs.submit({ ...s.args(0), release_on_finish: true })).job;
  const b = (await s.jobs.submit(s.args(1))).job;
  assert.equal(a.release_on_finish, true);
  await s.run(a.job_id);
  await s.finish(a.job_id, { service_result: 'success', exit_code: 'exited', exit_status: '0' });
  await s.supervisor.tick();
  assert.equal((await s.row(a.job_id)).status, 'succeeded');
  assert.equal(s.ledger.calls.filter(c => c[0] === 'release').length, 0, 'job b still holds the claim');
  await s.run(b.job_id);
  await s.finish(b.job_id, { service_result: 'exit-code', exit_code: 'exited', exit_status: '1' });
  await s.supervisor.tick();
  const releases = s.ledger.calls.filter(c => c[0] === 'release');
  assert.deepEqual(releases.map(c => c[2]), ['completed']);
  const c = await s.claim();
  assert.deepEqual([c.state, c.outcome], ['released', `completed: job ${a.job_id} succeeded`]);
  assert.equal(c.fence_sha, s.ledger.lease.fence);
  await s.supervisor.tick();
  assert.equal(s.ledger.calls.filter(x => x[0] === 'release').length, 1, 'released once');
  assert.ok((await s.jobs.events({ job_id: a.job_id })).events.some(e => e.kind === 'released'));
});

test('release_on_finish after a lost lease is skipped and journaled, never forced', async t => {
  const s = await setup(t);
  const { job } = await s.jobs.submit({ ...s.args(), release_on_finish: true });
  await s.run(job.job_id);
  await s.finish(job.job_id, { service_result: 'oom-kill', exit_code: 'killed', exit_status: 'KILL' });
  s.ledger.takeOver();
  await s.supervisor.tick();
  assert.equal((await s.row(job.job_id)).status, 'oom');
  assert.deepEqual(s.ledger.calls.filter(c => c[0] === 'release').map(c => c[2]), ['failed']);
  const skipped = (await s.jobs.events({ job_id: job.job_id })).events.find(e => e.kind === 'release_skipped');
  assert.equal(skipped.detail.reason, 'stale_lease');
  assert.equal((await s.claim()).state, 'claimed', 'the mirror is not marked released when the ledger refused');
});

test('dispatch re-verifies the lease: lost means cancelled, unreachable means deferred', async t => {
  const s = await setup(t);
  s.ledger.mode = 'ledger_unavailable';
  const submitted = await s.jobs.submit(s.args());
  assert.equal(submitted.error, 'ledger_unavailable', 'submission itself asks the ledger');
  s.ledger.mode = 'ok';
  const { job } = await s.jobs.submit(s.args());
  s.ledger.mode = 'ledger_unavailable';
  await s.supervisor.tick();
  let r = await s.row(job.job_id);
  assert.deepEqual([r.status, r.status_reason], ['deferred', 'deferred_ledger']);
  s.ledger.mode = 'ok';
  s.ledger.takeOver();
  s.clock.t += 31_000;
  await s.supervisor.tick();
  r = await s.row(job.job_id);
  assert.deepEqual([r.status, r.status_reason], ['cancelled', 'stale_lease']);
  assert.deepEqual(s.cancels(), [], 'never started, nothing to stop');
});

test('lifecycle: a closed workspace or a released claim cancels waiting jobs; nothing runs without them', async t => {
  const s = await setup(t, { worktrees: 2 });
  const a = (await s.jobs.submit(s.args(0))).job;
  const b = (await s.jobs.submit(s.args(1))).job;
  await s.rt.store().transaction(repo => repo.updateWorktree('wt_1', { status: 'removed', removed_at: s.clock.t }));
  await s.supervisor.tick();
  assert.deepEqual([(await s.row(b.job_id)).status, (await s.row(b.job_id)).status_reason], ['cancelled', 'worktree_removed']);
  assert.equal((await s.row(a.job_id)).status, 'dispatched');
  await s.rt.store().transaction(repo => repo.updateClaim(CLAIM, { state: 'released', updated_at: s.clock.t }, s.ledger.lease.fence));
  await s.supervisor.tick();
  assert.deepEqual([(await s.row(a.job_id)).status, (await s.row(a.job_id)).status_reason], ['cancelled', 'claim_released']);
  assert.deepEqual(s.cancels(), [dispatchIdFor(a.job_id)], 'the dispatched one is stopped (spool withdrawn, cancel written)');
  assert.equal(s.ledger.calls.filter(c => c[0] === 'heartbeat').length, 0, 'a released claim is not renewed');
});
