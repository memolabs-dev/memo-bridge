// Host resources for the VPS runner (Phase 4, TODO-P4-09): admission (REQ-P4-17) and the disk
// budget (REQ-P4-18). Production comes first on the VPS: a dev job only starts when the host
// has room, and is stopped when its worktree and output outgrow their budget.
//
// Readings, all read-only and bounded:
// - PSI: /proc/pressure/{cpu,memory,io}, lines "some|full avg10=.. avg60=.. avg300=.. total=..".
//   Linux kernel Documentation/accounting/psi.rst. avg10 is a percentage of wall time.
// - /proc/meminfo MemAvailable (kB), proc_meminfo(5).
// - statfs(2) on the runner tree: f_bavail * f_bsize, what an unprivileged user may still use.
// - du(1) -s -k -x -P on the job's worktree and output directory, fixed argv, no shell,
//   bounded output and time. Directories it cannot read make the sum a lower bound
//   (`partial: true`).
// A reading that cannot be taken defers the job (fail closed): production first.
//
// Thresholds come from root-owned /etc/memo-bridge/runner.json (MEMO_BRIDGE_RUNNER_CONFIG).
// The defaults below are starting points inferred from the measured host (8 vCPU, 178 GiB
// free, PSI io full avg10 about 0.96) and are calibrated in TODO-P4-41.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statfsSync } from 'node:fs';

export const DEFAULT_CONFIG_PATH = '/etc/memo-bridge/runner.json';
export const DU = '/usr/bin/du';
const DU_TIMEOUT_MS = 60_000;
const DU_MAX_BUFFER = 64 * 1024;
const CONFIG_MAX_BYTES = 64 * 1024;
const GIB = 1024 ** 3;

export const PSI_KEYS = Object.freeze(['cpu_some_avg10', 'memory_some_avg10', 'memory_full_avg10', 'io_some_avg10', 'io_full_avg10']);

export const DEFAULT_RUNNER_CONFIG = Object.freeze({
  admission: Object.freeze({
    min_free_disk_gib: 40,
    min_mem_available_gib: 4,
    // Maximum avg10 percentages; a key left out is not checked.
    max_psi: Object.freeze({ cpu_some_avg10: 60, memory_full_avg10: 5, io_full_avg10: 10 })
  }),
  disk_budget_gib: 20,
  lease_ttl_seconds: 1800,
  max_queue: 20,
  // How often a deferred job is re-admitted (REQ-P4-17) and the disk budget measured (REQ-P4-18).
  defer_retry_seconds: 30,
  du_interval_seconds: 60
});

// lab-infra writes runner.json in its own shape (role memo-bridge, templates/runner.json.j2):
//   admission: { min_free_disk_bytes, min_mem_available_bytes, psi_<res>_<kind>_avg10_max, retry_sec }
//   budgets:   { disk_bytes, du_interval_sec }
// Translate it into the shape read below, so the values the owner calibrates (TODO-P4-41) are
// the values the supervisor uses. A setting given in both shapes is reported and the
// canonical key is kept.
function fromLabInfraShape(doc, errors) {
  const out = { ...doc };
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const a = obj(doc.admission) ? { ...doc.admission } : null;
  if (a) {
    for (const [from, to] of [['min_free_disk_bytes', 'min_free_disk_gib'], ['min_mem_available_bytes', 'min_mem_available_gib']]) {
      if (a[from] === undefined) continue;
      const v = num(a[from], 0, 1e6 * GIB);
      if (a[to] !== undefined || v === undefined) errors.push(`admission.${from}`);
      else a[to] = v / GIB;
    }
    const flat = Object.keys(a).filter(k => /^psi_[a-z]+_[a-z]+_avg10_max$/.test(k));
    if (flat.length) {
      if (a.max_psi !== undefined) errors.push('admission.psi');
      else {
        a.max_psi = {};
        for (const k of flat) {
          const key = k.slice('psi_'.length, -'_max'.length);
          if (PSI_KEYS.includes(key)) a.max_psi[key] = a[k]; else errors.push(`admission.${k}`);
        }
      }
    }
    if (a.retry_sec !== undefined) {
      if (doc.defer_retry_seconds !== undefined) errors.push('admission.retry_sec'); else out.defer_retry_seconds = a.retry_sec;
    }
    out.admission = a;
  }
  const b = obj(doc.budgets);
  if (b) {
    if (b.disk_bytes !== undefined) {
      const v = num(b.disk_bytes, 1, 1e6 * GIB);
      if (doc.disk_budget_gib !== undefined || v === undefined) errors.push('budgets.disk_bytes'); else out.disk_budget_gib = v / GIB;
    }
    if (b.du_interval_sec !== undefined) {
      if (doc.du_interval_seconds !== undefined) errors.push('budgets.du_interval_sec'); else out.du_interval_seconds = b.du_interval_sec;
    }
  }
  return out;
}

const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined);

// runner.json is shared with the dispatcher, which reads its own keys (recipes, unit
// properties). Only the keys below are read here; unknown keys are ignored, invalid values
// fall back to the default and are reported in `errors` (names only, never values).
export function loadRunnerConfig(path = DEFAULT_CONFIG_PATH, { readFile = readFileSync, exists = existsSync } = {}) {
  const target = path || DEFAULT_CONFIG_PATH;
  const errors = [];
  let doc = {};
  let source = 'defaults';
  if (exists(target)) {
    try {
      const text = String(readFile(target, 'utf8'));
      if (text.length > CONFIG_MAX_BYTES) throw new Error('too_large');
      doc = JSON.parse(text);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not_an_object');
      source = 'file';
    } catch {
      errors.push('runner_config_unreadable');
      doc = {};
    }
  }
  doc = fromLabInfraShape(doc, errors);
  const d = DEFAULT_RUNNER_CONFIG;
  const a = doc.admission && typeof doc.admission === 'object' ? doc.admission : {};
  const pick = (value, fallback, name, min, max) => {
    if (value === undefined) return fallback;
    const v = num(value, min, max);
    if (v === undefined) { errors.push(name); return fallback; }
    return v;
  };
  let maxPsi = { ...d.admission.max_psi };
  if (a.max_psi !== undefined) {
    if (a.max_psi && typeof a.max_psi === 'object' && !Array.isArray(a.max_psi)) {
      maxPsi = {};
      for (const key of PSI_KEYS) {
        if (a.max_psi[key] === undefined) continue;
        const v = num(a.max_psi[key], 0, 100);
        if (v === undefined) { errors.push(`admission.max_psi.${key}`); if (d.admission.max_psi[key] !== undefined) maxPsi[key] = d.admission.max_psi[key]; } else maxPsi[key] = v;
      }
    } else errors.push('admission.max_psi');
  }
  return {
    source,
    admission: {
      min_free_disk_gib: pick(a.min_free_disk_gib, d.admission.min_free_disk_gib, 'admission.min_free_disk_gib', 0, 1e6),
      min_mem_available_gib: pick(a.min_mem_available_gib, d.admission.min_mem_available_gib, 'admission.min_mem_available_gib', 0, 1e4),
      max_psi: maxPsi
    },
    disk_budget_gib: pick(doc.disk_budget_gib, d.disk_budget_gib, 'disk_budget_gib', 0.001, 1e6),
    lease_ttl_seconds: Math.trunc(pick(doc.lease_ttl_seconds, d.lease_ttl_seconds, 'lease_ttl_seconds', 60, 1800)),
    max_queue: Math.trunc(pick(doc.max_queue, d.max_queue, 'max_queue', 1, 200)),
    defer_retry_seconds: Math.trunc(pick(doc.defer_retry_seconds, d.defer_retry_seconds, 'defer_retry_seconds', 5, 3600)),
    du_interval_seconds: Math.trunc(pick(doc.du_interval_seconds, d.du_interval_seconds, 'du_interval_seconds', 5, 3600)),
    errors
  };
}

// "some avg10=0.12 avg60=0.05 avg300=0.01 total=123\nfull avg10=..." -> { some: {...}, full: {...} }
export function parsePressure(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const match = /^(some|full)\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const fields = {};
    for (const pair of match[2].split(/\s+/)) {
      const [k, v] = pair.split('=');
      const n = Number(v);
      if (['avg10', 'avg60', 'avg300', 'total'].includes(k) && Number.isFinite(n)) fields[k] = n;
    }
    if (typeof fields.avg10 === 'number') out[match[1]] = fields;
  }
  return out.some ? out : null;
}

// /proc/meminfo -> bytes. Null when MemAvailable is missing (kernel < 3.14, or not Linux).
export function parseMeminfo(text) {
  const kb = name => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm').exec(String(text ?? ''));
    return match ? Number(match[1]) * 1024 : null;
  };
  const available = kb('MemAvailable');
  if (available === null) return null;
  return { available_bytes: available, total_bytes: kb('MemTotal'), swap_total_bytes: kb('SwapTotal'), swap_free_bytes: kb('SwapFree') };
}

// `du -s -k` output, one "<kib>\t<path>" line per operand.
export function parseDu(text) {
  let total = 0; let lines = 0;
  for (const line of String(text ?? '').split('\n')) {
    const match = /^(\d+)\s/.exec(line);
    if (!match) continue;
    total += Number(match[1]) * 1024; lines++;
  }
  return lines ? total : null;
}

function execDu(command, args) {
  return new Promise(resolve => {
    execFile(command, args, { timeout: DU_TIMEOUT_MS, maxBuffer: DU_MAX_BUFFER, killSignal: 'SIGKILL', windowsHide: true,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout) });
      if (error.code === 'ENOENT') return resolve({ code: null, missing: true });
      if (error.killed || error.signal) return resolve({ code: null, timedOut: true });
      resolve({ code: typeof error.code === 'number' ? error.code : 1, stdout: String(stdout ?? '') });
    });
  });
}

/**
 * procRoot: where /proc is (tests point it at a temporary tree). readFile, statfs, run: the
 * readers (tests inject them). Every method returns null for a reading it could not take.
 */
export function createResourceReader({ procRoot = '/proc', readFile = readFileSync, statfs = statfsSync, run = execDu,
  du = DU } = {}) {
  const readText = path => { try { return String(readFile(path, 'utf8')).slice(0, 64 * 1024); } catch { return null; } };
  const reader = {
    pressure() {
      const out = {};
      for (const resource of ['cpu', 'memory', 'io']) {
        const parsed = parsePressure(readText(`${procRoot}/pressure/${resource}`));
        if (!parsed) return null;
        out[resource] = parsed;
      }
      return out;
    },
    meminfo() {
      return parseMeminfo(readText(`${procRoot}/meminfo`));
    },
    disk(path) {
      try {
        const s = statfs(path);
        return { path, free_bytes: Number(s.bavail) * Number(s.bsize), total_bytes: Number(s.blocks) * Number(s.bsize) };
      } catch {
        return null;
      }
    },
    // Bytes used under the given paths (missing paths count as 0).
    async usage(paths) {
      const present = paths.filter(p => typeof p === 'string' && p.startsWith('/') && existsSync(p));
      if (!present.length) return { bytes: 0, partial: false };
      const r = await run(du, ['-s', '-k', '-x', '-P', '--', ...present]);
      if (r.missing || r.timedOut) return null;
      const bytes = parseDu(r.stdout);
      if (bytes === null) return null;
      // du exits 1 when it could not read part of the tree: the sum is a lower bound.
      return { bytes, partial: r.code !== 0 };
    },
    snapshot({ diskPath }) {
      return { pressure: reader.pressure(), memory: reader.meminfo(), disk: reader.disk(diskPath) };
    }
  };
  return reader;
}

// Admission (REQ-P4-17). { ok: true } or { ok: false, reason: deferred_disk | deferred_pressure, detail }.
export function admit(snapshot, admission = DEFAULT_RUNNER_CONFIG.admission) {
  const disk = snapshot?.disk;
  if (!disk || !Number.isFinite(disk.free_bytes)) return { ok: false, reason: 'deferred_disk', detail: 'disk_unreadable' };
  if (disk.free_bytes < admission.min_free_disk_gib * GIB) return { ok: false, reason: 'deferred_disk', detail: 'free_disk_below_minimum' };
  const memory = snapshot.memory;
  if (!memory || !Number.isFinite(memory.available_bytes)) return { ok: false, reason: 'deferred_pressure', detail: 'meminfo_unreadable' };
  if (memory.available_bytes < admission.min_mem_available_gib * GIB) {
    return { ok: false, reason: 'deferred_pressure', detail: 'mem_available_below_minimum' };
  }
  const limits = Object.entries(admission.max_psi ?? {});
  if (limits.length) {
    if (!snapshot.pressure) return { ok: false, reason: 'deferred_pressure', detail: 'psi_unreadable' };
    for (const [key, max] of limits) {
      const [resource, kind] = key.split('_');
      const value = snapshot.pressure[resource]?.[kind]?.avg10;
      if (typeof value !== 'number') return { ok: false, reason: 'deferred_pressure', detail: 'psi_unreadable' };
      if (value > max) return { ok: false, reason: 'deferred_pressure', detail: `psi_${key}_above_maximum` };
    }
  }
  return { ok: true };
}

// A compact, number-only view of a snapshot for status answers and job events.
export function summarizeSnapshot(snapshot) {
  if (!snapshot) return null;
  const round = n => (typeof n === 'number' ? Math.round(n * 100) / 100 : null);
  const p = snapshot.pressure;
  return {
    psi_avg10: p ? { cpu_some: round(p.cpu?.some?.avg10), memory_some: round(p.memory?.some?.avg10),
      memory_full: round(p.memory?.full?.avg10), io_some: round(p.io?.some?.avg10), io_full: round(p.io?.full?.avg10) } : null,
    mem_available_gib: snapshot.memory ? round(snapshot.memory.available_bytes / GIB) : null,
    disk_free_gib: snapshot.disk ? round(snapshot.disk.free_bytes / GIB) : null
  };
}
