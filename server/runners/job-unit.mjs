// Job unit mode of the runner (Phase 4, VPS; the unit side of TODO-P4-07).
//
//   memo-job@<id>.service  ExecStart=/usr/bin/node .../server/runners/job-runner.mjs --executor=systemd %i
//
// It runs as memo-job, inside the unit lab-infra declares (memo-dev.slice, no credentials, no
// docker or sudo group, loopback and private ranges denied, only its worktree and output folder
// writable). The root dispatcher (deploy/memo-runner-dispatch) validated the spool request and
// pinned everything this process needs into the unit's runtime drop-in:
//   WorkingDirectory=<worktree>   ReadWritePaths=<worktree> <out>   RuntimeMaxSec=<timeout>
//   Environment=MEMO_JOB_ID MEMO_JOB_DISPATCH_ID MEMO_JOB_RECIPE MEMO_JOB_ALLOWED_ARGV
//               MEMO_JOB_WORKTREE MEMO_JOB_OUT MEMO_JOB_TIMEOUT_SECONDS
//
// This process holds no store, no lease and no token, and decides no status: systemd's own
// result, written by root in ExecStopPost=+record-result (decision D5), is the job's outcome.
// What it does:
//   1. checks that the instance, the drop-in values and its working directory agree;
//   2. re-detects the recipe argv from the worktree (recipes.mjs) and runs it only if it is one
//      of the shapes the dispatcher allowed for that recipe (MEMO_JOB_ALLOWED_ARGV);
//   3. runs it without a shell, with the allow-listed environment of sandbox.mjs (no MEMO_JOB_*,
//      no token variable), a private HOME and TMPDIR, output appended to <out>/job.log (opened
//      without following symlinks, capped like Phase 3);
//   4. exits with the recipe's exit code. The recipe runs as its own process group. On SIGTERM
//      (cancel, RuntimeMaxSec, shutdown) it signals the whole group, not only the recipe's first
//      process: `npm test` runs `sh -c` and Debian's dash does not pass the signal on, so a
//      grandchild kept the output pipes open and the unit never ended. It then ends by the same
//      signal, so systemd reports a stop rather than a failure. When the recipe's first process
//      exits, what it left in its group is killed so the pipes close; KillMode=control-group
//      still stops anything that left the group (systemd.kill(5)).
// A refusal exits 2 before anything runs, with one line in job.log when it can be opened and
// one JSON line on stderr (the journal): codes only, never file contents or environment values.
import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { signalGroup } from './executor-local.mjs';
import { DISPATCH_ID_RE } from './executor-systemd.mjs';
import { RECIPE_NAMES, detectRecipes } from './recipes.mjs';
import { jobEnvironment } from './sandbox.mjs';

export const UNIT_EXECUTOR_ARG = '--executor=systemd';
export const REFUSED_EXIT = 2;
export const LOG_NAME = 'job.log';
const TOKEN_RE = /^[A-Za-z0-9._/@-]{1,200}$/;
const MAX_SHAPES = 16;
const MAX_TIMEOUT_SECONDS = 3600;

// "npm:test,python3:-m:pytest:-q" -> [['npm','test'], ['python3','-m','pytest','-q']], or null.
export function parseAllowedArgv(text) {
  if (typeof text !== 'string' || !text || text.length > 4096) return null;
  const shapes = text.split(',').map(shape => shape.split(':'));
  if (shapes.length > MAX_SHAPES || !shapes.every(s => s.length && s.length <= 16 && s.every(t => TOKEN_RE.test(t)))) return null;
  return shapes;
}

const sameArgv = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);
const isCanonical = p => typeof p === 'string' && isAbsolute(p) && normalize(p) === p && p !== '/' && !p.endsWith('/');
const real = p => { try { return realpathSync(p); } catch { return null; } };

// Everything checked before anything runs. { ok, id, recipe, worktree, out, argv } or { ok:false, error }.
export function planJobUnit(args, env = process.env, { cwd = process.cwd(), detect = detectRecipes } = {}) {
  const refuse = error => ({ ok: false, error });
  if (args.length !== 2 || args[0] !== UNIT_EXECUTOR_ARG) return refuse('invalid_arguments');
  const id = args[1];
  if (!DISPATCH_ID_RE.test(id ?? '') || id.startsWith('-')) return refuse('invalid_dispatch_id');
  if (env.MEMO_JOB_DISPATCH_ID !== id) return refuse('dispatch_id_mismatch');
  // lab-infra's unit also sets MEMO_BRIDGE_JOB_ID=%i; when present it must name this instance.
  if (env.MEMO_BRIDGE_JOB_ID !== undefined && env.MEMO_BRIDGE_JOB_ID !== id) return refuse('dispatch_id_mismatch');
  const recipe = env.MEMO_JOB_RECIPE;
  if (!RECIPE_NAMES.includes(recipe)) return refuse('unknown_recipe');
  const timeout = Number(env.MEMO_JOB_TIMEOUT_SECONDS);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) return refuse('invalid_timeout');
  const worktree = env.MEMO_JOB_WORKTREE;
  // No symlink anywhere in the path (the dispatcher checked it too), and it is where systemd put us.
  if (!isCanonical(worktree) || real(worktree) !== worktree) return refuse('worktree_invalid');
  if (real(cwd) !== worktree) return refuse('cwd_mismatch');
  const out = env.MEMO_JOB_OUT;
  if (!isCanonical(out) || basename(out) !== 'out' || basename(dirname(out)) !== id || real(out) !== out) return refuse('out_invalid');
  const allowed = parseAllowedArgv(env.MEMO_JOB_ALLOWED_ARGV);
  if (!allowed) return refuse('allowed_argv_invalid');
  let argv;
  try { argv = detect(worktree)[recipe]; } catch { argv = undefined; }
  if (!argv) return refuse('recipe_not_detected');
  if (!allowed.some(shape => sameArgv(shape, argv))) return refuse('recipe_not_allowed');
  return { ok: true, id, recipe, worktree, out, argv: [...argv], timeout };
}

function openLog(out) {
  const fd = openSync(join(out, LOG_NAME), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW
    | constants.O_NONBLOCK, 0o640);
  const info = fstatSync(fd);
  if (!info.isFile() || info.nlink !== 1) { closeSync(fd); throw Object.assign(new Error('log_invalid'), { code: 'log_invalid' }); }
  return fd;
}

const exitCodeOf = (code, signal) => (Number.isInteger(code) ? code : 128 + (osConstants.signals[signal] ?? 0));

/**
 * Run one job unit. Returns { code, signal?, error? }: `code` is the process exit status to
 * use; `signal` is set when the job was stopped by SIGTERM and the caller should end by it.
 * `createLogSink` comes from job-runner.mjs (the Phase 3 capped sink).
 */
export async function runJobUnit(args, { env = process.env, cwd = process.cwd(), createLogSink, journal = () => {},
  onSignal = (sig, fn) => process.on(sig, fn), offSignal = (sig, fn) => process.off(sig, fn) } = {}) {
  const plan = planJobUnit(args, env, { cwd });
  if (!plan.ok) {
    journal({ event: 'job_unit_refused', reason: plan.error });
    // Leave a trace next to the job when the output folder is the expected one.
    const id = args[1];
    if (DISPATCH_ID_RE.test(id ?? '') && isCanonical(env.MEMO_JOB_OUT) && basename(dirname(env.MEMO_JOB_OUT)) === id) {
      try { const fd = openLog(env.MEMO_JOB_OUT); try { createLogSink(fd).note(`job refused: ${plan.error}`); } finally { closeSync(fd); } }
      catch { /* nothing more to say */ }
    }
    return { code: REFUSED_EXIT, error: plan.error };
  }
  let fd;
  try { fd = openLog(plan.out); } catch (error) {
    journal({ event: 'job_unit_refused', reason: String(error?.code ?? 'log_unavailable') });
    return { code: REFUSED_EXIT, error: 'log_unavailable' };
  }
  const log = createLogSink(fd);
  // Private HOME and TMPDIR inside the unit's own /tmp (PrivateTmp=yes): removed at the end.
  let jobTmp = null;
  try {
    jobTmp = mkdtempSync(join(tmpdir(), 'memo-job-'));
    const home = join(jobTmp, 'home'); const tmp = join(jobTmp, 'tmp');
    mkdirSync(home, { mode: 0o700 }); mkdirSync(tmp, { mode: 0o700 });
    const childEnv = jobEnvironment(env, { jobId: plan.id, home, tmp });
    journal({ event: 'job_unit_start', id: plan.id, recipe: plan.recipe, argv: plan.argv });
    log.note(`job ${plan.id}: ${plan.recipe} -> ${plan.argv.join(' ')}`);
    const result = await new Promise(resolve => {
      let stopping = null;
      const child = spawn(plan.argv[0], plan.argv.slice(1), { cwd: plan.worktree, env: childEnv, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      const onTerm = () => {
        stopping = 'SIGTERM';
        if (!signalGroup(child.pid, 'SIGTERM')) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
      };
      // The first process is gone: whatever it left in its group would hold the pipes open.
      child.on('exit', () => { signalGroup(child.pid, 'SIGKILL'); });
      onSignal('SIGTERM', onTerm);
      child.stdout.on('data', chunk => log.write(chunk));
      child.stderr.on('data', chunk => log.write(chunk));
      child.on('error', error => {
        offSignal('SIGTERM', onTerm);
        log.note(`job could not start: ${error?.code === 'ENOENT' ? 'command_not_found' : 'spawn_failed'}`);
        resolve({ code: error?.code === 'ENOENT' ? 127 : 126 });
      });
      child.on('close', (code, signal) => {
        offSignal('SIGTERM', onTerm);
        log.note(`exit ${Number.isInteger(code) ? code : signal}${log.capped ? ' (log truncated)' : ''}`);
        resolve(stopping ? { code: exitCodeOf(code, signal), signal: stopping } : { code: exitCodeOf(code, signal) });
      });
    });
    journal({ event: 'job_unit_end', id: plan.id, code: result.code, ...(result.signal ? { signal: result.signal } : {}) });
    return result;
  } finally {
    closeSync(fd);
    if (jobTmp) { try { rmSync(jobTmp, { recursive: true, force: true }); } catch { /* KillMode and PrivateTmp clean up */ } }
  }
}
