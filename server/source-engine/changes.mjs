// Source Engine V0: typed, private observations. No Git or merge capability.
import { createHash } from 'node:crypto';

const ID = /^[a-z0-9][a-z0-9_.:-]{0,99}$/;
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const ISSUE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]{0,8}$/;
const WORKTREE = /^wt_[A-Za-z0-9_-]{16}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/;
const SHA = /^[0-9a-f]{40}$/;
const FIELDS = new Set(['project_id', 'issue_ref', 'worktree_id', 'branch', 'base_sha', 'head_sha', 'pr_number', 'ci_state', 'landing_state', 'deployment_state']);
const CI = new Set(['unknown', 'pending', 'success', 'failed']);
const DEPLOYMENT = Object.freeze({
  unknown: new Set(['unknown', 'pending', 'verified', 'not_required']),
  pending: new Set(['unknown', 'pending', 'verified', 'not_required']),
  verified: new Set(['verified', 'not_required']),
  not_required: new Set(['not_required', 'verified'])
});
const LANDING = Object.freeze({
  open: new Set(['open', 'queued', 'blocked', 'landed', 'closed']),
  queued: new Set(['open', 'queued', 'blocked', 'landed', 'closed']),
  blocked: new Set(['open', 'queued', 'blocked', 'closed', 'landed']),
  landed: new Set(['landed']),
  closed: new Set(['closed'])
});
const fail = error => ({ ok: false, error });
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const nullable = (v, valid) => v === null || valid(v);

function validFields(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
  if (Object.keys(patch).some(k => !FIELDS.has(k))) return false;
  return Object.entries(patch).every(([k, v]) => {
    if (k === 'project_id') return typeof v === 'string' && PROJECT.test(v);
    if (k === 'issue_ref') return typeof v === 'string' && ISSUE.test(v);
    if (k === 'worktree_id') return nullable(v, x => typeof x === 'string' && WORKTREE.test(x));
    if (k === 'branch') return typeof v === 'string' && BRANCH.test(v) && !v.includes('..') && !v.endsWith('/');
    if (k === 'base_sha' || k === 'head_sha') return nullable(v, x => typeof x === 'string' && SHA.test(x));
    if (k === 'pr_number') return nullable(v, x => Number.isSafeInteger(x) && x > 0);
    if (k === 'ci_state') return CI.has(v);
    if (k === 'landing_state') return has(LANDING, v);
    if (k === 'deployment_state') return DEPLOYMENT[v] !== undefined;
    return false;
  });
}

// Update a change atomically in the Coordinator store, recording every changed snapshot.
// A source timestamp must be comparable across observations of the same change.
export async function recordSourceChange(store, { id, patch, event_id = null, expected_revision = null, observed_at = null, at = Date.now() }) {
  if (!ID.test(String(id)) || !validFields(patch) || !Number.isSafeInteger(at) || at < 0 ||
      (event_id !== null && (typeof event_id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(event_id))) ||
      (expected_revision !== null && (!Number.isSafeInteger(expected_revision) || expected_revision < 0)) ||
      (observed_at !== null && (!Number.isSafeInteger(observed_at) || observed_at < 0))) return fail('invalid_input');
  const input_hash = createHash('sha256').update(JSON.stringify({ id, patch, observed_at })).digest('hex');
  return store.transaction(repo => {
    if (event_id !== null) {
      const seen = repo.getSourceEventById(event_id);
      if (seen) return seen.change_id === id && seen.input_hash === input_hash
        ? { ok: true, replayed: true, change: JSON.parse(seen.snapshot_json) }
        : fail('idempotency_conflict');
    }
    const prior = repo.getSourceChange(id);
    if (expected_revision !== null && expected_revision !== (prior?.revision ?? 0)) return fail('revision_conflict');
    if (prior && ((has(patch, 'project_id') && patch.project_id !== prior.project_id) ||
                  (has(patch, 'issue_ref') && patch.issue_ref !== prior.issue_ref))) return fail('immutable_identity');
    if (!prior && (!has(patch, 'project_id') || !has(patch, 'issue_ref') || !has(patch, 'branch'))) return fail('missing_identity');
    if (prior && observed_at !== null && prior.source_at !== null && observed_at <= prior.source_at) {
      return fail('stale_observation');
    }
    const next = {
      id,
      project_id: prior?.project_id ?? patch.project_id,
      issue_ref: prior?.issue_ref ?? patch.issue_ref,
      worktree_id: prior?.worktree_id ?? null,
      branch: prior?.branch ?? patch.branch,
      base_sha: prior?.base_sha ?? null,
      head_sha: prior?.head_sha ?? null,
      pr_number: prior?.pr_number ?? null,
      ci_state: prior?.ci_state ?? 'unknown',
      landing_state: prior?.landing_state ?? 'open',
      deployment_state: prior?.deployment_state ?? 'unknown',
      ...patch,
      source_at: observed_at ?? prior?.source_at ?? null,
      revision: (prior?.revision ?? 0) + 1,
      created_at: prior?.created_at ?? at,
      updated_at: at
    };
    if (prior && !LANDING[prior.landing_state].has(next.landing_state)) return fail('invalid_transition');
    if (prior?.landing_state === 'landed' &&
        (next.head_sha !== prior.head_sha || next.ci_state !== prior.ci_state)) return fail('invalid_transition');
    if (prior && has(patch, 'deployment_state') && !DEPLOYMENT[prior.deployment_state ?? 'unknown'].has(next.deployment_state)) return fail('invalid_transition');
    const changed = !prior || Object.keys(next).some(k =>
      !['revision', 'updated_at', 'created_at'].includes(k) && next[k] !== prior[k]);
    if (!changed) {
      // A noop with a unique event_id still gets its idempotency receipt.
      if (event_id !== null) repo.appendSourceEvent({
        change_id: id, event_id, input_hash, revision: prior.revision,
        snapshot_json: JSON.stringify(prior), at
      });
      return { ok: true, unchanged: true, change: prior };
    }
    if (!prior) repo.createSourceChange(next);
    else if (repo.updateSourceChange(next, prior.revision) !== 1) return fail('revision_conflict');
    repo.appendSourceEvent({
      change_id: id, event_id, input_hash, revision: next.revision,
      snapshot_json: JSON.stringify(next), at
    });
    return { ok: true, change: next };
  });
}

export function sourceChange(store, id) {
  if (!ID.test(String(id))) return Promise.resolve(fail('invalid_input'));
  return store.transaction(repo => ({ ok: true, change: repo.getSourceChange(id) }), { write: false });
}

export function sourceHistory(store, id, { after_seq = 0, limit = 50 } = {}) {
  if (!ID.test(String(id)) || !Number.isSafeInteger(after_seq) || after_seq < 0 ||
      !Number.isInteger(limit) || limit < 1 || limit > 100) return Promise.resolve(fail('invalid_input'));
  return store.transaction(repo => ({ ok: true, events: repo.listSourceEvents(id, { after_seq, limit }) }), { write: false });
}
