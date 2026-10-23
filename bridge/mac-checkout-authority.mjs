// Opt-in Mac-side cooperative checkout authority shared by the signed operator
// agent and local CLI wrappers. Same private 0700 state directory, same atomic
// read-decision-write lock. Not an OS sandbox: other processes can bypass it.
import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createHubState } from './hub-state.mjs';
import { ambiguousGitTarget, createCheckoutLeases } from './checkout-leases.mjs';
import { readOnlyCommand } from './operator-dangerous.mjs';

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const SAFE_GIT_ENV = Object.freeze({
  PATH: process.env.PATH || '/usr/bin:/bin', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat'
});

export function checkoutRootFor(target, { git = execFileSync, realpath = realpathSync.native } = {}) {
  if (typeof target !== 'string' || !isAbsolute(target) || target.includes('\0') ||
      target.split('/').includes('..')) return fail('checkout_scope_unknown');
  let directory;
  try { directory = realpath(target); } catch { return fail('checkout_root_unverified'); }
  try {
    if (!statSync(directory).isDirectory()) return fail('checkout_root_unverified');
    const found = git('git', ['-C', directory, '-c', 'core.fsmonitor=false',
      '-c', 'log.showSignature=false', 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', timeout: 5_000, env: SAFE_GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const root = realpath(found);
    if (root !== directory && !directory.startsWith(root + '/')) return fail('checkout_root_unverified');
    return { ok: true, root };
  } catch (error) {
    // Git also exits 128 for unsafe ownership, broken config and other failures.
    // Only a verified "not a git repository" result is outside our scope.
    if (error?.status === 128 && /not a git repository/i.test(String(error.stderr ?? ''))) {
      return { ok: true, root: null };
    }
    return fail('checkout_root_unverified');
  }
}

export function checkoutTargetFor(op, args) {
  if (op === 'operator_run') {
    if (readOnlyCommand(args?.argv) !== null) return { ok: true, skip: true };
    if (ambiguousGitTarget(args?.argv)) return fail('checkout_target_ambiguous');
    if (!args?.cwd) return fail('checkout_scope_unknown');
    return { ok: true, directories: [args.cwd] };
  }
  // These operations cannot identify the files they will modify before they run.
  if (op === 'operator_script' || op === 'operator_upload_complete') return fail('checkout_scope_unknown');
  if (op === 'operator_upload_chunk' || op === 'operator_service') return { ok: true, skip: true };
  const paths = ['operator_move', 'operator_copy'].includes(op) ? [args?.src, args?.dst] : [args?.path];
  if (paths.some(p => typeof p !== 'string' || !isAbsolute(p))) return fail('checkout_scope_unknown');
  const directories = paths.map(raw => {
    try {
      const physical = realpathSync.native(raw);
      return statSync(physical).isDirectory() ? physical : dirname(physical);
    } catch { /* new file; the parent is canonicalized by checkoutRootFor */ }
    return dirname(raw);
  });
  return { ok: true, directories };
}

export function createMacCheckoutAuthority({ stateDir, resolver = checkoutRootFor, now = Date.now } = {}) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new Error('absolute Mac-side stateDir required');
  const state = createHubState({ dir: stateDir });
  const leases = createCheckoutLeases({
    now,
    reload: () => state.read('checkout_leases'),
    onChange: data => state.save('checkout_leases', data),
    transaction: fn => state.exclusive('checkout_leases', fn)
  });
  function acquire({ root, session, principal }) {
    if (typeof root !== 'string' || !isAbsolute(root)) return fail('checkout_root_unverified');
    const resolved = resolver(root);
    if (!resolved.ok || !resolved.root) return fail('checkout_root_unverified');
    const input = { host: 'mac', root: resolved.root, principal, clientSession: session };
    return leases.acquire(input);
  }
  return Object.freeze({
    acquire,
    // Neither a session tag nor an empty process group proves quiescence:
    // arbitrary children can setsid()/detach and keep inherited write access.
    // No owner recovery API exists yet. Keep the durable fence, never certify
    // a clean handoff from this cooperative authority.
    release() { return fail('checkout_recovery_required', {
      detail: 'automatic release disabled: all descendant writers must be stopped or isolated by reviewed owner recovery'
    }); },
    guard(op, args, { session, principal } = {}) {
      const target = checkoutTargetFor(op, args);
      if (!target.ok || target.skip) return target;
      const roots = [];
      for (const directory of target.directories) {
        const resolved = resolver(directory);
        if (!resolved.ok) return resolved;
        if (!roots.includes(resolved.root)) roots.push(resolved.root);
      }
      if (roots.length > 1) return fail('checkout_cross_repo_not_supported');
      if (!roots[0]) return { ok: true, scope: 'outside_git' };
      return leases.acquire({ host: 'mac', root: roots[0], principal, clientSession: session });
    }
  });
}
