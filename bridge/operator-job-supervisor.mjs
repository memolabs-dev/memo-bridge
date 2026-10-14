// Supervisor of one background operator run (Phase 6, TODO-P6-09). Started detached by
// bridge/operator-jobs.mjs with one argument, the job directory. Reads job.json, runs its argv
// without a shell, streams output to files (4 MiB cap each), enforces timeout_s, and writes
// result.json atomically (write, fsync, rename) when the program ends. Nothing here reads a
// caller string as code: argv[0] is the program, the rest are its arguments.
import { spawn } from 'node:child_process';
import { constants as fsConstants, openSync, writeSync, closeSync, fsyncSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_OUTPUT = 4 * 1024 * 1024;
const dir = process.argv[2];
const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8'));
writeFileSync(join(dir, 'pid'), String(process.pid), { mode: 0o600 });
const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
const out = openSync(join(dir, 'stdout'), flags, 0o600);
const err = openSync(join(dir, 'stderr'), flags, 0o600);
const written = { out: 0, err: 0 };
const sink = (fd, key) => chunk => {
  const room = MAX_OUTPUT - written[key];
  if (room <= 0) return;
  const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
  writeSync(fd, part);
  written[key] += part.length;
};

const started = Date.now();
// process_group (the Mac root helper, DEV-P6-32): the program leads its own process group, and
// the whole group is killed at the timeout and once the program exits.
const group = job.process_group === true;
const stop = () => {
  if (group && child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } return; }
  child.kill('SIGKILL');
};
let timedOut = false;
let done = false;
function finish(code, signal) {
  if (done) return;
  done = true;
  closeSync(out); closeSync(err);
  const tmp = join(dir, 'result.json.tmp');
  const fd = openSync(tmp, flags, 0o600);
  writeSync(fd, JSON.stringify({ exit_code: code, signal: signal ?? null, timed_out: timedOut, ended_at: new Date().toISOString(),
    duration_ms: Date.now() - started, output_capped: written.out >= MAX_OUTPUT || written.err >= MAX_OUTPUT }));
  fsyncSync(fd); closeSync(fd);
  renameSync(tmp, join(dir, 'result.json'));
}

let child;
try {
  child = spawn(job.argv[0], job.argv.slice(1), { shell: false, cwd: job.cwd || '/', env: job.env ?? {}, stdio: ['ignore', 'pipe', 'pipe'],
    detached: group });
} catch {
  finish(null, null);
  process.exit(0);
}
child.stdout.on('data', sink(out, 'out'));
child.stderr.on('data', sink(err, 'err'));
const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, job.timeout_s ?? 30) * 1000);
if (group) child.on('exit', () => { clearTimeout(timer); stop(); });
child.on('error', () => { clearTimeout(timer); finish(null, null); process.exit(0); });
child.on('close', (code, signal) => { clearTimeout(timer); finish(code, signal); });
