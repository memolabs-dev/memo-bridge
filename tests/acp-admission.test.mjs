import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localOwnerId } from '../server/coordinator/policy.mjs';
import { checkAcpAdmission, inspectManagedWorktree } from '../server/runners/acp-admission.mjs';

const now = Date.parse('2026-10-23T20:00:00Z');
const worktree_id = 'wt_ABCDEFGHIJKLMNOP';
const workspace_id = 'ws_ABCDEFGHIJKLMNOP';
function fixture() {
  const workspace = {id:workspace_id,principal:localOwnerId(),project_id:'memo-bridge',host:'mac',status:'active'};
  const row = {id:worktree_id,workspace_id,project_id:'memo-bridge',host:'mac',status:'active',issue_ref:'memolabs-dev/memo-bridge#270',branch:'agent/270',path:'/not/exposed'};
  const claim = {claim_id:'1'.repeat(32),fence_sha:'a'.repeat(40),issue_ref:row.issue_ref,
    expires_at:new Date(now+600_000).toISOString()};
  const rt={readOnly:false,host:'mac',principal:{id:localOwnerId()},now:()=>now,catalogOptions:{},
    store:()=>({transaction:fn=>fn({
      getWorktree:()=>row,getWorkspace:()=>workspace,claimsOf:()=>[claim]
    })}),ledger:{forOwner:()=>({verify:async()=>({ok:true})})}};
  const deps={inspect:async()=>({ok:true}),findBinary:async()=>({ok:true,binary:'/private/fixed/opencode'})};
  return {rt,row,workspace,claim,deps};
}
test('approved local owner + verified lease can inspect a known worktree (no paths returned)',async()=>{
  const f=fixture();const r=await checkAcpAdmission(f.rt,{worktree_id,workspace_id},f.deps);
  assert.equal(r.ok,true);assert.equal(r.launch,'not_started');
  assert.equal(JSON.stringify(r).includes('/private'),false);
});
test('principal, platform and read-only are denied BEFORE ledger or filesystem',async()=>{
  for(const bad of [{readOnly:true},{host:'vps'},{principal:{id:'hub:owner'}}]){
    const f=fixture();Object.assign(f.rt,bad);
    f.deps.inspect=async()=>{throw Error('should not inspect');};
    assert.equal((await checkAcpAdmission(f.rt,{worktree_id},f.deps)).error,'forbidden');
  }
});
test('wrong worktree, workspace and missing lease fail closed',async()=>{
  const f=fixture();
  assert.equal((await checkAcpAdmission(f.rt,{worktree_id:'wt_wrong'},f.deps)).error,'invalid_worktree');
  assert.equal((await checkAcpAdmission(f.rt,{worktree_id,workspace_id:'ws_other'},f.deps)).error,'workspace_other_session');
  f.rt.store=()=>({transaction:fn=>fn({getWorktree:()=>f.row,getWorkspace:()=>f.workspace,claimsOf:()=>[]})});
  assert.equal((await checkAcpAdmission(f.rt,{worktree_id},f.deps)).error,'no_live_claim');
});
test('expired lease, unverifiable ledger and missing binary are denied',async()=>{
  const f=fixture();f.claim.expires_at=new Date(now+30_000).toISOString();
  assert.equal((await checkAcpAdmission(f.rt,{worktree_id},f.deps)).error,'lease_expiring');
  f.claim.expires_at=new Date(now+600_000).toISOString();
  f.rt.ledger.forOwner=()=>({verify:async()=>({ok:false,error:'stale_lease'})});
  assert.equal((await checkAcpAdmission(f.rt,{worktree_id},f.deps)).error,'stale_lease');
  f.rt.ledger.forOwner=()=>({verify:async()=>({ok:true})});
  f.deps.findBinary=async()=>({ok:false,error:'opencode_unavailable'});
  assert.equal((await checkAcpAdmission(f.rt,{worktree_id},f.deps)).error,'opencode_unavailable');
});
test('mirror changing during remote verification blocks admission',async()=>{
  const f=fixture();
  f.rt.ledger.forOwner=()=>({verify:async()=>{f.claim.fence_sha='b'.repeat(40);return {ok:true};}});
  assert.equal((await checkAcpAdmission(f.rt,{worktree_id},f.deps)).error,'stale_lease');
});
test('a symlinked worktree or forged .git link is refused',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-acp-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const repo=join(root,'repo');const wt=join(root,'worktree');const git=join(repo,'.git');
  mkdirSync(join(git,'worktrees','test'),{recursive:true});mkdirSync(wt);
  writeFileSync(join(wt,'.git'),`gitdir: ${join(git,'worktrees','test')}\n`);
  writeFileSync(join(git,'worktrees','test','HEAD'),'ref: refs/heads/agent/270\n');
  const row={path:wt,project_id:'memo-bridge',branch:'agent/270',issue_ref:'memolabs-dev/memo-bridge#270'};
  const lookup=async()=>({ok:true,project:{local_path:repo}});
  assert.equal((await inspectManagedWorktree(row,{lookup})).ok,true);
  writeFileSync(join(git,'worktrees','test','HEAD'),'ref: refs/heads/main\n');
  assert.equal((await inspectManagedWorktree(row,{lookup})).error,'branch_changed');
  writeFileSync(join(git,'worktrees','test','HEAD'),'ref: refs/heads/agent/270\n');
  writeFileSync(join(wt,'.git'),`gitdir: ${join(root,'foreign','worktrees','test')}\n`);
  assert.equal((await inspectManagedWorktree(row,{lookup})).error,'worktree_link_changed');
  const other=join(root,'aliased');symlinkSync(wt,other);
  assert.equal((await inspectManagedWorktree({...row,path:other},{lookup})).error,'worktree_link_changed');
});
