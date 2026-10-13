// Host capabilities and resources for the runners (Phase 3).
//
// What a machine can do is answered from two kinds of facts, always labelled:
// - 'observed': read on the machine running this process, with fixed read-only probes
//   (execFile, fixed argv, short timeouts, no shell), cached in memory for five minutes;
// - 'declared': the role each machine has in Memo Labs OS (Vault 1-Projects/memo-labs-os.md).
// A machine that is not local is never probed again here: its reachability comes from the
// existing host_status probe (server/probe.mjs collectHost), nothing else.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { arch, cpus, freemem, homedir, hostname, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { collectHost } from '../probe.mjs';
import { maxJobsFromEnv } from './jobs.mjs';

export const HOST_IDS = Object.freeze(['mac', 'vps']);
export const PROBE_CACHE_MS = 5 * 60 * 1000;
// Short, but long enough for `swift --version` on a loaded Mac (about 4 s observed at load 19).
const PROBE_TIMEOUT_MS = 6000;
const PROBE_MAX_BUFFER = 16 * 1024;
const MAX_TEXT = 160;

// The job concurrency limit is the one the job runner enforces (server/runners/jobs.mjs,
// MEMO_BRIDGE_MAX_JOBS), so host_resources never reports a number nobody applies.
export function jobConcurrencyLimit(env = process.env) {
  return maxJobsFromEnv(env);
}

// Declared roles. They describe intent and policy, not what the probes found.
export const DECLARED_ROLES = Object.freeze({
  mac: Object.freeze({
    roles: Object.freeze([
      Object.freeze({ id: 'apple-native-builds', description: 'Native Apple builds and tests (Xcode, Swift, iOS/macOS apps)' }),
      Object.freeze({ id: 'desktop', description: 'Desktop applications and simulators that need a graphical session' }),
      Object.freeze({ id: 'local-dev', description: 'Local development of registered projects' })
    ]),
    limitations: Object.freeze(['Accepts no incoming connection: the VPS cannot reach it; work reaches it only through sessions on the Mac'])
  }),
  vps: Object.freeze({
    roles: Object.freeze([
      Object.freeze({ id: 'linux-builds', description: 'Linux builds and tests' }),
      Object.freeze({ id: 'services', description: 'Production services (lab-infra stacks, autodeploy)' }),
      Object.freeze({ id: 'agents', description: 'Long-running agent workflows' })
    ]),
    limitations: Object.freeze(['Cannot build Xcode projects (no macOS, no Xcode)'])
  })
});

// The VPS serves production first; runner work there must never compete with it.
export const PRODUCTION_FIRST_NOTE = 'Production first: the VPS runs production services and agents. Runner jobs there are '
  + 'lowest priority, must yield when production load is high, and never start, stop or change services.';

// Text read from other programs goes back to models: one line, no control or bidi characters.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export function cleanLine(value, max = MAX_TEXT) {
  if (value === undefined || value === null) return null;
  const first = String(value).split(/\r?\n/).find(line => line.trim()) ?? '';
  const text = first.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return text || null;
}

// Fixed probes. Every one is a constant argv; none of them changes state. `gh auth status`
// is used for its exit code only: its output (account names, scopes) is never returned.
export const TOOL_PROBES = Object.freeze({
  node: { command: 'node', args: ['--version'] },
  npm: { command: 'npm', args: ['--version'] },
  python3: { command: 'python3', args: ['--version'] },
  git: { command: 'git', args: ['--version'] },
  gh: { command: 'gh', args: ['--version'] },
  swift: { command: 'swift', args: ['--version'], darwinOnly: true },
  xcodebuild: { command: 'xcodebuild', args: ['-version'], darwinOnly: true },
  docker: { command: 'docker', args: ['--version'] },
  cargo: { command: 'cargo', args: ['--version'] },
  go: { command: 'go', args: ['version'] },
  make: { command: 'make', args: ['--version'] }
});
const GH_AUTH_PROBE = Object.freeze({ command: 'gh', args: ['auth', 'status'] });

// Toolchains a job can use and the tools each needs, mirroring the argv that
// server/runners/recipes.mjs (detectRecipes) can choose. Xcode and Docker are reported as
// tools but no job recipe uses them yet. Python's test recipe also needs pytest installed,
// which is not probed here.
export const TOOLCHAIN_RECIPES = Object.freeze([
  Object.freeze({ toolchain: 'npm', requires: ['node', 'npm'], recipes: ['test', 'build', 'lint'] }),
  Object.freeze({ toolchain: 'swiftpm', requires: ['swift'], recipes: ['test', 'build'] }),
  Object.freeze({ toolchain: 'python', requires: ['python3'], recipes: ['test'] }),
  Object.freeze({ toolchain: 'cargo', requires: ['cargo'], recipes: ['test', 'build'] }),
  Object.freeze({ toolchain: 'go', requires: ['go'], recipes: ['test', 'build'] }),
  Object.freeze({ toolchain: 'make', requires: ['make'], recipes: ['test', 'build'] })
]);

// Default runner: no shell, fixed argv, short timeout, bounded output, non-interactive env.
export function execProbe(command, args, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise(resolvePromise => {
    execFile(command, args, {
      timeout: timeoutMs, maxBuffer: PROBE_MAX_BUFFER, killSignal: 'SIGKILL', windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }
    }, (error, stdout, stderr) => {
      if (!error) return resolvePromise({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      if (error.code === 'ENOENT') return resolvePromise({ code: null, missing: true });
      if (error.killed || error.signal) return resolvePromise({ code: null, timedOut: true });
      resolvePromise({ code: typeof error.code === 'number' ? error.code : 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function nearestExisting(path) {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return realpathSync(current);
}

async function diskOf(path) {
  if (!path) return null;
  try {
    const target = nearestExisting(path);
    const s = await statfs(target);
    const gib = n => Math.round((n / 1024 ** 3) * 10) / 10;
    return { free_gib: gib(s.bavail * s.bsize), total_gib: gib(s.blocks * s.bsize) };
  } catch {
    return null;
  }
}

function versionOf(output) {
  const line = cleanLine(output);
  if (!line) return null;
  // `swift --version` may start with the driver version; prefer the language version.
  // `xcodebuild -version` prints "Xcode 16.0"; the others print a version somewhere in line 1.
  const match = /Swift version (\d+\.\d+(?:\.\d+)?)/.exec(line) ?? /(\d+\.\d+(?:\.\d+)?)/.exec(line);
  return match ? match[1] : line.slice(0, 40);
}

/**
 * The host service. Every dependency is injectable so tests never run real gh, ssh or
 * python, and never read the user's state:
 * - run(command, args) -> { code, stdout, stderr, missing?, timedOut? }
 * - collect(host) -> collectHost-shaped reachability record
 * - now() -> epoch ms; os -> { platform, arch, release, hostname, loadavg, cpus, freemem, totalmem }
 */
export function createHostService({ run = execProbe, collect = collectHost, now = Date.now, cacheMs = PROBE_CACHE_MS,
  os = { platform, arch, release, hostname, loadavg, cpus, freemem, totalmem }, env = process.env } = {}) {
  let cache = null; // { at, value: Promise<observed> }

  async function probeTool(spec, isDarwin) {
    if (spec.darwinOnly && !isDarwin) return { present: false, version: null, reason: 'not_macos' };
    const r = await run(spec.command, spec.args);
    if (r.missing) return { present: false, version: null };
    if (r.timedOut) return { present: null, version: null, reason: 'timeout' };
    // xcodebuild exits non-zero when only the Command Line Tools are installed: not usable.
    if (r.code !== 0) return { present: false, version: null, reason: 'unusable' };
    return { present: true, version: versionOf(r.stdout || r.stderr) };
  }

  async function observe() {
    const isDarwin = os.platform() === 'darwin';
    const names = Object.keys(TOOL_PROBES);
    const results = await Promise.all(names.map(name => probeTool(TOOL_PROBES[name], isDarwin)));
    const tools = Object.fromEntries(names.map((name, i) => [name, results[i]]));
    if (tools.gh.present) {
      const auth = await run(GH_AUTH_PROBE.command, GH_AUTH_PROBE.args);
      // Boolean only; null when it could not be established (timeout, no network).
      tools.gh.authenticated = auth.timedOut || auth.missing ? null : auth.code === 0;
    } else {
      tools.gh.authenticated = false;
    }
    return { at: now(), tools };
  }

  // Concurrent callers share one probe run; a cached result is reused for cacheMs.
  async function observedTools() {
    const t = now();
    if (!cache || t - cache.at >= cacheMs) {
      const value = observe();
      cache = { at: t, value };
      value.catch(() => { if (cache?.value === value) cache = null; });
    }
    return cache.value;
  }

  function recipesFor(tools) {
    return TOOLCHAIN_RECIPES.map(t => {
      const missing = t.requires.filter(name => tools[name]?.present !== true);
      return { toolchain: t.toolchain, recipes: [...t.recipes], available: missing.length === 0,
        ...(missing.length ? { missing } : {}) };
    });
  }

  function declared(host) {
    const d = DECLARED_ROLES[host];
    return { source: 'declared', roles: d.roles.map(r => ({ ...r })), limitations: [...d.limitations] };
  }

  // Reachability of a remote host from the existing host_status probe, sanitized.
  async function reachability(host) {
    let r;
    try { r = await collect(host); } catch { r = { online: false, error: 'unavailable' }; }
    return {
      source: 'observed', via: 'host_status', online: r?.online === true,
      hostname: cleanLine(r?.hostname, 80), system: cleanLine(r?.system, 40), architecture: cleanLine(r?.architecture, 40),
      ...(r?.error ? { error: cleanLine(r.error, 40) } : {})
    };
  }

  return {
    async capabilities(host, { localHost }) {
      if (!HOST_IDS.includes(host)) return { ok: false, error: 'invalid_input', detail: 'host' };
      if (host !== localHost) {
        // Without a route (the VPS cannot reach the Mac: no incoming connection) nothing is observed.
        const reach = localHost === 'mac'
          ? await reachability(host)
          : { source: 'unknown', online: null, detail: 'no route from this host; the Mac accepts no incoming connection' };
        return { ok: true, host, local: false, roles: declared(host), reachability: reach, tools: null, recipes: null,
          note: 'Remote host: only declared roles and host_status reachability; no new remote probe is run.' };
      }
      const observed = await observedTools();
      const tools = Object.fromEntries(Object.entries(observed.tools).map(([k, v]) => [k, { ...v }]));
      return {
        ok: true, host, local: true,
        os: { source: 'observed', platform: os.platform(), release: cleanLine(os.release(), 40), arch: os.arch(),
          hostname: cleanLine(os.hostname(), 80) },
        tools: { source: 'observed', observed_at: new Date(observed.at).toISOString(),
          cached_until: new Date(observed.at + cacheMs).toISOString(), ...tools },
        recipes: { source: 'observed', toolchains: recipesFor(observed.tools) },
        roles: declared(host)
      };
    },

    // jobs: { running, queued } from the local store (only jobs this machine launched).
    async resources(host, { localHost, stateDir, projectsRoot, jobs }) {
      if (!HOST_IDS.includes(host)) return { ok: false, error: 'invalid_input', detail: 'host' };
      // Only the local runner's limit is known; a remote runner enforces its own.
      const limit = host === localHost ? jobConcurrencyLimit(env) : null;
      const notes = host === 'vps' ? [PRODUCTION_FIRST_NOTE] : [];
      if (host !== localHost) {
        if (localHost !== 'mac') {
          return { ok: true, host, local: false, source: 'unknown', online: null, job_concurrency_limit: limit, notes,
            detail: 'no route from this host; the Mac accepts no incoming connection' };
        }
        let r;
        try { r = await collect(host); } catch { r = { online: false, error: 'unavailable' }; }
        const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        return {
          ok: true, host, local: false, source: 'observed', via: 'host_status', online: r?.online === true,
          ...(r?.online ? {
            load_average: Array.isArray(r.load_average) ? r.load_average.slice(0, 3).map(num) : null,
            cpu_count: num(r.cpu_count),
            disk_root: { free_gib: num(r.disk_free_gib), total_gib: num(r.disk_total_gib) },
            docker_running_containers: num(r.docker_running_containers)
          } : { error: cleanLine(r?.error, 40) ?? 'unavailable' }),
          job_concurrency_limit: limit, notes
        };
      }
      const [stateDisk, projectsDisk] = await Promise.all([diskOf(stateDir), diskOf(projectsRoot)]);
      const cpuList = os.cpus();
      return {
        ok: true, host, local: true, source: 'observed', at: new Date(now()).toISOString(),
        load_average: os.loadavg().map(v => Math.round(v * 100) / 100),
        cpu_count: Array.isArray(cpuList) ? cpuList.length : null,
        memory: { free_bytes: os.freemem(), total_bytes: os.totalmem(),
          ...(os.platform() === 'darwin' ? { note: 'free excludes reclaimable cache on macOS' } : {}) },
        disk: { state_dir: stateDisk, projects: projectsDisk },
        jobs: jobs ? { running: jobs.running, queued: jobs.queued, source: 'local store' } : null,
        job_concurrency_limit: limit,
        notes
      };
    },

    // Test hook: forget the cached probe results.
    resetCache() { cache = null; }
  };
}

export const defaultProjectsRoot = (env = process.env) => env.MEMO_BRIDGE_PROJECTS_ROOT || join(homedir(), 'projects');
