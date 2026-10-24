// Opt-in live Mac canary. No provider, network, prompt, GitHub issue or source edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { launchSandboxedOpenCode } from '../server/runners/acp-sandbox-launcher.mjs';

const enabled=process.platform==='darwin' && process.env.MEMO_BRIDGE_REAL_ACP_CANARY==='1';
test('real sandboxed OpenCode responds to ACP initialize and terminates', {skip:!enabled,timeout:20_000}, async()=>{
 const folder=mkdtempSync(join(tmpdir(),'bridge-real-acp-'));
 const workspaceId='ws_ABCDEFGHIJKLMNOP',worktreeId='wt_ABCDEFGHIJKLMNOP',issue='memolabs-dev/memo-orbit#174';
 const rt={host:'mac',readOnly:false,stateDir:join(homedir(),'.local/share/memo-bridge/state'),
  store:()=>({transaction:async fn=>fn({getWorktree:()=>({workspace_id:workspaceId,issue_ref:issue,path:folder,status:'active'})})})};
 let child;
 try{
  child=await launchSandboxedOpenCode(rt,{workspaceId,worktreeId,admission:{issue}},{
   inspect:async()=>({ok:true}),
   // Fixture does not touch GitHub. The separate production admission tests
   // cover live lease and repository Git integrity.
   verify:async()=>({ok:true,workspace_id:workspaceId,worktree_id:worktreeId,issue})
  });
  // A second MCP server on the same host cannot launch the same worktree:
  // the filesystem lock is shared across stdio processes, not just JS state.
  await assert.rejects(launchSandboxedOpenCode(rt,{workspaceId,worktreeId,admission:{issue}},{
   inspect:async()=>({ok:true}),
   verify:async()=>({ok:true,workspace_id:workspaceId,worktree_id:worktreeId,issue})
  }),/acp_worktree_already_running/);
  let output='';
  child.stdout.on('data',chunk=>output=(output+String(chunk)).slice(-4096));
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',
   params:{protocolVersion:1,clientCapabilities:{}}})+'\n');
  for(let i=0;i<40 && !output.includes('"id":1');i++)
   await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(output.includes('"id":1'),true,'ACP initialize response from real binary');
 }finally{
  if(child){
   child.stop('SIGTERM');
   await Promise.race([child.exited,new Promise(resolve=>setTimeout(resolve,3000))]);
   assert.equal(child.alive(),false,'sandbox child must exit');
  }
  rmSync(folder,{recursive:true,force:true});
 }
});
