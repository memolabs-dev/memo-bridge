// Operator locks (multi-session spec D-MS4 to D-MS6): which conversation may write, run or
// restart what on the Mac and the VPS while up to ten conversations share one principal.
//
// Held by the hub, the one place every operator call of both hosts crosses, in memory. A lock
// is taken by a workspace (checked with the runtime: active, owned, bound to the caller's
// conversation) on a path subtree, a systemd unit, a docker container or a whole host, for a
// TTL (default 15 min, at most 2 h, renewed by taking it again). It is bound to the workspace and
// to the conversation (session hash) that took it.
//
// Enforcement, before signing and before any owner approval is asked:
//  - a remote principal (oidc:*) must name its workspace_id on every T1 to T3 call
//    (workspace_required) and hold a lock that covers the call (lock_required);
//  - anyone else (the 9443 hub principals) may call without a workspace, unless another
//    workspace's lock covers the target;
//  - a lock of another workspace that overlaps the target answers locked_by_other_session with
//    the holder's session tag, workspace, target and reason;
//  - a lock of this workspace taken from another conversation answers workspace_other_session.
// Restart: the table is empty after a hub restart. A remote holder's next write answers
// lock_required, so it takes the lock again, or learns that another conversation took it. No
// operator write runs under a lock the hub does not know.
//
// Locks coordinate conversations; they are not a security boundary. Paths are compared as text
// after normalization ("." and "..", trailing "/", "~/" with the host's configured home, case
// folded on the Mac); a symlink is not resolved here. The host policy, the request signature
// and the owner approvals stay the boundary.
import { randomBytes } from 'node:crypto';
import { CLIENT_SESSION_RE, sessionTag } from './write-gate.mjs';
import { isRemotePrincipal } from '../server/coordinator/policy.mjs';

export const LOCK_KINDS = Object.freeze(['path', 'unit', 'container', 'global']);
export const LOCK_TTL = Object.freeze({ default: 900, min: 30, max: 7200 });
// total 32: sessions_overview with 20 workspaces and every lock stays under the 24 KiB remote budget.
export const LOCK_LIMITS = Object.freeze({ perWorkspace: 8, total: 32, reason: 200, listed: 32, uploads: 256 });
export const LOCK_OPS = Object.freeze(['operator_lock', 'operator_unlock']);
const UPLOAD_TTL_MS = 24 * 3600_000;
const WS_RE = /^ws_[A-Za-z0-9_-]{16}$/;
const LOCK_ID_RE = /^lk_[A-Za-z0-9_-]{16}$/;
const UNIT_RE = /^[A-Za-z0-9@._:\\-]{1,128}$/;
const UNIT_SUFFIX_RE = /\.(service|socket|timer|target|path|mount|slice|scope)$/;
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/;
// The Mac's default home: "~/" on the Mac is the agent user's home (spec Phase 6 Lot 3).
export const DEFAULT_HOMES = Object.freeze({ mac: '/Users/memo' });
// Case-insensitive file systems (APFS default on the Mac): paths compared folded.
const FOLDED_HOSTS = new Set(['mac']);

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

// A path as a lock key: absolute, normalized; null when it cannot be one. A "~" path on a host
// without a configured home becomes {unresolved: true}: it is covered by every path lock of that
// host (conservative), and only a global lock covers it for its own caller.
export function normalizePath(host, raw, homes = DEFAULT_HOMES) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096 || CONTROL.test(raw)) return null;
  let path = raw;
  if (path === '~' || path.startsWith('~/')) {
    const home = homes?.[host];
    if (typeof home !== 'string' || !home.startsWith('/')) return { unresolved: true };
    path = home + path.slice(1);
  }
  if (!path.startsWith('/')) return null;
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(part);
  }
  const key = `/${parts.join('/')}`;
  return { key: FOLDED_HOSTS.has(host) ? key.toLowerCase() : key, shown: `/${parts.join('/')}` };
}

// {kind, key, shown} for one lock target, or null.
export function lockTarget(host, kind, target, homes = DEFAULT_HOMES) {
  if (kind === 'global') return { kind, key: '*', shown: '*' };
  if (typeof target !== 'string') return null;
  if (kind === 'path') {
    const p = normalizePath(host, target, homes);
    return p && !p.unresolved ? { kind, key: p.key, shown: p.shown } : null;
  }
  if (kind === 'unit') {
    if (!UNIT_RE.test(target)) return null;
    const unit = UNIT_SUFFIX_RE.test(target) ? target : `${target}.service`;
    return { kind, key: unit, shown: unit };
  }
  if (kind === 'container') return CONTAINER_RE.test(target) ? { kind, key: target, shown: target } : null;
  return null;
}

const under = (child, parent) => parent === '/' || child === parent || child.startsWith(`${parent}/`);
// Does lock `a` touch target `b` (same host)? Global touches everything; paths overlap when one
// is inside the other; units and containers by name. An unresolved "~" path touches every path.
export function overlaps(a, b) {
  if (a.kind === 'global' || b.kind === 'global') return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'path') return a.unresolved || b.unresolved || under(a.key, b.key) || under(b.key, a.key);
  return a.key === b.key;
}
// Does a lock of the caller cover `need` (so the caller may act on it)?
export function covers(lock, need) {
  if (lock.kind === 'global') return true;
  if (need.kind === 'global' || need.unresolved || lock.kind !== need.kind) return false;
  if (lock.kind === 'path') return under(need.key, lock.key);
  return lock.key === need.key;
}

// What one operator call touches: [{kind, key, shown, unresolved?}], or {error}. T0 calls touch
// nothing. Commands are opaque (their argv can name any path): a run with a cwd is covered by a
// path lock on that cwd, a run without one, a root run and a script need the host. A user script follows the run rule.
export function operatorTargets(op, args, { homes = DEFAULT_HOMES, uploads = null } = {}) {
  const host = args?.host;
  const path = raw => {
    const p = normalizePath(host, raw, homes);
    if (!p) return { error: 'invalid_arguments' };
    return p.unresolved ? { kind: 'path', key: String(raw), shown: String(raw).slice(0, 200), unresolved: true }
      : { kind: 'path', key: p.key, shown: p.shown };
  };
  const all = list => {
    const bad = list.find(t => t.error);
    return bad ? { error: bad.error } : list;
  };
  const global = [{ kind: 'global', key: '*', shown: '*' }];
  switch (op) {
    case 'operator_edit': case 'operator_upload_init': case 'operator_delete': case 'operator_chmod':
      return all([path(args.path)]);
    case 'operator_move': return all([path(args.src), path(args.dst)]);
    case 'operator_copy': return all([path(args.dst)]);
    case 'operator_upload_chunk': case 'operator_upload_complete': {
      const upload = uploads?.get(args.upload_id);
      return upload && upload.host === host ? all([path(upload.path)]) : { unknownUpload: true };
    }
    case 'operator_run':
      if (args.as_root === true || typeof args.cwd !== 'string') return global;
      return all([path(args.cwd)]);
    // Repatriation D-R6: a user script with a cwd is covered by a path lock on it, like a run.
    case 'operator_script':
      if (args.as_root === true || typeof args.cwd !== 'string') return global;
      return all([path(args.cwd)]);
    case 'operator_docker': {
      // Reads touch nothing; restart, stop and start need a lock on the container.
      if (!['restart', 'stop', 'start'].includes(args.action)) return [];
      const container = lockTarget(host, 'container', args.container, homes);
      return container ? [container] : { error: 'invalid_arguments' };
    }
    case 'operator_service': {
      const unit = lockTarget(host, 'unit', args.unit, homes);
      return unit ? [unit] : { error: 'invalid_arguments' };
    }
    default: return [];
  }
}

// Delegation (#47, spec D7): may a child of `delegation` (as workspace_status returns it: {scope:
// {mode, paths}}) act on these targets of `host`? Only path targets under one of its absolute scope
// paths; read_only and worktree scopes have none. null when allowed, else a refusal.
export function delegationTargetRefusal(delegation, host, targets, homes = DEFAULT_HOMES) {
  const scope = delegation?.scope ?? {};
  const prefixes = scope.mode === 'paths' ? (Array.isArray(scope.paths) ? scope.paths : [])
    .filter(p => typeof p === 'string' && (p.startsWith('/') || p.startsWith('~'))).map(p => normalizePath(host, p, homes))
    .filter(p => p && !p.unresolved) : [];
  for (const need of targets) {
    const ok = need.kind === 'path' && !need.unresolved && prefixes.some(p => under(need.key, p.key));
    if (!ok) {
      return fail('outside_delegation_scope', { detail: need.kind === 'path' ? `${need.shown} is outside your delegation scope`
        : `a delegated conversation takes path locks inside its scope only, never ${need.kind}` });
    }
  }
  return null;
}

// createOperatorLocks({now, verifyWorkspace, homes, newId}). verifyWorkspace(principal,
// workspaceId, clientSession) resolves with {ok:true, workspace:{workspace_id, status,
// session_tag, project}} as the runtime's workspace_status answers it for that conversation, or
// {ok:false, error}.
export function createOperatorLocks({ now = Date.now, verifyWorkspace, homes = DEFAULT_HOMES,
  newId = () => `lk_${randomBytes(12).toString('base64url')}` } = {}) {
  if (typeof verifyWorkspace !== 'function') throw new Error('verifyWorkspace required');
  const locks = new Map();    // id -> lock
  const uploads = new Map();  // upload_id -> {host, path, workspaceId, at}
  const lastCall = new Map(); // session hash -> ms of the last operator or runtime call seen
  // Delegation (#47): a child workspace -> its parent's workspace. A lock's family is the parent
  // for a child's lock, else its own workspace: one family never blocks itself, and a child's
  // lock blocks every other conversation as its parent's would.
  const families = new Map();
  const familyOf = workspaceId => families.get(workspaceId) ?? workspaceId;
  const setFamily = (workspaceId, parentId) => {
    families.delete(workspaceId);
    families.set(workspaceId, parentId);
    while (families.size > 1024) families.delete(families.keys().next().value);
  };
  const startedAt = now();

  const sweep = () => {
    const t = now();
    for (const [id, l] of locks) if (l.expires <= t) locks.delete(id);
    for (const [id, u] of uploads) if (t - u.at > UPLOAD_TTL_MS) uploads.delete(id);
  };
  const describe = (l, session = null) => ({ lock_id: l.id, host: l.host, kind: l.kind, target: l.shown, workspace_id: l.workspaceId,
    session_tag: sessionTag(l.session), project: l.project ?? null, reason: l.reason, expires_at: new Date(l.expires).toISOString(),
    taken_at: new Date(l.taken).toISOString(), ...(session !== undefined ? { you: Boolean(session) && l.session === session } : {}) });
  const holderOf = l => ({ session_tag: sessionTag(l.session), workspace_id: l.workspaceId,
    ...(familyOf(l.workspaceId) !== l.workspaceId ? { parent_workspace_id: familyOf(l.workspaceId) } : {}), kind: l.kind, target: l.shown,
    reason: l.reason, expires_at: new Date(l.expires).toISOString() });
  const session = value => (CLIENT_SESSION_RE.test(value ?? '') ? value : null);
  // Two conversations of one workspace never share its locks: a session recorded on the lock
  // must be the caller's (when the caller has none, it cannot prove it is the same one).
  const otherSession = (l, caller) => Boolean(l.session) && l.session !== caller;
  const reasonOf = value => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || CONTROL.test(value)) return undefined;
    const text = value.trim();
    return text.length <= LOCK_LIMITS.reason ? text || null : undefined;
  };

  function seen(clientSession) {
    const s = session(clientSession);
    if (!s) return;
    lastCall.delete(s);
    lastCall.set(s, now());
    while (lastCall.size > 256) lastCall.delete(lastCall.keys().next().value);
  }

  // operator_lock and operator_unlock, answered by the hub.
  async function handle(op, args, { principal, clientSession }) {
    sweep();
    const caller = session(clientSession);
    if (!WS_RE.test(args?.workspace_id ?? '')) return fail('workspace_required', { detail: 'pass the workspace_id from workspace_open' });
    if (op === 'operator_unlock') {
      const mine = [...locks.values()].filter(l => l.workspaceId === args.workspace_id && l.principal === principal.id);
      let chosen;
      if (args.lock_id !== undefined) {
        if (!LOCK_ID_RE.test(args.lock_id)) return fail('invalid_arguments');
        chosen = mine.filter(l => l.id === args.lock_id && l.host === args.host);
      } else if (args.kind !== undefined) {
        const target = lockTarget(args.host, args.kind, args.target, homes);
        if (!target) return fail('invalid_arguments');
        chosen = mine.filter(l => l.host === args.host && l.kind === target.kind && l.key === target.key);
      } else {
        chosen = mine.filter(l => l.host === args.host);
      }
      if (chosen.some(l => otherSession(l, caller))) return fail('workspace_other_session');
      for (const l of chosen) locks.delete(l.id);
      return { ok: true, host: args.host, released: chosen.map(l => ({ lock_id: l.id, kind: l.kind, target: l.shown })) };
    }
    // operator_lock
    if (!LOCK_KINDS.includes(args.kind)) return fail('invalid_arguments');
    const target = lockTarget(args.host, args.kind, args.target, homes);
    if (!target) return fail('invalid_arguments', { detail: 'target: an absolute path (or ~/ on the Mac), a unit or a container name' });
    const ttl = args.ttl_seconds ?? LOCK_TTL.default;
    if (!Number.isInteger(ttl) || ttl < LOCK_TTL.min || ttl > LOCK_TTL.max) return fail('invalid_arguments', { detail: 'ttl_seconds' });
    const reason = reasonOf(args.reason);
    if (reason === undefined) return fail('invalid_arguments', { detail: 'reason' });
    // The workspace must be this principal's, active, and bound to this conversation.
    let verified;
    try { verified = await verifyWorkspace(principal, args.workspace_id, caller); } catch { verified = fail('workspace_unverified'); }
    if (!verified?.ok) return fail(typeof verified?.error === 'string' ? verified.error : 'workspace_unverified');
    const ws = verified.workspace ?? {};
    if (ws.status !== 'active') return fail('workspace_closed');
    const callerTag = sessionTag(caller);
    if (isRemotePrincipal(principal) && ws.session_tag && callerTag && ws.session_tag !== callerTag) return fail('workspace_other_session');
    if (ws.delegation) {
      const refusal = delegationTargetRefusal(ws.delegation, args.host, [target], homes);
      if (refusal) return refusal;
      if (typeof ws.delegation.parent_workspace_id === 'string') setFamily(args.workspace_id, ws.delegation.parent_workspace_id);
    }
    sweep();
    const conflict = [...locks.values()].find(l => l.host === args.host && familyOf(l.workspaceId) !== familyOf(args.workspace_id) &&
      overlaps(l, target));
    if (conflict) return fail('locked_by_other_session', { holder: holderOf(conflict) });
    const t = now();
    // The runtime says this conversation owns the workspace: its earlier locks follow it.
    for (const l of locks.values()) if (l.workspaceId === args.workspace_id && l.principal === principal.id) l.session = caller;
    const same = [...locks.values()].find(l => l.workspaceId === args.workspace_id && l.host === args.host && l.kind === target.kind && l.key === target.key);
    if (same) {
      Object.assign(same, { expires: t + ttl * 1000, reason: reason ?? same.reason, session: caller });
      return { ok: true, renewed: true, lock: describe(same) };
    }
    if ([...locks.values()].filter(l => l.workspaceId === args.workspace_id).length >= LOCK_LIMITS.perWorkspace || locks.size >= LOCK_LIMITS.total) {
      return fail('lock_limit', { detail: `at most ${LOCK_LIMITS.perWorkspace} locks per workspace and ${LOCK_LIMITS.total} in all` });
    }
    const lock = { id: newId(), host: args.host, kind: target.kind, key: target.key, shown: target.shown, workspaceId: args.workspace_id,
      principal: principal.id, session: caller, project: typeof ws.project === 'string' ? ws.project : null, reason, taken: t, expires: t + ttl * 1000 };
    locks.set(lock.id, lock);
    return { ok: true, renewed: false, lock: describe(lock) };
  }

  // The gate of one T1 to T3 call. {ok:true} or a refusal.
  function check(op, args, { principal, clientSession }) {
    sweep();
    const caller = session(clientSession);
    const remote = isRemotePrincipal(principal);
    const workspaceId = args?.workspace_id;
    if (workspaceId !== undefined && !WS_RE.test(workspaceId ?? '')) return fail('invalid_arguments', { detail: 'workspace_id' });
    if (remote && workspaceId === undefined) {
      return fail('workspace_required', { detail: 'operator writes, commands and root calls name your workspace_id and need an operator_lock' });
    }
    const targets = operatorTargets(op, args, { homes, uploads });
    if (targets.error) return fail(targets.error);
    let needs = targets;
    if (targets.unknownUpload) {
      // The upload was started before a hub restart or by another path: remote callers start it again.
      if (remote) return fail('lock_required', { detail: 'unknown upload here: start it again with operator_upload_init' });
      needs = [];
    }
    const hostLocks = [...locks.values()].filter(l => l.host === args.host);
    for (const need of needs) {
      const blocking = hostLocks.find(l => (familyOf(l.workspaceId) !== familyOf(workspaceId) || l.principal !== principal.id) && overlaps(l, need));
      if (blocking) return fail('locked_by_other_session', { holder: holderOf(blocking) });
    }
    if (workspaceId !== undefined) {
      const mine = hostLocks.filter(l => l.workspaceId === workspaceId && l.principal === principal.id);
      if (remote && mine.some(l => otherSession(l, caller))) return fail('workspace_other_session');
      if (remote) {
        const missing = needs.find(need => !mine.some(l => covers(l, need)));
        if (missing) {
          return fail('lock_required', { detail: missing.kind === 'global'
            ? `take operator_lock kind global on ${args.host} first (root calls, scripts and commands without cwd)`
            : `take operator_lock kind ${missing.kind} on ${missing.shown} first` });
        }
      }
    }
    return { ok: true };
  }

  // Implicit per-call locks (repatriation D-R14, bench 2026-10-14 20:04): a remote call with no
  // covering lock of its own holds its targets for the duration of the call only, refused only
  // when ANOTHER workspace's lock overlaps. Never counted in the per-workspace limit, never
  // verified with the runtime (they last one call). Returns {ok, ids, release()} or a refusal.
  function acquireImplicit(host, targets, { principal, clientSession, workspaceId, ttlMs = 3_600_000 }) {
    sweep();
    const caller = session(clientSession);
    const hostLocks = [...locks.values()].filter(l => l.host === host);
    const mine = hostLocks.filter(l => l.workspaceId === workspaceId && l.principal === principal.id);
    for (const need of targets) {
      const blocking = hostLocks.find(l => (familyOf(l.workspaceId) !== familyOf(workspaceId) || l.principal !== principal.id) && overlaps(l, need));
      if (blocking) return fail('locked_by_other_session', { holder: holderOf(blocking),
        next_step: 'another conversation holds this target: tell the owner and wait, or work elsewhere' });
    }
    const t = now();
    const ids = [];
    for (const need of targets) {
      if (mine.some(l => covers(l, need))) continue;
      const lock = { id: newId(), host, kind: need.kind, key: need.key, shown: need.shown, workspaceId, principal: principal.id, session: caller,
        project: null, reason: 'implicit (one call)', taken: t, expires: t + ttlMs, implicit: true };
      locks.set(lock.id, lock);
      ids.push(lock.id);
    }
    return { ok: true, ids, release: () => { for (const id of ids) locks.delete(id); } };
  }

  // A started upload belongs to the path it was started for (operator_upload_init answer).
  function recordUpload(args, data) {
    if (data?.ok !== true || typeof data.upload_id !== 'string' || typeof args?.path !== 'string') return;
    sweep();
    uploads.set(data.upload_id, { host: args.host, path: args.path, workspaceId: args.workspace_id ?? null, at: now() });
    while (uploads.size > LOCK_LIMITS.uploads) uploads.delete(uploads.keys().next().value);
  }

  // For sessions_overview: this principal's locks (with `you`), and the last call per tag.
  function overview(principal, clientSession) {
    sweep();
    const caller = session(clientSession);
    const mine = [...locks.values()].filter(l => l.principal === principal.id).sort((a, b) => a.taken - b.taken);
    const calls = {};
    for (const [s, at] of lastCall) calls[sessionTag(s)] = new Date(at).toISOString();
    return { locks: mine.slice(0, LOCK_LIMITS.listed).map(l => describe(l, caller)), locks_truncated: mine.length > LOCK_LIMITS.listed,
      locks_since: new Date(startedAt).toISOString(), last_call_at: calls };
  }

  // What one call touches, with the uploads this table knows (implicit locks, D-R14).
  const targetsOf = (op, args) => operatorTargets(op, args, { homes, uploads });
  return Object.freeze({ handle, check, acquireImplicit, targetsOf, recordUpload, overview, seen, setFamily, familyOf,
    get size() { sweep(); return locks.size; } });
}

// Merge the hub's view into a sessions_overview answer of the runtime.
export function mergeOverview(data, view) {
  if (!data || data.ok !== true || !Array.isArray(data.sessions)) return data;
  const byWorkspace = new Map();
  for (const l of view.locks) byWorkspace.set(l.workspace_id, [...(byWorkspace.get(l.workspace_id) ?? []), l]);
  // Delegation (#47, spec D10): children sit under their parent and get their locks there too.
  const withLocks = s => ({ ...s, operator_locks: (byWorkspace.get(s.workspace_id) ?? [])
    .map(({ lock_id, host, kind, target, reason, expires_at }) => ({ lock_id, host, kind, target, reason: reason ? reason.slice(0, 80) : null,
      expires_at })),
  ...(s.session_tag && view.last_call_at[s.session_tag] ? { last_call_at: view.last_call_at[s.session_tag] } : {}),
  ...(Array.isArray(s.children) ? { children: s.children.map(withLocks) } : {}) });
  const sessions = data.sessions.map(withLocks);
  // Bounded for the 24 KiB remote budget: the details sit on each workspace shown; the list
  // repeats them only for a workspace beyond the ones shown.
  const shown = new Set(data.sessions.flatMap(s => [s.workspace_id, ...(Array.isArray(s.children) ? s.children.map(c => c.workspace_id) : [])]));
  const list = view.locks.map(({ lock_id, host, kind, target, workspace_id, session_tag, you, reason, expires_at }) => ({ lock_id, workspace_id,
    session_tag, ...(you !== undefined ? { you } : {}), ...(shown.has(workspace_id) ? {} : { host, kind, target, reason, expires_at }) }));
  return { ...data, sessions, operator_locks: list, ...(view.locks_truncated ? { operator_locks_truncated: true } : {}),
    locks_since: view.locks_since };
}
