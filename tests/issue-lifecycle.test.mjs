import test from 'node:test';
import assert from 'node:assert/strict';
import { issueLifecycleDecision, DECISION_CLOSE, DECISION_KEEP_OPEN } from '../server/source-engine/issue-lifecycle.mjs';

function decide(obs = {}) {
  return issueLifecycleDecision(obs);
}

test('PR open: issue stays open', t => {
  const r = decide({ landing_state: 'open' });
  assert.equal(r.decision, DECISION_KEEP_OPEN);
  assert.equal(r.reason, 'PR not submitted or not merged');
  assert.ok(r.evidence.some(e => /landing_state=open/.test(e)));
});

test('CI green but unmerged: issue stays open (CI alone is not acceptance)', t => {
  const r = decide({ landing_state: 'open', ci_state: 'success' });
  assert.equal(r.decision, DECISION_KEEP_OPEN);
  assert.equal(r.reason, 'PR not submitted or not merged');
  assert.ok(r.evidence.some(e => /ci_state=success/.test(e)));
});

test('PR queued for landing: issue stays open', t => {
  const r = decide({ landing_state: 'queued', ci_state: 'success' });
  assert.equal(r.decision, DECISION_KEEP_OPEN);
  assert.equal(r.reason, 'PR queued for landing, not yet merged');
});

test('merged but not deployed: issue stays open (fail closed)', t => {
  const r = decide({ landing_state: 'landed', deployment_state: 'unknown' });
  assert.equal(r.decision, DECISION_KEEP_OPEN);
  assert.equal(r.reason, 'deployment_evidence_missing');
  assert.ok(r.evidence.some(e => /fail closed/.test(e)));
});

test('merged, deployment pending: issue stays open (fail closed)', t => {
  const r = decide({ landing_state: 'landed', deployment_state: 'pending' });
  assert.equal(r.decision, DECISION_KEEP_OPEN);
  assert.equal(r.reason, 'deployment_evidence_missing');
});

test('merged and deployment verified: issue may be closed', t => {
  const r = decide({ landing_state: 'landed', deployment_state: 'verified' });
  assert.equal(r.decision, DECISION_CLOSE);
  assert.equal(r.reason, 'deployment_verified');
  assert.ok(r.evidence.some(e => /deployment verified/.test(e)));
});

test('non-deploy doc-only repo: merge is acceptance evidence, issue may be closed', t => {
  const r = decide({ landing_state: 'landed', isDeployable: false });
  assert.equal(r.decision, DECISION_CLOSE);
  assert.equal(r.reason, 'deployment_not_required');
  assert.ok(r.evidence.some(e => /non-deploy /.test(e)));
});

test('non-deploy repo with no deployment evidence still closes (no deploy required)', t => {
  const r = decide({ landing_state: 'landed', deployment_state: 'unknown', isDeployable: false });
  assert.equal(r.decision, DECISION_CLOSE);
  assert.equal(r.reason, 'deployment_not_required');
});

test('PR closed without merge: issue stays open', t => {
  const r = decide({ landing_state: 'closed' });
  assert.equal(r.decision, DECISION_KEEP_OPEN);
  assert.equal(r.reason, 'PR closed without merge; not a merge');
});

test('reverted / head moved (blocked): issue stays open', t => {
  const r = decide({ landing_state: 'blocked', deployment_state: 'verified' });
  assert.equal(r.decision, DECISION_KEEP_OPEN);
  assert.equal(r.reason, 'PR head moved or superseded; not a stable merge');
});

test('superseded (blocked head): issue stays open even if previously verified', t => {
  const r = decide({ landing_state: 'blocked', ci_state: 'success', deployment_state: 'verified' });
  assert.equal(r.decision, DECISION_KEEP_OPEN);
  assert.equal(r.reason, 'PR head moved or superseded; not a stable merge');
});

test('partial PR (close_issue:false) never closes its parent issue, even when landed', t => {
  const r = decide({ landing_state: 'landed', deployment_state: 'verified', partial: true });
  assert.equal(r.decision, DECISION_KEEP_OPEN);
  assert.equal(r.reason, 'partial_pr_no_close_issue');
  assert.ok(r.evidence.some(e => /partial slice/.test(e)));
});

test('partial PR with no merge evidence still keeps open', t => {
  const r = decide({ landing_state: 'open', partial: true });
  assert.equal(r.decision, DECISION_KEEP_OPEN);
  assert.equal(r.reason, 'partial_pr_no_close_issue');
});

test('no automatic reopen: once merged and verified, the decision is close (not reopen)', t => {
  const r = decide({ landing_state: 'landed', deployment_state: 'verified' });
  assert.equal(r.decision, DECISION_CLOSE);
  assert.notEqual(r.reason, 'deployment_evidence_missing');
});

test('repeats are idempotent: same observation yields the same decision', t => {
  const obs = { landing_state: 'landed', deployment_state: 'verified', isDeployable: true };
  const first = decide(obs);
  const second = decide(obs);
  assert.deepEqual(first, second);
});

test('idempotent across the fail-closed path too', t => {
  const obs = { landing_state: 'landed', deployment_state: 'unknown', isDeployable: true };
  const a = decide(obs);
  const b = decide(obs);
  assert.deepEqual(a, b);
  assert.equal(a.decision, DECISION_KEEP_OPEN);
});

test('invalid landing_state is treated conservatively (open) and kept open', t => {
  const r = decide({ landing_state: 'not_a_state' });
  assert.equal(r.decision, DECISION_KEEP_OPEN);
});

test('invalid deployment_state is treated conservatively (unknown) and fail-closed when landed', t => {
  const r = decide({ landing_state: 'landed', deployment_state: 'maybe' });
  assert.equal(r.decision, DECISION_KEEP_OPEN);
  assert.equal(r.reason, 'deployment_evidence_missing');
});

test('empty input defaults to keep_open (no acceptance evidence)', t => {
  const r = decide({});
  assert.equal(r.decision, DECISION_KEEP_OPEN);
  assert.equal(r.reason, 'PR not submitted or not merged');
});

test('DECISION_CLOSE and DECISION_KEEP_OPEN are the only decisions', () => {
  assert.equal(DECISION_CLOSE, 'close');
  assert.equal(DECISION_KEEP_OPEN, 'keep_open');
});
