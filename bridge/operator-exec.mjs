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
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { UNIT_RE } from './operator-policy.mjs';
import { createDenylist, catalogProjects, repositoryGuard, resolveOperatorPath } from './operator-paths.mjs';
import { SAFE_ENV, runArgv } from './operator-tools.mjs';
import { untrusted } from './operator-output.mjs';

export const RUN_LIMITS = Object.freeze({ defaultTimeoutS: 30, foregroundMaxS: 600, backgroundMaxS: 3600, maxEnv: 32 });
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

// The working directory: inside the read roots, a directory, not a default-branch checkout.
export async function checkCwd(policy, raw, { denylist, projects }) {
  if (raw === undefined) return { ok: true, path: '/' };
  const at = await resolveOperatorPath(policy, raw, { access: 'r', denylist, projects });
  if (!at.ok) return at;
  const info = await lstat(at.path);
  if (!info.isDirectory()) return fail('not_a_directory');
  const guard = await repositoryGuard(at.path, { projects });
  if (guard) return fail(guard.error, guard.project ? { project: guard.project, branch: guard.branch } : {});
  return { ok: true, path: at.path };
}

export function createOperatorExecTools(policy, { run = runArgv, jobs, projects = catalogProjects(policy.repositories),
  platform = process.platform, now = Date.now } = {}) {
  const denylist = createDenylist(policy);
  return {
    async operator_run(args) {
      if (args.as_root === true) return fail('root_unavailable_on_host');
      const checked = checkRun(args, policy);
      if (!checked.ok) return checked;
      const cwd = await checkCwd(policy, args.cwd, { denylist, projects });
      if (!cwd.ok) return cwd;
      if (checked.background) {
        if (!jobs) return fail('background_unavailable');
        const { job_id: jobId } = await jobs.start({ op: 'operator_run', argv: checked.argv, cwd: cwd.path, env: checked.env, timeout_s: checked.timeoutS });
        return { ok: true, host: policy.host, status: 'running', job_id: jobId, detail: 'read the result with operator_job_status' };
      }
      const started = now();
      const r = await run(checked.argv, { cwd: cwd.path, env: checked.env, timeoutMs: checked.timeoutS * 1000 });
      if (r.code === null && !r.timedOut && r.error === 'spawn_failed') return fail('program_not_found');
      return { ok: true, host: policy.host, exit_code: r.code, signal: r.signal ?? null, timed_out: r.timedOut === true,
        output_capped: r.truncated === true, duration_ms: now() - started, ...untrusted({ stdout: r.stdout, stderr: r.stderr }) };
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
