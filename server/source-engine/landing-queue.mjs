// Source Engine landing coordination, NOT a GitHub merge executor.
// GitHub is authoritative. A consumer must fetch fresh PR, review, checks and target HEAD
// again immediately before invoking the existing protected landing contract.
import { randomUUID } from 'node:crypto';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/;
const fail = (error) => ({ ok: false, error });
const validRepo = value => typeof value === 'string' && REPO.test(value) && !value.includes('..');
const validSha = value => typeof value === 'string' && SHA.test(value);

// The evidence must come from authenticated GitHub reads; never expose enqueue as
// an unrestricted remote tool that trusts caller-supplied approvals or check results.
export function assessLanding({ repo, pr, target, checks, allowedRepos } = {}) {
  if (!validRepo(repo) || !Array.isArray(allowedRepos) ||
      !allowedRepos.some(x => typeof x === 'string' && x.toLowerCase() === repo.toLowerCase())) {
    return fail('repo_not_allowed');
  }
  if (!pr || !target || !checks || !Number.isSafeInteger(pr.number) || pr.number < 1 ||
      pr.repo !== repo || pr.base_ref !== target.ref || !REF.test(String(target.ref)) ||
      !validSha(pr.head_sha) || !validSha(pr.base_sha) || !validSha(target.sha) ||
      !validSha(pr.expected_head_sha)) return fail('invalid_input');
  if (pr.draft || pr.fork || pr.state !== 'open') return fail('pr_not_ready');
  if (pr.head_sha !== pr.expected_head_sha || pr.base_sha !== target.sha) return fail('stale_sha');
  if (pr.mergeable !== true || pr.review_decision !== 'APPROVED' ||
      pr.branch_protection_ok !== true) return fail('review_or_protection_required');
  if (!Array.isArray(checks.required) || !checks.required.length ||
      checks.required.some(x => !x || typeof x.name !== 'string' ||
        x.conclusion !== 'success' || x.status !== 'completed') ||
      checks.head_sha !== pr.head_sha) return fail('checks_not_green');
  return { ok: true, repo, pr_number: pr.number, head_sha: pr.head_sha,
    base_sha: pr.base_sha, base_ref: pr.base_ref };
}

// Enqueues metadata only; an approved observation is not permission to merge later.
export async function enqueueLanding(store, evidence, { at = Date.now() } = {}) {
  const decision = assessLanding(evidence);
  if (!decision.ok) return decision;
  if (!Number.isSafeInteger(at) || at < 0) return fail('invalid_input');
  return store.transaction(repo => {
    const previous = repo.getLanding(decision.repo, decision.pr_number);
    if (previous) {
      if (previous.head_sha !== decision.head_sha || previous.base_sha !== decision.base_sha ||
          previous.base_ref !== decision.base_ref) return fail('head_or_base_changed');
      if (['landed', 'cancelled', 'blocked'].includes(previous.status)) return fail('already_terminal');
      return { ok: true, unchanged: true, item: previous };
    }
    repo.insertLanding({ ...decision, enqueued_at: at, updated_at: at });
    return { ok: true, item: repo.getLanding(decision.repo, decision.pr_number) };
  });
}

// BEGIN IMMEDIATE in the shared SQLite Coordinator serializes claims across processes.
// An expired lease can be reclaimed, but the consumer must re-read GitHub evidence.
export async function claimLanding(store, { repo, worker, ttl_ms = 300000, at = Date.now() }) {
  if (!validRepo(repo) || typeof worker !== 'string' ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(worker) || !Number.isSafeInteger(ttl_ms) ||
      ttl_ms < 1000 || ttl_ms > 1800000 || !Number.isSafeInteger(at) || at < 0) return fail('invalid_input');
  return store.transaction(db => {
    const first = db.firstLanding(repo);
    if (!first) return { ok: true, empty: true };
    if (first.status === 'leased' && first.lease_expires_at > at) return fail('repo_busy');
    const lease_id = randomUUID();
    if (db.updateLandingLease(repo, first.pr_number, lease_id, worker, at + ttl_ms, at) !== 1) return fail('lease_conflict');
    return { ok: true, lease_id, item: db.getLanding(repo, first.pr_number), revalidate_required: true };
  });
}

export async function finishLanding(store, { repo, pr_number, lease_id, outcome, at = Date.now() }) {
  if (!validRepo(repo) || !Number.isSafeInteger(pr_number) || pr_number < 1 ||
      typeof lease_id !== 'string' || !/^[a-f0-9-]{36}$/.test(lease_id) ||
      !['landed','blocked','cancelled'].includes(outcome) ||
      !Number.isSafeInteger(at) || at < 0) return fail('invalid_input');
  return store.transaction(db => {
    if (db.completeLanding(repo, pr_number, lease_id, outcome, at) !== 1) return fail('stale_lease');
    return { ok: true, item: db.getLanding(repo, pr_number) };
  });
}

export async function landingQueueStatus(store, { repo, limit = 50 }) {
  if (!validRepo(repo) || !Number.isInteger(limit) || limit < 1 || limit > 100) return fail('invalid_input');
  return store.transaction(db => ({ ok: true, queue: db.listLandings(repo, limit) }), { write: false });
}
