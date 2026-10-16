import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { extractInstallationChanges, verifyInstallationWebhook,
  planAutomaticOnboarding } from '../server/onboarding-auto.mjs';
import { ownerApprovedPolicy, reconcileAutoOnboarding } from '../server/onboarding-auto-worker.mjs';

const ORG = 'memolabs-dev';
const ID = 170927025;
const SHA = 'f'.repeat(40);
function payload(action = 'added') {
  const rows = [
    { name: 'rebuild-radar', full_name: ORG + '/rebuild-radar', id: 234001,
      owner: { login: ORG } },
    { name: 'mobile-explorer', full_name: ORG + '/mobile-explorer', id: 234002,
      owner: { login: ORG } }
  ];
  return { action, installation: { account: { login: ORG, type: 'Organization' }, id: ID },
    organization: { login: ORG }, repositories_added: rows, repositories_removed: rows };
}
function change(action = 'added') {
  return extractInstallationChanges({ event: 'installation_repositories',
    payload: payload(action), signatureVerified: true });
}
function proofs() {
  return Object.fromEntries([['rebuild-radar', 234001], ['mobile-explorer',234002]].map(([name,id]) => [
    ORG + '/' + name, {
      repositoryId: id, fullName: ORG + '/' + name, archived: false, private: true,
      installationAccess: true, installationId: ID, defaultBranch: 'main',
      manifestVerified: true, governanceMerged: false, runnerMerged: false,
      landingMerged: false, prChecks: { headSha: SHA, checkedSha: SHA,
        passed: true, pending: false, held: false }
    }
  ]));
}
const catalog = ['rebuild-radar','mobile-explorer'].map(name =>
  ({ name, kind: 'repo', catalog_stale: false }));
const policy = { enabled: true, org: ORG, installationId: ID,
  enrolledRepositories: [ORG+'/rebuild-radar', ORG+'/mobile-explorer'] };
test('verify webhook HMAC in constant-time comparison and reject unauthenticated input', () => {
  const body = JSON.stringify(payload());
  const secret = 'supersecret-supersecret-keys';
  const good = 'sha256=' + createHmac('sha256',secret).update(body).digest('hex');
  assert.equal(verifyInstallationWebhook({ payloadBytes: body, signature: good, secret }), true);
  assert.equal(verifyInstallationWebhook({ payloadBytes: body+'x', signature: good, secret }), false);
  assert.equal(verifyInstallationWebhook({ payloadBytes: body, signature: 'sha256='+'0'.repeat(64), secret }), false);
  assert.equal(extractInstallationChanges({ event: 'installation_repositories', payload: payload(),
    signatureVerified: false }).error, 'webhook_not_verified');
});
test('reject forged organizations, invalid repo origins and duplicate event identities', () => {
  const p = payload(); p.organization.login = 'other';
  assert.equal(extractInstallationChanges({ event:'installation_repositories',payload:p,
    signatureVerified:true }).ok,false);
  const wrong = payload(); wrong.repositories_added[0].full_name='other/rebuild-radar';
  assert.equal(extractInstallationChanges({ event:'installation_repositories',payload:wrong,
    signatureVerified:true }).ok,false);
  const duplicates = payload(); duplicates.repositories_added.push(duplicates.repositories_added[0]);
  assert.equal(extractInstallationChanges({ event:'installation_repositories',
    payload:duplicates, signatureVerified:true }).ok,false);
});
test('candidate missing explicit enrollment is not promoted by a webhook', () => {
  const p = {...policy, enrolledRepositories:[]};
  const result = planAutomaticOnboarding({change:change(),trustedPolicy:p,catalog,proofs:proofs()});
  assert.ok(result.next.every(x=>x.actions.length===0));
  assert.ok(result.next.every(x=>x.blockers.includes('not_in_owner_approved_enrollment')));
});
test('owner may opt in once at org level, but per-repo trusted checks still apply', () => {
  const p={...policy,enrolledRepositories:[], orgWideAutoEnrollment:true};
  const prepared=ownerApprovedPolicy({policy:p,change:change(),proofs:proofs()});
  assert.equal(prepared.enrolledRepositories.length,2);
  const altered=proofs();altered[ORG+'/rebuild-radar'].manifestVerified=false;
  const rejected=ownerApprovedPolicy({policy:p,change:change(),proofs:altered});
  assert.deepEqual(rejected.enrolledRepositories,[ORG+'/mobile-explorer']);
  const exclude={...p,excludedRepositories:[ORG+'/mobile-explorer']};
  const excluded=ownerApprovedPolicy({policy:exclude,change:change(),proofs:proofs()});
  assert.deepEqual(excluded.enrolledRepositories,[ORG+'/rebuild-radar']);
});
test('propose first reviewed governance PR deterministically; event duplicates do not duplicate effects', () => {
  const plan=planAutomaticOnboarding({change:change(),trustedPolicy:policy,catalog,proofs:proofs()});
  assert.equal(plan.action_count,2);
  assert.equal(plan.next[0].actions[0].operation,'propose_governance_pr');
  const second=planAutomaticOnboarding({change:change(),trustedPolicy:policy,catalog,proofs:proofs(),
    completed:plan.next.map(x=>x.actions[0].key)});
  assert.equal(second.action_count,0);
});
test('automatic stages progress only after independently verified governance and runner merges', () => {
  const p=proofs();const repo=ORG+'/rebuild-radar';
  p[repo].governanceMerged=true;
  let a=planAutomaticOnboarding({change:change(),trustedPolicy:policy,catalog,proofs:p});
  assert.equal(a.next[0].actions[0].operation,'propose_runner_pr');
  p[repo].runnerMerged=true;p[repo].runnerOriginVerified=true;
  a=planAutomaticOnboarding({change:change(),trustedPolicy:policy,catalog,proofs:p});
  assert.equal(a.next[0].actions[0].operation,'propose_landing_pr');
  p[repo].landingMerged=true;p[repo].landingPolicyVerified=true;
  p[repo].runnerLive=true;p[repo].leaseEligible=true;
  a=planAutomaticOnboarding({change:change(),trustedPolicy:policy,catalog,proofs:p});
  assert.equal(a.next[0].stage,'active');
  assert.equal(a.next[0].actions.length,0);
});
test('CI wrong head SHA, failing check or hold prevents activation and PR merging', () => {
  const p=proofs();const repo=ORG+'/rebuild-radar';
  Object.assign(p[repo], { governanceMerged:true, runnerMerged:true, runnerOriginVerified:true,
    landingMerged:true,landingPolicyVerified:true,runnerLive:true,leaseEligible:true });
  p[repo].prChecks.checkedSha='a'.repeat(40);
  let a=planAutomaticOnboarding({change:change(),trustedPolicy:policy,catalog,proofs:p});
  assert.equal(a.next[0].stage,'ready');
  assert.ok(a.next[0].blockers.includes('exact_sha_ci_not_green_or_held'));
  assert.equal(a.next[0].actions.length,0);
  p[repo].prChecks.checkedSha=SHA;p[repo].prChecks.held=true;
  a=planAutomaticOnboarding({change:change(),trustedPolicy:policy,catalog,proofs:p});
  assert.equal(a.next[0].actions.length,0);
});
test('removed installation repo suspends future work irrespective of stored permission state', () => {
  const result=planAutomaticOnboarding({change:change('removed'),trustedPolicy:policy,catalog,proofs:proofs()});
  assert.ok(result.next.every(x=>x.stage==='suspended' && x.stop_new_work && x.actions.length===0));
});
test('atomic adapter retries failure and applies at most once per deterministic key', async () => {
  const seen=new Set(), executed=[];let first=true;
  const adapter = {
    reserve:async key => {if(seen.has(key))return false;seen.add(key);return true;},
    propose:async act=>{if(first){first=false;throw Error('network timeout');}return {id:'pr/'+act.key};},
    finish:async (key,receipt)=>executed.push([key,receipt.id]),
    fail:async key=>seen.delete(key)
  };
  const args={change:change(),policy,catalog,proofs:proofs(),adapter,dryRun:false};
  let r=await reconcileAutoOnboarding(args);
  assert.equal(r.executions.filter(x=>x.status==='retryable_error').length,1);
  r=await reconcileAutoOnboarding(args);
  assert.equal(r.executions.filter(x=>x.status==='proposed').length,1);
  r=await reconcileAutoOnboarding(args);
  assert.equal(r.executions.filter(x=>x.status==='already_recorded').length,2);
  assert.equal(executed.length,2);
});
