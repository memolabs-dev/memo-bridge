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
// Executors (Phase 4, executor.mjs): the steps above are the local executor
// (executor-local.mjs), the Mac behaviour of Phase 3, unchanged: at its maximum number of
// jobs, jobs_submit refuses with host_busy. On the VPS the systemd executor
// (executor-systemd.mjs, MEMO_BRIDGE_JOB_EXECUTOR=systemd) queues instead: jobs_submit records
// the job 'queued' and returns; the supervisor (supervisor.mjs) admits it, hands it to the
// root dispatcher through the spool, follows the unit, and records the status root wrote
// from systemd's own result. The job's code never writes the store there.
//
// Version skew: `pnpm run install:local` replaces job-runner.mjs under servers that are still
// running. The runner protocol is passed first on the runner's command line; a runner refuses
// a job launched with another protocol, and a runner older than the protocol argument reads
// it as its state directory and refuses too (not absolute). Bump it on any change to the job
// rows, the job events or the runner's arguments.
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownsWorkspace, workerFor } from '../coordinator/policy.mjs';
import { parseIssueRef } from '../coordinator/issue-lease.mjs';
import { CLIENT_REQUEST_ID_RE, requestKey } from '../coordinator/store.mjs';
import { ACTIVE_JOB_STATUSES, JOB_STATUSES as ALL_JOB_STATUSES, STARTED_JOB_STATUSES, executorKindFromEnv, nudgeSupervisor,
  unavailableExecutor } from './executor.mjs';
import { KILL_GRACE_MS, createLocalExecutor, jobsDir, leaderStartOf, logPathFor, reconcileLocalJob } from './executor-local.mjs';
import { RESULTS_MAX_BYTES, createSystemdExecutor, runnerRootFromEnv } from './executor-systemd.mjs';
import { jobConcurrencyLimit } from './hosts.mjs';
import { signalJobGroup } from './processes.mjs';
import { RECIPE_NAMES, detectRecipes } from './recipes.mjs';
import { loadRunnerConfig } from './resources.mjs';
import { remotePolicyFromEnv, requestMeta, sessionBindingDecision } from '../../bridge/write-gate.mjs';

// Moved to executor-local.mjs (the local executor); re-exported for job-runner.mjs, the
// Coordinator, worktrees.mjs and the Phase 3 tests.
export { DEADLINE_GRACE_MS, KILL_GRACE_MS, groupAlive, jobsDir, leaderStartOf, logPathFor, processAlive, signalGroup }
  from './executor-local.mjs';

export const RUNNER_PROTOCOL = 2;

export const JOB_ID_RE = /^job_[A-Za-z0-9_-]{16}$/;
const WS_RE = /^ws_[A-Za-z0-9_-]{16}$/;
// Worktree ids are minted by the worktree module; only their shape is bounded here.
const WORKTREE_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Phase 4 adds deferred, dispatched, oom and budget_exceeded (store SCHEMA_V3). The local
// executor never produces them, so a Mac job moves through the Phase 3 statuses only.
export const JOB_STATUSES = ALL_JOB_STATUSES;
const ACTIVE = new Set(ACTIVE_JOB_STATUSES);
export const TIMEOUT_SECONDS = Object.freeze({ default: 15 * 60, min: 1, max: 60 * 60 });
export const LOG_CAP_BYTES = 5 * 1024 * 1024;
export const RESULTS = Object.freeze({ defaultLines: 100, maxLines: 400, maxBytes: 64 * 1024 });
const MAX_LIST = 200;
const MAX_EVENTS = 200;
// Queueing executors (VPS): jobs waiting or running per host beyond which jobs_submit refuses.
export const MAX_QUEUE = 20;

export const DEFAULT_RUNNER_PATH = fileURLToPath(new URL('./job-runner.mjs', import.meta.url));

// Results the model sees as refusals rather than faults; both are journaled.
const DENIED = new Set(['forbidden', 'workspace_closed', 'worktree_removed', 'wrong_host', 'no_live_claim', 'host_busy',
  'stale_lease', 'lease_held', 'issue_changed', 'lease_denied', 'queue_full', 'session_mismatch']);

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

// The concurrency limit has one source, hosts.mjs (MEMO_BRIDGE_MAX_JOBS for the local
// executor, 1 for the systemd executor); host_resources reports the same number.
export function maxJobsFromEnv(env = process.env) {
  return jobConcurrencyLimit(env);
}

// The executor this host uses, from MEMO_BRIDGE_JOB_EXECUTOR. The systemd executor reads the
// runner tree from MEMO_BRIDGE_RUNNER_ROOT and the recorded limits from runner.json.
export function defaultExecutor(env = process.env, { runnerPath = DEFAULT_RUNNER_PATH, nodePath = process.execPath, spawnRunner } = {}) {
  const kind = executorKindFromEnv(env);
  if (!kind.ok) return unavailableExecutor(kind.error, kind.detail);
  if (kind.kind === 'local') return createLocalExecutor({ runnerPath, nodePath, env, spawnRunner });
  const root = runnerRootFromEnv(env);
  if (!root.ok) return unavailableExecutor(root.error, root.detail);
  const config = loadRunnerConfig(env.MEMO_BRIDGE_RUNNER_CONFIG);
  return createSystemdExecutor({ root: root.root, maxQueue: config.max_queue,
    policy: { recipes: config.recipes, max_timeout_seconds: config.max_timeout_seconds },
    limits: { slice: 'memo-dev.slice', disk_budget_gib: config.disk_budget_gib } });
}

function parseDetail(detail) {
  if (detail === null || detail === undefined) return null;
  try { return JSON.parse(detail); } catch { return cleanLine(detail).slice(0, 500); }
}

// Phase 4 fields appear only when set, so a Mac job reads exactly as in Phase 3.
export function publicJob(j) {
  let argv = [];
  try { argv = JSON.parse(j.argv_json); } catch { /* recorded by this module, always JSON */ }
  let limits = null;
  try { limits = j.limits_json ? JSON.parse(j.limits_json) : null; } catch { limits = null; }
  return {
    job_id: j.id, workspace_id: j.workspace_id, worktree_id: j.worktree_id, project: j.project_id, host: j.host,
    recipe: j.recipe, argv, status: j.status, exit_code: j.exit_code,
    timeout_seconds: Math.round(j.timeout_ms / 1000), created_at: iso(j.created_at), started_at: iso(j.started_at),
    ended_at: iso(j.ended_at), summary: j.summary === null || j.summary === undefined ? null : lastLines(j.summary, 40).join('\n'),
    ...(j.status_reason ? { status_reason: cleanLine(j.status_reason).slice(0, 80) } : {}),
    ...(j.unit ? { unit: j.unit } : {}),
    ...(limits ? { limits } : {}),
    ...(j.release_on_finish ? { release_on_finish: true } : {})
  };
}
function publicEvent(e) {
  return { seq: e.seq, at: iso(e.at), kind: e.kind, detail: parseDetail(e.detail) };
}

// Signal a job's process group, only if it is still that job's group.
function signalJob(repo, job, signal, signalFn = signalJobGroup) {
  return Number.isInteger(job.pid) ? signalFn(job.pid, leaderStartOf(repo, job.id), signal) : false;
}

// Bring a job row up to date with its executor, inside a write transaction. A local job
// (no unit) is checked against its processes (executor-local.mjs, Phase 3). A systemd job
// (unit set from submission on) is never judged by process liveness: this process cannot see
// memo-job's processes. It only takes the final status root recorded, when an executor is
// given; otherwise the supervisor brings it up to date.
export function reconcileJob(repo, job, at, options = {}) {
  if (!ACTIVE.has(job.status) && !job.unit) return job;
  if (job.unit) return options.executor?.kind === 'systemd' ? options.executor.reconcile(repo, job, at) : job;
  return reconcileLocalJob(repo, job, at, options);
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
// A systemd job (unit set) has no pid here: the supervisor sees it cancelled and asks the
// dispatcher to stop its unit (supervisor.mjs, stop sweep).
export function cancelActiveJobs(repo, { workspaceId, issueRef = null }, at, by) {
  const stopped = [];
  for (const status of ACTIVE) {
    for (const job of repo.listJobs({ workspace_id: workspaceId, status, limit: 1000 })) {
      if (issueRef && repo.getWorktree(job.worktree_id)?.issue_ref !== issueRef) continue;
      if (!repo.updateJob(job.id, { status: 'cancelled', ended_at: at }, status)) continue;
      repo.appendJobEvent({ job_id: job.id, at, kind: 'cancelled', detail: JSON.stringify({ from: status, by, reason: issueRef ? 'claim_released' : 'workspace_closed' }) });
      stopped.push({ job_id: job.id, pid: job.pid ?? null, pid_start: leaderStartOf(repo, job.id), unit: job.unit ?? null });
    }
  }
  if (stopped.some(j => j.unit)) nudgeSupervisor();
  return stopped;
}

// SIGTERM now and SIGKILL after the grace, each only while the group is still the job's.
export function stopCancelledJobs(stopped, { killGraceMs = KILL_GRACE_MS, signal = signalJobGroup } = {}) {
  for (const job of stopped) {
    if (!Number.isInteger(job.pid) || job.unit) continue;
    signal(job.pid, job.pid_start, 'SIGTERM');
    setTimeout(() => signal(job.pid, job.pid_start, 'SIGKILL'), killGraceMs).unref();
  }
}

// ---------------------------------------------------------------------------------------

export function createJobService(rt, { runnerPath = DEFAULT_RUNNER_PATH, nodePath = process.execPath,
  maxJobs, killGraceMs = KILL_GRACE_MS, spawnRunner, env = process.env, executor, maxQueue,
  remotePolicy = typeof rt?.remotePolicy === 'function' ? rt.remotePolicy() : remotePolicyFromEnv(env) } = {}) {
  const read = fn => rt.store().transaction(repo => fn(repo, rt.now()), { write: false });
  const write = fn => rt.store().transaction(repo => fn(repo, rt.now()));
  const exec = executor ?? defaultExecutor(env, { runnerPath, nodePath, spawnRunner });
  const queueCap = maxQueue ?? exec.maxQueue ?? MAX_QUEUE;
  const limit = maxJobs ?? (exec.queueing ? 1 : maxJobsFromEnv(env));
  const reconcile = (repo, job, at) => reconcileJob(repo, job, at, { executor: exec });

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

  // D8 (REQ-P5-11, fix F4): a job submitted or cancelled from a conversation other than the one
  // the workspace is bound to. ctx.meta is the hub's per-request metadata, never tool arguments;
  // in 'warn' mode the call goes on and the tool result carries session_warning.
  function sessionCheck(workspace, ctx) {
    const decision = sessionBindingDecision(workspace?.client_session, requestMeta(ctx?.meta).client_session, remotePolicy?.session_binding);
    if (decision.ok && decision.warning && ctx) ctx.sessionWarning = decision.warning;
    return decision;
  }
  const requestIds = ctx => { const id = requestMeta(ctx?.meta).request_id; return id ? { request_id: id } : {}; };

  // Load a job and check that the caller's principal owns its workspace.
  async function ownedJob(op, jobId, { reconcile: refresh = true } = {}) {
    if (!JOB_ID_RE.test(jobId ?? '')) return { error: fail('invalid_input', 'job_id') };
    const found = await (refresh ? write : read)((repo, at) => {
      const job = repo.getJob(jobId);
      if (!job) return null;
      const workspace = repo.getWorkspace(job.workspace_id);
      return { job: refresh ? reconcile(repo, job, at) : job, workspace };
    });
    if (!found) return { error: fail('unknown_job') };
    if (!ownsWorkspace(rt.principal, found.workspace)) {
      return { error: await denied(op, { workspace_id: found.job.workspace_id }) };
    }
    return found;
  }

  // The context record of a VPS job: where its code came from and what bounded it. The lease
  // is the mirror's current view: the supervisor renews it while the job waits or runs, which
  // moves the fence, so a client resumes with this fence rather than the one it claimed with.
  async function contextOf(job) {
    if (!job.unit) return null;
    const { worktree, claim } = await read(repo => ({ worktree: repo.getWorktree(job.worktree_id),
      claim: job.claim_id ? repo.getClaim(job.claim_id) : null }));
    return { project: job.project_id, issue: worktree?.issue_ref ?? null, branch: worktree?.branch ?? null,
      base_commit: worktree?.base_commit ?? null, host: job.host, unit: job.unit, claim_id: job.claim_id ?? null,
      ...(claim ? { lease: { state: claim.state, fence: claim.fence_sha, expires_at: claim.expires_at } } : {}) };
  }

  const service = {
    executor: exec,

    async submit(args = {}, ctx = {}) {
      const op = 'jobs_submit';
      if (!rt.authorize(op)) return denied(op);
      const { workspace_id: workspaceId, worktree_id: worktreeId, recipe } = args;
      if (!WS_RE.test(workspaceId ?? '')) return journal(op, fail('invalid_input', 'workspace_id'));
      const ids = { workspace_id: workspaceId, ...requestIds(ctx) };
      if (!WORKTREE_RE.test(worktreeId ?? '')) return journal(op, fail('invalid_input', 'worktree_id'), ids);
      if (!RECIPE_NAMES.includes(recipe)) return journal(op, fail('unknown_recipe', `allowed: ${RECIPE_NAMES.join(', ')}`), ids);
      const timeoutSeconds = args.timeout_seconds ?? TIMEOUT_SECONDS.default;
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < TIMEOUT_SECONDS.min || timeoutSeconds > TIMEOUT_SECONDS.max) {
        return journal(op, fail('invalid_input', 'timeout_seconds'), ids);
      }
      // The VPS runner's own limits (runner.json, also enforced by the root dispatcher).
      const policy = exec.policy ?? null;
      if (policy?.recipes && !policy.recipes.includes(recipe)) {
        return journal(op, fail('recipe_not_allowed', policy.recipes.length ? `allowed on this host: ${policy.recipes.join(', ')}` : 'no recipe is allowed on this host'), ids);
      }
      if (Number.isInteger(policy?.max_timeout_seconds) && timeoutSeconds > policy.max_timeout_seconds) {
        return journal(op, fail('invalid_input', `timeout_seconds above this host's maximum (${policy.max_timeout_seconds})`), ids);
      }
      if (args.client_request_id !== undefined && !CLIENT_REQUEST_ID_RE.test(String(args.client_request_id))) {
        return journal(op, fail('invalid_input', 'client_request_id'), ids);
      }
      if (args.release_on_finish !== undefined && typeof args.release_on_finish !== 'boolean') {
        return journal(op, fail('invalid_input', 'release_on_finish'), ids);
      }
      // Only the VPS supervisor releases claims; on the Mac the flag would be silently ignored.
      if (args.release_on_finish === true && !exec.queueing) {
        return journal(op, fail('invalid_input', 'release_on_finish needs the VPS runner'), ids);
      }
      // Idempotency (REQ-P4-07): a retry with the same client_request_id returns the job the
      // first call created, whatever happened to it since, and starts nothing.
      const key = args.client_request_id === undefined ? null : requestKey(rt.principal.id, op, args.client_request_id);
      const replay = async jobId => {
        const job = await write((repo, at) => { const j = repo.getJob(jobId); return j ? reconcile(repo, j, at) : null; });
        return job ? journal(op, { ok: true, job: publicJob(job), replayed: true }, ids) : journal(op, fail('store_unavailable'), ids);
      };
      if (key) {
        const first = await read(repo => repo.getRequest(key));
        if (first) {
          let stored = null;
          try { stored = JSON.parse(first.result_json); } catch { stored = null; }
          return stored?.job_id ? replay(stored.job_id) : journal(op, fail('store_unavailable'), ids);
        }
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
      const bound = sessionCheck(workspace, ctx);
      if (!bound.ok) return journal(op, bound, ids);
      // Another workspace's worktree is reported as unknown, never described.
      if (!worktree || worktree.workspace_id !== workspace.id) return journal(op, fail('unknown_worktree'), ids);
      const issueIds = { ...ids, issue: worktree.issue_ref ?? undefined };
      if (worktree.status !== 'active') return journal(op, fail('worktree_removed'), issueIds);
      if (worktree.host !== rt.host) return journal(op, fail('wrong_host', worktree.host), issueIds);
      if (!context.claim) return journal(op, fail('no_live_claim', worktree.issue_ref ? 'claim expired or released' : 'worktree has no issue'), issueIds);
      // Jobs run only inside the job sandbox (macOS) or a memo-job unit (VPS), unless the owner
      // switched the Mac sandbox off.
      const sandbox = exec.sandbox();
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

      // Local: the log file exists before the job row, so the runner never has to create it.
      // systemd: only the names (log under the runner tree, unit) are chosen here.
      const jobId = newJobId();
      try { rt.store(); } catch { return journal(op, fail('store_unavailable', 'job_log'), issueIds); } // opens (and creates) the private state directory first
      const prepared = exec.prepare({ stateDir: rt.stateDir, jobId });
      if (!prepared.ok) return journal(op, fail(prepared.error, prepared.detail), issueIds);
      const logPath = prepared.logPath;
      const dropLog = () => { if (!exec.queueing) { try { unlinkSync(logPath); } catch { /* best effort */ } } };
      const limits = prepared.limits ? { ...prepared.limits, timeout_seconds: timeoutSeconds } : null;

      // Count and insert in one write transaction so two sessions cannot both take the last slot.
      let inserted;
      try {
        inserted = await write((repo, at) => {
          if (key) {
            const first = repo.getRequest(key);
            if (first) return { replayOf: JSON.parse(first.result_json).job_id };
          }
          if (exec.queueing) {
            // The VPS queues (REQ-P4-04): only a bound on the queue itself refuses.
            const depth = repo.countJobs({ host: rt.host, statuses: [...ACTIVE] });
            if (depth >= queueCap) return { full: depth };
          } else {
            const active = [...ACTIVE].flatMap(status => repo.listJobs({ host: rt.host, status, limit: 1000 }))
              .map(job => reconcile(repo, job, at))
              .filter(job => ACTIVE.has(job.status));
            if (active.length >= limit) return { busy: active.length };
          }
          // Re-check the claim under the write lock: it may have been released meanwhile.
          const claim = liveClaim(repo, workspace.id, worktree.issue_ref, at);
          if (!claim) return { noClaim: true };
          const row = { id: jobId, workspace_id: workspace.id, worktree_id: worktree.id, project_id: worktree.project_id,
            host: rt.host, recipe, argv_json: JSON.stringify(argv), timeout_ms: timeoutSeconds * 1000, log_path: logPath,
            created_at: at, claim_id: claim.claim_id, unit: prepared.unit ?? null, limits_json: limits ? JSON.stringify(limits) : null,
            release_on_finish: args.release_on_finish === true, principal: rt.principal.id };
          repo.insertJob(row);
          if (key) repo.insertRequest({ key, principal: rt.principal.id, op, result_json: JSON.stringify({ job_id: jobId }), created_at: at });
          if (exec.queueing) {
            repo.appendJobEvent({ job_id: jobId, at, kind: 'submitted', detail: JSON.stringify({ recipe, queued: true }) });
          }
          return { job: repo.getJob(jobId) };
        });
      } catch {
        inserted = { storeError: true };
      }
      if (!inserted.job) {
        dropLog();
        if (inserted.replayOf) return replay(inserted.replayOf);
        if (inserted.busy !== undefined) {
          return journal(op, fail('host_busy', `${inserted.busy}/${limit} jobs active on this host; queueing is not available yet, retry later`), issueIds);
        }
        if (inserted.full !== undefined) {
          return journal(op, fail('queue_full', `${inserted.full}/${queueCap} jobs queued or running on this host; retry later`), issueIds);
        }
        if (inserted.noClaim) return journal(op, fail('no_live_claim', 'claim expired or released'), issueIds);
        return journal(op, fail('store_unavailable'), issueIds);
      }

      if (exec.queueing) {
        // The supervisor admits and dispatches it; the job outlives this connection.
        nudgeSupervisor();
        return journal(op, { ok: true, job: publicJob(inserted.job) }, issueIds);
      }
      const launched = await exec.launch({ stateDir: rt.stateDir, job: inserted.job, protocol: RUNNER_PROTOCOL });
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
      const max = args.limit ?? 50;
      if (!Number.isInteger(max) || max < 1 || max > MAX_LIST) return fail('invalid_input', 'limit');
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
          .map(job => reconcile(repo, job, at))
          .filter(job => !args.status || job.status === args.status)
          .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
          .slice(0, max);
      });
      return { ok: true, jobs: jobs.map(publicJob) };
    },

    async status(args = {}) {
      const op = 'job_status';
      if (!rt.authorize(op)) return denied(op);
      const found = await ownedJob(op, args.job_id);
      if (found.error) return found.error;
      const context = await contextOf(found.job);
      return { ok: true, job: publicJob(found.job), ...(context ? { context } : {}) };
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
      let lines = []; let size = 0; let cut = false;
      let t = null;
      if (job.unit) {
        // VPS: the log is written by memo-job; it is opened without following symlinks and
        // only at the path the executor names, never the one in the row.
        if (exec.kind === 'systemd' && job.log_path === exec.logPath(job)) t = exec.readLog(job, RESULTS_MAX_BYTES);
      } else {
        // Only ever read the log this module named; the path in the row is double-checked.
        const expected = logPathFor(rt.stateDir, job.id);
        if (job.log_path === expected && existsSync(expected)) {
          const real = realpathSync(expected);
          if (real.startsWith(realpathSync(jobsDir(rt.stateDir)) + sep)) t = readTail(real, RESULTS.maxBytes);
        }
      }
      if (t) {
        lines = lastLines(t.text, tail); size = t.size;
        cut = t.cut || t.text.replace(/\n$/, '').split('\n').length > tail;
      }
      const context = await contextOf(job);
      return { ok: true, job: publicJob(job), log: { lines, bytes: size, truncated_to_tail: cut }, ...(context ? { context } : {}) };
    },

    async cancel(args = {}, ctx = {}) {
      const op = 'job_cancel';
      if (!rt.authorize(op)) return denied(op);
      if (!JOB_ID_RE.test(args.job_id ?? '')) return journal(op, fail('invalid_input', 'job_id'));
      const found = await ownedJob(op, args.job_id);
      if (found.error) return found.error.error === 'forbidden' ? found.error : journal(op, found.error);
      const ids = { workspace_id: found.job.workspace_id, ...requestIds(ctx) };
      const bound = sessionCheck(found.workspace, ctx);
      if (!bound.ok) return journal(op, bound, ids);
      const outcome = await write((repo, at) => {
        const job = repo.getJob(found.job.id);
        if (!ACTIVE.has(job.status)) return { finished: job };
        // Signal first, then record: the runner sees 'cancelled' and escalates to SIGKILL too.
        if (job.status === 'running' && !job.unit) signalJob(repo, job, 'SIGTERM');
        if (!repo.updateJob(job.id, { status: 'cancelled', ended_at: at }, job.status)) return { finished: repo.getJob(job.id) };
        repo.appendJobEvent({ job_id: job.id, at, kind: 'cancelled', detail: JSON.stringify({ from: job.status, by: rt.principal.id }) });
        return { cancelled: { ...job, status: 'cancelled', ended_at: at }, pidStart: leaderStartOf(repo, job.id), from: job.status };
      });
      if (outcome.finished) {
        return journal(op, fail('job_finished', outcome.finished.status), ids);
      }
      const job = outcome.cancelled;
      if (job.unit) {
        // A queued or deferred job never started: nothing to stop (REQ-P4-20). A dispatched or
        // running one is stopped through the dispatcher; the supervisor retries if this fails.
        if (STARTED_JOB_STATUSES.includes(outcome.from) && exec.kind === 'systemd') {
          const stopped = exec.stop(job);
          await write((repo, at) => repo.appendJobEvent({ job_id: job.id, at, kind: 'stop_requested',
            detail: JSON.stringify({ by: 'job_cancel', ok: stopped.ok, withdrawn: Boolean(stopped.withdrawn) }) })).catch(() => {});
        }
        nudgeSupervisor();
      } else if (job.pid) {
        // Escalation from this process too, in case the runner itself is gone; never to a
        // group id that has been reused since.
        setTimeout(() => signalJobGroup(job.pid, outcome.pidStart, 'SIGKILL'), killGraceMs).unref();
      }
      return journal(op, { ok: true, job: publicJob(job) }, ids);
    }
  };
  return service;
}
