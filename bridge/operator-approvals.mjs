// Owner approvals for dangerous operator calls (Phase 6, TODO-P6-11, spec D5, AC-P6-05).
//
// Held by the hub, in memory (a hub restart drops pending approvals: the model asks again and
// the owner gets a new message). An approval is bound to one call: host, op, principal and the
// SHA-256 of the exact arguments (operator-signing.mjs argsSha256). It is decided only from the
// owner's Telegram chat (bridge/operator-telegram.mjs), never from a tool argument: a
// `confirm: true` in the arguments is just another argument byte, which changes the hash.
//  - pending: expires 10 min after it was asked;
//  - approve: usable once, until those 10 min end;
//  - approve for 15 min ("standing"): the same exact call may run again for 15 min after the
//    decision;
//  - deny, expiry: the call stays refused; asking again opens a new approval.
// The hub signs the consumed approval id into the request; the agent and the root helper refuse
// a call their own approval_mode requires approval for when that id is missing.
import { randomBytes } from 'node:crypto';
import { APPROVAL_TTL_MS, STANDING_APPROVAL_MS } from './operator-dangerous.mjs';

export const MAX_PENDING_APPROVALS = 20;
const ID_RE = /^ap_[A-Za-z0-9_-]{16,40}$/;

export function createApprovalStore({ now = Date.now, random = randomBytes, maxPending = MAX_PENDING_APPROVALS } = {}) {
  const items = new Map(); // id -> approval
  const keyOf = ({ host, op, argsSha256, principal }) => `${host}|${op}|${argsSha256}|${principal}`;
  const effective = a => {
    const t = now();
    if (a.status === 'pending' && t > a.expires) return 'expired';
    if (a.status === 'approved' && !a.standingUntil && (a.consumed || t > a.expires)) return a.consumed ? 'used' : 'expired';
    if (a.status === 'approved' && a.standingUntil && t > a.standingUntil) return 'expired';
    return a.status;
  };
  const sweep = () => {
    const t = now();
    for (const [id, a] of items) {
      if (t - a.created > APPROVAL_TTL_MS + STANDING_APPROVAL_MS + 60_000) items.delete(id);
    }
  };
  return Object.freeze({
    // Open (or return the open) approval for this call. {approval, created} or {error}.
    request(call) {
      sweep();
      const key = keyOf(call);
      for (const a of items.values()) if (a.key === key && effective(a) === 'pending') return { approval: a, created: false };
      if ([...items.values()].filter(a => effective(a) === 'pending').length >= maxPending) return { error: 'approval_backlog' };
      const id = `ap_${random(18).toString('base64url')}`;
      const a = { id, key, host: call.host, op: call.op, argsSha256: call.argsSha256, principal: call.principal, reason: call.reason ?? null,
        status: 'pending', created: now(), expires: now() + APPROVAL_TTL_MS, consumed: false, standingUntil: null, decidedBy: null };
      items.set(id, a);
      return { approval: a, created: true };
    },
    // The id of an approved approval for exactly this call, consumed (single-use ones), or null.
    consume(call) {
      const key = keyOf(call);
      for (const a of items.values()) {
        if (a.key !== key || effective(a) !== 'approved') continue;
        if (!a.standingUntil) a.consumed = true;
        return a.id;
      }
      return null;
    },
    // The owner's decision: 'approve' | 'standing' | 'deny'. Only a pending approval changes.
    decide(id, decision, by = 'owner') {
      const a = items.get(id);
      if (!a || effective(a) !== 'pending') return { ok: false, error: a ? `approval_${effective(a)}` : 'unknown_approval' };
      if (decision === 'deny') a.status = 'denied';
      else if (decision === 'approve') a.status = 'approved';
      else if (decision === 'standing') { a.status = 'approved'; a.standingUntil = now() + STANDING_APPROVAL_MS; }
      else return { ok: false, error: 'invalid_decision' };
      a.decidedBy = by;
      return { ok: true, status: a.status, standing: a.standingUntil !== null };
    },
    drop(id) { items.delete(id); },
    status(id, host) {
      if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'unknown_approval' };
      const a = items.get(id);
      if (!a || (host !== undefined && a.host !== host)) return { ok: false, error: 'unknown_approval' };
      return { ok: true, approval_id: a.id, host: a.host, op: a.op, status: effective(a), args_sha256: a.argsSha256,
        expires_at: new Date(a.standingUntil ?? a.expires).toISOString(),
        detail: effective(a) === 'approved' ? 'repeat the exact same call now' : effective(a) === 'pending' ? 'waiting for the owner' : null };
    },
    get pending() { return [...items.values()].filter(a => effective(a) === 'pending').length; }
  });
}
