// T0 operator tools, as the host agent runs them (Phase 6, TODO-P6-03, spec §4, D8, D10).
//
// createOperatorTools(policy, deps) returns {op: async (args) => data} for the read tier. Each
// tool receives arguments already validated by the shared schema (server/tools/operator-tools.mjs)
// and signature-checked by the agent (bridge/operator-agent.mjs). Rules held here:
//  - every path goes through resolveOperatorPath (realpath, roots, secret denylist); entries
//    found while walking are checked against the denylist again and skipped silently (counted);
//  - commands are fixed argv arrays run with shell:false and a minimal environment; a caller
//    value only ever fills one argv slot, after a check against the policy's declared units or
//    containers (a unit name is never a flag: UNIT_RE starts with a letter or digit);
//  - contents, names and command output travel as untrusted_content; redaction and the 128 KiB
//    bound are applied by the agent on every result (operator-output.mjs finalizeResult).
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, statfs } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';
import { join } from 'node:path';
import { CONTAINER_RE, UNIT_RE, policySummary } from './operator-policy.mjs';
import { createDenylist, resolveOperatorPath, catalogProjects } from './operator-paths.mjs';
import { untrusted } from './operator-output.mjs';

export const LIMITS = Object.freeze({
  readDefaultBytes: 64 * 1024, readMaxBytes: 128 * 1024, listEntries: 1000, listDepth: 5,
  searchResults: 200, searchDefaultResults: 100, searchBudgetMs: 20_000, searchMaxFileBytes: 4 * 1024 * 1024,
  searchMaxFiles: 20_000, searchDepth: 12, searchLineChars: 4096, matchTextChars: 512,
  logLinesDefault: 200, commandTimeoutMs: 15_000, commandMaxBytes: 4 * 1024 * 1024
});
// Skipped while walking, as SentinelX does (research §3): big, never what the owner looks for.
export const NOISE_DIRS = Object.freeze(new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.next',
  '.pnpm-store', '.tox', '.mypy_cache', '.pytest_cache', 'DerivedData']));
export const SAFE_ENV = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin:/opt/homebrew/bin:/usr/local/bin', LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: '', PAGER: 'cat' });

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

// Run one fixed argv without a shell. Resolves {code, signal, stdout, stderr, timedOut,
// truncated}; never rejects (a missing binary answers code null, error 'spawn_failed').
// Repatriation D-R7: the program leads its own process group (spawn detached: setsid), and the
// whole group gets SIGKILL at the timeout and once the program exits, so a grandchild cannot
// outlive the call. A program that leaves the group on purpose (setsid, daemons) is out of reach.
export function runArgv(argv, { timeoutMs = LIMITS.commandTimeoutMs, maxBytes = LIMITS.commandMaxBytes, env = SAFE_ENV, cwd,
  kill = (pid, signal) => process.kill(pid, signal) } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env }, ...(cwd ? { cwd } : {}) });
    } catch { resolve({ code: null, error: 'spawn_failed', stdout: '', stderr: '', timedOut: false, truncated: false }); return; }
    const killGroup = () => { if (child.pid) { try { kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ } } };
    const out = []; const err = []; let size = 0; let truncated = false; let timedOut = false;
    const take = (chunks, chunk) => {
      if (size >= maxBytes) { truncated = true; return; }
      const room = maxBytes - size;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      if (chunk.length > room) truncated = true;
      size += Math.min(chunk.length, room);
    };
    child.stdout.on('data', c => take(out, c));
    child.stderr.on('data', c => take(err, c));
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    child.on('exit', () => { clearTimeout(timer); killGroup(); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, error: 'spawn_failed', stdout: '', stderr: '', timedOut, truncated }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, truncated });
    });
  });
}

// Name filter with * and ? only (no path separators), case-insensitive.
export function nameMatcher(glob) {
  if (!glob) return () => true;
  const re = new RegExp(`^${glob.replace(/[\\^$.|+(){}[\]]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return name => re.test(name);
}

// A regular expression the search may run: bounded length, compiled, and refused when it nests
// quantifiers ((a+)+ and the like), the usual catastrophic backtracking shape.
export function searchMatcher(pattern, { regex = false, caseSensitive = true } = {}) {
  if (!regex) {
    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    return { ok: true, test: line => (caseSensitive ? line : line.toLowerCase()).includes(needle) };
  }
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{?]/.test(pattern)) return fail('regex_too_complex');
  let re;
  try { re = new RegExp(pattern, caseSensitive ? 'u' : 'iu'); } catch { return fail('invalid_pattern'); }
  return { ok: true, test: line => re.test(line) };
}

// Decode a file slice: BOM-aware UTF-8 and UTF-16, binary when a NUL byte shows up first.
export function decodeSlice(buf, { atStart }) {
  if (atStart && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: 'utf-16le', text: buf.subarray(2).toString('utf16le') };
  if (atStart && buf[0] === 0xfe && buf[1] === 0xff) {
    // swap16 needs an even length: a split last code unit is dropped.
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    return { encoding: 'utf-16be', text: body.swap16().toString('utf16le') };
  }
  if (buf.subarray(0, 8192).includes(0)) return { encoding: 'binary', text: null };
  const bom = atStart && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = bom ? buf.subarray(3) : buf;
  try {
    return { encoding: 'utf-8', text: new TextDecoder('utf-8', { fatal: true }).decode(body) };
  } catch {
    // A range may split a character; a real non-UTF-8 file is shown lossily, and says so.
    return { encoding: 'utf-8-lossy', text: body.toString('utf8') };
  }
}

// deps: run (argv runner), projects (D11 guard source), platform, now, guard (freeze status),
// chain (audit chain), statfsImpl, resolve (path resolver; tests).
export function createOperatorTools(policy, { run = runArgv, projects = catalogProjects(policy.repositories),
  platform = process.platform, now = Date.now, guard = null, chain = null, statfsImpl = statfs } = {}) {
  const denylist = createDenylist(policy);
  const resolve = (raw, access = 'r') => resolveOperatorPath(policy, raw, { access, denylist, projects });

  // Walk a directory without following symlinks. visit(entry) returns false to stop.
  async function walk(start, { depth, hidden, onEntry, deadline = Infinity }) {
    const stats = { denied: 0, unreadable: 0, stopped: null };
    const queue = [[start, 0]];
    while (queue.length) {
      const [dir, level] = queue.shift();
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { stats.unreadable++; continue; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (now() > deadline) { stats.stopped = 'time_budget'; return stats; }
        if (!hidden && entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (denylist.denied(full)) { stats.denied++; continue; }
        if (entry.isDirectory() && NOISE_DIRS.has(entry.name)) continue;
        const keepGoing = await onEntry(entry, full, level + 1);
        if (keepGoing === false) { stats.stopped = 'limit'; return stats; }
        if (entry.isDirectory() && level + 1 < depth) queue.push([full, level + 1]);
      }
    }
    return stats;
  }

  async function diskOf(paths) {
    const out = [];
    for (const path of paths.slice(0, 8)) {
      try {
        const s = await statfsImpl(path);
        out.push({ path, total_gib: +(s.blocks * s.bsize / 2 ** 30).toFixed(1), free_gib: +(s.bavail * s.bsize / 2 ** 30).toFixed(1) });
      } catch { out.push({ path, error: 'unavailable' }); }
    }
    return out;
  }

  const lines = text => text.split('\n').filter(Boolean);

  return {
    async operator_policy() {
      return { ok: true, host: policy.host, policy: policySummary(policy), frozen: guard ? guard.status() : null };
    },

    async operator_state() {
      const linux = platform === 'linux';
      const up = uptime();
      const state = {
        ok: true, host: policy.host, platform,
        uptime_s: Math.round(up), last_boot: new Date(now() - up * 1000).toISOString(),
        load_average: loadavg().map(v => +v.toFixed(2)), cpu_count: cpus().length,
        memory: { total_mib: Math.round(totalmem() / 2 ** 20), free_mib: Math.round(freemem() / 2 ** 20) },
        disk: await diskOf(['/', ...policy.readRoots.filter(r => r !== '/')])
      };
      let failed = null; let docker = null;
      if (linux) {
        const r = await run(['systemctl', '--failed', '--no-legend', '--plain', '--no-pager']);
        failed = r.code === 0 ? lines(r.stdout).map(l => l.split(/\s+/)[0]).slice(0, 100) : { error: 'systemctl_unavailable' };
      }
      const d = await run(['docker', 'ps', '--format', '{{.Names}}\t{{.Status}}']);
      docker = d.code === 0 ? lines(d.stdout).slice(0, 200).map(l => { const [name, status] = l.split('\t'); return { name, status }; })
        : { error: 'docker_unavailable' };
      return { ...state, ...untrusted({ failed_units: failed, containers: docker }) };
    },

    async operator_list({ path, depth = 1, glob, show_hidden: hidden = false, limit = LIMITS.listEntries }) {
      const at = await resolve(path);
      if (!at.ok) return at;
      const info = await lstat(at.path);
      if (!info.isDirectory()) return fail('not_a_directory');
      const matches = nameMatcher(glob);
      const entries = [];
      const stats = await walk(at.path, { depth: Math.min(depth, LIMITS.listDepth), hidden, onEntry: async (entry, full) => {
        if (glob && !entry.isDirectory() && !matches(entry.name)) return true;
        let size = null; let mtime = null;
        try { const s = await lstat(full); size = s.size; mtime = s.mtime.toISOString(); } catch { /* vanished */ }
        const type = entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other';
        entries.push({ path: full, type, size, mtime });
        return entries.length < Math.min(limit, LIMITS.listEntries);
      } });
      return { ok: true, host: policy.host, path: at.path, count: entries.length, truncated: stats.stopped === 'limit',
        secret_entries_skipped: stats.denied, unreadable_dirs: stats.unreadable, ...untrusted({ entries }) };
    },

    async operator_read({ path, offset = 0, max_bytes: maxBytes = LIMITS.readDefaultBytes }) {
      const at = await resolve(path);
      if (!at.ok) return at;
      let fh;
      // O_NOFOLLOW on the canonical path: a swap to a symlink after realpath fails here.
      try { fh = await open(at.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0)); } catch (error) {
        return fail(error?.code === 'EACCES' ? 'permission_denied' : error?.code === 'ELOOP' ? 'path_changed' : 'unreadable');
      }
      try {
        const info = await fh.stat();
        if (!info.isFile()) return fail('not_a_file');
        const size = info.size;
        const want = Math.min(maxBytes, LIMITS.readMaxBytes, Math.max(0, size - offset));
        const buf = Buffer.alloc(want);
        let got = 0;
        while (got < want) { const { bytesRead } = await fh.read(buf, got, want - got, offset + got); if (!bytesRead) break; got += bytesRead; }
        const slice = buf.subarray(0, got);
        const decoded = decodeSlice(slice, { atStart: offset === 0 });
        const next = offset + got < size ? offset + got : null;
        const base = { ok: true, host: policy.host, path: at.path, size, offset, bytes: got, next_offset: next, encoding: decoded.encoding,
          mtime: info.mtime.toISOString() };
        if (decoded.encoding === 'binary') return { ...base, binary: true };
        return { ...base, ...untrusted({ content: decoded.text }) };
      } finally { await fh.close(); }
    },

    async operator_search({ path, pattern, regex = false, case_sensitive: caseSensitive = true, file_glob: fileGlob,
      max_results: maxResults = LIMITS.searchDefaultResults }) {
      const at = await resolve(path);
      if (!at.ok) return at;
      const matcher = searchMatcher(pattern, { regex, caseSensitive });
      if (!matcher.ok) return matcher;
      const fileMatches = nameMatcher(fileGlob);
      const limit = Math.min(maxResults, LIMITS.searchResults);
      const deadline = now() + LIMITS.searchBudgetMs;
      const matches = [];
      let files = 0; let skippedBinary = 0; let skippedLarge = 0; let truncatedReason = null;
      const searchFile = async full => {
        files++;
        let fh;
        try { fh = await open(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0)); } catch { return true; }
        try {
          const info = await fh.stat();
          if (!info.isFile()) return true;
          if (info.size > LIMITS.searchMaxFileBytes) { skippedLarge++; return true; }
          const buf = await fh.readFile();
          if (buf.subarray(0, 8192).includes(0)) { skippedBinary++; return true; }
          const text = buf.toString('utf8').split('\n');
          for (let i = 0; i < text.length; i++) {
            const line = text[i].length > LIMITS.searchLineChars ? text[i].slice(0, LIMITS.searchLineChars) : text[i];
            if (!matcher.test(line)) continue;
            matches.push({ path: full, line: i + 1, text: line.slice(0, LIMITS.matchTextChars) });
            if (matches.length >= limit) { truncatedReason = 'max_results'; return false; }
          }
          if (files >= LIMITS.searchMaxFiles) { truncatedReason = 'max_files'; return false; }
          return true;
        } finally { await fh.close(); }
      };
      const info = await lstat(at.path);
      let stats = { denied: 0, stopped: null };
      if (info.isFile()) await searchFile(at.path);
      else if (info.isDirectory()) {
        stats = await walk(at.path, { depth: LIMITS.searchDepth, hidden: true, deadline, onEntry: async (entry, full) => {
          if (!entry.isFile() || !fileMatches(entry.name)) return true;
          return searchFile(full);
        } });
        if (stats.stopped === 'time_budget') truncatedReason = 'time_budget';
      } else return fail('not_a_file');
      return { ok: true, host: policy.host, path: at.path, files_scanned: files, count: matches.length,
        truncated_reason: truncatedReason, skipped_binary: skippedBinary, skipped_large: skippedLarge,
        secret_entries_skipped: stats.denied, ...untrusted({ matches }) };
    },

    async operator_logs({ unit, container, lines: count = LIMITS.logLinesDefault, since }) {
      if ((unit === undefined) === (container === undefined)) return fail('invalid_arguments', { detail: 'exactly one of unit, container' });
      let argv;
      if (unit !== undefined) {
        if (!UNIT_RE.test(unit) || !policy.units.includes(unit)) return fail('unit_not_declared');
        if (platform !== 'linux') return fail('logs_unavailable_on_host');
        argv = ['journalctl', '--no-pager', '--output=short-iso', `--lines=${count}`, `--unit=${unit}`,
          ...(since ? [`--since=${since}`] : [])];
      } else {
        if (!CONTAINER_RE.test(container) || !policy.containers.includes(container)) return fail('container_not_declared');
        argv = ['docker', 'logs', `--tail=${count}`, ...(since ? [`--since=${since.startsWith('-') ? since.slice(1) : since}`] : []), container];
      }
      const r = await run(argv);
      if (r.code === null) return fail('logs_unavailable');
      if (r.code !== 0) return fail('logs_failed', { exit_code: r.code });
      // docker logs writes the container's stderr to its own stderr: both are the log.
      const text = unit !== undefined ? r.stdout : `${r.stdout}${r.stderr}`;
      return { ok: true, host: policy.host, source: unit !== undefined ? { unit } : { container }, truncated: r.truncated,
        ...untrusted({ lines: text.split('\n').filter(Boolean).slice(-count) }) };
    },

    async operator_service_status({ unit }) {
      if (!UNIT_RE.test(unit) || !policy.units.includes(unit)) return fail('unit_not_declared');
      if (platform !== 'linux') return fail('systemd_unavailable_on_host');
      const r = await run(['systemctl', 'show', '--no-pager',
        '--property=Id,LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStartTimestamp,Result,NRestarts', unit]);
      if (r.code !== 0) return fail('systemctl_failed', { exit_code: r.code });
      const props = {};
      for (const line of lines(r.stdout)) {
        const i = line.indexOf('=');
        if (i > 0) props[line.slice(0, i)] = line.slice(i + 1).slice(0, 200);
      }
      return { ok: true, host: policy.host, unit, is_active: props.ActiveState ?? null, is_enabled: props.UnitFileState ?? null,
        load_state: props.LoadState ?? null, sub_state: props.SubState ?? null, main_pid: props.MainPID ? Number(props.MainPID) : null,
        started: props.ExecMainStartTimestamp || null, result: props.Result ?? null, restarts: props.NRestarts ? Number(props.NRestarts) : null };
    },

    async operator_freeze_status() {
      const s = guard ? guard.status() : { file: false, auto: false };
      return { ok: true, host: policy.host, host_frozen_file: s.file, auto_frozen: s.auto, frozen_above_t0: s.file || s.auto,
        unfreeze: 'owner only: remove the FROZEN file or the auto-freeze marker on the host (no tool can)' };
    },

    async operator_audit_verify() {
      if (!chain) return fail('audit_unavailable');
      let v;
      try { v = await chain.verify(); } catch { return fail('audit_unavailable'); }
      return { ok: true, host: policy.host, chain_ok: v.ok, lines: v.lines, head: v.head,
        ...(v.ok ? {} : { first_broken_line: v.first_broken_line, reason: v.reason }) };
    }
  };
}
