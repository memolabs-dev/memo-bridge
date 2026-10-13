// Jobs: predefined recipes (test, build, lint) executed on the local host, outside the MCP
// session. The service validates and records a job, then hands it to job-runner.mjs, a
// detached process that runs the recipe, writes the log and records the outcome. Closing
// the MCP session therefore never stops a job; job_cancel and the timeout do.
//
// Execution model, in order:
//   jobs_submit  -> job row 'queued', log file <stateDir>/jobs/<id>.log (0600), event 'submitted'
//                -> spawns `node job-runner.mjs --protocol=<RUNNER_PROTOCOL> <stateDir> <jobId>`
//                   detached (own process group)
//   job-runner   -> CAS queued->running (pid of the job's process group), event 'started'
//                -> runs the recipe inside the job sandbox (sandbox.mjs), follows every process
//                   it starts (processes.mjs), stops it when the claim, the worktree or the
//                   workspace goes away
//                -> succeeded | failed | timed_out | cancelled, events 'exit' / 'timeout'
//   job_cancel   -> SIGTERM to the job's process group, CAS ->cancelled, SIGKILL after 5 s
//   workspace_close, task_release, task_complete -> cancelActiveJobs (same as job_cancel)
//   any read     -> a running/queued job whose processes are all gone becomes 'interrupted';
//                   a running job past its timeout plus a grace is killed and 'timed_out'
//                   (the runner itself may have been killed)
//
// Signals sent from here check the group leader's start time first (processes.mjs), so a
// reused process group id never receives them.
//
// Bundled build: index.mjs is bundled into plugin/server/dist/. The runner is resolved as
// './job-runner.mjs' next to the file that contains this code, so the bundle must ship
// dist/job-runner.mjs (a second esbuild entry for server/runners/job-runner.mjs). Callers
// can also inject `runnerPath`.
//
// Queueing is a later phase: when the host already runs its maximum number of jobs,
// jobs_submit refuses with host_busy instead of waiting.
//
// Version skew: `npm run install:local` replaces job-runner.mjs under servers that are still
// running. The runner protocol is passed first on the runner's command line; a runner refuses
// a job launched with another protocol, and a runner older than the protocol argument reads
// it as its state directory and refuses too (not absolute). Bump it on any change to the job
// rows, the job events or the runner's arguments.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownsWorkspace, workerFor } from '../coordinator/policy.mjs';
import { parseIssueRef } from '../coordinator/issue-lease.mjs';
import { signalJobGroup } from './processes.mjs';
import { RECIPE_NAMES, detectRecipes } from './recipes.mjs';
import { sandboxMode } from './sandbox.mjs';

export const RUNNER_PROTOCOL = 2;

export const JOB_ID_RE = /^job_[A-Za-z0-9_-]{16}$/;
const WS_RE = /^ws_[A-Za-z0-9_-]{16}$/;
// Worktree ids are minted by the worktree module; only their shape is bounded here.
const WORKTREE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const JOB_STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const ACTIVE = new Set(['queued', 'running']);
export const TIMEOUT_SECONDS = Object.freeze({ default: 15 * 60, min: 1, max: 60 * 60 });
export const KILL_GRACE_MS = 5000;
// A running job past timeout + this grace is killed by the next read, in case its runner died
// (or was killed) and can no longer enforce the timeout itself.
export const DEADLINE_GRACE_MS = KILL_GRACE_MS + 30_000;
export const LOG_CAP_BYTES = 5 * 1024 * 1024;
export const RESULTS = Object.freeze({ defaultLines: 100, maxLines: 400, maxBytes: 64 * 1024 });
const MAX_LIST = 200;
const MAX_EVENTS = 200;
// A queued job whose runner pid was never recorded is only declared interrupted after this.
const QUEUED_GRACE_MS = 60_000;

export const DEFAULT_RUNNER_PATH = fileURLToPath(new URL('./job-runner.mjs', import.meta.url));

// Results the model sees as refusals rather than faults; both are journaled.
const DENIED = new Set(['forbidden', 'workspace_closed', 'worktree_removed', 'wrong_host', 'no_live_claim', 'host_busy',
  'stale_lease', 'lease_held', 'issue_changed', 'lease_denied']);

const newJobId = () => `job_${randomBytes(12).toString('base64url')}`;
const iso = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail } : {}) });

// ---------------------------------------------------------------------------------------
// Text returned to models: no ANSI escapes, no control characters, no bidi overrides.

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function cleanLine(line) {
  return String(line).replace(ANSI, '').replace(/\t/g, '  ').replace(CONTROL, '');
}

// Last `maxLines` lines of a text, each cleaned; trailing empty line dropped.
export function lastLines(text, maxLines) {
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-maxLines).map(l => cleanLine(l.replace(/\r$/, '')));
}

// Read at most `maxBytes` from the end of a file. A partial first line is dropped.
export function readTail(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, size - length + read);
      if (n === 0) break;
      read += n;
    }
    let text = buffer.subarray(0, read).toString('utf8');
    const cut = size > length;
    if (cut) text = text.slice(text.indexOf('\n') + 1);
    return { text, size, cut };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ---------------------------------------------------------------------------------------
// Process liveness. A job is identified by its process group (the runner spawns the recipe
// as a group leader); the runner itself is a separate, detached process.

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

export function maxJobsFromEnv(env = process.env) {
  const n = Number.parseInt(env.MEMO_BRIDGE_MAX_JOBS ?? '', 10);
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : 2;
}

export function jobsDir(stateDir) {
  return join(stateDir, 'jobs');
}
export function logPathFor(stateDir, jobId) {
  return join(jobsDir(stateDir), `${jobId}.log`);
}

function parseDetail(detail) {
  if (detail === null || detail === undefined) return null;
  try { return JSON.parse(detail); } catch { return cleanLine(detail).slice(0, 500); }
}

function publicJob(j) {
  let argv = [];
  try { argv = JSON.parse(j.argv_json); } catch { /* recorded by this module, always JSON */ }
  return {
    job_id: j.id, workspace_id: j.workspace_id, worktree_id: j.worktree_id, project: j.project_id, host: j.host,
    recipe: j.recipe, argv, status: j.status, exit_code: j.exit_code,
    timeout_seconds: Math.round(j.timeout_ms / 1000), created_at: iso(j.created_at), started_at: iso(j.started_at),
    ended_at: iso(j.ended_at), summary: j.summary === null ? null : lastLines(j.summary, 40).join('\n')
  };
}
function publicEvent(e) {
  return { seq: e.seq, at: iso(e.at), kind: e.kind, detail: parseDetail(e.detail) };
}

// The runner pid recorded by jobs_submit ('submitted') or by the runner ('started').
function runnerPidOf(repo, jobId) {
  let pid = null;
  for (const e of repo.listJobEvents(jobId, 0, 20)) {
    if (e.kind !== 'submitted' && e.kind !== 'started') continue;
    const d = parseDetail(e.detail);
    if (Number.isInteger(d?.runner_pid)) pid = d.runner_pid;
  }
  return pid;
}

// Start time of the job's group leader, recorded by the runner in its 'started' event.
export function leaderStartOf(repo, jobId) {
  for (const e of repo.listJobEvents(jobId, 0, 20)) {
    if (e.kind !== 'started') continue;
    const d = parseDetail(e.detail);
    if (typeof d?.pid_start === 'string') return d.pid_start;
  }
  return null;
}

// Signal a job's process group, only if it is still that job's group.
function signalJob(repo, job, signal, signalFn = signalJobGroup) {
  return Number.isInteger(job.pid) ? signalFn(job.pid, leaderStartOf(repo, job.id), signal) : false;
}

// Report a job whose processes are all gone as interrupted, and stop a running job past its
// deadline (timeout + grace) as timed_out. Runs inside a write transaction; the CAS on status
// means a runner that finishes at the same moment wins.
export function reconcileJob(repo, job, at, { alive = processAlive, aliveGroup = groupAlive, signal = signalJobGroup } = {}) {
  if (!ACTIVE.has(job.status)) return job;
  const runnerPid = runnerPidOf(repo, job.id);
  if (job.status === 'running' && Number.isInteger(job.started_at) && at > job.started_at + job.timeout_ms + DEADLINE_GRACE_MS) {
    // The runner should have stopped it long ago: it is gone or stuck. Kill the group; a live
    // runner sees the status change and also kills every process it tracks.
    signalJob(repo, job, 'SIGKILL', signal);
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

// A live claim in the local mirror: claimed, on this Issue, not expired.
export function liveClaim(repo, workspaceId, issueRef, at) {
  if (!issueRef) return null;
  return repo.claimsOf(workspaceId, 'claimed')
    .find(c => c.issue_ref === issueRef && Date.parse(c.expires_at) > at) ?? null;
}

// Cancel the active jobs of a workspace (all of them, or those on worktrees of one Issue) when
// the workspace closes or the claim is released. Runs inside a write transaction; returns what
// stopCancelledJobs needs to signal them once the transaction is committed. The runner also
// notices the status change within a second and stops every process of the job.
export function cancelActiveJobs(repo, { workspaceId, issueRef = null }, at, by) {
  const stopped = [];
  for (const status of ACTIVE) {
    for (const job of repo.listJobs({ workspace_id: workspaceId, status, limit: 1000 })) {
      if (issueRef && repo.getWorktree(job.worktree_id)?.issue_ref !== issueRef) continue;
      if (!repo.updateJob(job.id, { status: 'cancelled', ended_at: at }, status)) continue;
      repo.appendJobEvent({ job_id: job.id, at, kind: 'cancelled', detail: JSON.stringify({ from: status, by, reason: issueRef ? 'claim_released' : 'workspace_closed' }) });
      stopped.push({ job_id: job.id, pid: job.pid ?? null, pid_start: leaderStartOf(repo, job.id) });
    }
  }
  return stopped;
}

// SIGTERM now and SIGKILL after the grace, each only while the group is still the job's.
export function stopCancelledJobs(stopped, { killGraceMs = KILL_GRACE_MS, signal = signalJobGroup } = {}) {
  for (const job of stopped) {
    if (!Number.isInteger(job.pid)) continue;
    signal(job.pid, job.pid_start, 'SIGTERM');
    setTimeout(() => signal(job.pid, job.pid_start, 'SIGKILL'), killGraceMs).unref();
  }
}

// ---------------------------------------------------------------------------------------

export function createJobService(rt, { runnerPath = DEFAULT_RUNNER_PATH, nodePath = process.execPath,
  maxJobs = maxJobsFromEnv(), killGraceMs = KILL_GRACE_MS, spawnRunner, env = process.env } = {}) {
  const read = fn => rt.store().transaction(repo => fn(repo, rt.now()), { write: false });
  const write = fn => rt.store().transaction(repo => fn(repo, rt.now()));

  const launch = spawnRunner ?? ((stateDir, jobId) => new Promise(resolve => {
    let child;
    try {
      child = spawn(nodePath, [runnerPath, `--protocol=${RUNNER_PROTOCOL}`, stateDir, jobId],
        { detached: true, stdio: 'ignore', cwd: stateDir, env });
    } catch (error) {
      return resolve({ ok: false, error: String(error?.code ?? 'spawn_failed') });
    }
    child.once('error', error => resolve({ ok: false, error: String(error?.code ?? 'spawn_failed') }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true, pid: child.pid }); });
  }));

  async function denied(op, ids = {}) {
    await rt.audit(op, 'denied', 'forbidden', ids);
    return fail('forbidden');
  }
  // Write operations journal every outcome; ids are only those already validated.
  async function journal(op, result, ids = {}) {
    const outcome = result.ok ? 'ok' : DENIED.has(result.error) ? 'denied' : 'error';
    await rt.audit(op, outcome, result.ok ? null : result.error, ids);
    return result;
  }

  // Load a job and check that the caller's principal owns its workspace.
  async function ownedJob(op, jobId, { reconcile = true } = {}) {
    if (!JOB_ID_RE.test(jobId ?? '')) return { error: fail('invalid_input', 'job_id') };
    const found = await (reconcile ? write : read)((repo, at) => {
      const job = repo.getJob(jobId);
      if (!job) return null;
      const workspace = repo.getWorkspace(job.workspace_id);
      return { job: reconcile ? reconcileJob(repo, job, at) : job, workspace };
    });
    if (!found) return { error: fail('unknown_job') };
    if (!ownsWorkspace(rt.principal, found.workspace)) {
      return { error: await denied(op, { workspace_id: found.job.workspace_id }) };
    }
    return found;
  }

  const service = {
    async submit(args = {}) {
      const op = 'jobs_submit';
      if (!rt.authorize(op)) return denied(op);
      const { workspace_id: workspaceId, worktree_id: worktreeId, recipe } = args;
      if (!WS_RE.test(workspaceId ?? '')) return journal(op, fail('invalid_input', 'workspace_id'));
      const ids = { workspace_id: workspaceId };
      if (!WORKTREE_RE.test(worktreeId ?? '')) return journal(op, fail('invalid_input', 'worktree_id'), ids);
      if (!RECIPE_NAMES.includes(recipe)) return journal(op, fail('unknown_recipe', `allowed: ${RECIPE_NAMES.join(', ')}`), ids);
      const timeoutSeconds = args.timeout_seconds ?? TIMEOUT_SECONDS.default;
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < TIMEOUT_SECONDS.min || timeoutSeconds > TIMEOUT_SECONDS.max) {
        return journal(op, fail('invalid_input', 'timeout_seconds'), ids);
      }

      const context = await read((repo, at) => {
        const workspace = repo.getWorkspace(workspaceId);
        const worktree = repo.getWorktree(worktreeId);
        const claim = workspace && worktree ? liveClaim(repo, workspace.id, worktree.issue_ref, at) : null;
        return { workspace, worktree, claim };
      });
      const { workspace, worktree } = context;
      if (!workspace) return journal(op, fail('unknown_workspace'), ids);
      if (!ownsWorkspace(rt.principal, workspace)) return journal(op, fail('forbidden'), ids);
      if (workspace.status !== 'active') return journal(op, fail('workspace_closed'), ids);
      // Another workspace's worktree is reported as unknown, never described.
      if (!worktree || worktree.workspace_id !== workspace.id) return journal(op, fail('unknown_worktree'), ids);
      const issueIds = { ...ids, issue: worktree.issue_ref ?? undefined };
      if (worktree.status !== 'active') return journal(op, fail('worktree_removed'), issueIds);
      if (worktree.host !== rt.host) return journal(op, fail('wrong_host', worktree.host), issueIds);
      if (!context.claim) return journal(op, fail('no_live_claim', worktree.issue_ref ? 'claim expired or released' : 'worktree has no issue'), issueIds);
      // Jobs run only inside the job sandbox, unless the owner switched it off.
      const sandbox = sandboxMode(env);
      if (!sandbox.ok) return journal(op, fail(sandbox.error, sandbox.detail), issueIds);
      // Running code is a write boundary like a commit: the ledger confirms the lease is still
      // this workspace's (the local mirror only knows about expiry).
      let verified;
      try {
        verified = await rt.ledger.verify(parseIssueRef(worktree.issue_ref), workerFor(workspace), context.claim.claim_id, context.claim.fence_sha);
      } catch {
        verified = null;
      }
      if (!verified?.ok) return journal(op, verified?.error ? fail(verified.error, verified.detail) : fail('ledger_unavailable'), issueIds);

      let cwd;
      try {
        cwd = realpathSync(worktree.path);
        if (!statSync(cwd).isDirectory()) throw new Error('not_a_directory');
      } catch {
        return journal(op, fail('worktree_unavailable'), issueIds);
      }
      const recipes = detectRecipes(cwd);
      const argv = recipes[recipe];
      if (!argv) {
        const available = Object.keys(recipes);
        return journal(op, fail('unknown_recipe', available.length ? `available: ${available.join(', ')}` : 'no recipe detected'), issueIds);
      }

      // The log file exists before the job row, so the runner never has to create it.
      const jobId = newJobId();
      const logPath = logPathFor(rt.stateDir, jobId);
      try {
        rt.store(); // opens (and creates) the private state directory first
        mkdirSync(jobsDir(rt.stateDir), { recursive: true, mode: 0o700 });
        chmodSync(jobsDir(rt.stateDir), 0o700);
        closeSync(openSync(logPath, 'wx', 0o600));
        chmodSync(logPath, 0o600);
      } catch {
        return journal(op, fail('store_unavailable', 'job_log'), issueIds);
      }

      // Count and insert in one write transaction so two sessions cannot both take the last slot.
      let inserted;
      try {
        inserted = await write((repo, at) => {
          const active = repo.listJobs({ host: rt.host, status: 'running', limit: 1000 })
            .concat(repo.listJobs({ host: rt.host, status: 'queued', limit: 1000 }))
            .map(job => reconcileJob(repo, job, at))
            .filter(job => ACTIVE.has(job.status));
          if (active.length >= maxJobs) return { busy: active.length };
          // Re-check the claim under the write lock: it may have been released meanwhile.
          if (!liveClaim(repo, workspace.id, worktree.issue_ref, at)) return { noClaim: true };
          const row = { id: jobId, workspace_id: workspace.id, worktree_id: worktree.id, project_id: worktree.project_id,
            host: rt.host, recipe, argv_json: JSON.stringify(argv), timeout_ms: timeoutSeconds * 1000, log_path: logPath,
            created_at: at };
          repo.insertJob(row);
          return { job: repo.getJob(jobId) };
        });
      } catch {
        inserted = { storeError: true };
      }
      if (!inserted.job) {
        try { unlinkSync(logPath); } catch { /* best effort */ }
        if (inserted.busy !== undefined) {
          return journal(op, fail('host_busy', `${inserted.busy}/${maxJobs} jobs active on this host; queueing is not available yet, retry later`), issueIds);
        }
        if (inserted.noClaim) return journal(op, fail('no_live_claim', 'claim expired or released'), issueIds);
        return journal(op, fail('store_unavailable'), issueIds);
      }

      const launched = await launch(rt.stateDir, jobId);
      const final = await write((repo, at) => {
        if (launched.ok) {
          repo.appendJobEvent({ job_id: jobId, at, kind: 'submitted', detail: JSON.stringify({ runner_pid: launched.pid, recipe }) });
        } else {
          repo.updateJob(jobId, { status: 'failed', ended_at: at, summary: `runner_spawn_failed: ${launched.error}` }, 'queued');
          repo.appendJobEvent({ job_id: jobId, at, kind: 'spawn_failed', detail: JSON.stringify({ error: launched.error }) });
        }
        return repo.getJob(jobId);
      });
      if (!launched.ok) return journal(op, fail('runner_unavailable', launched.error), issueIds);
      return journal(op, { ok: true, job: publicJob(final) }, issueIds);
    },

    async list(args = {}) {
      const op = 'jobs_list';
      if (!rt.authorize(op)) return denied(op);
      const limit = args.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) return fail('invalid_input', 'limit');
      if (args.status !== undefined && !JOB_STATUSES.includes(args.status)) return fail('invalid_input', 'status');
      let workspaceIds;
      if (args.workspace_id !== undefined) {
        if (!WS_RE.test(args.workspace_id)) return fail('invalid_input', 'workspace_id');
        const workspace = await read(repo => repo.getWorkspace(args.workspace_id));
        if (!workspace) return fail('unknown_workspace');
        if (!ownsWorkspace(rt.principal, workspace)) return denied(op, { workspace_id: args.workspace_id });
        workspaceIds = [workspace.id];
      }
      const jobs = await write((repo, at) => {
        workspaceIds ??= repo.listWorkspaces({ principal: rt.principal.id, limit: MAX_LIST }).map(w => w.id);
        // Reconcile first, then filter: a job read as running may in fact be interrupted.
        return workspaceIds.flatMap(id => repo.listJobs({ workspace_id: id, limit: MAX_LIST }))
          .map(job => reconcileJob(repo, job, at))
          .filter(job => !args.status || job.status === args.status)
          .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
          .slice(0, limit);
      });
      return { ok: true, jobs: jobs.map(publicJob) };
    },

    async status(args = {}) {
      const op = 'job_status';
      if (!rt.authorize(op)) return denied(op);
      const found = await ownedJob(op, args.job_id);
      if (found.error) return found.error;
      return { ok: true, job: publicJob(found.job) };
    },

    async events(args = {}) {
      const op = 'job_events';
      if (!rt.authorize(op)) return denied(op);
      const after = args.after_seq ?? 0;
      if (!Number.isInteger(after) || after < 0) return fail('invalid_input', 'after_seq');
      const found = await ownedJob(op, args.job_id);
      if (found.error) return found.error;
      const events = await read(repo => repo.listJobEvents(found.job.id, after, MAX_EVENTS));
      return { ok: true, job_id: found.job.id, status: found.job.status, events: events.map(publicEvent),
        next_after_seq: events.length ? events[events.length - 1].seq : after, more: events.length === MAX_EVENTS };
    },

    async results(args = {}) {
      const op = 'job_results';
      if (!rt.authorize(op)) return denied(op);
      const tail = args.tail_lines ?? RESULTS.defaultLines;
      if (!Number.isInteger(tail) || tail < 1 || tail > RESULTS.maxLines) return fail('invalid_input', 'tail_lines');
      const found = await ownedJob(op, args.job_id);
      if (found.error) return found.error;
      const { job } = found;
      // Only ever read the log this module named; the path in the row is double-checked.
      const expected = logPathFor(rt.stateDir, job.id);
      let lines = []; let size = 0; let cut = false;
      if (job.log_path === expected && existsSync(expected)) {
        const real = realpathSync(expected);
        if (real.startsWith(realpathSync(jobsDir(rt.stateDir)) + sep)) {
          const t = readTail(real, RESULTS.maxBytes);
          if (t) {
            lines = lastLines(t.text, tail); size = t.size;
            cut = t.cut || t.text.replace(/\n$/, '').split('\n').length > tail;
          }
        }
      }
      return { ok: true, job: publicJob(job), log: { lines, bytes: size, truncated_to_tail: cut } };
    },

    async cancel(args = {}) {
      const op = 'job_cancel';
      if (!rt.authorize(op)) return denied(op);
      if (!JOB_ID_RE.test(args.job_id ?? '')) return journal(op, fail('invalid_input', 'job_id'));
      const found = await ownedJob(op, args.job_id);
      if (found.error) return found.error.error === 'forbidden' ? found.error : journal(op, found.error);
      const ids = { workspace_id: found.job.workspace_id };
      const outcome = await write((repo, at) => {
        const job = repo.getJob(found.job.id);
        if (!ACTIVE.has(job.status)) return { finished: job };
        // Signal first, then record: the runner sees 'cancelled' and escalates to SIGKILL too.
        if (job.status === 'running') signalJob(repo, job, 'SIGTERM');
        if (!repo.updateJob(job.id, { status: 'cancelled', ended_at: at }, job.status)) return { finished: repo.getJob(job.id) };
        repo.appendJobEvent({ job_id: job.id, at, kind: 'cancelled', detail: JSON.stringify({ from: job.status, by: rt.principal.id }) });
        return { cancelled: { ...job, status: 'cancelled', ended_at: at }, pidStart: leaderStartOf(repo, job.id) };
      });
      if (outcome.finished) {
        return journal(op, fail('job_finished', outcome.finished.status), ids);
      }
      const job = outcome.cancelled;
      if (job.pid) {
        // Escalation from this process too, in case the runner itself is gone; never to a
        // group id that has been reused since.
        setTimeout(() => signalJobGroup(job.pid, outcome.pidStart, 'SIGKILL'), killGraceMs).unref();
      }
      return journal(op, { ok: true, job: publicJob(job) }, ids);
    }
  };
  return service;
}
