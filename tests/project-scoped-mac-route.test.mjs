import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceHostRouter } from '../bridge/workspace-host-router.mjs';

test('Mac-owned project batch creation follows an authenticated Mac workspace across restart',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'host-project-route-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const owner={id:'oidc:alice',client_type:'chatgpt'};
  const stranger={id:'oidc:bob',client_type:'chatgpt'};
  const calls=[];
  const requestAgent=async (host,op)=>{
    calls.push([host,op]);
    return op==='workspace_open' ? {ok:true,workspace:{workspace_id:'ws_CDKFabcde123456',host}} :
      {ok:host==='mac',...(host!=='mac'?{error:'project_not_allowed'}:{})};
  };
  let router=createWorkspaceHostRouter({enabled:true,stateDir:dir,requestAgent});
  assert.equal((await router.call('vps','workspace_open',{args:{host:'mac',project:'clinical-data-knowledge-foundation'},principal:owner})).ok,true);
  router=createWorkspaceHostRouter({enabled:true,stateDir:dir,requestAgent});
  assert.equal((await router.call('vps','batch_create',{args:{project:'clinical-data-knowledge-foundation'},principal:owner})).ok,true);
  assert.equal((await router.call('vps','batch_create',{args:{project:'clinical-data-knowledge-foundation'},principal:stranger})).error,'project_not_allowed');
  assert.deepEqual(calls.map(x=>x[0]),['mac','mac','vps']);
});
