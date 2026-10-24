// Policy composition for a supervised ACP process. A trusted Mac launcher
// is injected by the runner; there are no request-supplied executables, paths
// or environment values. Never return claim secrets through public MCP tools.
import {checkAcpAdmission} from './acp-admission.mjs';
import {createAcpProcessSupervisor} from './acp-process-supervisor.mjs';
import {localOwnerId} from '../coordinator/policy.mjs';
const fail=error=>({ok:false,error});

export function createManagedAcpSupervisor(rt,{launch,preflight=checkAcpAdmission,
  createSupervisor=createAcpProcessSupervisor}={}){
 if(!rt||typeof launch!=='function')throw new TypeError('trusted_launcher_required');
 if(rt.host!=='mac'||rt.readOnly||rt.principal?.id!==localOwnerId())
  throw new TypeError('mac_owner_required');
 const admit=async ({workspace_id,worktree_id})=>{
  const ready=await preflight(rt,{workspace_id,worktree_id});
  if(!ready?.ok)return ready??fail('admission_unavailable');
  // Bind preflight to the specific local claim. A race with another agent
  // between verification and this read must fail before process creation.
  const bound=await rt.store().transaction(repo=>{
   const claims=repo.claimsOf(ready.workspace_id,'claimed');
   const claim=claims.find(c=>c.issue_ref===ready.issue &&
     c.expires_at===ready.lease_expires_at);
   return claim?{claim_id:claim.claim_id,fence:claim.fence_sha}:null;
  },{write:false});
  return bound?{...ready,...bound}:fail('stale_lease');
 };
 const renew=async a=>{
  const remaining=Date.parse(a.lease_expires_at)-rt.now();
  if(!Number.isFinite(remaining)||remaining<=0)return fail('stale_lease');
  // Verify on every monitor tick but heartbeat only near expiry: avoid
  // hammering the GitHub ledger with an unnecessary write every 10 seconds.
  if(remaining>180_000)return {ok:true,claim_id:a.claim_id,fence:a.fence,
    expires_at:a.lease_expires_at};
  const result=await rt.coordinator().taskRenew({
   workspace_id:a.workspace_id,issue:a.issue,claim_id:a.claim_id,
   fence:a.fence,ttl_seconds:300
  });
  return result?.ok&&result.claim_id===a.claim_id?result:
   fail(result?.error??'stale_lease');
 };
 return createSupervisor({admit,renew,launch});
}
