// Multi-process helpers for the invariants: a pool of forked workers (lib/worker.mjs), each one a
// session with its own SQLite connection on a shared state directory. A self-contained copy of
// startWorkers / stopWorkers from tests/coordinator-concurrency.test.mjs, so the invariants never
// import tests/helpers/.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url));

function startWorker(stateDir, githubState, clockOffsetMs, project) {
  const child = fork(WORKER, [stateDir, githubState, String(clockOffsetMs), project], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
  const messages = []; const waiters = [];
  child.on('message', m => {
    const i = waiters.findIndex(w => w.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else messages.push(m);
  });
  const next = type => new Promise((resolve, reject) => {
    const i = messages.findIndex(m => m.type === type);
    if (i >= 0) return resolve(messages.splice(i, 1)[0]);
    waiters.push({ type, resolve });
    child.once('exit', code => reject(new Error(`worker exited ${code}: ${stderr.trim().slice(-400)}`)));
  });
  return { child, next };
}

// `clockOffsetMs[i]` shifts worker i's Bridge clock (default 0). `project` is the registered
// project every worker opens its workspace on.
export async function startWorkers(stateDir, githubState, count, { clockOffsetMs = [], project = 'drop' } = {}) {
  const workers = Array.from({ length: count }, (_, i) => startWorker(stateDir, githubState, clockOffsetMs[i] ?? 0, project));
  const ready = await Promise.all(workers.map(w => w.next('ready')));
  return { workers, ready };
}

// Idempotent: a worker that already exited is not waited for.
export async function stopWorkers(workers) {
  await Promise.all(workers.map(w => new Promise(resolve => {
    if (w.child.exitCode !== null || w.child.signalCode !== null) return resolve();
    w.child.once('exit', resolve);
    try { w.child.send({ type: 'exit' }); } catch { w.child.kill('SIGKILL'); }
  })));
}

// Every worker claims `issue`; resolves to the claim results in worker order.
export async function raceClaims(workers, issue, ttl) {
  for (const w of workers) w.child.send({ type: 'claim', issue, ttl });
  return (await Promise.all(workers.map(w => w.next('claimed')))).map(m => m.claim);
}

// The rows of one Issue in a store (newest first), read through a transaction.
export const claimRows = (store, issue) => store.transaction(repo => repo.claimsOfIssue(issue, 200), { write: false });
