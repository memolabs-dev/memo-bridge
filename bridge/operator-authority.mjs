// Policy authority (issue #290): the agent asks, it never defines, widens or switches off its
// own rights, and a sensitive call stops when the source that decides is not there.
//
// Two gaps closed here, both on the operator agent and, independently, on the root helper:
//  1. The policy file was read once at start (operator-policy.mjs). Removed, truncated,
//     re-owned, made writable or swapped for another host's file after start, it went unnoticed:
//     the process kept serving its first copy. loadPolicyAuthority() keeps the digest of the
//     bytes it loaded and check() re-reads the file with the same trusted read before every call
//     above T0: policy_unavailable when the file no longer passes (missing, unreadable, symlink,
//     wrong owner, writable, malformed, other host), policy_changed when it passes but differs
//     from the copy in force (a restart applies it, as before). T0 reads keep the loaded copy.
//  2. With approvals off on both hosts (owner decision 2026-10-23, #274) the dangerous list no
//     longer stopped a write tool or a command naming the files that decide: the policy and its
//     directory, the FROZEN switches, the auto-freeze marker, the host journal, the hub's state
//     (/freeze flag, /grant approvals, locks), the coordinator store (claims and leases), the
//     units, drop-ins and polkit rule that start the agents. Those are control paths: a write to
//     one, or a command whose arguments name one, is refused with control_path_protected
//     whatever the approval mode. Reads are not changed here: a command readOnlyCommand calls a
//     read is not scanned, and read paths keep the secret denylist.
// What an application check cannot stop while the agent and the files share a uid, or while a
// root call runs as root, is written down in docs/POLICY_AUTHORITY.md, not claimed away.
import { createHash } from 'node:crypto';
import { realpath as fsRealpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseOperatorPolicy, readTrustedFile } from './operator-policy.mjs';
import { readOnlyCommand } from './operator-dangerous.mjs';
export { CONTROL_GLOBS, controlGlobs, createControlMatcher } from './operator-paths.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const REASON_RE = /^[a-z][a-z0-9_:.[\]-]{0,95}$/;
const reasonOf = error => (REASON_RE.test(String(error?.message)) ? error.message : 'policy_unreadable');

// Load the policy and keep what check() compares against. Same inputs as loadOperatorPolicy.
// Throws at start like it (fail closed); check() never throws.
export function loadPolicyAuthority({ path, expectedHost, agentUid = process.getuid(), trustedUids = [0], home = homedir(),
  realpath = realpathSync.native, read = readTrustedFile } = {}) {
  const parse = text => {
    let raw;
    try { raw = JSON.parse(text); } catch { throw new Error('invalid_operator_policy:json'); }
    const parsed = parseOperatorPolicy(raw, { home, realpath });
    if (expectedHost !== undefined && parsed.host !== expectedHost) throw new Error('policy_host_mismatch');
    return parsed;
  };
  const text = read(path, { agentUid, trustedUids });
  const policy = parse(text);
  const digest = sha256(text);
  return Object.freeze({
    policy,
    path,
    // null when the file on disk is still the one in force, else {error, reason}.
    check() {
      let now;
      try { now = read(path, { agentUid, trustedUids }); } catch (error) { return { error: 'policy_unavailable', reason: reasonOf(error) }; }
      if (sha256(now) === digest) return null;
      try { parse(now); } catch (error) { return { error: 'policy_unavailable', reason: reasonOf(error) }; }
      return { error: 'policy_changed', reason: 'restart_to_apply' };
    }
  });
}

// The canonical form of a path that may not exist yet: realpath of the deepest existing
// ancestor, the rest appended. Never throws; null when nothing resolves.
async function canonical(path, realpath) {
  let at = path;
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try { return join(await realpath(at), ...tail.reverse()); } catch {
      const parent = dirname(at);
      if (parent === at) return null;
      tail.push(basename(at));
      at = parent;
    }
  }
  return null;
}

// The parts of one argument that may be a path: the whole token, what follows each "=" ("of=x",
// "--out=x", "DESTDIR=x") and what follows a short option ("-o/x", "-C/x"). Option-looking parts
// are dropped. Every part is a path relative to the cwd unless it is absolute ("~/" on the Mac).
function pathParts(token) {
  const parts = [token];
  for (let i = token.indexOf('='); i >= 0; i = token.indexOf('=', i + 1)) parts.push(token.slice(i + 1));
  if (/^-[A-Za-z0-9]./.test(token) && !token.startsWith('--')) parts.push(token.slice(2));
  return parts.filter(p => p !== '' && !p.startsWith('-'));
}

// Does this command name a control path? Its argv (the program included), its cwd and, for
// operator_script, the script text. Every part of every argument (pathParts) is resolved against
// the cwd, bare names included ("sudoers" from /etc), and checked lexically and once symlinks are
// resolved; every argument, the cwd and the script are also scanned as text (matcher.mentions).
// Reads (operator-dangerous.mjs readOnlyCommand): one that takes no file (systemctl status,
// journalctl, ps...) is not checked; a file reader (cat, grep, ls...) skips the text scan, so a
// pattern or a unit name in its arguments is not a match, but its resolved paths are still
// checked: a misclassified "read" never reaches a control path. Returns null or a refusal.
export async function controlRefusal(matcher, policy, { argv = [], cwd = '/', content = null } = {},
  { realpath = fsRealpath, readOnly = readOnlyCommand } = {}) {
  const refused = what => ({ ok: false, error: 'control_path_protected', detail: what });
  const read = content === null ? readOnly(argv) : null;
  if (read !== null && read.paths.length === 0) return null;
  const scan = read === null;
  if (content !== null && matcher.mentions(content)) return refused('script names a control path');
  // The cwd as checkCwd reads it: "~/" is the agent user's home on the Mac.
  const home = typeof cwd === 'string' && policy.host === 'mac' && (cwd === '~' || cwd.startsWith('~/')) ? policy.home + cwd.slice(1) : cwd;
  const base = typeof home === 'string' && isAbsolute(home) ? resolve(home) : '/';
  if (scan && typeof cwd === 'string' && matcher.mentions(cwd)) return refused('cwd names a control path');
  const candidates = [base];
  for (const raw of argv.slice(0, 256)) {
    if (typeof raw !== 'string' || raw === '') continue;
    if (scan && matcher.mentions(raw)) return refused('argument names a control path');
    for (const part of pathParts(raw)) {
      if ((part === '~' || part.startsWith('~/')) && policy.host === 'mac') candidates.push(policy.home + part.slice(1));
      else candidates.push(isAbsolute(part) ? part : resolve(base, part));
    }
  }
  for (const path of candidates.slice(0, 512)) {
    const lexical = resolve(path);
    if (matcher.controlled(lexical)) return refused('argument names a control path');
    const real = await canonical(lexical, realpath);
    if (real !== null && matcher.controlled(real)) return refused('argument resolves to a control path');
  }
  return null;
}
