import { parseIssueRef, inExpiryWindow } from '../coordinator/issue-lease.mjs';
import { ownsWorkspace, workerFor } from '../coordinator/policy.mjs';
const WT = /^wt_[A-Za-z0-9_-]{8,60}$/;
const WS = /^ws_[A-Za-z0-9_-]{16}$/;
const fail = error => ({ok:false,error});
// #270: admission is not launch authority. Check again immediately before
// spawning and after every renewal. No filesystem path or command is returned.
export async function inspectAcpAdmission({rt,workspaceId,worktreeId,now=Date.now}={}) {
  if(!WS.test(workspaceId??'')||!WT.test(worktreeId??''))return fail('invalid_input');
  if(!rt?.store||!rt?.ledger?.verify)return fail('runtime_unavailable');
  if(rt.host!=='mac')return fail('wrong_host');
  if(rt.readOnly)return fail('read_only');
  let data;
  try {data=await rt.store().transaction(repo=>{
    const ws=repo.getWorkspace(workspaceId),wt=repo.getWorktree(worktreeId);
    if(!ws||!wt||wt.workspace_id!==ws.id)return null;
    return {ws,wt,claims:repo.claimsOf(ws.id,'claimed')};
  },{write:false});}catch{return fail('store_unavailable');}
  if(!data)return fail('unknown_worktree');
  const {ws,wt,claims}=data;
  if(!ownsWorkspace(rt.principal,ws))return fail('forbidden');
  if(ws.status!=='active')return fail('workspace_closed');
  if(wt.status!=='active'||wt.host!==rt.host)return fail('worktree_unavailable');
  if(wt.project_id!==ws.project_id)return fail('project_mismatch');
  const issue=parseIssueRef(wt.issue_ref);
  if(!issue)return fail('no_live_claim');
  const claim=claims.find(c=>c.issue_ref===wt.issue_ref &&
    /^[0-9a-f]{32}$/.test(c.claim_id??'') &&
    /^[0-9a-f]{40}$/.test(c.fence_sha??'') &&
    Date.parse(c.expires_at)>now());
  if(!claim)return fail('no_live_claim');
  if(inExpiryWindow(claim.expires_at,now()))return fail('lease_expiring');
  let result;
  try {result=await rt.ledger.verify(issue,workerFor(ws),claim.claim_id,claim.fence_sha);}
  catch{return fail('ledger_unavailable');}
  if(!result?.ok)return fail(result?.error??'ledger_unavailable');
  return {ok:true,workspace_id:ws.id,worktree_id:wt.id,issue:wt.issue_ref,
    claim_id:claim.claim_id,fence:claim.fence_sha};
}
