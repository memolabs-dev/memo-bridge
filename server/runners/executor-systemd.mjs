// Systemd executor (Phase 4, TODO-P4-07): jobs on the VPS run as memo-job@<id>.service.
//
// memo-runner (this process) never starts, signals or reads the memory of job code. The only
// things it does are, under /var/lib/memo-runner (MEMO_BRIDGE_RUNNER_ROOT):
//   spool/queue/<id>.json   written atomically (temporary file + rename) when the supervisor
//                           dispatches a job. memo-runner-dispatch.path wakes the root
//                           dispatcher, which re-validates it and starts the unit (D3).
//   spool/cancel/<id>       {"version":1,"id":<id>,"reason":<reason>} asking the dispatcher to stop
//                           the unit; the reason (CANCEL_REASONS) lets record-result end it as
//                           budget_exceeded or cancelled rather than as a clean exit.
//   jobs/<id>/status.json   read only. Root writes it from ExecStopPost=+record-result with
//                           systemd's $SERVICE_RESULT, $EXIT_CODE and $EXIT_STATUS (D5). The
//                           file must be a regular file owned by root, not writable by group
//                           or others; anything else is ignored. Job output never sets a status.
//   jobs/<id>/out/job.log   the job's output, opened without following symlinks.
//   `systemctl show`        read-only unit state (ActiveState, SubState, Result) to see a job
//                           start, and to find a unit that ended without a status file.
//
// <id> is the dispatch id: 'j' + 31 hex characters of sha256(job id). It matches the
// dispatcher's ^[a-z0-9-]{8,64}$ (REQ-P4-11), which a job id (job_<base64url>) does not.
//
// systemd semantics relied on (systemd 257, man/systemd.exec.xml and systemd.service.xml at
// tag v257, read 2026-10-14):
// - systemd.exec(5) "Environment Variables in Spawned Processes": $SERVICE_RESULT is one of
//   success, protocol, timeout, exit-code, signal, core-dump, watchdog, exec-condition,
//   oom-kill, start-limit-hit, resources; $EXIT_CODE is exited, killed or dumped; $EXIT_STATUS
//   is the numeric exit code for exited, else the signal name without "SIG" (TERM, KILL...).
//   A clean stop by SIGTERM (HUP, INT, TERM, PIPE) is result success with EXIT_CODE=killed.
// - systemd.service(5) RuntimeMaxSec=: past it the service "is terminated and put into a
//   failure state". That this failure is $SERVICE_RESULT=timeout is inferred from the
//   systemd.exec(5) summary table (timeout: killed TERM/KILL): to verify in TODO-P4-01 spike.
// - systemctl(1) show --property=...: read by memo-runner without privileges over D-Bus
//   (inferred, no polkit needed for reads): to verify in TODO-P4-01 spike.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, statSync,
  unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

export const DEFAULT_RUNNER_ROOT = '/var/lib/memo-runner';
// Debian 13 path; an absolute path so PATH never chooses the binary.
export const SYSTEMCTL = '/usr/bin/systemctl';
export const UNIT_PREFIX = 'memo-job@';
export const DISPATCH_ID_RE = /^[a-z0-9-]{8,64}$/;
const UNIT_RE = /^memo-job@([a-z0-9-]{8,64})\.service$/;
export const SPOOL_VERSION = 1;
export const STATUS_VERSION = 1;
export const STATUS_MAX_BYTES = 4096;
// Hub frames are 16 KiB (REQ-P4-02): the log tail returned for a VPS job stays under 12 KiB.
export const RESULTS_MAX_BYTES = 12 * 1024;
const SHOW_TIMEOUT_MS = 10_000;
const SHOW_MAX_BUFFER = 16 * 1024;
const SUMMARY_TAIL_BYTES = 16 * 1024;
const SUMMARY_CHARS = 2000;

export const SERVICE_RESULTS = Object.freeze(['success', 'protocol', 'timeout', 'exit-code', 'signal', 'core-dump', 'watchdog',
  'exec-condition', 'oom-kill', 'start-limit-hit', 'resources']);
// Not a systemd value: the dispatcher records that it refused a spool file, or withdrew it
// before any unit existed (reason cancelled_before_start), in the same status.json shape.
export const DISPATCH_REFUSED = 'dispatch_refused';
// The stop reasons the dispatcher accepts (deploy/memo-runner-dispatch CANCEL_REASONS).
export const CANCEL_REASONS = Object.freeze(['cancelled', 'stale_lease', 'budget_exceeded', 'no_live_claim', 'workspace_closed',
  'worktree_removed', 'runtime_shutdown']);
export function cancelReasonFor(statusReason) {
  if (statusReason === 'disk_budget' || statusReason === 'budget_exceeded') return 'budget_exceeded';
  return CANCEL_REASONS.includes(statusReason) ? statusReason : 'cancelled';
}
// Signals that mean "someone stopped it" rather than "it crashed".
const STOP_SIGNALS = new Set(['HUP', 'INT', 'TERM', 'KILL', 'PIPE']);
const ACTIVE_STATES = new Set(['active', 'activating', 'deactivating', 'reloading', 'refreshing']);

export function dispatchIdFor(jobId) {
  return `j${createHash('sha256').update(String(jobId)).digest('hex').slice(0, 31)}`;
}
export function unitFor(dispatchId) {
  if (!DISPATCH_ID_RE.test(dispatchId ?? '')) throw new Error('invalid_dispatch_id');
  return `${UNIT_PREFIX}${dispatchId}.service`;
}
export function dispatchIdOfUnit(unit) {
  const match = UNIT_RE.exec(unit ?? '');
  return match ? match[1] : null;
}

export function runnerPaths(root = DEFAULT_RUNNER_ROOT) {
  return {
    root,
    queue: join(root, 'spool', 'queue'),
    cancel: join(root, 'spool', 'cancel'),
    jobs: join(root, 'jobs'),
    worktrees: join(root, 'worktrees')
  };
}

// The runner tree from the environment: MEMO_BRIDGE_RUNNER_ROOT (default /var/lib/memo-runner).
// lab-infra also sets MEMO_BRIDGE_SPOOL_DIR and MEMO_BRIDGE_JOBS_DIR (memo-bridge-runner.service);
// the dispatcher only knows <root>/spool and <root>/jobs, so any other value is a configuration
// error, refused rather than half-followed.
export function runnerRootFromEnv(env = process.env) {
  const root = env.MEMO_BRIDGE_RUNNER_ROOT || DEFAULT_RUNNER_ROOT;
  if (!isAbsolute(root) || normalize(root) !== root || root === '/') {
    return { ok: false, error: 'invalid_configuration', detail: 'MEMO_BRIDGE_RUNNER_ROOT' };
  }
  for (const [name, expected] of [['MEMO_BRIDGE_SPOOL_DIR', join(root, 'spool')], ['MEMO_BRIDGE_JOBS_DIR', join(root, 'jobs')]]) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    if (!isAbsolute(value) || normalize(value).replace(/\/+$/, '') !== expected) {
      return { ok: false, error: 'invalid_configuration', detail: `${name} must be ${expected}` };
    }
  }
  return { ok: true, root };
}

// The spool file, the whole contract with the dispatcher: no argv, no unit properties, no
// environment. The dispatcher takes properties from root-owned runner.json only, re-detects
// nothing itself, checks every field and refuses any other key (REQ-P4-11).
export function spoolSpec({ dispatchId, jobId, recipe, worktree, timeoutSeconds }) {
  return { version: SPOOL_VERSION, id: dispatchId, job_id: jobId, recipe, worktree, timeout_seconds: timeoutSeconds };
}

// Write a file atomically in a directory memo-runner owns: a temporary dot-file (never a
// name the dispatcher accepts), fsync, rename, then fsync of the directory.
export function writeAtomic(dir, name, content) {
  const tmp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const data = Buffer.from(content);
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, join(dir, name));
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw error;
  }
  try {
    const dfd = openSync(dir, 'r');
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch { /* directory fsync is best effort (not supported everywhere) */ }
}

// Read a small file without following a symlink at the last component, and check it is the
// same regular file that lstat saw. Returns { buffer, stat } or null.
function readNoFollow(path, maxBytes, { fromEnd = false } = {}) {
  let fd;
  try {
    const before = lstatSync(path);
    if (!before.isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) return null;
    const length = Math.min(stat.size, maxBytes);
    const start = fromEnd ? stat.size - length : 0;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return { buffer: buffer.subarray(0, read), stat };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const ISO_OK = v => v === undefined || v === null || (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)));

// jobs/<id>/status.json. { ok: true, result } | { ok: false, error: 'absent' | 'untrusted', detail }.
export function readStatusFile(path, dispatchId, { ownerUid = 0 } = {}) {
  let st;
  try { st = lstatSync(path); } catch (error) {
    return error?.code === 'ENOENT' ? { ok: false, error: 'absent' } : { ok: false, error: 'untrusted', detail: 'unreadable' };
  }
  if (!st.isFile()) return { ok: false, error: 'untrusted', detail: 'not_a_regular_file' };
  if (st.uid !== ownerUid) return { ok: false, error: 'untrusted', detail: 'owner' };
  if ((st.mode & 0o022) !== 0) return { ok: false, error: 'untrusted', detail: 'mode' };
  if (st.size > STATUS_MAX_BYTES) return { ok: false, error: 'untrusted', detail: 'size' };
  const read = readNoFollow(path, STATUS_MAX_BYTES);
  if (!read || read.stat.uid !== ownerUid) return { ok: false, error: 'untrusted', detail: 'changed' };
  let doc;
  try { doc = JSON.parse(read.buffer.toString('utf8')); } catch { return { ok: false, error: 'untrusted', detail: 'json' }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'untrusted', detail: 'json' };
  if (doc.version !== STATUS_VERSION) return { ok: false, error: 'untrusted', detail: 'version' };
  if (doc.id !== dispatchId) return { ok: false, error: 'untrusted', detail: 'id' };
  if (doc.service_result !== DISPATCH_REFUSED && !SERVICE_RESULTS.includes(doc.service_result)) {
    return { ok: false, error: 'untrusted', detail: 'service_result' };
  }
  const exitCode = doc.exit_code ?? null;
  if (exitCode !== null && !['exited', 'killed', 'dumped'].includes(exitCode)) return { ok: false, error: 'untrusted', detail: 'exit_code' };
  const exitStatus = doc.exit_status ?? null;
  if (exitStatus !== null && (typeof exitStatus !== 'string' || !/^[A-Z0-9+-]{1,16}$/.test(exitStatus))) {
    return { ok: false, error: 'untrusted', detail: 'exit_status' };
  }
  if (!ISO_OK(doc.started_at) || !ISO_OK(doc.ended_at)) return { ok: false, error: 'untrusted', detail: 'timestamps' };
  // Root's own reason code (a dispatch refusal, a cancel marker): a short code, or ignored.
  const reason = typeof doc.reason === 'string' && /^[a-z0-9_]{1,64}$/.test(doc.reason) ? doc.reason : null;
  return {
    ok: true,
    result: { service_result: doc.service_result, exit_code: exitCode, exit_status: exitStatus, reason,
      started_at: doc.started_at ? Date.parse(doc.started_at) : null, ended_at: doc.ended_at ? Date.parse(doc.ended_at) : null }
  };
}

// systemd's verdict -> job status. `reason` lands in status_reason.
export function statusFromResult({ service_result: result, exit_code: code, exit_status: status, reason = null }) {
  switch (result) {
    case 'success':
      if (code === 'exited' && status === '0') return { status: 'succeeded', exit_code: 0 };
      // Killed by HUP/INT/TERM/PIPE, which systemd counts as clean: someone stopped the unit
      // (shutdown, a manual systemctl stop). Our own stops are recorded before they happen.
      return { status: 'interrupted', exit_code: null, reason: 'unit_stopped' };
    case 'exit-code': {
      const n = Number.parseInt(status ?? '', 10);
      return { status: 'failed', exit_code: Number.isInteger(n) ? n : null };
    }
    case 'timeout': return { status: 'timed_out', exit_code: null, reason: 'runtime_max' };
    case 'oom-kill': return { status: 'oom', exit_code: null, reason: 'oom_kill' };
    case 'signal':
      return STOP_SIGNALS.has(status)
        ? { status: 'interrupted', exit_code: null, reason: `signal_${status}` }
        : { status: 'failed', exit_code: null, reason: `signal_${status ?? 'unknown'}` };
    case 'core-dump': return { status: 'failed', exit_code: null, reason: `core_dump_${status ?? 'unknown'}` };
    case DISPATCH_REFUSED:
      return reason === 'cancelled_before_start'
        ? { status: 'cancelled', exit_code: null, reason }
        : { status: 'failed', exit_code: null, reason: DISPATCH_REFUSED };
    default: return { status: 'failed', exit_code: null, reason: `unit_${result}` };
  }
}

// `systemctl show` Key=Value lines -> object (first occurrence wins, values bounded).
export function parseShowOutput(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i);
    if (!/^[A-Za-z]{1,40}$/.test(key) || key in out) continue;
    out[key] = line.slice(i + 1).trim().slice(0, 80);
  }
  return out;
}

export function execSystemctl(command, args) {
  return new Promise(resolve => {
    execFile(command, args, {
      timeout: SHOW_TIMEOUT_MS, maxBuffer: SHOW_MAX_BUFFER, killSignal: 'SIGKILL', windowsHide: true,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' }
    }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout) });
      if (error.code === 'ENOENT') return resolve({ code: null, missing: true });
      if (error.killed || error.signal) return resolve({ code: null, timedOut: true });
      resolve({ code: typeof error.code === 'number' ? error.code : 1, stdout: String(stdout ?? '') });
    });
  });
}

function tailText(buffer, cut) {
  let text = buffer.toString('utf8');
  if (cut) text = text.slice(text.indexOf('\n') + 1);
  return text;
}

/**
 * root: the runner tree (/var/lib/memo-runner). systemctl/run: the read-only unit query
 * (tests inject a fake). statusOwnerUid: who must own status.json (root; tests use their own
 * uid). limits: what is recorded with each job (from runner.json).
 */
export function createSystemdExecutor({ root = DEFAULT_RUNNER_ROOT, systemctl = SYSTEMCTL, run = execSystemctl,
  statusOwnerUid = 0, limits = {}, maxQueue } = {}) {
  const paths = runnerPaths(root);
  const didOf = job => dispatchIdOfUnit(job.unit) ?? dispatchIdFor(job.id);
  const statusPath = did => join(paths.jobs, did, 'status.json');
  const logPath = did => join(paths.jobs, did, 'out', 'job.log');
  const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };

  const executor = {
    kind: 'systemd',
    queueing: true,
    paths,
    // Bound on queued plus running jobs per host (runner.json max_queue); jobs.mjs refuses beyond.
    ...(Number.isInteger(maxQueue) ? { maxQueue } : {}),
    sandbox() {
      // The isolation is the unit itself (memo-job, memo-dev.slice, lab-infra). Without the
      // spool there is no dispatcher to hand jobs to.
      if (!isDir(paths.queue) || !isDir(paths.cancel)) return { ok: false, error: 'runner_unavailable', detail: 'spool' };
      return { ok: true, mode: 'systemd' };
    },
    prepare({ jobId }) {
      const did = dispatchIdFor(jobId);
      return { ok: true, logPath: logPath(did), unit: unitFor(did), limits: { executor: 'systemd', ...limits } };
    },
    // Hand the job to the dispatcher. Idempotent: the same job always writes the same name.
    async launch({ job, worktreePath }) {
      const did = didOf(job);
      if (!DISPATCH_ID_RE.test(did)) return { ok: false, error: 'invalid_dispatch_id' };
      const spec = spoolSpec({ dispatchId: did, jobId: job.id, recipe: job.recipe, worktree: worktreePath,
        timeoutSeconds: Math.round(job.timeout_ms / 1000) });
      try {
        writeAtomic(paths.queue, `${did}.json`, `${JSON.stringify(spec)}\n`);
      } catch (error) {
        return { ok: false, error: 'spool_unavailable', detail: String(error?.code ?? 'write_failed') };
      }
      return { ok: true, unit: unitFor(did), dispatch_id: did };
    },
    pendingDispatch(job) {
      return existsSync(join(paths.queue, `${didOf(job)}.json`));
    },
    // Withdraw a spool file the dispatcher has not taken yet, and ask it to stop the unit.
    // A cancel for an id the dispatcher never saw stops nothing (cancel_unknown_job).
    stop(job, { reason = 'cancelled' } = {}) {
      const did = didOf(job);
      let withdrawn = false;
      try { unlinkSync(join(paths.queue, `${did}.json`)); withdrawn = true; } catch { /* taken already, or never written */ }
      try {
        writeAtomic(paths.cancel, did, `${JSON.stringify({ version: SPOOL_VERSION, id: did, reason: cancelReasonFor(reason) })}\n`);
      } catch (error) {
        return { ok: false, withdrawn, error: 'spool_unavailable', detail: String(error?.code ?? 'write_failed') };
      }
      return { ok: true, withdrawn };
    },
    async show(job) {
      const unit = job.unit ?? unitFor(didOf(job));
      if (!UNIT_RE.test(unit)) return { ok: false, error: 'invalid_unit' };
      const r = await run(systemctl, ['show', '--no-pager', '--property=LoadState,ActiveState,SubState,Result', unit]);
      if (r.code !== 0) return { ok: false, error: r.missing ? 'systemctl_missing' : r.timedOut ? 'systemctl_timeout' : 'systemctl_failed' };
      const p = parseShowOutput(r.stdout);
      if (!p.ActiveState) return { ok: false, error: 'systemctl_unparsable' };
      return { ok: true, unit, load: p.LoadState ?? null, active_state: p.ActiveState, sub_state: p.SubState ?? null,
        result: p.Result ?? null, active: ACTIVE_STATES.has(p.ActiveState) };
    },
    async alive(job) {
      const s = await executor.show(job);
      return s.ok ? s.active : null;
    },
    result(job) {
      const did = didOf(job);
      return readStatusFile(statusPath(did), did, { ownerUid: statusOwnerUid });
    },
    // Last lines of the job's output for the summary (display only, never a status).
    summary(job) {
      const read = readNoFollow(logPath(didOf(job)), SUMMARY_TAIL_BYTES, { fromEnd: true });
      if (!read) return null;
      const text = tailText(read.buffer, read.stat.size > read.buffer.length);
      const lines = text.split('\n').filter(l => l.trim()).slice(-20).join('\n');
      return lines.slice(-SUMMARY_CHARS) || null;
    },
    // Bounded tail for job_results; { text, size, cut } like jobs.mjs readTail, or null.
    readLog(job, maxBytes = RESULTS_MAX_BYTES) {
      const read = readNoFollow(logPath(didOf(job)), Math.min(maxBytes, RESULTS_MAX_BYTES), { fromEnd: true });
      if (!read) return null;
      const cut = read.stat.size > read.buffer.length;
      return { text: tailText(read.buffer, cut), size: read.stat.size, cut };
    },
    // Synchronous, inside a write transaction: apply a final status file if root wrote one.
    reconcile(repo, job, at) {
      if (!job.unit) return job;
      const settled = !['dispatched', 'running'].includes(job.status);
      if (settled && hasEvent(repo, job.id, 'exit')) return job;
      if (!settled || hasEvent(repo, job.id, 'dispatched')) {
        const r = executor.result(job);
        if (r.ok) return applyUnitResult(repo, job, r.result, at, { summary: executor.summary(job) });
      }
      return job;
    },
    logPath: job => logPath(didOf(job)),
    logRoot: () => paths.jobs
  };
  return executor;
}

export function hasEvent(repo, jobId, kind) {
  return repo.listJobEvents(jobId, 0, 1000).some(e => e.kind === kind);
}

// Record systemd's verdict once. A job still dispatched or running takes the mapped status;
// a job we already ended (cancelled, budget_exceeded, interrupted by the supervisor) keeps
// its status and only gains the exit event and code.
export function applyUnitResult(repo, job, result, at, { summary = null } = {}) {
  if (hasEvent(repo, job.id, 'exit')) return repo.getJob(job.id) ?? job;
  const outcome = statusFromResult(result);
  const detail = { service_result: result.service_result, exit_code: result.exit_code, exit_status: result.exit_status,
    ...(result.reason ? { root_reason: result.reason } : {}) };
  if (job.status === 'dispatched' || job.status === 'running') {
    const patch = { status: outcome.status, exit_code: outcome.exit_code, ended_at: result.ended_at ?? at,
      started_at: job.started_at ?? result.started_at ?? null, summary: summary ?? job.summary ?? null,
      status_reason: outcome.reason ?? null };
    if (repo.updateJob(job.id, patch, job.status)) {
      repo.appendJobEvent({ job_id: job.id, at, kind: 'exit', detail: JSON.stringify({ ...detail, status: outcome.status }) });
      return { ...job, ...patch };
    }
  }
  const current = repo.getJob(job.id);
  repo.appendJobEvent({ job_id: job.id, at, kind: 'exit', detail: JSON.stringify({ ...detail, status: current.status, unit_status: outcome.status }) });
  const patch = {};
  if (current.exit_code === null && outcome.exit_code !== null) patch.exit_code = outcome.exit_code;
  if (current.summary === null && summary) patch.summary = summary;
  if (Object.keys(patch).length) repo.updateJob(job.id, patch, current.status);
  return repo.getJob(job.id);
}
