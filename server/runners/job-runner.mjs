// Detached job runner: `node job-runner.mjs <stateDir> <jobId>`.
//
// Started by jobs_submit in its own process group, it outlives the MCP session. It opens the
// private store itself, takes the job (CAS queued -> running), runs the recipe argv without a
// shell in the worktree at lower priority, appends stdout and stderr to the job log (capped),
// enforces the timeout, watches for job_cancel, and records the outcome.
//
// The recipe runs as its own process group (pgid = the recorded pid), so timeout and cancel
// reach every process it started, and nothing it started survives the job.
//
// In the bundled plugin this file is a separate esbuild entry shipped next to index.mjs
// (plugin/server/dist/job-runner.mjs); see jobs.mjs.
import { spawn } from 'node:child_process';
import { closeSync, openSync, realpathSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openSqliteStore } from '../coordinator/store.mjs';
import { detectRecipes } from './recipes.mjs';
import { JOB_ID_RE, KILL_GRACE_MS, LOG_CAP_BYTES, groupAlive, lastLines, logPathFor, signalGroup } from './jobs.mjs';

const CANCEL_POLL_MS = 500;
const SUMMARY_LINES = 20;
const SUMMARY_CHARS = 2000;
const TAIL_KEEP = 16 * 1024;
const CLOSE_WAIT_MS = 2000;

// Variables never handed to repository scripts. The scripts still run as the owner and can
// read the owner's files: this is hygiene, not a sandbox.
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE|CREDENTIAL|AUTH|COOKIE|SESSION/i;
const SECRET_PREFIX = /^(?:GH_|GITHUB_|AWS_|AZURE_|GOOGLE_|GCP_|ANTHROPIC|OPENAI|CLAUDE|HF_|NPM_CONFIG__AUTH|MEMO_BRIDGE_|SSH_)/i;

export function jobEnv(base = process.env, jobId) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (SECRET_NAME.test(key) || SECRET_PREFIX.test(key)) continue;
    env[key] = value;
  }
  // Non-interactive, uncoloured output: test runners skip watch mode and prompts.
  env.CI = '1';
  env.NO_COLOR = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.MEMO_BRIDGE_JOB_ID = jobId;
  return env;
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

export async function runJob(stateDir, jobId) {
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

  try {
    const loaded = await tx(repo => {
      const job = repo.getJob(jobId);
      return job ? { job, worktree: repo.getWorktree(job.worktree_id) } : null;
    });
    if (!loaded || loaded.job.status !== 'queued') return { ok: false, error: 'not_queued' };
    const { job, worktree } = loaded;
    if (job.log_path !== logPathFor(stateDir, jobId)) { await refuse('log_path_mismatch'); return { ok: false, error: 'log_path_mismatch' }; }
    if (!worktree || worktree.status !== 'active') { await refuse('worktree_unavailable'); return { ok: false, error: 'worktree_unavailable' }; }

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

    const fd = openSync(job.log_path, 'a');
    const log = createLogSink(fd);
    try {
      return await execute({ job, argv, cwd, log, tx, event });
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
    await store.close();
  }
}

async function execute({ job, argv, cwd, log, tx, event }) {
  const jobId = job.id;
  const [command, args] = commandFor(argv);
  log.note(`job ${jobId}: recipe ${job.recipe}: ${argv.join(' ')}`);

  let child;
  let spawnError = null;
  try {
    child = spawn(command, args, { cwd, env: jobEnv(process.env, jobId), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  } catch (error) {
    spawnError = error;
  }
  if (child && !spawnError) {
    spawnError = await new Promise(resolve => {
      child.once('spawn', () => resolve(null));
      child.once('error', resolve);
    });
  }
  if (spawnError) {
    const code = String(spawnError?.code ?? 'spawn_failed');
    log.note(`could not start ${command}: ${code}`);
    await tx((repo, at) => {
      if (repo.updateJob(jobId, { status: 'failed', ended_at: at, summary: `spawn_failed: ${code}` }, 'queued')) {
        repo.appendJobEvent({ job_id: jobId, at, kind: 'spawn_failed', detail: JSON.stringify({ error: code }) });
      }
    });
    return { ok: false, error: 'spawn_failed' };
  }

  const pid = child.pid;
  child.stdout.on('data', chunk => log.write(chunk));
  child.stderr.on('data', chunk => log.write(chunk));
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const closed = new Promise(resolve => child.once('close', resolve));

  // Take the job. If it was cancelled between the read and the spawn, stop at once.
  const taken = await tx((repo, at) => repo.updateJob(jobId, { status: 'running', pid, started_at: at }, 'queued'));
  if (!taken) {
    signalGroup(pid, 'SIGKILL');
    await exited;
    log.note('job was cancelled before it started');
    await event('exit', { exit_code: null, signal: 'SIGKILL', reason: 'cancelled_before_start' });
    return { ok: true, status: 'cancelled' };
  }
  await event('started', { pid, runner_pid: process.pid, argv });

  // Terminate the whole group: SIGTERM, then SIGKILL after the grace period.
  let stopping = null;
  let killTimer = null;
  const stop = reason => {
    if (stopping) return;
    stopping = reason;
    signalGroup(pid, 'SIGTERM');
    killTimer = setTimeout(() => signalGroup(pid, 'SIGKILL'), KILL_GRACE_MS);
  };
  const timeoutTimer = setTimeout(() => {
    log.note(`timeout after ${Math.round(job.timeout_ms / 1000)} s: stopping the job`);
    event('timeout', { timeout_seconds: Math.round(job.timeout_ms / 1000) }).catch(() => {});
    stop('timeout');
  }, job.timeout_ms);
  // job_cancel records 'cancelled' and signals the group; the runner also notices it here,
  // so the SIGKILL escalation happens even if the cancelling process went away.
  let polling = false;
  const pollTimer = setInterval(async () => {
    if (polling || stopping) return;
    polling = true;
    try {
      const status = await tx(repo => repo.getJob(jobId)?.status);
      if (status !== 'running') stop('cancelled');
    } catch { /* store briefly busy: try again on the next tick */ } finally { polling = false; }
  }, CANCEL_POLL_MS);

  const { code, signal } = await exited;
  clearTimeout(timeoutTimer);
  clearInterval(pollTimer);
  // The leader is gone; anything it left behind in its group goes too.
  if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
  clearTimeout(killTimer);
  await Promise.race([closed, new Promise(resolve => setTimeout(resolve, CLOSE_WAIT_MS))]);

  const timedOut = stopping === 'timeout';
  const status = timedOut ? 'timed_out' : code === 0 ? 'succeeded' : 'failed';
  log.note(`exit code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''}: ${status}${log.capped ? ' (log truncated)' : ''}`);
  const summary = summaryOf(log.tail());
  const recorded = await tx((repo, at) => {
    repo.appendJobEvent({ job_id: jobId, at, kind: 'exit', detail: JSON.stringify({ exit_code: code, signal, status, log_capped: log.capped }) });
    if (repo.updateJob(jobId, { status, exit_code: code, ended_at: at, summary }, 'running')) return status;
    // Cancelled (or reported interrupted) meanwhile: keep that status, add what we know.
    const current = repo.getJob(jobId);
    repo.updateJob(jobId, { exit_code: code, summary }, current.status);
    return current.status;
  });
  return { ok: true, status: recorded };
}

// Run only when executed directly, so tests can import the helpers.
function isMain() {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  const [stateDir, jobId] = process.argv.slice(2);
  // Termination signals aimed at the runner itself must not leave the job behind unrecorded;
  // the runner's own group never contains the job (the job has its own group).
  for (const sig of ['SIGHUP', 'SIGINT']) process.on(sig, () => {});
  runJob(stateDir, jobId).then(result => { process.exitCode = result.ok ? 0 : 1; }, () => { process.exitCode = 1; });
}
