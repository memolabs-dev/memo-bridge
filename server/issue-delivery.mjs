// Pure, conservative issue-delivery lifecycle projection.
// It makes no API mutations; the caller must verify sources before applying transitions.
const states=['triage','ready','claimed','pr_open','merged','deployed_verified','done'];
export function assessIssueDelivery({issue,prs=[],deployment=null,policy=null,acceptance=null}={}) {
 if(!issue||!Number.isInteger(issue.number))throw new Error('invalid_issue');
 const links=prs.filter(pr=>Array.isArray(pr.linked_issues)&&pr.linked_issues.includes(issue.number));
 const completed=links.filter(pr=>pr.merged_at && pr.state==='closed');
 const partial=completed.some(pr=>pr.partial===true || pr.close_issue===false);
 const latest=completed.sort((a,b)=>Date.parse(b.merged_at)-Date.parse(a.merged_at))[0];
 const active=links.some(pr=>pr.state==='open');
 let stage='triage',reason='requires_triage',closeAllowed=false;
 if(issue.state==='closed')return {stage:'done',reason:'closed_observed_not_deployment_proof',closeAllowed:false,linked_prs:links.map(p=>p.number),evidence:[]};
 if(issue.ready) {stage='ready';reason='ready_for_claim'}
 if(issue.claimed) {stage='claimed';reason='active_claim'}
 if(active) {stage='pr_open';reason='review_in_progress'}
 if(latest){stage='merged';reason='merge_not_deployment'}
 const mergeSha=latest?.merge_commit_sha;
 const proof=deployment?.verified===true && deployment?.merge_commit_sha===mergeSha &&
   Boolean(mergeSha) && typeof deployment?.receipt_ref==='string' && deployment.receipt_ref.length>0 &&
   typeof deployment?.environment==='string' && deployment.environment.length>0;
 const noDeploy=policy?.type==='no_deployment' && policy?.verified===true &&
   typeof policy.source_ref==='string' && policy.source_ref.length>0;
 const accepted=acceptance?.passed===true && typeof acceptance?.evidence_ref==='string' && acceptance.evidence_ref.length>0;
 if(latest && proof) {stage='deployed_verified';reason='deployment_receipt_validated'}
 else if(latest && noDeploy){stage='deployed_verified';reason='no_deployment_policy_verified'}
 if(stage==='deployed_verified' && !partial && accepted && !active) {
   closeAllowed=true;reason='eligible_for_closure_with_evidence';
 }
 if(partial){closeAllowed=false;reason='partial_delivery_requires_followup'}
 const evidence=[latest?.html_url,proof?deployment.receipt_ref:null,noDeploy?policy.source_ref:null,accepted?acceptance.evidence_ref:null].filter(Boolean);
 return {stage,reason,closeAllowed,linked_prs:links.map(p=>p.number),evidence};
}
export function lifecycleTransition(current,next) {
 if(!states.includes(current)||!states.includes(next))return {allowed:false,reason:'unknown_state'};
 if(states.indexOf(next)<states.indexOf(current))return {allowed:false,reason:'regression_requires_manual_review'};
 return {allowed:states.indexOf(next)<=states.indexOf(current)+1,
   reason:states.indexOf(next)<=states.indexOf(current)+1?'ok':'missing_intermediate_evidence'};
}
