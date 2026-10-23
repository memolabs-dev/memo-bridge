// Durable, opt-in lease for multi-call operator sessions writing in one Git checkout.
// Scope: remote operator calls through the same hub. This does not guard local stdio
// clients, direct shells or external filesystem actors. Never advertise it as an OS lock.
import { isAbsolute, normalize, relative } from 'node:path';

const SESSION_RE = /^[0-9a-f]{32}$/;
const HOSTS = new Set(['mac', 'vps']);
const LEASE_MS = 30 * 60_000;
const MAX_CHECKOUTS = 128;
const MAX_REVOKED = 32;
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

export function normalizedCheckout(host, root) {
  if (!HOSTS.has(host) || typeof root !== 'string' || !isAbsolute(root) || root.includes('\0') || root.split('/').includes('..')) return null;
  const normalized = normalize(root).replace(/\/$/, '') || '/';
  return host === 'mac' ? normalized.toLowerCase() : normalized;
}

// The target directory reported by the host must be physically within the Git root.
// Reject git's arbitrary string output when it doesn't cover the resolved path.
export function verifiedCheckoutRoot(host, root, resolvedPath) {
  const a = normalizedCheckout(host, root);
  const b = normalizedCheckout(host, resolvedPath);
  if (!a || !b) return null;
  const rel = relative(a, b);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) ? a : null;
}

export function ambiguousGitTarget(argv) {
  if (!Array.isArray(argv) || String(argv[0] ?? '').split('/').at(-1) !== 'git') return false;
  return argv.slice(1).some(x => x === '-C' || x === '--git-dir' || x === '--work-tree' ||
    (typeof x === 'string' && (x.startsWith('--git-dir=') || x.startsWith('--work-tree=') || /^-C.+/.test(x))));
}

// A lease is persisted synchronously BEFORE an operator call may be signed.
// Expiry is not proof that an in-flight call or descendant has stopped.
// Never transfer an expired lease automatically, including on the hub.
export function createCheckoutLeases({
  now = Date.now, reload = null, onChange = () => ({ ok: true }), transaction = null, ttlMs = LEASE_MS
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 3_600_000) throw new Error('invalid checkout lease TTL');
  let records = new Map();
  let unavailable = false;
  const adopt = data => {
    if (data !== null && data !== undefined && (!data || data.schema !== 1 || !Array.isArray(data.rows) || data.rows.length > MAX_CHECKOUTS)) return false;
    const next = new Map();
    for (const row of data?.rows ?? []) {
      const root = normalizedCheckout(row.host, row.root);
      if (!root || root !== row.root || typeof row.session !== 'string' || !SESSION_RE.test(row.session) || typeof row.principal !== 'string' ||
          !row.principal || row.principal.length > 130 || !Number.isSafeInteger(row.expires) || Math.abs(row.expires) > 8.64e15 ||
          !Array.isArray(row.revoked) || row.revoked.length > MAX_REVOKED ||
          row.revoked.some(s => typeof s !== 'string' || !SESSION_RE.test(s)) || next.has(row.host + '|' + root)) return false;
      next.set(row.host + '|' + root, { ...row, revoked: [...row.revoked] });
    }
    records = next;
    return true;
  };
  if (reload) {
    try {
      const first = reload();
      unavailable = !first?.ok || !adopt(first.data);
    } catch { unavailable = true; }
  }
  function ensureState() {
    if (!unavailable) return true;
    if (!reload) return false;
    try { const read = reload(); if (read?.ok && adopt(read.data)) unavailable = false; } catch { /* fail closed */ }
    return !unavailable;
  }
  const describe = row => ({ host: row.host, root: row.root, expires_at: new Date(row.expires).toISOString() });
  function acquireOnce({ host, root, principal, clientSession }) {
    if (!ensureState()) return fail('checkout_lease_state_unavailable');
    const safeRoot = normalizedCheckout(host, root);
    if (!safeRoot) return fail('checkout_root_unverified');
    if (typeof clientSession !== 'string' || !SESSION_RE.test(clientSession)) return fail('session_required',
      { detail: 'a stable client session tag is required for multi-step checkout writes while the checkout gate is enabled' });
    if (typeof principal !== 'string' || !principal || principal.length > 130) return fail('forbidden');
    const key = host + '|' + safeRoot;
    const previous = records.get(key);
    if (previous?.revoked.includes(clientSession)) return fail('checkout_lease_revoked',
      { detail: 'this conversation lost checkout ownership; use a fresh isolated checkout, never continue on another branch' });
    const time = now();
    if (!Number.isSafeInteger(time) || Math.abs(time + ttlMs) > 8.64e15) return fail('checkout_lease_state_unavailable');
    if (previous && previous.expires > time && (previous.session !== clientSession || previous.principal !== principal)) {
      return fail('locked_by_other_session', { holder: describe(previous),
        next_step: 'another session owns this checkout; use another checkout or request reviewed owner recovery' });
    }
    // A heartbeat or a legacy release tombstone cannot prove quiescence.
    // Older supervisors released after observing only their process group;
    // escaped descendants may still be writing. Preserve those records too.
    if (previous && previous.expires <= time) {
      return fail('checkout_recovery_required', {
        detail: 'expired or released lease requires reviewed owner recovery; TTL and process-group exit do not prove quiescence'
      });
    }
    if (!previous && records.size >= MAX_CHECKOUTS) return fail('checkout_lease_capacity');
    const revoked = previous ? [...previous.revoked] : [];
    const current = { host, root: safeRoot, principal, session: clientSession, expires: time + ttlMs, revoked };
    records.set(key, current);
    let saved;
    try { saved = onChange({ schema: 1, rows: [...records.values()] }); } catch { saved = { ok: false }; }
    if (saved?.ok !== true) {
      if (previous) records.set(key, previous); else records.delete(key);
      unavailable = true;
      return fail('checkout_lease_state_unavailable');
    }
    return { ok: true, lease: describe(current), renewed: Boolean(previous && previous.session === clientSession && previous.principal === principal) };
  }
  function releaseOnce({ host, root, principal, clientSession }) {
    if (!ensureState()) return fail('checkout_lease_state_unavailable');
    const safeRoot = normalizedCheckout(host, root);
    if (!safeRoot) return fail('checkout_root_unverified');
    if (typeof clientSession !== 'string' || !SESSION_RE.test(clientSession)) return fail('session_required');
    const key = host + '|' + safeRoot;
    const previous = records.get(key);
    if (!previous || previous.session !== clientSession || previous.principal !== principal ||
        previous.revoked.includes(clientSession)) return fail('checkout_lease_not_owned');
    const time = now();
    if (!Number.isSafeInteger(time) || Math.abs(time) > 8.64e15) return fail('checkout_lease_state_unavailable');
    if (previous.expires <= time) return fail('checkout_recovery_required');
    if (previous.revoked.length >= MAX_REVOKED) return fail('checkout_lease_capacity');
    // Revocation preserves a tombstone, not deletion. It stops this session;
    // it does not certify quiescence or authorize a successor session.
    const current = { ...previous, expires: time, revoked: [...previous.revoked, clientSession] };
    records.set(key, current);
    let saved;
    try { saved = onChange({ schema: 1, rows: [...records.values()] }); } catch { saved = { ok: false }; }
    if (saved?.ok !== true) {
      records.set(key, previous);
      unavailable = true;
      return fail('checkout_lease_state_unavailable');
    }
    return { ok: true, released: true };
  }
  function mutate(input, action) {
    if (!transaction) return action(input);
    if (typeof reload !== 'function') return fail('checkout_lease_state_unavailable');
    try {
      return transaction(() => {
        // Re-read under the same cross-process exclusive lock.
        let current;
        try { current = reload(); } catch { current = { ok: false }; }
        if (!current?.ok || !adopt(current.data)) {
          unavailable = true;
          return fail('checkout_lease_state_unavailable');
        }
        unavailable = false;
        return action(input);
      });
    } catch {
      return fail('checkout_lease_state_unavailable');
    }
  }
  return Object.freeze({
    acquire: input => mutate(input, acquireOnce),
    release: input => mutate(input, releaseOnce),
    get size() { return records.size; }
  });
}
