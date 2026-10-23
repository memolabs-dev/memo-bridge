// Deterministic eligibility gate for a trusted repository-owned landing workflow.
// No mutations, secrets, arbitrary commands, or reliance on a model's approval.
const ALLOWED = new Set(['guillaume-flambard','memo-labs-automation[bot]']);
const OK = new Set(['success']);
export function evaluateLanding(pr,{requiredChecks=[]}={}) {
  const reasons=[];
  if(!pr || typeof pr!=='object') return {eligible:false,reasons:['invalid_pr']};
  if(pr.draft) reasons.push('draft');
  if(pr.state!=='open') reasons.push('not_open');
  if(!ALLOWED.has(pr.author)) reasons.push('untrusted_author');
  if(!pr.headRepo || pr.headRepo!==pr.baseRepo) reasons.push('fork_or_unknown_origin');
  if(pr.baseBranch!=='main') reasons.push('unexpected_base');
  if(!/^[a-f0-9]{40}$/.test(pr.headSha??'')) reasons.push('invalid_head_sha');
  if(pr.holdMerge===true) reasons.push('hold_merge');
  if(pr.approved!==true) reasons.push('acceptance_not_approved');
  if(pr.mergeable!==true) reasons.push('not_mergeable');
  if(pr.reviewRequired&&!pr.reviewApproved) reasons.push('review_required');
  if(pr.unresolvedThreads) reasons.push('unresolved_review');
  if(!Array.isArray(requiredChecks)||requiredChecks.length===0) reasons.push('required_checks_not_configured');
  if(new Set(requiredChecks).size!==requiredChecks.length) reasons.push('duplicate_required_checks');
  for(const name of (Array.isArray(requiredChecks)?requiredChecks:[])) {
    const matching=(pr.checks??[]).filter(c=>c.name===name&&c.headSha===pr.headSha);
    if(matching.length!==1||!OK.has(matching[0].conclusion)) reasons.push('required_check_missing_or_failing:'+name);
  }
  return {eligible:reasons.length===0,reasons,headSha:pr.headSha??null};
}
