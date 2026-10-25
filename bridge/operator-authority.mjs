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
//     whatever the approval mode. Reads are not changed here (the secret denylist already covers
//     the policy directories).
// What an application check cannot stop while the agent and the files share a uid, or while a
// root call runs as root, is written down in docs/POLICY_AUTHORITY.md, not claimed away.
import { createHash } from 'node:crypto';
import { realpath as fsRealpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseOperatorPolicy, readTrustedFile } from './operator-policy.mjs';
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

// Does this command name a control path? argv tokens (the program included), the cwd and, for
// operator_script, the script text. A token is read as a path when it is absolute, starts with
// "~/" on the Mac, or contains a "/" (relative to cwd); "--opt=value" is read on its value.
// Each path is checked lexically and after symlinks are resolved. Returns null or a refusal.
export async function controlRefusal(matcher, policy, { argv = [], cwd = '/', content = null } = {}, { realpath = fsRealpath } = {}) {
  const refused = what => ({ ok: false, error: 'control_path_protected', detail: what });
  if (content !== null && matcher.mentions(content)) return refused('script names a control path');
  const base = typeof cwd === 'string' && isAbsolute(cwd) ? cwd : '/';
  const candidates = [base];
  for (const raw of argv.slice(0, 256)) {
    if (typeof raw !== 'string' || raw === '') continue;
    if (matcher.mentions(raw)) return refused('argument names a control path');
    const value = raw.startsWith('-') && raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : raw;
    if (value.startsWith('~/') && policy.host === 'mac') candidates.push(policy.home + value.slice(1));
    else if (isAbsolute(value)) candidates.push(value);
    else if (value.includes('/') || value === '..' || value === '.') candidates.push(resolve(base, value));
  }
  for (const path of candidates.slice(0, 64)) {
    const lexical = resolve(path);
    if (matcher.controlled(lexical)) return refused('argument names a control path');
    const real = await canonical(lexical, realpath);
    if (real !== null && matcher.controlled(real)) return refused('argument resolves to a control path');
  }
  return null;
}
