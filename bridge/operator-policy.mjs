// Operator policy file (Phase 6, TODO-P6-01, spec D1, D5, D6, D8).
//
// Each host's operator agent reads one local JSON file, owned by root on lab
// (/etc/memo-operator/policy.json) and by the owner on the Mac (~/.memo-operator/policy.json).
// The hub never sends policy: the agent checks every signed request against this file, so a
// tier, a root or a unit the file does not grant stays refused whatever the hub asks (R-P6-02).
//
// Format, version 1 (unknown keys are refused at every level, a typo never weakens a rule):
//   version         1
//   host            "mac" | "vps"                      the agent's own host; must match the wire
//   max_tier        "read" | "write" | "exec" | "root"  highest tier served (root needs root_helper)
//   roots           {read: [abs], write: [abs]}        write roots are readable too
//   units           ["traefik.service", ...]           systemd units for logs and status
//   containers      ["traefik", ...]                   docker containers whose logs may be read
//   approval_mode   "off" | "dangerous" | "all_root"   (spec D5; enforced in Lot 2)
//   denylist        ["**/glob", "/abs/glob", "~/glob"] added to the built-in list (D8), never replacing it
//   rate_limits     {write, exec, root}                calls per minute per tier (D6 defaults 120, 60, 20)
//   frozen_file     abs path                           FROZEN switch, checked on every call (D6)
//   audit_file      abs path                           hash-chained host journal (D7)
//   repositories    {projects_root, registry_file?, layout_root?}  accepted for existing policy files;
//                   the D11 repository guard it fed was removed on 2026-10-23
//   state_dir       abs path, writable by the agent: background runs, uploads, auto-freeze
//                   marker (default: the directory of audit_file)
//   run_env_allow   ["NAME", ...] environment names a caller may set on operator_run, on top of
//                   LANG, LC_ALL, TZ, TERM, NO_COLOR; loader and linker variables are refused
//   root_helper     {socket: abs path} the root helper's Unix socket; required for "root" (lab, and
//                   the Mac once its root helper is installed)
//   run_path        [abs dir, ...] put before the fixed PATH of user runs (operator_run and
//                   operator_script as the agent user; never root calls), repatriation D-R8
//   permanent_grants [{host, programs, cwd_prefixes}] (issue #48) standing grants with no TTL, set
//                   by the owner in this file only: operator_run and operator_script as the agent
//                   user naming only these programs, with a cwd under a prefix, run without a
//                   Telegram request. At most 8; each host is this file's host, programs are bare
//                   names (1 to 16) none of them hard-listed or a privilege tool (sudo, su...),
//                   prefixes 1 to 4 absolute paths other than "/". There is no root key: a hard
//                   call or a root call is never covered (operator-grants.mjs permanentCovers).
// Paths are absolute; "~/" is accepted on the Mac only and expands to the agent user's home.
//
// The file itself must be trustworthy before anything in it is believed: a regular file (no
// symlink), at most 64 KiB, owned by a trusted uid (root, plus the owner on the Mac), never
// writable by group or other, and never writable by the agent user. The directory holding it
// obeys the same owner and group/other rules, so the agent cannot swap the file by a rename.
// On the Mac the agent user is the owner: the file must then be read-only (0400 or 0444); this
// stops the agent's own tools from rewriting it, not the owner (spec R-P6-02, accepted).
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, normalize } from 'node:path';
import { PROGRAM_RE, permanentGrantId, programGrantable } from './operator-grants.mjs';

export const POLICY_VERSION = 1;
export const TIERS = Object.freeze(['read', 'write', 'exec', 'root']);
export const APPROVAL_MODES = Object.freeze(['off', 'dangerous', 'all_root']);
export const RATE_LIMIT_DEFAULTS = Object.freeze({ write: 120, exec: 60, root: 20 });
export const DEFAULT_POLICY_PATHS = Object.freeze({ vps: '/etc/memo-operator/policy.json', mac: '~/.memo-operator/policy.json' });
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_LIST = 128;
const MAX_PATH_CHARS = 1024;
const KEYS = Object.freeze(['version', 'host', 'max_tier', 'roots', 'units', 'containers', 'approval_mode', 'denylist',
  'rate_limits', 'frozen_file', 'audit_file', 'repositories', 'state_dir', 'run_env_allow', 'root_helper', 'run_path', 'permanent_grants']);
export const PERMANENT_GRANT_LIMITS = Object.freeze({ entries: 8, programs: 16, prefixes: 4 });
const REQUIRED = Object.freeze(['version', 'host', 'max_tier', 'roots', 'frozen_file', 'audit_file']);
// systemd unit names (systemd.unit(5)): name, optional instance, a known suffix.
export const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,120}\.(service|socket|timer|target|path|mount)$/;
export const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const GLOB_RE = /^(\/|~\/|\*\*\/)[^\0]{1,250}$/;
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
// Names that change what a program loads or runs: never settable by a caller.
export const FORBIDDEN_ENV_RE = /^(PATH|HOME|USER|SHELL|IFS|ENV|BASH_ENV|BASH_FUNC_.*|LD_.*|DYLD_.*|NODE_.*|PYTHON.*|PERL.*|RUBY.*|GIT_.*|SSH_.*|GCONV_PATH|LOCPATH|SYSTEMD_.*|CREDENTIALS_DIRECTORY|PROMPT_COMMAND|PS4)$/;
export const DEFAULT_RUN_ENV = Object.freeze(['LANG', 'LC_ALL', 'TZ', 'TERM', 'NO_COLOR']);

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = field => new Error(`invalid_operator_policy:${field}`);

function onlyKeys(value, allowed, field) {
  if (!plainObject(value)) throw invalid(field);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid(`${field}.${key}`);
}

// One absolute path, "~/" expanded on the Mac. Lexically normalized; ".." segments refused
// rather than resolved, so the file says exactly what it grants.
function policyPath(value, field, { host, home }) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_CHARS || value.includes('\0')) throw invalid(field);
  let path = value;
  if (path === '~' || path.startsWith('~/')) {
    if (host !== 'mac') throw invalid(field);
    path = home + path.slice(1);
  }
  if (!isAbsolute(path) || path.split('/').includes('..')) throw invalid(field);
  const out = normalize(path);
  return out.length > 1 && out.endsWith('/') ? out.slice(0, -1) : out;
}

function list(value, field, check, { max = MAX_LIST, fallback = [] } = {}) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > max) throw invalid(field);
  value.forEach((item, i) => { if (!check(item)) throw invalid(`${field}[${i}]`); });
  return [...new Set(value)];
}

// permanent_grants (issue #48): each entry checked like a standing grant request, refused (never
// trimmed) when it names a hard-listed program, a privilege tool, "/" or another host. Unknown keys
// (a "root" or "as_root" flag included) are refused like everywhere else in the file.
function permanentGrants(value, ctx) {
  const entries = list(value, 'permanent_grants', item => plainObject(item), { max: PERMANENT_GRANT_LIMITS.entries });
  return entries.map((entry, i) => {
    const field = `permanent_grants[${i}]`;
    onlyKeys(entry, ['host', 'programs', 'cwd_prefixes'], field);
    if (entry.host !== ctx.host) throw invalid(`${field}.host`);
    if (!Array.isArray(entry.programs) || entry.programs.length === 0 || entry.programs.length > PERMANENT_GRANT_LIMITS.programs) throw invalid(`${field}.programs`);
    entry.programs.forEach((name, j) => {
      if (typeof name !== 'string' || !PROGRAM_RE.test(name) || !programGrantable(name)) throw invalid(`${field}.programs[${j}]`);
    });
    if (!Array.isArray(entry.cwd_prefixes) || entry.cwd_prefixes.length === 0 || entry.cwd_prefixes.length > PERMANENT_GRANT_LIMITS.prefixes) throw invalid(`${field}.cwd_prefixes`);
    const prefixes = entry.cwd_prefixes.map((raw, j) => {
      const path = policyPath(raw, `${field}.cwd_prefixes[${j}]`, ctx);
      if (path === '/') throw invalid(`${field}.cwd_prefixes[${j}]`);
      return path;
    });
    const programs = [...new Set(entry.programs)];
    const unique = [...new Set(prefixes)];
    return Object.freeze({ grant_id: permanentGrantId(ctx.host, programs, unique), host: ctx.host, programs: Object.freeze(programs),
      cwd_prefixes: Object.freeze(unique) });
  });
}

// Canonical form of a root: the realpath when it exists (/tmp is /private/tmp on macOS), else
// dropped and reported, never guessed.
function canonicalRoots(paths, realpath) {
  const roots = []; const missing = [];
  for (const path of paths) {
    try { roots.push(realpath(path)); } catch { missing.push(path); }
  }
  return { roots: [...new Set(roots)], missing };
}

// Validate and normalize a parsed policy document. Options: home (for "~/"), realpath
// (injectable, tests). Returns a frozen policy; throws invalid_operator_policy:<field>.
export function parseOperatorPolicy(raw, { home = homedir(), realpath = realpathSync.native } = {}) {
  onlyKeys(raw, KEYS, 'policy');
  for (const key of REQUIRED) if (raw[key] === undefined) throw invalid(key);
  if (raw.version !== POLICY_VERSION) throw invalid('version');
  if (!['mac', 'vps'].includes(raw.host)) throw invalid('host');
  const host = raw.host;
  const maxTier = TIERS.indexOf(raw.max_tier);
  if (maxTier < 0) throw invalid('max_tier');
  // Root needs a root helper on either host (below). On the Mac the helper is the LaunchDaemon
  // dev.memolabs.memo-operator-root (owner decision 2026-10-14, spec §13 Mac root follow-up).
  const ctx = { host, home };
  onlyKeys(raw.roots, ['read', 'write'], 'roots');
  const pathOf = field => item => { policyPath(item, field, ctx); return true; };
  const readPaths = list(raw.roots.read, 'roots.read', pathOf('roots.read')).map(p => policyPath(p, 'roots.read', ctx));
  const writePaths = list(raw.roots.write, 'roots.write', pathOf('roots.write')).map(p => policyPath(p, 'roots.write', ctx));
  const units = list(raw.units, 'units', u => typeof u === 'string' && UNIT_RE.test(u));
  const containers = list(raw.containers, 'containers', c => typeof c === 'string' && CONTAINER_RE.test(c));
  const approvalMode = raw.approval_mode ?? 'off';
  if (!APPROVAL_MODES.includes(approvalMode)) throw invalid('approval_mode');
  const denylist = list(raw.denylist, 'denylist', g => typeof g === 'string' && GLOB_RE.test(g) && !(g.startsWith('~/') && host !== 'mac'));
  const rateLimits = { ...RATE_LIMIT_DEFAULTS };
  if (raw.rate_limits !== undefined) {
    onlyKeys(raw.rate_limits, Object.keys(RATE_LIMIT_DEFAULTS), 'rate_limits');
    for (const [tier, value] of Object.entries(raw.rate_limits)) {
      if (!Number.isInteger(value) || value < 1 || value > 1000) throw invalid(`rate_limits.${tier}`);
      rateLimits[tier] = value;
    }
  }
  let repositories = null;
  if (raw.repositories !== undefined) {
    onlyKeys(raw.repositories, ['projects_root', 'registry_file', 'layout_root'], 'repositories');
    if (raw.repositories.projects_root === undefined) throw invalid('repositories.projects_root');
    repositories = Object.freeze(Object.fromEntries(Object.entries(raw.repositories)
      .map(([key, value]) => [key, policyPath(value, `repositories.${key}`, ctx)])));
  }
  const runEnvAllow = list(raw.run_env_allow, 'run_env_allow', n => typeof n === 'string' && ENV_NAME_RE.test(n) && !FORBIDDEN_ENV_RE.test(n));
  let rootHelper = null;
  if (raw.root_helper !== undefined) {
    onlyKeys(raw.root_helper, ['socket'], 'root_helper');
    rootHelper = Object.freeze({ socket: policyPath(raw.root_helper.socket, 'root_helper.socket', ctx) });
  }
  if (maxTier === TIERS.indexOf('root') && rootHelper === null) throw invalid('root_helper');
  // PATH entries: absolute, no ":" (the PATH separator), at most 16.
  const runPath = list(raw.run_path, 'run_path', item => { policyPath(item, 'run_path', ctx); return !item.includes(':'); }, { max: 16 })
    .map(item => policyPath(item, 'run_path', ctx));
  const permanent = permanentGrants(raw.permanent_grants, ctx);
  const auditFile = policyPath(raw.audit_file, 'audit_file', ctx);
  const stateDir = raw.state_dir === undefined ? dirname(auditFile) : policyPath(raw.state_dir, 'state_dir', ctx);
  const read = canonicalRoots([...readPaths, ...writePaths], realpath);
  const write = canonicalRoots(writePaths, realpath);
  return Object.freeze({
    version: POLICY_VERSION,
    host,
    maxTier,
    maxTierName: TIERS[maxTier],
    // Canonical roots; readRoots include the write roots (rw implies r, as SentinelX does).
    readRoots: Object.freeze(read.roots),
    writeRoots: Object.freeze(write.roots),
    declaredRoots: Object.freeze({ read: Object.freeze(readPaths), write: Object.freeze(writePaths) }),
    missingRoots: Object.freeze([...new Set(read.missing)]),
    units: Object.freeze(units),
    containers: Object.freeze(containers),
    approvalMode,
    denylist: Object.freeze(denylist),
    rateLimits: Object.freeze(rateLimits),
    frozenFile: policyPath(raw.frozen_file, 'frozen_file', ctx),
    auditFile,
    stateDir,
    runEnvAllow: Object.freeze([...DEFAULT_RUN_ENV, ...runEnvAllow.filter(n => !DEFAULT_RUN_ENV.includes(n))]),
    rootHelper,
    repositories,
    runPath: Object.freeze(runPath),
    permanentGrants: Object.freeze(permanent),
    home
  });
}

// Is this file (and its directory) safe to trust? Returns null when it is, else a short code.
//   stat         fs.Stats of the open file (fstat, so no swap between check and read)
//   dirStat      fs.Stats of its directory (lstat: a symlinked directory is refused)
//   agentUid     the uid this agent runs as
//   trustedUids  uids allowed to own the file: [0] on lab, [0, <owner uid>] on the Mac
export function trustProblem(stat, dirStat, { agentUid, trustedUids }) {
  if (!stat.isFile()) return 'policy_not_regular_file';
  if (!trustedUids.includes(stat.uid)) return 'policy_owner_untrusted';
  if ((stat.mode & 0o022) !== 0) return 'policy_writable_by_others';
  if (stat.uid === agentUid && (stat.mode & 0o222) !== 0) return 'policy_writable_by_agent';
  if (!dirStat.isDirectory()) return 'policy_dir_invalid';
  if (!trustedUids.includes(dirStat.uid)) return 'policy_dir_owner_untrusted';
  if ((dirStat.mode & 0o022) !== 0) return 'policy_dir_writable_by_others';
  return null;
}

// Read one small file the agent must trust (the policy, the hub's operator public key): opened
// with O_NOFOLLOW, checked with fstat on the same descriptor, its directory with lstat.
// Throws Error(<code>) on any problem; the content is never logged.
export function readTrustedFile(path, { agentUid = process.getuid(), trustedUids = [0], maxBytes = MAX_POLICY_BYTES } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('policy_path_invalid');
  let fd;
  try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch (error) {
    throw new Error(error?.code === 'ELOOP' ? 'policy_is_symlink' : 'policy_unreadable');
  }
  try {
    const stat = fstatSync(fd);
    const problem = trustProblem(stat, lstatSync(dirname(path)), { agentUid, trustedUids });
    if (problem) throw new Error(problem);
    if (stat.size > maxBytes) throw new Error('policy_too_large');
    const buf = Buffer.alloc(stat.size);
    let at = 0;
    while (at < stat.size) { const n = readSync(fd, buf, at, stat.size - at, at); if (n === 0) break; at += n; }
    return buf.subarray(0, at).toString('utf8');
  } finally { closeSync(fd); }
}

// The agent's startup path: trusted read, JSON, schema. Any failure throws, and the agent
// refuses to start (fail closed). expectedHost must equal the file's host.
export function loadOperatorPolicy({ path, expectedHost, agentUid = process.getuid(), trustedUids = [0], home = homedir(),
  realpath = realpathSync.native } = {}) {
  const text = readTrustedFile(path, { agentUid, trustedUids });
  let raw;
  try { raw = JSON.parse(text); } catch { throw invalid('json'); }
  const policy = parseOperatorPolicy(raw, { home, realpath });
  if (expectedHost !== undefined && policy.host !== expectedHost) throw invalid('host');
  return policy;
}

// The effective policy as operator_policy shows it: what is granted, never key material.
export function policySummary(policy) {
  return {
    host: policy.host,
    max_tier: policy.maxTierName,
    roots: { read: [...policy.declaredRoots.read], write: [...policy.declaredRoots.write] },
    canonical_roots: { read: [...policy.readRoots], write: [...policy.writeRoots] },
    missing_roots: [...policy.missingRoots],
    units: [...policy.units],
    containers: [...policy.containers],
    approval_mode: policy.approvalMode,
    extra_denylist: [...policy.denylist],
    rate_limits_per_minute: { ...policy.rateLimits },
    run_env_allow: [...policy.runEnvAllow],
    root_helper: policy.rootHelper !== null,
    run_path: [...(policy.runPath ?? [])],
    // Owner-set, no TTL (issue #48): calls they cover never ask Telegram.
    permanent_grants: (policy.permanentGrants ?? []).map(g => ({ grant_id: g.grant_id, host: g.host, programs: [...g.programs],
      cwd_prefixes: [...g.cwd_prefixes], source: 'permanent', expires_at: null }))
  };
}
