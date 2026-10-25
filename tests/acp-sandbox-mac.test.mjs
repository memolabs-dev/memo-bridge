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
  assert.deepEqual(child.acp, {protocolVersion:1}, 'live sandbox handshake succeeded');
 }finally{
  if(child){
   child.stop('SIGTERM');
   await Promise.race([child.exited,new Promise(resolve=>setTimeout(resolve,3000))]);
   assert.equal(child.alive(),false,'sandbox child must exit');
  }
  rmSync(folder,{recursive:true,force:true});
 }
});
