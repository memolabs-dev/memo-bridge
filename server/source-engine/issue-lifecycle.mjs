// Source Engine: issue lifecycle reconciliation decision.
// Safe rules for issue -> claimed -> PR submitted -> merged -> verified deployed -> issue closed.
// Never treats task_complete or PR push as done. Never reopens an issue without an explicit policy.
// A partial PR (close_issue:false) never closes its parent issue.
//
// This is a pure function: it inspects observed state and returns a decision. It performs no
// GitHub write, no label, no comment and no merge. The caller (a validated, idempotent
// reconciler or an operator) decides whether to act on the recommendation.
const LANDING_OPEN = 'open';
const LANDING_QUEUED = 'queued';
const LANDING_BLOCKED = 'blocked';
const LANDING_LANDED = 'landed';
const LANDING_CLOSED = 'closed';

const DEPLOYMENT_UNKNOWN = 'unknown';
const DEPLOYMENT_PENDING = 'pending';
const DEPLOYMENT_VERIFIED = 'verified';
const DEPLOYMENT_NOT_REQUIRED = 'not_required';

const fail = error => ({ ok: false, error, decision: 'keep_open', evidence: [] });

const DECISION_CLOSE = 'close';
const DECISION_KEEP_OPEN = 'keep_open';

// Validates a single landing_state observation.
function validLanding(v) {
  return ['open', 'queued', 'blocked', 'landed', 'closed'].includes(v);
}

// Validates a single deployment_state observation.
function validDeployment(v) {
  return ['unknown', 'pending', 'verified', 'not_required'].includes(v);
}

// Normalize and validate inputs, returning a clean observation or a refusal.
function normalize({
  landing_state = 'open',
  ci_state = 'unknown',
  deployment_state = 'unknown',
  isDeployable = true,
  partial = false
} = {}) {
  const ls = typeof landing_state === 'string' && validLanding(landing_state) ? landing_state : 'open';
  const cs = typeof ci_state === 'string' && ['unknown', 'pending', 'success', 'failed'].includes(ci_state) ? ci_state : 'unknown';
  const ds = typeof deployment_state === 'string' && validDeployment(deployment_state) ? deployment_state : 'unknown';
  return { landing_state: ls, ci_state: cs, deployment_state: ds, isDeployable: isDeployable === true, partial: partial === true };
}

/**
 * issueLifecycleDecision decides whether an Issue may be closed based on observed
   evidence across its lifecycle: PR submitted, CI, merge, deployment verification.
 *
 * @param {object} obs
 * @param {string} obs.landing_state - open | queued | blocked | landed | closed (Source Engine)
 * @param {string} obs.ci_state - unknown | pending | success | failed
 * @param {string} obs.deployment_state - unknown | pending | verified | not_required
 * @param {boolean} obs.isDeployable - false for code-only / doc-only repos with no deployment
 * @param {boolean} obs.partial - true when the tracked PR is a partial slice (close_issue:false)
 * @returns {{ decision: 'close'|'keep_open', reason: string, evidence: string[] }}
 */
export function issueLifecycleDecision({
  landing_state = 'open',
  ci_state = 'unknown',
  deployment_state = 'unknown',
  isDeployable = true,
  partial = false
} = {}) {
  const o = normalize({ landing_state, ci_state, deployment_state, isDeployable, partial });
  const evidence = [`landing_state=${o.landing_state}`, `ci_state=${o.ci_state}`,
    `deployment_state=${o.deployment_state}`, `isDeployable=${o.isDeployable}`,
    `partial=${o.partial}`];

  // Rule 1: a partial PR never closes its parent Issue. Acceptance is incomplete.
  if (o.partial === true) {
    return { decision: DECISION_KEEP_OPEN, reason: 'partial_pr_no_close_issue',
      evidence: [...evidence, 'PR is a partial slice (close_issue:false); Issue stays open'] };
  }

  // Rule 2: PR not merged -> never close. CI green alone is not acceptance evidence.
  if (o.landing_state !== LANDING_LANDED) {
    const reasons = {
      [LANDING_OPEN]: 'PR not submitted or not merged',
      [LANDING_QUEUED]: 'PR queued for landing, not yet merged',
      [LANDING_BLOCKED]: 'PR head moved or superseded; not a stable merge',
      [LANDING_CLOSED]: 'PR closed without merge; not a merge'
    };
    return { decision: DECISION_KEEP_OPEN,
      reason: reasons[o.landing_state] ?? 'PR not merged',
      evidence: [...evidence, `PR not merged (landing_state=${o.landing_state})`] };
  }

  // Rule 3: merged but non-deploy repo (doc-only / code-only). Merge is acceptance evidence.
  if (o.isDeployable === false) {
    return { decision: DECISION_CLOSE, reason: 'deployment_not_required',
      evidence: [...evidence, 'Project is non-deploy / doc-only; merge is acceptance evidence'] };
  }

  // Rule 4: merged and deployment verified -> close.
  if (o.deployment_state === DEPLOYMENT_VERIFIED) {
    return { decision: DECISION_CLOSE, reason: 'deployment_verified',
      evidence: [...evidence, 'PR merged and deployment verified'] };
  }

  // Rule 5: merged but no verified deployment evidence -> fail closed, keep open.
  return { decision: DECISION_KEEP_OPEN, reason: 'deployment_evidence_missing',
    evidence: [...evidence, 'Merge observed but no verified deployment; fail closed'] };
}

export { DECISION_CLOSE, DECISION_KEEP_OPEN,
  LANDING_OPEN, LANDING_QUEUED, LANDING_BLOCKED, LANDING_LANDED, LANDING_CLOSED,
  DEPLOYMENT_UNKNOWN, DEPLOYMENT_PENDING, DEPLOYMENT_VERIFIED, DEPLOYMENT_NOT_REQUIRED };
