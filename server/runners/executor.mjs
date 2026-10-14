// Executor seam (Phase 4, TODO-P4-07): how a recorded job is turned into running code.
//
// The job service (jobs.mjs) owns validation, the store rows, authorization and the journal.
// An executor only starts, observes and stops the code of a job. Two exist:
// - local   (executor-local.mjs): the Phase 3 Mac behaviour, unchanged. A detached
//           job-runner.mjs process per job, liveness from process groups, signals to stop it.
// - systemd (executor-systemd.mjs): the VPS runner. memo-runner never starts code itself: it
//           writes spool/queue/<id>.json for the root dispatcher (D3), spool/cancel/<id> to stop
//           a job, and reads the final status from jobs/<id>/status.json, which root writes from
//           systemd's own result variables (D5). Job output is never trusted for the status.
//
// Interface (every executor):
//   kind                 'local' | 'systemd'
//   queueing             false: jobs_submit refuses with host_busy at the limit (Mac, Phase 3)
//                        true: jobs_submit always queues and the supervisor dispatches (VPS)
//   sandbox()            { ok, mode } or { ok:false, error, detail }: may this host run jobs at all
//   prepare({stateDir, jobId})  { ok, logPath, unit, limits } before the job row is inserted
//   launch({stateDir, job, worktreePath})  { ok, pid? } start (local) or hand off (systemd)
//   alive(job, ctx)      is the job's code still there
//   stop(job, ctx)       ask for the job's code to stop (signal, or cancel spool file)
//   show(job)            what the executor knows about the job right now
//   reconcile(repo, job, at)  synchronous, inside a store transaction: apply what the
//                        executor knows (processes gone, final status file) to the row
//   logPath(job, {stateDir}), logRoot({stateDir})  the only log file job_results may read, and its root
import { platform } from 'node:os';

export const EXECUTOR_KINDS = Object.freeze(['local', 'systemd']);
export const EXECUTOR_METHODS = Object.freeze(['sandbox', 'prepare', 'launch', 'alive', 'stop', 'show', 'reconcile', 'logPath', 'logRoot']);

// Job statuses (store SCHEMA_V3). Active ones hold a slot in the queue or on the host.
export const JOB_STATUSES = Object.freeze(['queued', 'deferred', 'dispatched', 'running', 'succeeded', 'failed', 'cancelled',
  'timed_out', 'oom', 'budget_exceeded', 'interrupted']);
export const ACTIVE_JOB_STATUSES = Object.freeze(['queued', 'deferred', 'dispatched', 'running']);
// Waiting in the FIFO (no code started yet) versus holding the host (code may be running).
export const WAITING_JOB_STATUSES = Object.freeze(['queued', 'deferred']);
export const STARTED_JOB_STATUSES = Object.freeze(['dispatched', 'running']);
export const FINAL_JOB_STATUSES = Object.freeze(JOB_STATUSES.filter(s => !ACTIVE_JOB_STATUSES.includes(s)));

// MEMO_BRIDGE_JOB_EXECUTOR selects the executor: unset or 'local' keeps Phase 3; 'systemd'
// is the VPS runner and is refused anywhere but Linux.
export function executorKindFromEnv(env = process.env, os = platform()) {
  const raw = env.MEMO_BRIDGE_JOB_EXECUTOR;
  if (raw === undefined || raw === '' || raw === 'local') return { ok: true, kind: 'local' };
  if (raw === 'systemd') {
    return os === 'linux' ? { ok: true, kind: 'systemd' } : { ok: false, error: 'invalid_configuration', detail: 'systemd executor needs Linux' };
  }
  return { ok: false, error: 'invalid_configuration', detail: 'MEMO_BRIDGE_JOB_EXECUTOR must be local or systemd' };
}

export function assertExecutor(executor) {
  if (!executor || !EXECUTOR_KINDS.includes(executor.kind)) throw new Error('invalid_executor');
  for (const method of EXECUTOR_METHODS) {
    if (typeof executor[method] !== 'function') throw new Error(`invalid_executor: ${method}`);
  }
  if (typeof executor.queueing !== 'boolean') throw new Error('invalid_executor: queueing');
  return executor;
}

// An executor that refuses everything, for a misconfigured host: jobs_submit reports the
// configuration error instead of the server failing to start.
export function unavailableExecutor(error, detail) {
  const refuse = () => ({ ok: false, error, ...(detail ? { detail } : {}) });
  return {
    kind: 'local', queueing: false, sandbox: refuse, prepare: refuse, launch: async () => refuse(),
    alive: () => false, stop: () => false, show: () => ({ active: false }), reconcile: (repo, job) => job,
    logPath: () => null, logRoot: () => null
  };
}

// Status of the supervisor running in this process, if any (host_resources reads it). Kept
// here, in the leaf module, so hosts.mjs and supervisor.mjs do not import each other.
let runnerStatusProvider = null;
export function setRunnerStatusProvider(fn) {
  runnerStatusProvider = typeof fn === 'function' ? fn : null;
}
export function runnerStatus() {
  try { return runnerStatusProvider ? runnerStatusProvider() : null; } catch { return null; }
}

// Wake the supervisor of this process (a job was queued or cancelled) instead of waiting for
// its next tick. Never throws, never blocks the caller (it may run inside a transaction).
let supervisorNudge = null;
export function setSupervisorNudge(fn) {
  supervisorNudge = typeof fn === 'function' ? fn : null;
}
export function nudgeSupervisor() {
  const fn = supervisorNudge;
  if (fn) setImmediate(() => { try { fn(); } catch { /* the next tick catches up */ } });
}
