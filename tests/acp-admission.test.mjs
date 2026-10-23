import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectAcpAdmission} from '../server/runners/acp-admission.mjs';
import {localOwnerPrincipal} from '../server/coordinator/policy.mjs';
const workspaceId='ws_0123456789ABCDEF',worktreeId='wt_0123456789ABCDEF';
const now=Date.parse('2026-10-23T22:00:00Z');
function fixture(){
 const ws={id:workspaceId,principal:'local:memo',project_id:'memo-orbit',status:'active',host:'mac'};
 const wt={id:worktreeId,workspace_id:workspaceId,project_id:'memo-orbit',status:'active',host:'mac',issue_ref:'memolabs-dev/memo-orbit#174'};
 const claim={issue_ref:wt.issue_ref,claim_id:'b'.repeat(32),fence_sha:'a'.repeat(40),expires_at:new Date(now+300000).toISOString()};
 let checked=0;
 const rt={host:'mac',readOnly:false,principal:localOwnerPrincipal({USER:'memo'}),store:()=>({transaction:async f=>f({getWorkspace:()=>ws,getWorktree:()=>wt,claimsOf:()=>[claim]})}),ledger:{verify:async()=>{checked++;return {ok:true}}}};
 return {ws,wt,claim,rt,checked:()=>checked};
}
const inspect=h=>inspectAcpAdmission({rt:h.rt,workspaceId,worktreeId,now:()=>now});
test('checks ledger before admission; never returns paths',async()=>{
 const h=fixture(),r=await inspect(h);
 assert.equal(r.ok,true);assert.equal(h.checked(),1);
 assert.equal('path' in r,false);assert.equal('argv' in r,false);
});
test('fails closed on host, readonly and bad IDs',async()=>{
 const h=fixture();h.rt.host='vps';assert.equal((await inspect(h)).error,'wrong_host');
 h.rt.host='mac';h.rt.readOnly=true;assert.equal((await inspect(h)).error,'read_only');
 h.rt.readOnly=false;assert.equal((await inspectAcpAdmission({rt:h.rt,workspaceId:'../../',worktreeId})).error,'invalid_input');
});
test('fails closed on expired or revoked lease and wrong project',async()=>{
 const h=fixture();h.claim.expires_at=new Date(now+10000).toISOString();
 assert.equal((await inspect(h)).error,'lease_expiring');
 h.claim.expires_at=new Date(now-100).toISOString();assert.equal((await inspect(h)).error,'no_live_claim');
 h.claim.expires_at=new Date(now+300000).toISOString();h.wt.project_id='wrong';
 assert.equal((await inspect(h)).error,'project_mismatch');
 h.wt.project_id='memo-orbit';h.rt.ledger.verify=async()=>({ok:false,error:'stale_lease'});
 assert.equal((await inspect(h)).error,'stale_lease');
});
test('fails closed on foreign worktree and closed workspace',async()=>{
 const h=fixture();h.ws.status='closed';assert.equal((await inspect(h)).error,'workspace_closed');
 h.ws.status='active';h.wt.workspace_id='ws_unknown_session';
 assert.equal((await inspect(h)).error,'unknown_worktree');
});
