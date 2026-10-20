import { assessIssueDelivery } from './issue-delivery.mjs';

// Dry-run reconciliation: never mutates GitHub or implies a deploy from merged PR/CI.
export function reconcileDeliveryReport({issues=[],prs=[],deployments={},policies={},acceptances={}}={}) {
 const entries=[];
 for (const issue of issues) {
  const repo=issue.repo;
  const linked=prs.filter(p=>p.repo===repo&&(p.linked_issues??[]).includes(issue.number));
  const key=repo+'#'+issue.number;
  const assessment=assessIssueDelivery({issue,prs:linked,deployment:deployments[key],
    policy:policies[repo],acceptance:acceptances[key]});
  entries.push({issue:key,url:issue.url??null,stage:assessment.stage,reason:assessment.reason,
    suggested_action:assessment.closeAllowed?'review_closure_evidence':
      assessment.stage==='merged'?'verify_deployment':assessment.stage==='pr_open'?'await_review':'triage_or_continue',
    close_eligible:assessment.closeAllowed,evidence:assessment.evidence,linked_prs:assessment.linked_prs});
 }
 return {ok:true,mode:'dry_run',complete:false,
  caveat:'No GitHub writes. Real PR issue linkage, deployment receipts and acceptance source must be verified externally.',
  entries,closure_candidates:entries.filter(e=>e.close_eligible).length};
}
