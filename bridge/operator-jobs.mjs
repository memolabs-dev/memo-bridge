// Background operator runs (Phase 6, TODO-P6-09, spec D10, AC-P6-12).
//
// A background run is a directory under <state_dir>/jobs/<id>/ (0700):
//   job.json     what to run, written and fsynced BEFORE anything starts or is answered
//   pid          the supervisor's pid
//   stdout, stderr  the output, capped at 4 MiB each
//   result.json  {exit_code, signal, timed_out, ended_at, duration_ms}, written atomically by the
//                supervisor (rename) when the program ends, BEFORE any status can report it
// The supervisor (bridge/operator-job-supervisor.mjs) is a detached Node process: it survives
// a restart of the agent (lab-infra sets KillMode=process on memo-operator.service, DEV-P6-17),
// and the result is read back from disk by whichever agent instance is asked (AC-P6-12). A job
// with no result whose supervisor is gone is reported `lost`, never guessed.
// The same store serves the root helper (job ids rj_), where the program is the systemd-run argv.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUPERVISOR = fileURLToPath(new URL('./operator-job-supervisor.mjs', import.meta.url));
export const JOB_OUTPUT_TAIL_BYTES = 256 * 1024;
const JOB_ID_RE = /^r?j_[A-Za-z0-9_-]{16,40}$/;

async function writeSynced(path, text) {
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
  try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
  await rename(tmp, path);
}

async function tail(path, bytes) {
  let fh;
  try { fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { return ''; }
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return (size > len ? `[... ${size - len} bytes before ...]\n` : '') + buf.toString('utf8');
  } finally { await fh.close(); }
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };

// dir: the jobs directory. prefix: 'j' (agent) or 'rj' (root helper). launch(jobDir) starts the
// supervisor (injectable: tests may run it in process or not at all).
export function createJobStore({ dir, prefix = 'j', now = Date.now, random = randomBytes,
  launch = jobDir => { const child = spawn(process.execPath, [SUPERVISOR, jobDir], { detached: true, stdio: 'ignore' }); child.unref(); } } = {}) {
  const jobDir = id => join(dir, id);
  return Object.freeze({
    // job: {argv, cwd, env, timeout_s, op, principal}. Returns {job_id} once job.json is on disk.
    async start(job) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const id = `${prefix}_${random(16).toString('base64url')}`;
      const d = jobDir(id);
      await mkdir(d, { mode: 0o700 });
      await writeSynced(join(d, 'job.json'), JSON.stringify({ id, ...job, started_at: new Date(now()).toISOString() }));
      launch(d);
      return { job_id: id };
    },
    async status(id) {
      if (typeof id !== 'string' || !JOB_ID_RE.test(id) || !id.startsWith(`${prefix}_`)) return { ok: false, error: 'unknown_job' };
      const d = jobDir(id);
      let job;
      try { job = JSON.parse(await readFile(join(d, 'job.json'), 'utf8')); } catch { return { ok: false, error: 'unknown_job' }; }
      const base = { ok: true, job_id: id, op: job.op ?? null, started_at: job.started_at };
      let result = null;
      try { result = JSON.parse(await readFile(join(d, 'result.json'), 'utf8')); } catch { result = null; }
      if (result) {
        return { ...base, status: 'done', exit_code: result.exit_code, signal: result.signal ?? null, timed_out: result.timed_out === true,
          ended_at: result.ended_at, duration_ms: result.duration_ms,
          stdout: await tail(join(d, 'stdout'), JOB_OUTPUT_TAIL_BYTES), stderr: await tail(join(d, 'stderr'), JOB_OUTPUT_TAIL_BYTES) };
      }
      let pid = null;
      try { pid = Number((await readFile(join(d, 'pid'), 'utf8')).trim()); } catch { pid = null; }
      if (pid && alive(pid)) return { ...base, status: 'running' };
      // Started moments ago: the supervisor may not have written its pid yet.
      const age = now() - (await stat(join(d, 'job.json'))).mtimeMs;
      if (!pid && age < 5_000) return { ...base, status: 'running' };
      return { ...base, status: 'lost', detail: 'the supervisor ended without a result (host restart or kill)' };
    }
  });
}
