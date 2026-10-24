import test from 'node:test';
import assert from 'node:assert/strict';
import {launchSandboxedOpenCode} from '../server/runners/acp-sandbox-launcher.mjs';
const args={workspaceId:'ws_ABCDEFGHIJKLMNOP',worktreeId:'wt_ABCDEFGHIJKLMNOP',
 admission:{issue:'memolabs-dev/memo-orbit#174'}};
const row={workspace_id:args.workspaceId,issue_ref:args.admission.issue,status:'active',path:'/tmp/fake'};
function fixture(changes={}){
 let spawns=0;
 const rt={host:'mac',readOnly:false,stateDir:'/tmp/state',catalogOptions:{},
  store:()=>({transaction:async fn=>fn({getWorktree:()=>row})})};
 const base={
  verify:async()=>({ok:true,issue:args.admission.issue,
   workspace_id:args.workspaceId,worktree_id:args.worktreeId}),
  inspect:async()=>({ok:true}),findBinary:async()=>({ok:true,binary:'/usr/bin/true'}),
  spawnProcess:()=>{spawns++;throw Error('synthetic spawn');}
 };
 return {rt,opts:{...base,...changes},spawns:()=>spawns};
}
test('refuses non Mac and read-only before inspecting the agent',async()=>{
 const f=fixture();
 await assert.rejects(launchSandboxedOpenCode({...f.rt,host:'vps'},args,f.opts),/acp_launch_denied/);
 await assert.rejects(launchSandboxedOpenCode({...f.rt,readOnly:true},args,f.opts),/acp_launch_denied/);
 assert.equal(f.spawns(),0);
});
test('refuses changed lease and foreign worktree before any executable',async()=>{
 const f=fixture({verify:async()=>({ok:false,error:'stale_lease'})});
 await assert.rejects(launchSandboxedOpenCode(f.rt,args,f.opts),/acp_lease_changed/);
 const wrong=fixture();
 await assert.rejects(launchSandboxedOpenCode({...wrong.rt,store:()=>({transaction:async fn=>fn({getWorktree:()=>({...row,workspace_id:'ws_OTHER'})})})},args,wrong.opts),/acp_worktree_changed/);
 assert.equal(f.spawns()+wrong.spawns(),0);
});
test('refuses changed git link and missing binary',async()=>{
 const f=fixture({inspect:async()=>({ok:false,error:'worktree_link_changed'})});
 await assert.rejects(launchSandboxedOpenCode(f.rt,args,f.opts),/acp_worktree_changed/);
 const missing=fixture({findBinary:async()=>({ok:false,error:'opencode_unavailable'})});
 await assert.rejects(launchSandboxedOpenCode(missing.rt,args,missing.opts),/acp_binary_unavailable/);
});
