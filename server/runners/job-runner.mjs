// Detached job runner: `node job-runner.mjs --protocol=<n> <stateDir> <jobId>`.
// VPS unit mode (Phase 4): `node job-runner.mjs --executor=systemd <dispatchId>` inside
// memo-job@<id>.service, see job-unit.mjs; it opens no store and decides no status.
//
// Started by jobs_submit in its own process group, it outlives the MCP session. It opens the
// private store itself, takes the job (CAS queued -> running), runs the recipe argv without a
// shell in the worktree at lower priority and inside the job sandbox (sandbox.mjs), appends
// stdout and stderr to the job log (capped), enforces the timeout, watches for job_cancel and
// for the end of the claim, workspace or worktree, and records the outcome.
//
// The recipe runs as its own process group (pgid = the recorded pid). A process can still
// leave that group (setsid, `detached: true`), so the runner also follows the process tree
// (processes.mjs) and stops every process it saw. That tracking polls `ps`: a process that
// detaches and whose parent exits between two polls can escape it. Such a process stays inside
// the sandbox (no network, no writes outside the worktree, no secrets), but it is not counted
// against MEMO_BRIDGE_MAX_JOBS any more. With MEMO_BRIDGE_JOB_SANDBOX=off there is no such
// bound: the job is owner-equivalent.
//
// In the bundled plugin this file is a separate esbuild entry shipped next to index.mjs
// (plugin/server/dist/job-runner.mjs); see jobs.mjs.
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openSqliteStore } from '../coordinator/store.mjs';
import { INSTALL_TIMEOUT_MS } from './executor-local.mjs';
import { detectRecipes, planLocalInstall } from './recipes.mjs';
import { JOB_ID_RE, KILL_GRACE_MS, LOG_CAP_BYTES, RUNNER_PROTOCOL, groupAlive, lastLines, liveClaim, logPathFor, signalGroup } from './jobs.mjs';
import { jobProcesses, processStart, signalTracked, snapshotProcesses } from './processes.mjs';
import { RUNTIME_DIR_NAME, jobEnvironment, localPhaseEnvironment, sandboxCommand, sandboxMode, sandboxPaths } from './sandbox.mjs';

const CANCEL_POLL_MS = 500;
// The claim, workspace and worktree are re-checked every this many polls (about 5 s).
const LIFECYCLE_EVERY = 10;
const TRACK_POLL_MS = 250;
const SUMMARY_LINES = 20;
const SUMMARY_CHARS = 2000;
const TAIL_KEEP = 16 * 1024;
const CLOSE_WAIT_MS = 2000;

// The environment of a recipe (see sandbox.mjs jobEnvironment): an allow-list, never the
// server's secrets, with HOME and TMPDIR inside the job's own folder.
export function jobEnv(base = process.env, jobId, { home = '/nonexistent', tmp = tmpdir() } = {}) {
  return jobEnvironment(base, { jobId, home, tmp });
}

// Lower priority on macOS and Linux: `nice -n 10 <argv>` (nice execs the command, same pid).
export function commandFor(argv, os = platform()) {
  return os === 'darwin' || os === 'linux' ? ['nice', ['-n', '10', ...argv]] : [argv[0], argv.slice(1)];
}

// Append-only log sink with a hard cap. Past the cap one marker is written and the rest is
// dropped (the pipes keep draining so the job never blocks). A small in-memory tail of the
// real output is kept for the summary, so the summary shows the end even when the log is cut.
export function createLogSink(fd, cap = LOG_CAP_BYTES) {
  let written = 0;
  let capped = false;
  let tail = '';
  const keepTail = text => { tail = (tail + text).slice(-TAIL_KEEP); };
  // A failing disk must not crash the runner (the job would then end unrecorded).
  const put = data => { try { writeSync(fd, data); } catch { /* log incomplete; the outcome is still recorded */ } };
  return {
    write(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      keepTail(buffer.toString('utf8'));
      if (capped) return;
      const room = cap - written;
      const part = buffer.length > room ? buffer.subarray(0, Math.max(0, room)) : buffer;
      if (part.length) { put(part); written += part.length; }
      if (buffer.length > room) {
        capped = true;
        put(`\n[memo-bridge] log truncated at ${cap} bytes; further output dropped\n`);
      }
    },
    note(text) {
      // Runner notes are not counted against the cap and never dropped.
      put(`[memo-bridge] ${text}\n`);
    },
    get capped() { return capped; },
    get written() { return written; },
    tail: () => tail
  };
}

function summaryOf(tail) {
  return lastLines(tail, SUMMARY_LINES).join('\n').trim().slice(-SUMMARY_CHARS) || null;
}

// Delete the job folder. A package manager may leave read-only folders in its cache (Go's module
// cache does without -modcacherw), which rmSync cannot empty: give the owner write access back
// to every folder (never following a link) and try once more.
export function removeJobRoot(root) {
  try { rmSync(root, { recursive: true, force: true }); return true; } catch { /* read-only folders: below */ }
  const reopen = dir => {
    try { chmodSync(dir, 0o700); } catch { return; }
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) if (entry.isDirectory()) reopen(join(dir, entry.name));
  };
  try { if (lstatSync(root).isDirectory()) reopen(root); } catch { return true; }
  try { rmSync(root, { recursive: true, force: true }); return true; } catch { return false; }
}

// Signals aimed at the runner itself (SIGTERM from a logout, an installer, a tired owner) must
// stop the job instead of leaving it running unwatched. `control.stop` is set while a job runs.
const control = { terminated: false, stop: null };
export function terminateRunner() {
  control.terminated = true;
  control.stop?.('runner_terminated');
}

export async function runJob(stateDir, jobId, { protocol = RUNNER_PROTOCOL, env = process.env, installTimeoutMs = INSTALL_TIMEOUT_MS,
  planInstall = planLocalInstall } = {}) {
  if (!isAbsolute(stateDir ?? '') || !JOB_ID_RE.test(jobId ?? '')) return { ok: false, error: 'invalid_arguments' };
  const store = openSqliteStore({ dir: stateDir });
  const tx = fn => store.transaction(repo => fn(repo, Date.now()));
  const event = (kind, detail) => tx((repo, at) => repo.appendJobEvent({ job_id: jobId, at, kind,
    detail: detail === undefined ? null : JSON.stringify(detail) }));
  // Fail a job that never started.
  const refuse = (summary, detail) => tx((repo, at) => {
    if (repo.updateJob(jobId, { status: 'failed', ended_at: at, summary }, 'queued')) {
      repo.appendJobEvent({ job_id: jobId, at, kind: 'rejected', detail: JSON.stringify(detail ?? { reason: summary }) });
    }
  });

  let jobRoot = null;
  try {
    const loaded = await tx(repo => {
      const job = repo.getJob(jobId);
      return job ? { job, worktree: repo.getWorktree(job.worktree_id) } : null;
    });
    if (!loaded || loaded.job.status !== 'queued') return { ok: false, error: 'not_queued' };
    // A server from another version launched this runner: refuse rather than guess.
    if (protocol !== RUNNER_PROTOCOL) {
      await refuse('runner_version_mismatch', { reason: 'runner_version_mismatch', expected: RUNNER_PROTOCOL, got: protocol ?? null });
      return { ok: false, error: 'runner_version_mismatch' };
    }
    const { job, worktree } = loaded;
    if (job.log_path !== logPathFor(stateDir, jobId)) { await refuse('log_path_mismatch'); return { ok: false, error: 'log_path_mismatch' }; }
    if (!worktree || worktree.status !== 'active') { await refuse('worktree_unavailable'); return { ok: false, error: 'worktree_unavailable' }; }
    const sandbox = sandboxMode(env);
    if (!sandbox.ok) { await refuse(sandbox.error); return { ok: false, error: sandbox.error }; }

    // The store is private, but the argv is still re-derived from the worktree: a job row can
    // only ever run what detectRecipes would choose for that recipe right now.
    let cwd;
    try { cwd = realpathSync(worktree.path); } catch { await refuse('worktree_unavailable'); return { ok: false, error: 'worktree_unavailable' }; }
    const argv = JSON.parse(job.argv_json);
    const expected = detectRecipes(cwd)[job.recipe];
    if (!expected || JSON.stringify(expected) !== JSON.stringify(argv)) {
      await refuse('recipe_changed', { reason: 'recipe_changed', recipe: job.recipe });
      return { ok: false, error: 'recipe_changed' };
    }
    // The install phase is decided here too, from the worktree, and runs only a pinned argv
    // (recipes.mjs LOCAL_INSTALL_ARGV).
    const install = planInstall(cwd, argv);
    if (install.error) {
      await refuse(install.error, { reason: install.error, phase: 'install' });
      return { ok: false, error: install.error };
    }

    // The job's own folder: its HOME, TMPDIR and package caches, the only place besides the
    // worktree it may write. Deleted when the job ends, so nothing is shared between jobs.
    jobRoot = mkdtempSync(join(tmpdir(), 'memo-bridge-job-'));
    const home = join(jobRoot, 'home'); const tmp = join(jobRoot, 'tmp'); const cache = join(jobRoot, 'cache');
    for (const dir of [home, tmp, cache, join(cache, RUNTIME_DIR_NAME)]) mkdirSync(dir, { mode: 0o700 });
    let paths = null;
    if (sandbox.mode === 'seatbelt') {
      const worktreesRoot = isAbsolute(env.MEMO_BRIDGE_WORKTREES_ROOT ?? '') ? env.MEMO_BRIDGE_WORKTREES_ROOT : null;
      paths = sandboxPaths({ worktree: cwd, stateDir, jobTmp: jobRoot, worktreesRoot, path: env.PATH });
    }
    const phase = (name, phaseArgv) => {
      const [file, args] = commandFor(phaseArgv);
      return { argv: phaseArgv, command: paths ? sandboxCommand([file, ...args], paths, { phase: name }) : [file, args],
        env: localPhaseEnvironment(name, env, { jobId, home, tmp, cache }) };
    };
    const installPhase = install.argv
      ? { ...phase('install', install.argv), timeoutMs: Math.min(Math.max(1, installTimeoutMs), INSTALL_TIMEOUT_MS) }
      : { skip: install.skip };

    const fd = openSync(job.log_path, 'a');
    const log = createLogSink(fd);
    try {
      return await execute({ job, cwd, log, tx, event, sandbox: sandbox.mode, install: installPhase, recipe: phase('recipe', argv) });
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    // Last resort: never leave the job queued or running because the runner crashed.
    await tx((repo, at) => {
      for (const from of ['queued', 'running']) {
        if (repo.updateJob(jobId, { status: 'failed', ended_at: at, summary: 'runner_error' }, from)) {
          repo.appendJobEvent({ job_id: jobId, at, kind: 'runner_error', detail: JSON.stringify({ error: String(error?.code ?? 'error') }) });
        }
      }
    }).catch(() => {});
    return { ok: false, error: 'runner_error' };
  } finally {
    if (jobRoot) removeJobRoot(jobRoot);
    await store.close();
  }
}

// The two phases of a job, one after the other in the same job folder and log:
//   install (when planned): network on (sandbox.mjs 'install' profile), scripts off, bounded by
//     INSTALL_TIMEOUT_MS; events install_started, install_exit. A failed, timed-out, cancelled
//     or interrupted install ends the job: the recipe never runs.
//   recipe: the 'recipe' profile (no network beyond loopback), bounded by the job's timeout
//     from its own start; events started, exit.
// The job is taken (queued -> running) when its first phase starts, and its pid is always the
// current phase's process group.
async function execute({ job, cwd, log, tx, event, sandbox, install, recipe }) {
  const jobId = job.id;
  const how = sandbox === 'seatbelt' ? ' (sandboxed)' : ' (NOT sandboxed: MEMO_BRIDGE_JOB_SANDBOX=off)';
  const common = { jobId, cwd, log, tx, event, sandbox };
  // A phase that could not start: the job fails from the status it had (queued for the first
  // phase, running after an install).
  const startFailed = async (name, file, code, from) => {
    log.note(`${name === 'install' ? 'phase install: ' : ''}could not start ${file}: ${code}`);
    await tx((repo, at) => {
      const patch = { status: 'failed', ended_at: at, summary: `spawn_failed: ${code}`, ...(name === 'install' ? { status_reason: 'install_failed' } : {}) };
      if (repo.updateJob(jobId, patch, from)) {
        repo.appendJobEvent({ job_id: jobId, at, kind: 'spawn_failed', detail: JSON.stringify({ error: code, ...(name === 'install' ? { phase: name } : {}) }) });
      }
    });
    return { ok: false, error: 'spawn_failed' };
  };
  const cancelledBeforeStart = async () => {
    log.note('job was cancelled before it started');
    await event('exit', { exit_code: null, signal: 'SIGKILL', reason: 'cancelled_before_start' });
    return { ok: true, status: 'cancelled' };
  };
  // The job's end: an exit event, then the status, unless one was recorded meanwhile
  // (job_cancel, a reconcile), which is kept.
  const finish = ({ status, code = null, signal = null, summary, reason = null, phase = null }) => tx((repo, at) => {
    repo.appendJobEvent({ job_id: jobId, at, kind: 'exit', detail: JSON.stringify({ exit_code: code, signal, status, log_capped: log.capped,
      ...(phase ? { phase } : {}), ...(reason ? { reason } : {}) }) });
    if (repo.updateJob(jobId, { status, exit_code: code, ended_at: at, summary, ...(reason ? { status_reason: reason } : {}) }, 'running')) return status;
    const current = repo.getJob(jobId);
    repo.updateJob(jobId, { exit_code: code, summary }, current.status);
    return current.status;
  });

  let first = true;
  if (install.argv) {
    log.note(`job ${jobId}: phase install (network on, scripts off): ${install.argv.join(' ')}${how}`);
    const r = await runPhase({ ...common, phase: 'install', first, argv: install.argv, command: install.command, env: install.env,
      timeoutMs: install.timeoutMs });
    if (r.spawnError) return startFailed('install', install.command[0], r.spawnError, 'queued');
    if (!r.taken) return cancelledBeforeStart();
    first = false;
    const outcome = r.stopping === 'runner_terminated' ? { status: 'interrupted', summary: 'runner_terminated' }
      : r.stopping === 'cancelled' ? { status: 'cancelled' }
        : r.stopping === 'timeout' ? { status: 'failed', reason: 'install_timeout' }
          : r.code !== 0 ? { status: 'failed', reason: 'install_failed' } : null;
    log.note(`phase install: exit ${r.code ?? 'none'}${r.signal ? `, signal ${r.signal}` : ''}${outcome ? `: ${outcome.reason ?? outcome.status}` : ''}`);
    await event('install_exit', { exit_code: r.code, signal: r.signal, status: outcome ? outcome.reason ?? outcome.status : 'succeeded' });
    if (outcome) {
      const status = await finish({ code: r.code, signal: r.signal, summary: outcome.summary ?? summaryOf(log.tail()), phase: 'install', ...outcome });
      return { ok: true, status };
    }
    if (control.terminated) {
      return { ok: true, status: await finish({ status: 'interrupted', summary: 'runner_terminated', phase: 'install' }) };
    }
  } else {
    log.note(`job ${jobId}: phase install: skipped (${install.skip})`);
  }

  log.note(`job ${jobId}: recipe ${job.recipe}: ${recipe.argv.join(' ')}${how}`);
  const r = await runPhase({ ...common, phase: 'recipe', first, argv: recipe.argv, command: recipe.command, env: recipe.env,
    timeoutMs: job.timeout_ms });
  if (r.spawnError) return startFailed('recipe', recipe.command[0], r.spawnError, first ? 'queued' : 'running');
  if (!r.taken) {
    if (first) return cancelledBeforeStart();
    log.note('job ended before the recipe started');
    return { ok: true, status: (await tx(repo => repo.getJob(jobId)))?.status ?? null };
  }
  const { code, signal } = r;
  const timedOut = r.stopping === 'timeout';
  const terminated = r.stopping === 'runner_terminated';
  const status = timedOut ? 'timed_out' : terminated ? 'interrupted' : code === 0 ? 'succeeded' : 'failed';
  log.note(`exit code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''}: ${status}${log.capped ? ' (log truncated)' : ''}`);
  const recorded = await finish({ status, code, signal, summary: terminated ? 'runner_terminated' : summaryOf(log.tail()) });
  return { ok: true, status: recorded };
}

// One phase: spawn `command` in its own process group, take the job (first phase: queued ->
// running) or move it to this group, then watch it until it and everything it started are gone.
// Returns { spawnError } (nothing ran), { taken: false } (the job was no longer ours; the
// process was killed), or { taken: true, code, signal, stopping } where stopping is null,
// 'timeout', 'cancelled' or 'runner_terminated'.
async function runPhase({ jobId, phase, first, argv, command, cwd, env, timeoutMs, log, tx, event, sandbox }) {
  const [file, args] = command;
  let child;
  let spawnError = null;
  try {
    child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  } catch (error) {
    spawnError = error;
  }
  if (child && !spawnError) {
    spawnError = await new Promise(resolve => {
      child.once('spawn', () => resolve(null));
      child.once('error', resolve);
    });
  }
  if (spawnError) return { spawnError: String(spawnError?.code ?? 'spawn_failed') };

  const pid = child.pid;
  const pidStart = processStart(pid);
  child.stdout.on('data', chunk => log.write(chunk));
  child.stderr.on('data', chunk => log.write(chunk));
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const closed = new Promise(resolve => child.once('close', resolve));

  // Every process of the phase seen so far (pid -> start time), refreshed while it runs.
  let tracked = new Map(pidStart ? [[pid, pidStart]] : []);
  const refresh = () => {
    const snapshot = snapshotProcesses();
    if (snapshot) tracked = jobProcesses(snapshot, pid, tracked, [process.pid]);
    return snapshot;
  };
  const trackTimer = setInterval(refresh, TRACK_POLL_MS);

  // Take the job, or move it to this phase's group. If it was cancelled meanwhile, stop at once.
  const taken = await tx((repo, at) => first
    ? repo.updateJob(jobId, { status: 'running', pid, started_at: at }, 'queued')
    : repo.updateJob(jobId, { pid }, 'running'));
  if (!taken) {
    signalGroup(pid, 'SIGKILL');
    await exited;
    clearInterval(trackTimer);
    await killRemaining(refresh, () => tracked);
    return { taken: false };
  }
  await event(phase === 'install' ? 'install_started' : 'started', { pid, pid_start: pidStart, runner_pid: process.pid, argv, sandbox });

  // Terminate the whole phase: SIGTERM to the group and every tracked process, SIGKILL after the grace.
  let stopping = null;
  let killTimer = null;
  const stop = reason => {
    if (stopping) return;
    stopping = reason;
    signalGroup(pid, 'SIGTERM');
    signalTracked(tracked, 'SIGTERM', refresh());
    killTimer = setTimeout(() => { signalGroup(pid, 'SIGKILL'); signalTracked(tracked, 'SIGKILL', refresh()); }, KILL_GRACE_MS);
  };
  control.stop = stop;
  if (control.terminated) stop('runner_terminated');
  const seconds = Math.round(timeoutMs / 1000);
  const timeoutTimer = setTimeout(() => {
    log.note(phase === 'install' ? `phase install: timeout after ${seconds} s: stopping the install` : `timeout after ${seconds} s: stopping the job`);
    event('timeout', { timeout_seconds: seconds, ...(phase === 'install' ? { phase } : {}) }).catch(() => {});
    stop('timeout');
  }, timeoutMs);
  // job_cancel (and workspace_close, task_release, task_complete) record 'cancelled'; the
  // runner notices it here. It also stops the job itself when the claim expired or was
  // released, or the workspace or worktree went away: code never runs without a live claim.
  let polling = false; let polls = 0;
  const pollTimer = setInterval(async () => {
    if (polling || stopping) return;
    polling = true;
    try {
      const check = ++polls % LIFECYCLE_EVERY === 0;
      const state = await tx((repo, at) => {
        const current = repo.getJob(jobId);
        if (current?.status !== 'running') return { status: current?.status };
        if (!check) return { status: 'running' };
        const workspace = repo.getWorkspace(current.workspace_id);
        const worktree = repo.getWorktree(current.worktree_id);
        const reason = workspace?.status !== 'active' ? 'workspace_closed'
          : worktree?.status !== 'active' ? 'worktree_removed'
            : !liveClaim(repo, current.workspace_id, worktree.issue_ref, at) ? 'no_live_claim' : null;
        if (!reason) return { status: 'running' };
        if (repo.updateJob(jobId, { status: 'cancelled', ended_at: at }, 'running')) {
          repo.appendJobEvent({ job_id: jobId, at, kind: 'cancelled', detail: JSON.stringify({ from: 'running', by: 'runner', reason }) });
        }
        return { status: 'cancelled', reason };
      });
      if (state.status !== 'running') {
        if (state.reason) log.note(`stopping the job: ${state.reason}`);
        stop('cancelled');
      }
    } catch { /* store briefly busy: try again on the next tick */ } finally { polling = false; }
  }, CANCEL_POLL_MS);

  const { code, signal } = await exited;
  clearTimeout(timeoutTimer);
  clearInterval(pollTimer);
  clearInterval(trackTimer);
  // The leader is gone; anything it left behind, in its group or detached from it, goes too.
  if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
  await killRemaining(refresh, () => tracked);
  clearTimeout(killTimer);
  control.stop = null;
  await Promise.race([closed, new Promise(resolve => setTimeout(resolve, CLOSE_WAIT_MS))]);
  return { taken: true, code, signal, stopping };
}

// After the leader exited: SIGKILL every process of the job that is still there, until none is
// left or the grace period is over.
async function killRemaining(refresh, trackedNow) {
  const deadline = Date.now() + KILL_GRACE_MS;
  for (;;) {
    const snapshot = refresh();
    const left = trackedNow();
    if (!snapshot || left.size === 0) return;
    signalTracked(left, 'SIGKILL', snapshot);
    if (Date.now() > deadline) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// `--protocol=<n>` first, then the state directory and the job id. Without it (a server older
// than the protocol argument), protocol is null and the job is refused as a version mismatch.
export function parseRunnerArgs(argv) {
  const [first, ...rest] = argv;
  const match = /^--protocol=(\d{1,6})$/.exec(first ?? '');
  if (match) return { protocol: Number(match[1]), stateDir: rest[0], jobId: rest[1] };
  return { protocol: null, stateDir: first, jobId: rest[0] };
}

// Run only when executed directly, so tests can import the helpers.
function isMain() {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain() && process.argv[2]?.startsWith('--executor=')) {
  // Unit mode: no store, no lease; systemd records the outcome (decision D5).
  for (const sig of ['SIGHUP', 'SIGINT']) process.on(sig, () => {});
  const { runJobUnit } = await import('./job-unit.mjs');
  const journal = entry => { try { process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); } catch { /* journal gone */ } };
  const keepAlive = setInterval(() => {}, 1 << 30);
  runJobUnit(process.argv.slice(2), { createLogSink, journal }).then(result => {
    clearInterval(keepAlive);
    if (result.signal) { process.kill(process.pid, result.signal); return; }
    process.exitCode = result.code;
  }, () => { clearInterval(keepAlive); process.exitCode = 1; });
} else if (isMain()) {
  const { protocol, stateDir, jobId } = parseRunnerArgs(process.argv.slice(2));
  // The runner's own group never contains the job (the job has its own group). Hangups and
  // interrupts are ignored; a termination request stops the job first, then the runner exits.
  for (const sig of ['SIGHUP', 'SIGINT']) process.on(sig, () => {});
  process.on('SIGTERM', terminateRunner);
  runJob(stateDir, jobId, { protocol }).then(result => { process.exitCode = result.ok ? 0 : 1; }, () => { process.exitCode = 1; });
}
