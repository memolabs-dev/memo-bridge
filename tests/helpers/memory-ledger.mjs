// An in-memory lease ledger with the contract of scripts/issue_lease.py, shared by the batch
// and multi-session tests.
import { randomBytes } from 'node:crypto';

// The ledger's contract (scripts/issue_lease.py): one live lease per Issue, check and write in
// one step; an expired lease can be claimed again. A random delay interleaves parallel calls.
export function memoryLedger(clock) {
  const leases = new Map();
  const tick = () => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 4)));
  const view = l => ({ ...l, expired: l.state === 'claimed' && Date.parse(l.expires_at) <= clock() });
  const unclaimed = { state: 'unclaimed', expired: false, worker: null, claim_id: null, fence_sha: null, epoch: null, expires_at: null };
  const owned = (issue, worker, claimId, fence) => {
    const l = leases.get(issue.ref);
    return l && l.state === 'claimed' && l.worker === worker && l.claim_id === claimId && l.fence_sha === fence &&
      Date.parse(l.expires_at) > clock() ? l : null;
  };
  return {
    leases,
    claims: 0,
    refuseOnce: new Map(),
    async status(issue) { await tick(); const l = leases.get(issue.ref); return { ok: true, receipt: l ? view(l) : unclaimed }; },
    async claim(issue, worker, ttl) {
      await tick();
      this.claims += 1;
      const forced = this.refuseOnce.get(issue.ref);
      if (forced) { this.refuseOnce.delete(issue.ref); return { ok: false, error: forced }; }
      const l = leases.get(issue.ref);
      if (l && l.state === 'claimed' && Date.parse(l.expires_at) > clock()) return { ok: false, error: 'lease_held', detail: 'Active lease exists' };
      const r = { state: 'claimed', worker, claim_id: randomBytes(16).toString('hex'), fence_sha: randomBytes(20).toString('hex'),
        epoch: (l?.epoch ?? 0) + 1, expires_at: new Date(clock() + ttl * 1000).toISOString() };
      leases.set(issue.ref, r);
      return { ok: true, receipt: view(r) };
    },
    async verify(issue, worker, claimId, fence) {
      await tick(); const l = owned(issue, worker, claimId, fence);
      return l ? { ok: true, receipt: view(l) } : { ok: false, error: 'stale_lease' };
    },
    async heartbeat(issue, worker, claimId, fence, ttl) {
      await tick(); const l = owned(issue, worker, claimId, fence);
      if (!l) return { ok: false, error: 'stale_lease' };
      Object.assign(l, { fence_sha: randomBytes(20).toString('hex'), expires_at: new Date(clock() + ttl * 1000).toISOString() });
      return { ok: true, receipt: view(l) };
    },
    async release(issue, worker, claimId, fence) {
      await tick(); const l = owned(issue, worker, claimId, fence);
      if (!l) return { ok: false, error: 'stale_lease' };
      Object.assign(l, { state: 'released', fence_sha: randomBytes(20).toString('hex') });
      return { ok: true, receipt: view(l) };
    }
  };
}
