import test from 'node:test';
import assert from 'node:assert/strict';
import {launchSandboxedOpenCode} from '../server/runners/acp-sandbox-launcher.mjs';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

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


test('registered Mac worktree handshake and session/new occur before launch returns ready', { skip: process.platform !== 'darwin' }, async () => {
 const root=mkdtempSync(join(tmpdir(),'acp-launch-test-'));
 const worktree=join(root,'worktree'), stateDir=join(root,'state');
 const {mkdirSync}=await import('node:fs');
 mkdirSync(worktree);mkdirSync(stateDir);
 const workspaceId='ws_ABCDEFGHIJKLMNOP',worktreeId='wt_ABCDEFGHIJKLMNOP';
 const issue='memolabs-dev/memo-orbit#174';
 let seen=[],killed=false;
 const peer=new EventEmitter();
 peer.pid=12003;peer.exitCode=null;peer.signalCode=null;
 peer.stdin=new PassThrough();peer.stdout=new PassThrough();peer.stderr=new PassThrough();
 peer.kill=signal=>{
  if(killed)return false;
  killed=true;peer.signalCode=signal;
  queueMicrotask(()=>peer.emit('close',null,signal));
  return true;
 };
 let buffer='';
 peer.stdin.on('data',chunk=>{
  buffer+=String(chunk);
  while(buffer.includes('\n')){
   const index=buffer.indexOf('\n');
   const msg=JSON.parse(buffer.slice(0,index));
   buffer=buffer.slice(index+1);
   seen.push(msg);
   if(msg.method==='initialize')peer.stdout.write(JSON.stringify({
    jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1,agentCapabilities:{}}
   })+'\n');
   if(msg.method==='session/new')peer.stdout.write(JSON.stringify({
    jsonrpc:'2.0',id:msg.id,result:{sessionId:'test-session'}
   })+'\n');
  }
 });
 const rt={host:'mac',readOnly:false,stateDir,store:()=>({
  transaction:async fn=>fn({getWorktree:()=>({
   workspace_id:workspaceId,issue_ref:issue,status:'active',path:worktree
  })})
 })};
 let managed;
 try{
  managed=await launchSandboxedOpenCode(rt,{
   workspaceId,worktreeId,admission:{issue}
  },{
   inspect:async()=>({ok:true}),findBinary:async()=>({ok:true,binary:'/usr/bin/true'}),
   verify:async()=>({ok:true,workspace_id:workspaceId,worktree_id:worktreeId,issue}),
   spawnProcess:()=>peer
  });
  assert.deepEqual(seen.map(m=>m.method),['initialize','session/new']);
  assert.equal(seen[1].params.cwd,worktree);
  assert.deepEqual(seen[1].params.mcpServers,[]);
  assert.deepEqual(managed.conversation.status(),{state:'session_ready',busy:false});
  assert.equal(killed,false);
 }finally{
  if(managed){
   managed.stop('SIGTERM');
   await managed.exited;
  }
  rmSync(root,{recursive:true,force:true});
 }
});
