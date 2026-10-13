// Process bookkeeping for jobs: who belongs to a job, and when it is safe to signal it.
//
// A job's recipe starts as the leader of its own process group (pgid = leader pid). Two things
// make the group alone insufficient:
// - a process can leave the group (setsid, setpgid, `detached: true` in Node), so killing the
//   group misses it; the runner therefore also follows the process tree with `ps`;
// - once the group is gone its id can be reused by an unrelated process, so a delayed signal
//   to a recorded pgid could hit someone else; signals from outside the runner therefore check
//   the leader's start time first.
//
// No shell: `ps` runs with a fixed argv. Everything here is best effort and never throws.
import { execFileSync } from 'node:child_process';

const PS = '/bin/ps';
const PS_TIMEOUT_MS = 5000;
const PS_MAX_BYTES = 8 * 1024 * 1024;

// One line of `ps -A -o pid=,ppid=,pgid=,lstart=`. lstart ("Mon Oct 13 10:00:00 2026") has
// spaces, so it comes last and is taken as the rest of the line.
export function parsePs(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), start: match[4] });
  }
  return rows;
}

// Every process visible to this user, or null when ps cannot run.
export function snapshotProcesses() {
  try {
    const text = execFileSync(PS, ['-A', '-o', 'pid=,ppid=,pgid=,lstart='], {
      encoding: 'utf8', timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BYTES, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
    });
    return parsePs(text);
  } catch {
    return null;
  }
}

// Start time of one process (the same lstart text as above), or null when it does not exist.
export function processStart(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const text = execFileSync(PS, ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: PS_TIMEOUT_MS, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
    }).trim();
    return text || null;
  } catch {
    return null;
  }
}

function groupExists(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// True when signalling process group `pgid` reaches the job whose leader started at `start`.
// POSIX never reuses a pid while a process group with that id exists, so:
// - leader alive with the recorded start time: it is the job;
// - leader alive with another start time (or no recorded start): the pid was reused, refuse;
// - leader gone but the group still exists: the id is still reserved by the job's group.
export function safeToSignalGroup(pgid, start, { startOf = processStart, exists = groupExists } = {}) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  const current = startOf(pgid);
  if (current !== null) return typeof start === 'string' && start !== '' && current === start;
  return exists(pgid);
}

export function signalJobGroup(pgid, start, signal, options) {
  if (!safeToSignalGroup(pgid, start, options)) return false;
  try { process.kill(-pgid, signal); return true; } catch { return false; }
}

// The processes of a job in `snapshot`: members of its group, previously tracked processes that
// still exist with the same start time, and every descendant of either. `tracked` maps
// pid -> start time; the result is a new map of the same shape. `exclude` lists pids never
// tracked (the runner itself).
export function jobProcesses(snapshot, pgid, tracked = new Map(), exclude = []) {
  const skip = new Set([0, 1, ...exclude]);
  const result = new Map();
  for (const p of snapshot) {
    if (skip.has(p.pid)) continue;
    if (p.pgid === pgid || tracked.get(p.pid) === p.start) result.set(p.pid, p.start);
  }
  // Descendants, to a fixed point (a parent can appear after its child in ps output).
  for (let grew = true; grew;) {
    grew = false;
    for (const p of snapshot) {
      if (skip.has(p.pid) || result.has(p.pid) || !result.has(p.ppid)) continue;
      result.set(p.pid, p.start);
      grew = true;
    }
  }
  return result;
}

// Signal every tracked process, and the groups they lead, after checking that each pid still
// has its recorded start time in a fresh snapshot.
export function signalTracked(tracked, signal, snapshot = snapshotProcesses()) {
  if (!snapshot) return 0;
  let sent = 0;
  for (const p of snapshot) {
    if (tracked.get(p.pid) !== p.start) continue;
    try { process.kill(p.pid, signal); sent++; } catch { /* already gone */ }
    if (p.pgid === p.pid) { try { process.kill(-p.pid, signal); } catch { /* already gone */ } }
  }
  return sent;
}
