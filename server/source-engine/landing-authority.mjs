// Read-only authority boundary for Source Engine landing coordination.
// This file neither claims GitHub permissions nor performs a merge. Integrate only with
// an authenticated hub route and the single VPS Coordinator queue from issue #86.
const AUTHORITY = 'vps';
const SHA = /^[0-9a-f]{40}$/;
const LEASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const fail = error => ({ ok: false, error });

function validRepo(repo) {
  return typeof repo === 'string' && REPO.test(repo) && !repo.includes('..');
}
function validRow(item) {
  return item && validRepo(item.repo) && Number.isSafeInteger(item.pr_number) && item.pr_number > 0 &&
    typeof item.base_ref === 'string' && /^(?!.*\.\.)(?!.*\/\/)\w[\w./-]{0,199}$/.test(item.base_ref) &&
    typeof item.head_sha === 'string' && SHA.test(item.head_sha) &&
    typeof item.base_sha === 'string' && SHA.test(item.base_sha) &&
    Number.isSafeInteger(item.lease_expires_at);
}

// Centralized host selection is non-fallback: a disconnected VPS does not promote a
// Mac-local SQLite queue into a second writer.
export function selectLandingAuthority({ availableHosts } = {}) {
  if (!Array.isArray(availableHosts) || !availableHosts.includes(AUTHORITY)) {
    return fail('authority_unavailable');
  }
  return { ok: true, host: AUTHORITY };
}

// This guard must receive the server-observed host, not a client-supplied host argument.
// Fail closed on any missing or non-VPS identity, even for local dev credentials.
export function landingAuthorityGuard({ host, mode } = {}) {
  if (host !== AUTHORITY) return fail('not_landing_authority');
  if (mode !== 'trusted_server') return fail('server_only');
  return { ok: true, host: AUTHORITY };
}

// Verify after the queue lease was acquired, using a fresh authenticated GitHub read.
// This is a read-only preflight; it never returns a token or authority to merge.
// The policy callback is trusted server code, not a model-controlled parameter.
export async function preflightAfterLandingLease({
  host, mode, lease, readGitHub, checkPolicy, now = Date.now,
  minRemainingMs = 15_000
} = {}) {
  const guard = landingAuthorityGuard({ host, mode });
  if (!guard.ok) return guard;
  if (typeof readGitHub !== 'function' || typeof checkPolicy !== 'function' ||
      typeof now !== 'function' || !Number.isSafeInteger(minRemainingMs) ||
      minRemainingMs < 0 || minRemainingMs > 300_000) return fail('invalid_input');
  if (!lease || lease.ok !== true || !LEASE.test(String(lease.lease_id)) ||
      !validRow(lease.item) || lease.item.status !== 'leased' ||
      lease.item.lease_id !== lease.lease_id || lease.revalidate_required !== true) {
    return fail('invalid_lease');
  }
  const row = lease.item;
  const current = now();
  if (!Number.isSafeInteger(current) || current + minRemainingMs >= row.lease_expires_at) {
    return fail('lease_expired_or_short');
  }
  let snapshot;
  try { snapshot = await readGitHub({ repo: row.repo, pr_number: row.pr_number }); }
  catch { return fail('github_unavailable'); }
  if (!snapshot || snapshot.ok !== true || !snapshot.pr || !snapshot.target ||
      !snapshot.checks) return fail('github_unavailable');
  // Refs and SHAs from the authoritative GitHub read must still match the stored
  // queue observation. In particular, a green check from an obsolete SHA is not valid.
  if (snapshot.repo !== row.repo || snapshot.pr.number !== row.pr_number ||
      snapshot.pr.head_sha !== row.head_sha || snapshot.pr.base_sha !== row.base_sha ||
      snapshot.pr.base_ref !== row.base_ref ||
      snapshot.target.ref !== row.base_ref || snapshot.target.sha !== row.base_sha ||
      snapshot.checks.head_sha !== row.head_sha) return fail('stale_remote_snapshot');
  let result;
  try { result = await checkPolicy(snapshot); }
  catch { return fail('policy_unavailable'); }
  if (!result || result.ok !== true || result.eligible !== true ||
      result.head_sha !== row.head_sha) return fail('policy_not_satisfied');
  const after = now();
  if (!Number.isSafeInteger(after) || after + minRemainingMs >= row.lease_expires_at) {
    return fail('lease_expired_or_short');
  }
  return {
    ok: true, verified: true, merge_authorized: false,
    repo: row.repo, pr_number: row.pr_number, head_sha: row.head_sha,
    base_sha: row.base_sha, base_ref: row.base_ref, lease_expires_at: row.lease_expires_at
  };
}
