// Local executor: the Phase 3 behaviour, extracted from jobs.mjs without change (REQ-P4-22).
//
// jobs_submit creates <stateDir>/jobs/<id>.log (0600) and records the job; launch() spawns
// `node job-runner.mjs --protocol=<n> <stateDir> <jobId>` detached; the runner takes the job
// (CAS queued -> running), runs the recipe in the job sandbox and records the outcome.
// Liveness is the job's process group and the runner pid; stopping is SIGTERM then SIGKILL to
// the group, only while its leader is still the job's (processes.mjs).
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { signalJobGroup } from './processes.mjs';
import { sandboxMode } from './sandbox.mjs';

export const KILL_GRACE_MS = 5000;
// A running job past timeout + this grace is killed by the next read, in case its runner died
// (or was killed) and can no longer enforce the timeout itself.
export const DEADLINE_GRACE_MS = KILL_GRACE_MS + 30_000;
// A queued job whose runner pid was never recorded is only declared interrupted after this.
export const QUEUED_GRACE_MS = 60_000;

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try { process.kill(-pgid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export function signalGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try { process.kill(-pgid, signal); return true; } catch { return false; }
}

export function jobsDir(stateDir) {
  return join(stateDir, 'jobs');
}
export function logPathFor(stateDir, jobId) {
  return join(jobsDir(stateDir), `${jobId}.log`);
}

function detailOf(e) {
  try { return JSON.parse(e.detail); } catch { return null; }
}

// The runner pid recorded by jobs_submit ('submitted') or by the runner ('started').
export function runnerPidOf(repo, jobId) {
  let pid = null;
  for (const e of repo.listJobEvents(jobId, 0, 20)) {
    if (e.kind !== 'submitted' && e.kind !== 'started') continue;
    const d = detailOf(e);
    if (Number.isInteger(d?.runner_pid)) pid = d.runner_pid;
  }
  return pid;
}

// Start time of the job's group leader, recorded by the runner in its 'started' event.
export function leaderStartOf(repo, jobId) {
  for (const e of repo.listJobEvents(jobId, 0, 20)) {
    if (e.kind !== 'started') continue;
    const d = detailOf(e);
    if (typeof d?.pid_start === 'string') return d.pid_start;
  }
  return null;
}

// Report a job whose processes are all gone as interrupted, and stop a running job past its
// deadline (timeout + grace) as timed_out. Runs inside a write transaction; the CAS on status
// means a runner that finishes at the same moment wins.
export function reconcileLocalJob(repo, job, at, { alive = processAlive, aliveGroup = groupAlive, signal = signalJobGroup } = {}) {
  if (job.status !== 'queued' && job.status !== 'running') return job;
  const runnerPid = runnerPidOf(repo, job.id);
  if (job.status === 'running' && Number.isInteger(job.started_at) && at > job.started_at + job.timeout_ms + DEADLINE_GRACE_MS) {
    // The runner should have stopped it long ago: it is gone or stuck. Kill the group; a live
    // runner sees the status change and also kills every process it tracks.
    if (Number.isInteger(job.pid)) signal(job.pid, leaderStartOf(repo, job.id), 'SIGKILL');
    const patch = { status: 'timed_out', ended_at: at, summary: job.summary ?? 'deadline_exceeded' };
    if (!repo.updateJob(job.id, patch, 'running')) return repo.getJob(job.id);
    repo.appendJobEvent({ job_id: job.id, at, kind: 'timeout', detail: JSON.stringify({ by: 'deadline', timeout_seconds: Math.round(job.timeout_ms / 1000) }) });
    return { ...job, ...patch };
  }
  if (job.status === 'running') {
    if (aliveGroup(job.pid) || (runnerPid !== null && alive(runnerPid))) return job;
  } else {
    // queued: the runner has not taken it yet.
    if (runnerPid === null ? at - job.created_at < QUEUED_GRACE_MS : alive(runnerPid)) return job;
  }
  const patch = { status: 'interrupted', ended_at: at, summary: job.summary ?? 'runner_gone' };
  if (!repo.updateJob(job.id, patch, job.status)) return repo.getJob(job.id);
  repo.appendJobEvent({ job_id: job.id, at, kind: 'interrupted', detail: JSON.stringify({ from: job.status }) });
  return { ...job, ...patch };
}

/**
 * runnerPath, nodePath: the runner entry point and the node binary.
 * spawnRunner(stateDir, jobId) -> { ok, pid } replaces the spawn (tests).
 * env: the server environment, passed to the runner (which filters it for the recipe).
 */
export function createLocalExecutor({ runnerPath, nodePath = process.execPath, env = process.env, spawnRunner,
  signal = signalJobGroup } = {}) {
  const spawnDetached = (stateDir, jobId, protocol) => new Promise(resolve => {
    let child;
    try {
      child = spawn(nodePath, [runnerPath, `--protocol=${protocol}`, stateDir, jobId],
        { detached: true, stdio: 'ignore', cwd: stateDir, env });
    } catch (error) {
      return resolve({ ok: false, error: String(error?.code ?? 'spawn_failed') });
    }
    child.once('error', error => resolve({ ok: false, error: String(error?.code ?? 'spawn_failed') }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true, pid: child.pid }); });
  });

  return {
    kind: 'local',
    queueing: false,
    sandbox: () => sandboxMode(env),
    // The log file exists before the job row, so the runner never has to create it.
    prepare({ stateDir, jobId }) {
      const logPath = logPathFor(stateDir, jobId);
      try {
        mkdirSync(jobsDir(stateDir), { recursive: true, mode: 0o700 });
        chmodSync(jobsDir(stateDir), 0o700);
        closeSync(openSync(logPath, 'wx', 0o600));
        chmodSync(logPath, 0o600);
      } catch {
        return { ok: false, error: 'store_unavailable', detail: 'job_log' };
      }
      return { ok: true, logPath, unit: null, limits: null };
    },
    launch({ stateDir, job, protocol }) {
      return spawnRunner ? spawnRunner(stateDir, job.id) : spawnDetached(stateDir, job.id, protocol);
    },
    alive(job, { runnerPid = null } = {}) {
      return groupAlive(job.pid) || (runnerPid !== null && processAlive(runnerPid));
    },
    // SIGTERM or SIGKILL to the job's group, only while its leader is still the job's.
    stop(job, { pidStart = null, signal: sig = 'SIGTERM' } = {}) {
      return Number.isInteger(job.pid) ? signal(job.pid, pidStart, sig) : false;
    },
    show(job) {
      return { active: groupAlive(job.pid), pid: job.pid ?? null };
    },
    reconcile: (repo, job, at) => reconcileLocalJob(repo, job, at),
    logPath: (job, { stateDir }) => logPathFor(stateDir, job.id),
    logRoot: ({ stateDir }) => jobsDir(stateDir)
  };
}
