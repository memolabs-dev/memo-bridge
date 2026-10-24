import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagedAcpSupervisor} from '../server/runners/acp-managed-supervisor.mjs';
import {localOwnerId} from '../server/coordinator/policy.mjs';
const workspace_id='ws_ABCDEFGHIJKLMNOP',worktree_id='wt_ABCDEFGHIJKLMNOP';
const issue='memolabs-dev/memo-orbit#174',claim_id='b'.repeat(32);
const expires_at='2026-10-24T18:00:00Z';
function fixture(changes={}){
 let launchCount=0,renewCount=0;let finish;
 const child={stop:()=>finish(),alive:()=>false,exited:new Promise(resolve=>finish=resolve)};
 const rt={host:'mac',readOnly:false,principal:{id:localOwnerId()},now:()=>Date.parse('2026-10-24T17:58:00Z'),
  store:()=>({transaction:async fn=>fn({claimsOf:()=>[{issue_ref:issue,claim_id,fence_sha:'a'.repeat(40),expires_at}]})}),
  coordinator:()=>({taskRenew:async a=>{renewCount++;return{ok:true,claim_id:a.claim_id,fence:a.fence,expires_at}}})};
 const preflight=async()=>({ok:true,workspace_id,worktree_id,issue,lease_expires_at:expires_at});
 const launch=async()=>{launchCount++;return child};
 return {rt,preflight,launch,launchCount:()=>launchCount,renewCount:()=>renewCount,...changes};
}
test('preflight binds verified claim, renews and starts a single controlled process',async()=>{
 const f=fixture();
 const s=createManagedAcpSupervisor(f.rt,f);
 const a=await s.start({workspace_id,worktree_id});
 assert.equal(a.ok,true);
 assert.equal(f.renewCount()>0,true);
 assert.equal(f.launchCount(),1);
 await s.stop(a.session_id);
});
test('changed claim after preflight fails closed',async()=>{
 const f=fixture({preflight:async()=>({ok:true,workspace_id,worktree_id,issue,lease_expires_at:'old'})});
 const s=createManagedAcpSupervisor(f.rt,f);
 assert.equal((await s.start({workspace_id,worktree_id})).error,'stale_lease');
 assert.equal(f.launchCount(),0);
});
test('VPS or non-owner may not construct an execution supervisor',()=>{
 const f=fixture();
 assert.throws(()=>createManagedAcpSupervisor({...f.rt,host:'vps'},f),/mac_owner_required/);
 assert.throws(()=>createManagedAcpSupervisor({...f.rt,principal:{id:'hub:other'}},f),/mac_owner_required/);
 assert.throws(()=>createManagedAcpSupervisor(f.rt,{}),/trusted_launcher_required/);
});
