// Launch adapter restricted to a registered, lease-bound worktree on macOS.
// No caller-supplied executable, argv, cwd, env or user credentials.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { checkAcpAdmission, findOpenCode, inspectManagedWorktree } from './acp-admission.mjs';
import { sandboxCommand, sandboxMode, sandboxPaths, jobEnvironment } from './sandbox.mjs';
import { projectInfo } from '../catalog.mjs';
import { initializeAcp } from './acp-initialize.mjs';

export async function launchSandboxedOpenCode(rt, {workspaceId,worktreeId,admission}, {
  spawnProcess=spawn, findBinary=findOpenCode, inspect=inspectManagedWorktree,
  verify=checkAcpAdmission
}={}){
 if(rt?.readOnly || rt?.host!=='mac')throw Error('acp_launch_denied');
 if(!/^wt_[A-Za-z0-9_-]{16}$/.test(worktreeId??'') ||
    !/^ws_[A-Za-z0-9_-]{16}$/.test(workspaceId??'') ||
    !isAbsolute(rt.stateDir??''))throw Error('acp_launch_denied');
 // No spawn before the final ledger check: a preflight result is NOT a grant.
 const verified=await verify(rt,{workspace_id:workspaceId,worktree_id:worktreeId});
 if(!verified?.ok || verified.issue!==admission.issue ||
   verified.workspace_id!==workspaceId || verified.worktree_id!==worktreeId)
   throw Error('acp_lease_changed');
 const row=await rt.store().transaction(repo=>repo.getWorktree(worktreeId),{write:false});
 if(!row || row.workspace_id!==workspaceId || row.issue_ref!==admission.issue ||
   row.status!=='active')throw Error('acp_worktree_changed');
 const integrity=await inspect(row,{lookup:name=>projectInfo(name,rt.catalogOptions)});
 if(!integrity?.ok)throw Error('acp_worktree_changed');
 const bin=await findBinary();
 if(!bin?.ok)throw Error('acp_binary_unavailable');
 // The safe canary policy blocks all remote networking and home credentials;
 // production model prompts need a separately reviewed scoped provider transport.
 const mode=sandboxMode({...process.env,MEMO_BRIDGE_JOB_SANDBOX:'on'});
 if(!mode.ok||mode.mode!=='seatbelt')throw Error('acp_sandbox_required');
 // Cross-stdio-process reservation: O_EXCL is atomic on the local Mac.
 // A crash leaves the file behind and deliberately blocks relaunch until
 // operator inspection, rather than spawning two agents on one lease.
 const lockDir=join(rt.stateDir,'acp-process-locks');
 mkdirSync(lockDir,{recursive:true,mode:0o700});
 const lockPath=join(lockDir,worktreeId+'.lock');
 let lockFd;
 try{lockFd=openSync(lockPath,'wx',0o600);}
 catch{throw Error('acp_worktree_already_running');}
 closeSync(lockFd);
 let ownsLock=true;
 const releaseLock=()=>{
  if(!ownsLock)return;
  ownsLock=false;
  try{unlinkSync(lockPath);}catch{}
 };
 let root=null,child=null,exited=null;
 try{
  root=mkdtempSync(join(tmpdir(),'memo-acp-'));
  const home=join(root,'home'),tmp=join(root,'tmp');
  mkdirSync(home,{mode:0o700});mkdirSync(tmp,{mode:0o700});
  const env=jobEnvironment(process.env,{jobId:'acp',home,tmp});
  env.OPENCODE_CONFIG_CONTENT=JSON.stringify({
   plugin:[],permission:{'*':'deny'},autoupdate:false
  });
  const paths=sandboxPaths({worktree:row.path,stateDir:rt.stateDir,
   jobTmp:root,worktreesRoot:process.env.MEMO_BRIDGE_WORKTREES_ROOT,
   path:env.PATH});
  const [command,args]=sandboxCommand([bin.binary,'acp'],paths,{phase:'recipe'});
  child=spawnProcess(command,args,{cwd:row.path,env,
   stdio:['pipe','pipe','pipe'],detached:false,windowsHide:true});
  if(!child || typeof child.kill!=='function' || !child.pid)
   throw Error('acp_spawn_failed');
  // Drain bounded stderr so a noisy agent cannot block on a full pipe.
  // Never send these diagnostics to clients: plugins may print secrets.
  child.stderr?.on('data',()=>{});
  exited=new Promise(resolve=>{
   child.once('error',()=>resolve());
   child.once('close',()=>resolve());
  }).finally(()=>{
   try{if(root)rmSync(root,{recursive:true,force:true});}catch{}
   releaseLock();
  });
  // A spawned binary is not yet a working ACP agent. Confirm real JSON-RPC
  // initialize before the supervisor may report running or begin lease ticks.
  // No provider calls, prompts or internet access are possible here.
  const acp=await initializeAcp({stdin:child.stdin,stdout:child.stdout});
  // Preserve pipes for a trusted future ACP transport. This owner-only
  // canary does not expose them over MCP.
  return {acp,stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,exited,
   alive:()=>child.exitCode===null&&child.signalCode===null,
   stop:signal=>{if(child.exitCode===null&&child.signalCode===null)child.kill(signal)}};
 }catch(error){
  try{child?.kill?.('SIGTERM');}catch{}
  if(child && exited){
   // Never release the lock while a verified child may still be alive.
   // The process-exit hook, not the exception path, owns final cleanup.
   await Promise.race([exited,
     new Promise(resolve=>setTimeout(resolve,1_000))]);
   try{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}catch{}
  }else{
   // Spawn failed before process tracking; no running child owns the lock.
   try{if(root)rmSync(root,{recursive:true,force:true})}catch{}
   releaseLock();
  }
  throw error;
 }
}
