// Standing approvals (repatriation spec D-R4, D-R5): the owner approves once, in Telegram, a
// family of commands for a work session, e.g. "git, node, pnpm, python3, make, ssh under
// ~/memolabs on the Mac for 8 h". Held by the hub, in memory, next to the single-use approvals
// (operator-approvals.mjs); a hub restart drops them and the model asks again.
//
// A grant is {id, host, programs, cwd_prefixes, expires, principal}. It is made only by the owner:
//  - a request from a conversation (tool operator_grant, action request) stays pending until the
//    owner presses Approve in Telegram (10 min, like any approval);
//  - the owner's own /grant command in Telegram is active at once (principal: any).
// It covers one operator call when all of these hold (covers()):
//  - op is operator_run or operator_script, never as_root (T3 is never covered);
//  - the call's host is the grant's host, its principal the grant's (or the grant is the owner's
//    own, principal null);
//  - the call names a cwd inside one of the grant's prefixes (path compared as the operator locks
//    compare it: normalized, "~/" expanded, case folded on the Mac);
//  - its danger is grantable (operator-dangerous.mjs classifyCall: wrappers, remote programs,
//    user scripts) and every program it names (or the interpreter) is in the grant;
//  - the grant is active (approved, not expired, not revoked).
// Ids are ap_st_<random>: the agent and the root helper read the prefix and refuse a standing id
// on a hard call or on T3 (D-R5). What a grant cannot be: `/` as a prefix, a hard-listed program,
// sudo, su, doas, pkexec, or longer than 12 h.
//
// Permanent grants (issue #48, owner decision 2026-10-14 21:29) have the same coverage, with no
// TTL and no principal: they live in the host policy file (operator-policy.mjs permanent_grants),
// set by the owner through lab-infra or the Mac installer, never through a tool. The agent reads
// them from its own file and checks every ap_pm_ id against them (permanentCovers); the hub reads
// them from operator_policy to know when it need not ask Telegram.
import { createHash, randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { classifyCall, DESTRUCTIVE_PROGRAMS, PERMANENT_ID_PREFIX, STANDING_ID_PREFIX, isStandingApproval } from './operator-dangerous.mjs';
import { DEFAULT_HOMES, normalizePath } from './operator-locks.mjs';

export const GRANT_PREFIX = STANDING_ID_PREFIX;
export const GRANT_LIMITS = Object.freeze({ programs: 16, prefixes: 4, minHours: 1, maxHours: 12, defaultHours: 8, active: 16,
  pending: 8, reason: 200, pendingMs: 10 * 60_000 });
export const PROGRAM_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
// Never granted: privilege tools (root goes through the root helper, T3) and the hard list.
const NEVER = new Set(['sudo', 'su', 'doas', 'pkexec', 'runuser', 'chroot', 'nsenter']);
const COVERED_OPS = new Set(['operator_run', 'operator_script']);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

export const isStandingId = isStandingApproval;

// May a standing or permanent grant name this program? Never a privilege tool, never the hard list.
export const programGrantable = name => !NEVER.has(name) && !DESTRUCTIVE_PROGRAMS.has(name) && !/^mkfs(\.|$)/.test(name);

// The danger of a call a grant may cover, or null: operator_run or operator_script, never as_root,
// with a cwd, grantable (not hard) and naming at least one program.
export function grantableCall(op, args) {
  if (!COVERED_OPS.has(op) || args?.as_root === true || typeof args?.cwd !== 'string') return null;
  const danger = classifyCall(op, args);
  return !danger || danger.hard || danger.programs.length === 0 ? null : danger;
}

// The stable id of a permanent grant: ap_pm_ and a hash of its host, programs and prefixes, so the
// hub and the agent name the same entry without sharing state.
export function permanentGrantId(host, programs, prefixes) {
  const text = JSON.stringify([host, [...programs].sort(), [...prefixes].sort()]);
  return `${PERMANENT_ID_PREFIX}${createHash('sha256').update(`memo-bridge/permanent-grant|${text}`).digest('base64url').slice(0, 22)}`;
}

// The id of the permanent grant covering this call, or null. grants: [{grant_id, host, programs,
// cwd_prefixes}] as operator-policy.mjs parses them (absolute prefixes). Same rules as a standing
// grant, without TTL or principal.
export function permanentCovers(grants, { host, op, args }, homes = DEFAULT_HOMES) {
  if (!Array.isArray(grants) || grants.length === 0) return null;
  const danger = grantableCall(op, args);
  if (!danger) return null;
  const cwd = normalizePath(host, args.cwd, homes);
  if (!cwd || cwd.unresolved) return null;
  for (const g of grants) {
    if (g?.host !== host || !Array.isArray(g.programs) || !Array.isArray(g.cwd_prefixes)) continue;
    const prefixes = g.cwd_prefixes.map(p => normalizePath(host, p, homes)).filter(p => p && !p.unresolved && p.key !== '/');
    if (!prefixes.some(p => under(cwd.key, p.key))) continue;
    if (danger.programs.every(p => g.programs.includes(p) && programGrantable(p))) return g.grant_id;
  }
  return null;
}

// Validate a grant request. {ok, programs, prefixes, hours, reason} or a refusal.
export function checkGrantRequest({ host, programs, cwd_prefixes: prefixes, ttl_hours: hours = GRANT_LIMITS.defaultHours, reason = null },
  { homes = DEFAULT_HOMES } = {}) {
  if (!['mac', 'vps'].includes(host)) return fail('host_required', { detail: 'name host "mac" or "vps"' });
  if (!Array.isArray(programs) || programs.length === 0 || programs.length > GRANT_LIMITS.programs) return fail('invalid_arguments', { detail: 'programs: 1 to 16 names' });
  const names = [];
  for (const raw of programs) {
    const name = typeof raw === 'string' ? basename(raw) : '';
    if (!PROGRAM_RE.test(name)) return fail('invalid_arguments', { detail: 'programs: bare program names' });
    if (!programGrantable(name)) return fail('program_not_grantable', { program: name });
    if (!names.includes(name)) names.push(name);
  }
  if (!Array.isArray(prefixes) || prefixes.length === 0 || prefixes.length > GRANT_LIMITS.prefixes) return fail('invalid_arguments', { detail: 'cwd_prefixes: 1 to 4 absolute paths' });
  const keys = [];
  for (const raw of prefixes) {
    const p = normalizePath(host, raw, homes);
    if (!p || p.unresolved) return fail('invalid_arguments', { detail: 'cwd_prefixes: absolute paths ("~/" on the Mac)' });
    if (p.key === '/') return fail('prefix_too_broad', { detail: 'a standing approval never covers the whole host' });
    if (!keys.some(k => k.key === p.key)) keys.push(p);
  }
  if (!Number.isInteger(hours) || hours < GRANT_LIMITS.minHours || hours > GRANT_LIMITS.maxHours) return fail('invalid_arguments', { detail: 'ttl_hours: 1 to 12' });
  if (reason !== null && (typeof reason !== 'string' || CONTROL.test(reason) || reason.length > GRANT_LIMITS.reason)) return fail('invalid_arguments', { detail: 'reason' });
  return { ok: true, host, programs: names, prefixes: keys, hours, reason: reason?.trim() || null };
}

const under = (child, parent) => parent === '/' || child === parent || child.startsWith(`${parent}/`);

export function createGrantStore({ now = Date.now, random = randomBytes, homes = DEFAULT_HOMES } = {}) {
  const items = new Map(); // id -> grant
  const state = g => {
    if (g.status === 'revoked' || g.status === 'denied') return g.status;
    if (g.status === 'pending') return now() > g.pendingUntil ? 'expired' : 'pending';
    return now() > g.expires ? 'expired' : 'active';
  };
  const sweep = () => { for (const [id, g] of items) if (state(g) !== 'active' && state(g) !== 'pending' && now() - g.created > 24 * 3600_000) items.delete(id); };
  const newId = () => `${GRANT_PREFIX}${random(16).toString('base64url')}`;
  const view = g => ({ grant_id: g.id, host: g.host, programs: [...g.programs], cwd_prefixes: g.prefixes.map(p => p.shown), status: state(g),
    ttl_hours: g.hours, expires_at: state(g) === 'pending' ? null : new Date(g.expires).toISOString(), created_at: new Date(g.created).toISOString(),
    principal: g.principal ?? 'owner', reason: g.reason, by: g.by });
  function add(checked, { principal, status, by }) {
    sweep();
    const list = [...items.values()];
    if (status === 'pending' && list.filter(g => state(g) === 'pending').length >= GRANT_LIMITS.pending) return fail('approval_backlog');
    if (list.filter(g => state(g) === 'active').length >= GRANT_LIMITS.active) return fail('grant_limit', { detail: 'revoke one first (/revoke in Telegram)' });
    const t = now();
    const g = { id: newId(), host: checked.host, programs: checked.programs, prefixes: checked.prefixes, hours: checked.hours, reason: checked.reason,
      principal: principal ?? null, status, by, created: t, pendingUntil: t + GRANT_LIMITS.pendingMs, expires: status === 'active' ? t + checked.hours * 3600_000 : null };
    items.set(g.id, g);
    return { ok: true, grant: g };
  }
  return Object.freeze({
    // A conversation asks; the owner decides in Telegram.
    request(args, principal) {
      const checked = checkGrantRequest(args, { homes });
      return checked.ok ? add(checked, { principal, status: 'pending', by: null }) : checked;
    },
    // The owner's own /grant: active at once, for any principal of the owner.
    grantByOwner(args, by = 'telegram') {
      const checked = checkGrantRequest(args, { homes });
      return checked.ok ? add(checked, { principal: null, status: 'active', by }) : checked;
    },
    decide(id, decision, by = 'owner') {
      const g = items.get(id);
      if (!g || state(g) !== 'pending') return fail(g ? `grant_${state(g)}` : 'unknown_grant');
      if (decision === 'approve') { g.status = 'active'; g.expires = now() + g.hours * 3600_000; } else if (decision === 'deny') g.status = 'denied';
      else return fail('invalid_decision');
      g.by = by;
      return { ok: true, status: state(g) };
    },
    revoke(id, { principal } = {}) {
      const g = items.get(id);
      if (!g || (principal !== undefined && g.principal !== null && g.principal !== principal)) return fail('unknown_grant');
      if (!['active', 'pending'].includes(state(g))) return fail(`grant_${state(g)}`);
      g.status = 'revoked';
      return { ok: true, grant_id: id, status: 'revoked' };
    },
    revokeAll() {
      let n = 0;
      for (const g of items.values()) if (['active', 'pending'].includes(state(g))) { g.status = 'revoked'; n++; }
      return n;
    },
    get(id) { const g = items.get(id); return g ? view(g) : null; },
    // Active and pending grants, for one principal (theirs and the owner's) or all (principal undefined).
    list(principal) {
      sweep();
      return [...items.values()].filter(g => ['active', 'pending'].includes(state(g)) && (principal === undefined || g.principal === null || g.principal === principal))
        .sort((a, b) => a.created - b.created).map(view);
    },
    // The id of an active grant covering this call, or null.
    covers({ host, op, args, principal }) {
      const danger = grantableCall(op, args);
      if (!danger) return null;
      const cwd = normalizePath(host, args.cwd, homes);
      if (!cwd || cwd.unresolved) return null;
      for (const g of items.values()) {
        if (state(g) !== 'active' || g.host !== host || (g.principal !== null && g.principal !== principal)) continue;
        if (!g.prefixes.some(p => under(cwd.key, p.key))) continue;
        if (danger.programs.every(p => g.programs.includes(p))) return g.id;
      }
      return null;
    }
  });
}
