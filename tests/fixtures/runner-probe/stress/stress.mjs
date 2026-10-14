// Stress fixture for memo-job@<id>.service (Phase 4, AC-P4-16, AC-P4-18, AC-P4-19). TEST-ONLY.
//
// This file is the `test` script of a throwaway fixture repository (see ../README.md). It
// pushes ONE budget at a time to show that systemd stops the job inside memo-dev.slice and
// that production is untouched. Run it only in an owner-approved test window (O-7b).
//
// The mode comes from stress.config.json in the worktree (the recipe argv is always `npm test`;
// the operator edits the config between runs):
//
//   {"mode": "sleep",  "seconds": 600, "ignore_sigterm": false}      AC-16: RuntimeMaxSec
//   {"mode": "cpu",    "workers": 8, "seconds": 600}                  CPUQuota, CPUWeight
//   {"mode": "memory", "target_mib": 4096, "step_mib": 64, "hold_seconds": 60}   MemoryMax, oom
//   {"mode": "fork",   "max_processes": 2000, "hold_seconds": 30}     TasksMax
//   {"mode": "disk",   "total_mib": 1536, "chunk_mib": 64, "hold_seconds": 600}  du budget
//   {"mode": "mixed",  "workers": 8, "seconds": 600, "target_mib": 2560, "step_mib": 64}  AC-19
//
// Guards: it refuses to run unless it is on Linux inside a memo-job unit (MEMO_JOB_ID set by
// the dispatcher's drop-in), so `npm test` in this folder on a laptop does nothing. Every
// value is bounded. `node stress.mjs --dry-run` validates the config and prints the plan.
import { spawn } from 'node:child_process';
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

const JOB_ID_RE = /^job_[A-Za-z0-9_-]{16}$/;
const FILL_FILE = 'memo-stress-fill.bin';
const MIB = 1024 * 1024;

// key: [min, max, default]
const BOUNDS = {
  seconds: [1, 7200, 600],
  workers: [1, 64, 2],
  target_mib: [1, 65536, 4096],
  step_mib: [1, 1024, 64],
  hold_seconds: [0, 3600, 30],
  max_processes: [1, 100000, 2000],
  total_mib: [1, 102400, 1536],
  chunk_mib: [1, 1024, 64]
};
const MODES = {
  sleep: ['seconds', 'ignore_sigterm'],
  cpu: ['workers', 'seconds'],
  memory: ['target_mib', 'step_mib', 'hold_seconds'],
  fork: ['max_processes', 'hold_seconds'],
  disk: ['total_mib', 'chunk_mib', 'hold_seconds', 'keep_file'],
  mixed: ['workers', 'seconds', 'target_mib', 'step_mib']
};
const BOOLEANS = new Set(['ignore_sigterm', 'keep_file']);

export function validate(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { error: 'config_not_object' };
  const keys = MODES[config.mode];
  if (!keys) return { error: 'unknown_mode' };
  const plan = { mode: config.mode };
  for (const key of Object.keys(config)) {
    if (key !== 'mode' && !keys.includes(key)) return { error: `unknown_key:${key}` };
  }
  for (const key of keys) {
    const value = config[key];
    if (BOOLEANS.has(key)) {
      if (value !== undefined && typeof value !== 'boolean') return { error: `invalid:${key}` };
      plan[key] = value ?? false;
      continue;
    }
    const [min, max, fallback] = BOUNDS[key];
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) return { error: `invalid:${key}` };
    plan[key] = value ?? fallback;
  }
  return { plan };
}

const say = fields => process.stdout.write(`${JSON.stringify({ stress: fields.mode ?? 'info', ...fields })}\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function cpuWorkers(count, seconds) {
  const code = `const { workerData } = require('node:worker_threads');
    const end = Date.now() + workerData.ms; let x = 0;
    while (Date.now() < end) { for (let i = 0; i < 1e6; i++) x = (x + i) % 1000003; }`;
  return Array.from({ length: count }, () => new Promise(resolve => {
    const worker = new Worker(code, { eval: true, workerData: { ms: seconds * 1000 } });
    worker.once('exit', resolve);
    worker.once('error', resolve);
  }));
}

async function allocate(targetMib, stepMib) {
  const kept = [];
  let allocated = 0;
  while (allocated < targetMib) {
    const step = Math.min(stepMib, targetMib - allocated);
    // Filled, so every page is touched and counts against MemoryMax.
    kept.push(Buffer.alloc(step * MIB, 0x5a));
    allocated += step;
    say({ mode: 'memory', allocated_mib: allocated });
    await sleep(50);
  }
  return kept;
}

async function forkUntilRefused(max, holdSeconds) {
  const children = [];
  let refused = null;
  for (let i = 0; i < max; i++) {
    const child = spawn('sleep', [String(holdSeconds + 60)], { stdio: 'ignore' });
    const error = await new Promise(resolve => { child.once('spawn', () => resolve(null)); child.once('error', resolve); });
    if (error) { refused = String(error.code ?? 'error'); break; }
    children.push(child);
    if (children.length % 100 === 0) say({ mode: 'fork', processes: children.length });
  }
  say({ mode: 'fork', processes: children.length, refused });
  await sleep(holdSeconds * 1000);
  for (const child of children) child.kill('SIGKILL');
}

async function fillDisk(totalMib, chunkMib, holdSeconds, keepFile) {
  const fd = openSync(FILL_FILE, 'w', 0o600);
  const chunk = Buffer.alloc(chunkMib * MIB, 0x5a);
  let written = 0;
  try {
    while (written < totalMib) {
      const size = Math.min(chunkMib, totalMib - written);
      writeSync(fd, chunk, 0, size * MIB);
      fsyncSync(fd);
      written += size;
      say({ mode: 'disk', written_mib: written });
    }
  } finally {
    closeSync(fd);
  }
  await sleep(holdSeconds * 1000);
  if (!keepFile) unlinkSync(FILL_FILE);
}

export async function execute(plan) {
  switch (plan.mode) {
    case 'sleep':
      if (plan.ignore_sigterm) process.on('SIGTERM', () => say({ mode: 'sleep', note: 'SIGTERM ignored' }));
      await sleep(plan.seconds * 1000);
      return;
    case 'cpu':
      await Promise.all(cpuWorkers(plan.workers, plan.seconds));
      return;
    case 'memory': {
      const kept = await allocate(plan.target_mib, plan.step_mib);
      await sleep(plan.hold_seconds * 1000);
      kept.length = 0;
      return;
    }
    case 'fork':
      await forkUntilRefused(plan.max_processes, plan.hold_seconds);
      return;
    case 'disk':
      await fillDisk(plan.total_mib, plan.chunk_mib, plan.hold_seconds, plan.keep_file);
      return;
    case 'mixed': {
      const workers = cpuWorkers(plan.workers, plan.seconds);
      const kept = await allocate(plan.target_mib, plan.step_mib);
      await Promise.all(workers);
      kept.length = 0;
      return;
    }
    default:
      throw new Error('unknown_mode');
  }
}

async function main(args) {
  const dryRun = args.includes('--dry-run');
  const configIndex = args.indexOf('--config');
  const configPath = configIndex >= 0 ? args[configIndex + 1] : 'stress.config.json';
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    say({ error: 'config_unreadable' });
    return 2;
  }
  const { plan, error } = validate(config);
  if (error) { say({ error }); return 2; }
  if (dryRun) { say({ plan }); return 0; }
  if (process.platform !== 'linux' || !JOB_ID_RE.test(process.env.MEMO_JOB_ID ?? '')) {
    say({ error: 'refused_outside_memo_job', note: 'runs only inside memo-job@<id>.service on the VPS' });
    return 2;
  }
  say({ mode: plan.mode, started: true, plan, job_id: process.env.MEMO_JOB_ID });
  await execute(plan);
  say({ mode: plan.mode, finished: true });
  return 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  say({ error: String(error?.code ?? error?.message ?? 'error') });
  process.exitCode = 1;
});
