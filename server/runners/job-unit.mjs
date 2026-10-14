// Job unit mode of the runner (Phase 4, VPS; the unit side of TODO-P4-07).
//
//   memo-job-install@<id>.service  ExecStart=/usr/bin/node .../job-runner.mjs --executor=systemd --phase=install %i
//   memo-job@<id>.service          ExecStart=/usr/bin/node .../job-runner.mjs --executor=systemd %i
//
// A job has two phases, two units, one log (docs/RUNNER_VPS.md, "Two phases"). The install
// unit runs first (memo-job@ Requires= and After= it): with the network the job unit always
// had, it runs `pnpm install --frozen-lockfile --ignore-scripts` or `npm ci --ignore-scripts`
// when the worktree has a lockfile and no node_modules (recipes.mjs detectInstall), with
// corepack, the pnpm store and the npm cache in jobs/<id>/cache. The recipe unit then runs
// with PrivateNetwork=yes: its own loopback and nothing else, which this process checks.
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
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { signalGroup } from './executor-local.mjs';
import { DISPATCH_ID_RE } from './executor-systemd.mjs';
import { RECIPE_NAMES, detectInstall, detectRecipes } from './recipes.mjs';
import { jobEnvironment } from './sandbox.mjs';

export const UNIT_EXECUTOR_ARG = '--executor=systemd';
// memo-job-install@<id>.service runs `job-runner.mjs --executor=systemd --phase=install <id>`.
export const INSTALL_PHASE_ARG = '--phase=install';
export const REFUSED_EXIT = 2;
export const LOG_NAME = 'job.log';
// jobs/<id>/cache: created by the install unit (ExecStartPre=+, owner memo-job), writable in
// the install phase only. It holds this job's corepack, pnpm store and npm cache, so no
// writable state is shared between jobs.
export const CACHE_NAME = 'cache';
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

// The cache folder of a job, when it is a real directory (no symlink) next to out/.
function cacheDir(out) {
  const path = join(dirname(out), CACHE_NAME);
  try { return lstatSync(path).isDirectory() && real(path) === path ? path : null; } catch { return null; }
}

// Interface names of the network namespace this process is in (Linux /proc/self/net/dev,
// which follows the namespace), or null when they cannot be read.
export function netInterfaces() {
  try {
    return readFileSync('/proc/self/net/dev', 'utf8').split('\n').slice(2)
      .map(line => line.split(':')[0].trim()).filter(Boolean);
  } catch { return null; }
}

// The unit arguments: [--executor=systemd, <id>] (recipe) or [--executor=systemd, --phase=install, <id>].
function parsePhase(args) {
  if (!Array.isArray(args) || args[0] !== UNIT_EXECUTOR_ARG) return null;
  if (args.length === 2) return { phase: 'recipe', id: args[1] };
  if (args.length === 3 && args[1] === INSTALL_PHASE_ARG) return { phase: 'install', id: args[2] };
  return null;
}

// Everything checked before anything runs. { ok, phase, id, recipe, worktree, out, argv } or
// { ok:false, error }. In the install phase `argv` is null when there is nothing to install
// (`skip` says why). In the recipe phase, MEMO_JOB_NETWORK=private (pinned by the dispatcher
// next to PrivateNetwork=yes) means the job must see no network device but loopback:
// systemd.exec(5) says PrivateNetwork= may be impossible to implement and must not be the
// only safeguard, so a job that still sees the host's devices refuses to run.
export function planJobUnit(args, env = process.env, { cwd = process.cwd(), detect = detectRecipes, install = detectInstall,
  interfaces = netInterfaces } = {}) {
  const refuse = error => ({ ok: false, error });
  const parsed = parsePhase(args);
  if (!parsed) return refuse('invalid_arguments');
  const { phase, id } = parsed;
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
  if (phase === 'install') {
    const cache = cacheDir(out);
    if (!cache) return refuse('cache_invalid');
    let plan;
    try { plan = install(worktree); } catch { plan = { skip: 'install_not_detected' }; }
    if (!plan?.argv) return { ok: true, phase, id, recipe, worktree, out, cache, argv: null, skip: plan?.skip ?? 'nothing_to_install', timeout };
    if (!allowed.some(shape => sameArgv(shape, plan.argv))) return refuse('install_not_allowed');
    return { ok: true, phase, id, recipe, worktree, out, cache, argv: [...plan.argv], manager: plan.manager, timeout };
  }
  if (env.MEMO_JOB_NETWORK !== undefined) {
    if (env.MEMO_JOB_NETWORK !== 'private') return refuse('network_mode_invalid');
    const names = interfaces();
    if (!Array.isArray(names) || names.some(name => name !== 'lo')) return refuse('network_not_private');
  }
  let argv;
  try { argv = detect(worktree)[recipe]; } catch { argv = undefined; }
  if (!argv) return refuse('recipe_not_detected');
  if (!allowed.some(shape => sameArgv(shape, argv))) return refuse('recipe_not_allowed');
  return { ok: true, phase, id, recipe, worktree, out, cache: cacheDir(out), argv: [...argv], timeout };
}

// The environment of each phase: sandbox.mjs's allow-list, plus where corepack, pnpm and npm
// keep their files. The install phase writes them under jobs/<id>/cache (network allowed,
// --ignore-scripts); the recipe phase reads the same corepack folder with the network off,
// so `pnpm` inside a script runs the version installed in phase 1 and never downloads.
export function phaseEnvironment(plan, base, { home, tmp }) {
  const env = jobEnvironment(base, { jobId: plan.id, home, tmp });
  const corepack = { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', COREPACK_ENABLE_AUTO_PIN: '0' };
  if (plan.phase === 'install') {
    return Object.assign(env, corepack, {
      COREPACK_HOME: join(plan.cache, 'corepack'),
      // pnpm 12 reads pnpm_config_*, not npm_config_*, for its own settings (checked with
      // `pnpm store path`); npm reads npm_config_cache.
      pnpm_config_store_dir: join(plan.cache, 'pnpm-store'),
      npm_config_cache: join(plan.cache, 'npm'),
      npm_config_audit: 'false', npm_config_fund: 'false'
    });
  }
  Object.assign(env, corepack, { COREPACK_ENABLE_NETWORK: '0' });
  if (plan.cache) env.COREPACK_HOME = join(plan.cache, 'corepack');
  return env;
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
  onSignal = (sig, fn) => process.on(sig, fn), offSignal = (sig, fn) => process.off(sig, fn), interfaces = netInterfaces } = {}) {
  const plan = planJobUnit(args, env, { cwd, interfaces });
  if (!plan.ok) {
    journal({ event: 'job_unit_refused', reason: plan.error });
    // Leave a trace next to the job when the output folder is the expected one.
    const id = args[args.length - 1];
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
    const childEnv = phaseEnvironment(plan, env, { home, tmp });
    if (plan.phase === 'install' && !plan.argv) {
      journal({ event: 'job_install_skipped', id: plan.id, reason: plan.skip });
      log.note(`phase install: skipped (${plan.skip})`);
      return { code: 0 };
    }
    journal({ event: 'job_unit_start', id: plan.id, phase: plan.phase, recipe: plan.recipe, argv: plan.argv });
    if (plan.phase === 'install') log.note(`phase install (network on, scripts off): ${plan.argv.join(' ')}`);
    else log.note(`phase recipe (network off, loopback only): job ${plan.id}: ${plan.recipe} -> ${plan.argv.join(' ')}`);
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
        log.note(`${plan.phase === 'install' ? 'phase install: ' : ''}job could not start: ${error?.code === 'ENOENT' ? 'command_not_found' : 'spawn_failed'}`);
        resolve({ code: error?.code === 'ENOENT' ? 127 : 126 });
      });
      child.on('close', (code, signal) => {
        offSignal('SIGTERM', onTerm);
        log.note(`${plan.phase === 'install' ? 'phase install: ' : ''}exit ${Number.isInteger(code) ? code : signal}${log.capped ? ' (log truncated)' : ''}`);
        resolve(stopping ? { code: exitCodeOf(code, signal), signal: stopping } : { code: exitCodeOf(code, signal) });
      });
    });
    journal({ event: 'job_unit_end', id: plan.id, phase: plan.phase, code: result.code, ...(result.signal ? { signal: result.signal } : {}) });
    return result;
  } finally {
    closeSync(fd);
    if (jobTmp) { try { rmSync(jobTmp, { recursive: true, force: true }); } catch { /* KillMode and PrivateTmp clean up */ } }
  }
}
