// Operator path resolution (Phase 6, TODO-P6-02, spec D8, D11).
//
// Every path an operator tool touches goes through resolveOperatorPath() before any read:
//  1. shape: a string, absolute (or "~/" on the Mac), no NUL, at most 4096 characters;
//  2. secret denylist on the lexical path (what the caller asked for);
//  3. canonicalization with realpath (symlinks and ".." resolved), the parent's realpath for a
//     path that may not exist yet (writes, Lot 2);
//  4. secret denylist again on the canonical path, so a symlink into ~/.ssh is refused too;
//  5. root check on the canonical path against the canonical roots of the policy: "r" needs a
//     read or write root, "rw" a write root;
//  6. for "rw" only: a control path (the policy, FROZEN switches, journal, hub and coordinator
//     state, agent units; issue #290, operator-authority.mjs) is refused, lexical and canonical;
//  7. for "rw" only: anything inside a .git directory is refused (git config and hooks are
//     code: SentinelX finding, research §2). A project checkout is writable on any branch (owner
//     decision 2026-10-23: the agent works in the canonical checkout; the default branch is
//     protected on GitHub, not by a worktree flow here).
// Matching is case-insensitive: APFS is by default, and a denylist must not be bypassed by
// writing ".SSH". A time-of-check to time-of-use window remains between realpath and open
// (SentinelX states the same, research §2); the tools reopen with O_NOFOLLOW to narrow it.
import { realpath as fsRealpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const MAX_PATH_CHARS = 4096;

// Built-in secret denylist (spec D8), always on, in front of the policy's own entries. Beyond
// the spec's list: SSH host keys, systemd credential stores, token files and the usual CLI
// credential stores, since output redaction (operator-output.mjs) is the second net only.
export const DEFAULT_DENYLIST = Object.freeze([
  '**/.ssh/**', '**/.gnupg/**', '**/.env*', '**/*.pem', '**/*.key', '**/id_*', '**/*secret*',
  '/etc/shadow', '/etc/gshadow', '/etc/shadow-', '/etc/gshadow-', '~/Library/Keychains/**', '/Users/*/Library/Keychains/**',
  '/Library/Keychains/**', '/etc/memo-operator/**', '**/.memo-operator/**', '/etc/memo-bridge/*.key',
  '**/ssh_host_*_key', '/etc/credstore/**', '/etc/credstore.encrypted/**', '/run/credstore/**', '/run/credentials/**',
  '**/*.token', '**/.netrc', '**/.git-credentials', '**/.npmrc', '**/.pypirc', '**/.docker/config.json',
  '**/.config/gh/hosts.yml', '**/.aws/credentials', '**/.kube/config', '/etc/sudoers', '/etc/sudoers.d/**'
]);

// Glob -> RegExp. "**/" any number of directories (zero included), a trailing "/**" the
// directory itself and everything below, "*" one segment's characters, "?" one character.
export function globToRegExp(glob, home) {
  let pattern = glob.startsWith('~/') ? home + glob.slice(1) : glob;
  let tail = '';
  if (pattern.endsWith('/**')) { pattern = pattern.slice(0, -3); tail = '(?:/.*)?'; }
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; continue; }
    if (c === '*' && pattern[i + 1] === '*') { out += '.*'; i += 1; continue; }
    if (c === '*') { out += '[^/]*'; continue; }
    if (c === '?') { out += '[^/]'; continue; }
    out += /[\\^$.|+(){}[\]]/.test(c) ? `\\${c}` : c;
  }
  // A pattern starting with "**/" matches from any directory, the root included.
  if (out.startsWith('(?:.*/)?')) out = `^/?${out}`;
  else out = `^${out}`;
  return new RegExp(`${out}${tail}$`, 'i');
}

// Control paths (issue #290, operator-authority.mjs): the files that decide what the agent may
// do. Built in per host, on top of the ones the policy names. Globs as in the secret denylist: a
// trailing "/**" is the directory and all below. Refused for writes and in command arguments.
export const CONTROL_GLOBS = Object.freeze({
  vps: Object.freeze([
    '/etc/memo-operator/**', '/etc/memo-bridge/**', '/etc/credstore/**', '/etc/credstore.encrypted/**',
    '/var/lib/memo-bridge-hub/**', '/var/lib/memo-bridge/**', '/var/lib/memo-operator/**', '/var/lib/memo-operator-root/**',
    '/var/log/memo-operator/**', '/run/memo-operator/**',
    '/etc/systemd/system/memo-*', '/etc/systemd/system/memo-*/**', '/run/systemd/system/memo-operator*', '/run/systemd/system/memo-operator*/**',
    '/run/systemd/system/memo-bridge*', '/run/systemd/system/memo-bridge*/**',
    '/etc/polkit-1/rules.d/*memo*', '/etc/sudoers', '/etc/sudoers.d/**',
    // The deployed code (lab-infra memo_bridge_app_dir): rewriting a check rewrites the rights.
    '/opt/memo-bridge/**'
  ]),
  mac: Object.freeze([
    '~/.memo-operator/**', '~/Library/Application Support/memo-bridge/**', '~/Library/Logs/memo-operator/**',
    // The pinned agent bundle, its staged plist and the probe agent's hub CA (install-operator-agent.sh).
    '~/.local/share/memo-bridge/**', '~/.config/memo-bridge/**',
    '~/Library/LaunchAgents/dev.memolabs.*', '/Library/LaunchDaemons/dev.memolabs.*',
    '/Library/Application Support/MemoBridge/**', '/var/log/memo-operator/**', '/var/db/memo-operator-root/**',
    '/var/run/memo-operator/**', '/etc/sudoers', '/etc/sudoers.d/**'
  ])
});

// Unit names and launchd labels of the agents, the hub and the runtime: editing, enabling or
// restarting one through a command applies a changed policy or environment. A command naming
// one is refused unless it is a read (operator-dangerous.mjs readOnlyCommand: systemctl status,
// journalctl, launchctl print...); declared units are restarted through operator_service.
export const CONTROL_LABELS = Object.freeze(['memo-operator-agent', 'memo-operator-root', 'memo-bridge-hub', 'memo-bridge-runner',
  'memo-bridge-vps-agent', 'dev.memolabs.']);

// "//" and "/./" collapsed, so a spelling never hides a path from the text scan.
export function collapseSlashes(text) {
  let out = String(text);
  for (let i = 0; i < 8; i++) {
    const next = out.replace(/\/\.(?=\/|$)/g, '').replace(/\/{2,}/g, '/');
    if (next === out) break;
    out = next;
  }
  return out;
}

// The control paths of one policy: the built-in ones of its host, the directory of its FROZEN
// switch (the policy directory on both hosts), the journal's directory, the state directory
// (auto-freeze marker, Mac checkout ledger) and the root helper's socket directory. A directory
// that is "/", the home or a declared root is too broad to protect whole: only the file it
// holds is protected there (frozen_file, audit_file, the AUTO-FROZEN marker, the socket).
export function controlGlobs(policy, { extra = [] } = {}) {
  if (!policy) return [];
  const declared = [...(policy.declaredRoots?.read ?? []), ...(policy.declaredRoots?.write ?? []), ...(policy.readRoots ?? []),
    ...(policy.writeRoots ?? [])];
  const own = [];
  const add = (dir, file) => {
    if (typeof dir !== 'string') return;
    if (dir !== '/' && dir !== policy.home && !declared.includes(dir)) own.push(`${dir}/**`);
    else own.push(file);
  };
  if (policy.frozenFile) add(dirname(policy.frozenFile), policy.frozenFile);
  if (policy.auditFile) add(dirname(policy.auditFile), policy.auditFile);
  if (policy.stateDir) add(policy.stateDir, join(policy.stateDir, 'AUTO-FROZEN'));
  if (policy.rootHelper) add(dirname(policy.rootHelper.socket), policy.rootHelper.socket);
  const globs = [...(CONTROL_GLOBS[policy.host] ?? []), ...own, ...extra];
  // macOS: /etc, /var and /tmp are symlinks into /private; the canonical form must match too.
  const withPrivate = globs.flatMap(g => (/^\/(etc|var|tmp)(\/|$)/.test(g) ? [g, `/private${g}`] : [g]));
  return [...new Set(withPrivate)];
}

// controlled(path): an absolute, resolved path is a control path. mentions(text): a control path
// (with "~/" spelled out or not) or a label appears anywhere in a command line or a script, after
// collapseSlashes, ending at a path boundary ("/opt/memo-bridge-staging" is not
// "/opt/memo-bridge"). The text scan is a net for shell lines and scripts, not a boundary.
export function createControlMatcher(policy, options) {
  const home = policy?.home ?? '/nonexistent';
  const globs = controlGlobs(policy, options);
  const patterns = globs.map(g => globToRegExp(g, home));
  const unanchored = re => re.source.replace(/^\^/, '').replace(/\$$/, '');
  const spelled = [...new Set(globs.flatMap(g => (g.startsWith('~/') ? [g, home + g.slice(1)] : [g])))];
  // globToRegExp(g, '~') keeps a leading "~/" literal; the home-expanded spelling is its own entry.
  const inText = spelled.map(g => new RegExp(`${unanchored(globToRegExp(g, '~'))}(?=$|[^A-Za-z0-9._-])`, 'i'));
  const labels = CONTROL_LABELS.map(l => l.toLowerCase());
  return Object.freeze({
    globs,
    controlled: path => patterns.some(re => re.test(path)),
    mentions: text => {
      const t = collapseSlashes(text);
      return inText.some(re => re.test(t)) || labels.some(l => t.toLowerCase().includes(l));
    }
  });
}

// A matcher for one policy: the built-in list plus the policy's extra entries.
export function createDenylist(policy) {
  const home = policy?.home ?? '/nonexistent';
  const patterns = [...DEFAULT_DENYLIST, ...(policy?.denylist ?? [])].map(glob => globToRegExp(glob, home));
  const control = createControlMatcher(policy);
  return Object.freeze({ denied: path => patterns.some(re => re.test(path)), size: patterns.length, controlled: control.controlled,
    mentions: control.mentions });
}

export function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

// The lexical, absolute form of a requested path, or null when its shape is refused.
export function lexicalPath(raw, policy) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_CHARS || raw.includes('\0')) return null;
  let path = raw;
  if (path === '~' || path.startsWith('~/')) {
    if (policy.host !== 'mac') return null;
    path = policy.home + path.slice(1);
  }
  if (!isAbsolute(path)) return null;
  return resolve(path);
}

const insideGit = path => path.split('/').some(part => part.toLowerCase() === '.git');


// Resolve one requested path. access: 'r' | 'rw'. mustExist: false lets a write name a new
// file (its parent must exist). Returns {ok:true, path, requested} or {ok:false, error}.
// Options: denylist (createDenylist(policy)), realpath (tests).
export async function resolveOperatorPath(policy, raw, { access = 'r', mustExist = true, denylist = createDenylist(policy),
  realpath = fsRealpath } = {}) {
  const requested = lexicalPath(raw, policy);
  if (requested === null) return { ok: false, error: 'invalid_path' };
  if (denylist.denied(requested)) return { ok: false, error: 'path_secret' };
  if (access === 'rw' && insideGit(requested)) return { ok: false, error: 'git_internal' };
  if (access === 'rw' && denylist.controlled?.(requested)) return { ok: false, error: 'control_path_protected' };
  let canonical;
  try {
    canonical = await realpath(requested);
  } catch (error) {
    if (error?.code === 'ENOENT' && !mustExist) {
      try { canonical = join(await realpath(dirname(requested)), basename(requested)); } catch (inner) {
        return { ok: false, error: inner?.code === 'EACCES' ? 'permission_denied' : 'not_found' };
      }
    } else {
      return { ok: false, error: error?.code === 'ENOENT' ? 'not_found' : error?.code === 'EACCES' ? 'permission_denied' : 'invalid_path' };
    }
  }
  if (denylist.denied(canonical)) return { ok: false, error: 'path_secret' };
  if (access === 'rw' && denylist.controlled?.(canonical)) return { ok: false, error: 'control_path_protected' };
  const roots = access === 'rw' ? policy.writeRoots : policy.readRoots;
  if (!roots.some(root => contained(root, canonical))) return { ok: false, error: 'path_not_allowed' };
  if (access === 'rw' && insideGit(canonical)) return { ok: false, error: 'git_internal' };
  return { ok: true, path: canonical, requested };
}
