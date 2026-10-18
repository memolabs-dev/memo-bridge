// T2 operator tools: commands as the agent user (Phase 6, TODO-P6-09, spec D1, D10, D11).
//
// operator_run takes an argv array and spawns it with shell:false: ";", "|", "$()" and newlines
// are argument bytes (R-P6-03, AC-P6-01). The environment is a fixed safe base plus only the
// names the host policy allows (never PATH, LD_*, NODE_* and the like, operator-policy.mjs). The
// working directory must be inside the read roots and not inside a registered project checkout
// on its default branch (use_dev_flow, D11). Foreground runs default to 30 s, at most 600 s;
// longer runs need background (up to 3600 s) and are read back with operator_job_status from
// results stored on disk (operator-jobs.mjs). as_root runs never reach this module: the agent
// forwards them to the root helper (bridge/operator-root-helper.mjs).
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, unlink, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { UNIT_RE } from './operator-policy.mjs';
import { readOnlyCommand } from './operator-dangerous.mjs';
import { createDenylist, catalogProjects, repositoryGuard, resolveOperatorPath } from './operator-paths.mjs';
import { SAFE_ENV, runArgv } from './operator-tools.mjs';
import { untrusted } from './operator-output.mjs';

export const RUN_LIMITS = Object.freeze({ defaultTimeoutS: 30, foregroundMaxS: 600, backgroundMaxS: 3600, maxEnv: 32 });
// User scripts (repatriation D-R6): a bare name looked up in the run PATH (Homebrew or pnpm first
// on the Mac when run_path says so), the shells by their system path.
export const USER_INTERPRETERS = Object.freeze({ bash: { program: '/bin/bash', ext: 'sh' }, zsh: { program: 'zsh', ext: 'zsh' },
  sh: { program: '/bin/sh', ext: 'sh' }, python3: { program: 'python3', ext: 'py' }, node: { program: 'node', ext: 'mjs' } });

// The environment of a user run (D-R8): the fixed safe base, the agent user's identity (git, gh
// and ssh read their configuration from HOME) and its ssh agent when it has one, PATH with the
// policy's run_path first. Never caller-settable: these names are on FORBIDDEN_ENV_RE.
export function userRunEnv(policy, { processEnv = process.env, user = (() => { try { return userInfo(); } catch { return null; } })() } = {}) {
  const env = { ...SAFE_ENV, PATH: [...(policy.runPath ?? []), SAFE_ENV.PATH].join(':') };
  const home = user?.homedir || processEnv.HOME;
  if (typeof home === 'string' && isAbsolute(home)) env.HOME = home;
  if (user?.username) { env.USER = user.username; env.LOGNAME = user.username; }
  const sock = processEnv.SSH_AUTH_SOCK;
  if (typeof sock === 'string' && isAbsolute(sock) && !sock.includes('\0')) env.SSH_AUTH_SOCK = sock;
  return env;
}
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

// Checks shared by the agent (T2) and the root helper (T3): argv shape, timeout, environment.
// Returns {ok:true, argv, env, timeoutS, background} or a refusal.
export function checkRun(args, policy, { baseEnv = SAFE_ENV } = {}) {
  const argv = args.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(a => typeof a !== 'string' || a.includes('\0'))) return fail('invalid_arguments');
  // A program is an absolute path or a bare name looked up in the fixed PATH, never relative.
  if (argv[0].includes('/') && !isAbsolute(argv[0])) return fail('invalid_program');
  const background = args.background === true;
  const timeoutS = args.timeout_s ?? RUN_LIMITS.defaultTimeoutS;
  if (timeoutS > (background ? RUN_LIMITS.backgroundMaxS : RUN_LIMITS.foregroundMaxS)) {
    return fail('timeout_too_long', { detail: 'over 600 s needs background: true (at most 3600 s)' });
  }
  const env = { ...baseEnv };
  const entries = Object.entries(args.env ?? {});
  if (entries.length > RUN_LIMITS.maxEnv) return fail('too_many_env');
  for (const [name, value] of entries) {
    if (!policy.runEnvAllow.includes(name)) return fail('env_not_allowed', { name: /^[A-Z_][A-Z0-9_]{0,63}$/.test(name) ? name : 'invalid' });
    if (typeof value !== 'string' || value.includes('\0')) return fail('invalid_arguments');
    env[name] = value;
  }
  return { ok: true, argv: [...argv], env, timeoutS, background };
}

// The working directory: inside the read roots, a directory, and for a write-capable command
// not a default-branch checkout (D11).
//
// D11 protects tracked code from being edited outside the worktree flow. A read-only command
// cannot edit it, and it has already passed the read roots and the secret denylist above; the
// same classification already dispenses it from owner approval at the hub, so it is not sent
// to the heavy flow for an inspection either (2026-10-18: `git status` in a checkout on main
// answered `use_dev_flow`, while the owner console's golden prompt D13 expects it to run).
// `readOnly` is passed by the caller, never guessed here: a script is never read-only.
export async function checkCwd(policy, raw, { denylist, projects, readOnly = false }) {
  if (raw === undefined) return { ok: true, path: '/' };
  const at = await resolveOperatorPath(policy, raw, { access: 'r', denylist, projects });
  if (!at.ok) return at;
  const info = await lstat(at.path);
  if (!info.isDirectory()) return fail('not_a_directory');
  if (readOnly) return { ok: true, path: at.path };
  const guard = await repositoryGuard(at.path, { projects });
  if (guard) return fail(guard.error, guard.project ? { project: guard.project, branch: guard.branch } : {});
  return { ok: true, path: at.path };
}

// Read-only commands (repatriation D-R13): every path-like argument must be readable under the
// policy (read roots, secret denylist, symlinks resolved), relative ones from cwd. A missing
// file is the program's to report. Returns null or a refusal.
const PATH_REFUSALS = new Set(['path_secret', 'path_not_allowed', 'invalid_path', 'permission_denied']);
export async function readOnlyPaths(policy, paths, cwd, { denylist, projects }) {
  for (const raw of paths.slice(0, 64)) {
    if (typeof raw !== 'string' || raw === '') continue;
    const candidate = raw.startsWith('/') || raw === '~' || raw.startsWith('~/') ? raw : join(cwd, raw);
    const at = await resolveOperatorPath(policy, candidate, { access: 'r', denylist, projects });
    if (!at.ok && PATH_REFUSALS.has(at.error)) return fail(at.error, { path: raw.slice(0, 200) });
  }
  return null;
}
// Read-only git runs with configuration that can name programs switched off (core.fsmonitor,
// core.pager), no optional index writes, and no external diff or textconv drivers.
const GIT_DIFFING = new Set(['diff', 'show', 'log', 'whatchanged']);
export function hardenReadOnlyGit(argv, env) {
  const rest = argv.slice(1);
  let i = 0;
  for (; i < rest.length; i++) {
    if (['-C', '--git-dir', '--work-tree'].includes(rest[i])) { i++; continue; }
    if (!rest[i].startsWith('-')) break;
  }
  const out = GIT_DIFFING.has(rest[i]) ? [argv[0], ...rest.slice(0, i + 1), '--no-ext-diff', '--no-textconv', ...rest.slice(i + 1)] : [...argv];
  return { argv: out, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.pager', GIT_CONFIG_VALUE_1: 'cat' } };
}

export function createOperatorExecTools(policy, { run = runArgv, jobs, projects = catalogProjects(policy.repositories),
  platform = process.platform, now = Date.now, baseEnv = userRunEnv(policy), random = randomBytes,
  scriptDir = join(policy.stateDir, 'scripts') } = {}) {
  const denylist = createDenylist(policy);
  // One user run, foreground or background, in its own process group (D-R7). cleanup: files
  // removed when the program ends (a user script).
  async function execute(op, checked, cwd, cleanup = []) {
    if (checked.background) {
      if (!jobs) { for (const f of cleanup) await unlink(f).catch(() => {}); return fail('background_unavailable'); }
      const { job_id: jobId } = await jobs.start({ op, argv: checked.argv, cwd, env: checked.env, timeout_s: checked.timeoutS, process_group: true,
        ...(cleanup.length ? { cleanup } : {}) });
      return { ok: true, host: policy.host, status: 'running', job_id: jobId, detail: 'read the result with operator_job_status' };
    }
    const started = now();
    try {
      const r = await run(checked.argv, { cwd, env: checked.env, timeoutMs: checked.timeoutS * 1000 });
      if (r.code === null && !r.timedOut && r.error === 'spawn_failed') return fail('program_not_found');
      return { ok: true, host: policy.host, exit_code: r.code, signal: r.signal ?? null, timed_out: r.timedOut === true,
        output_capped: r.truncated === true, duration_ms: now() - started, ...untrusted({ stdout: r.stdout, stderr: r.stderr }) };
    } finally { for (const f of cleanup) await unlink(f).catch(() => {}); }
  }
  return {
    async operator_run(args) {
      if (args.as_root === true) return fail('root_unavailable_on_host');
      let checked = checkRun(args, policy, { baseEnv });
      if (!checked.ok) return checked;
      const ro = readOnlyCommand(checked.argv);
      const cwd = await checkCwd(policy, args.cwd, { denylist, projects, readOnly: ro !== null });
      if (!cwd.ok) return cwd;
      if (ro) {
        const refused = await readOnlyPaths(policy, ro.paths, cwd.path, { denylist, projects });
        if (refused) return refused;
        if (ro.program === 'git') checked = { ...checked, ...hardenReadOnlyGit(checked.argv, checked.env) };
      }
      return execute('operator_run', checked, cwd.path);
    },

    // A script as the agent user (D-R6): written 0700 in state_dir/scripts, run by its
    // interpreter, removed after the run. Root scripts never reach this tool (the agent forwards
    // as_root to the root helper).
    async operator_script(args) {
      if (args.as_root === true) return fail('root_unavailable_on_host');
      const interp = USER_INTERPRETERS[args.interpreter];
      if (!interp) return fail('invalid_arguments');
      const shape = checkRun({ argv: [interp.program], env: args.env, timeout_s: args.timeout_s, background: args.background }, policy, { baseEnv });
      if (!shape.ok) return shape;
      const cwd = await checkCwd(policy, args.cwd, { denylist, projects });
      if (!cwd.ok) return cwd;
      await mkdir(scriptDir, { recursive: true, mode: 0o700 });
      const file = join(scriptDir, `${random(12).toString('hex')}.${interp.ext}`);
      await writeFile(file, args.content, { mode: 0o700, flag: 'wx' });
      return execute('operator_script', { ...shape, argv: [interp.program, file, ...(args.args ?? [])] }, cwd.path, [file]);
    },

    async operator_service({ unit, action }) {
      if (!UNIT_RE.test(unit) || !policy.units.includes(unit)) return fail('unit_not_declared');
      if (platform !== 'linux') return fail('systemd_unavailable_on_host');
      // polkit grants memo-operator these actions on the declared units only (lab-infra).
      const r = await run(['systemctl', '--no-ask-password', action, unit], { timeoutMs: 90_000 });
      if (r.code === null) return fail('systemctl_unavailable');
      return { ok: r.code === 0, ...(r.code === 0 ? {} : { error: 'service_action_failed' }), host: policy.host, unit, action,
        exit_code: r.code, ...untrusted({ stderr: r.stderr.slice(-4000) }) };
    },

    async operator_job_status({ job_id: id }) {
      if (!jobs) return fail('unknown_job');
      const s = await jobs.status(id);
      if (!s.ok) return s;
      const { stdout, stderr, ...rest } = s;
      return { ...rest, host: policy.host, ...(s.status === 'done' ? untrusted({ stdout, stderr }) : {}) };
    }
  };
}
