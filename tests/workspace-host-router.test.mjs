import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceHostRouter } from '../bridge/workspace-host-router.mjs';
import { remoteArgs, parseRemoteConfig } from '../bridge/remote-surface.mjs';

const principal = { id: 'oidc:owner123', client_type: 'chatgpt' };
const guest = { id: 'oidc:guest456', client_type: 'chatgpt' };
test('Mac placement stays opt-in; legacy VPS requests are untouched', () => {
  const cfg = { macRuntimeRouting: false };
  assert.equal(remoteArgs('workspace_open', { project: 'cdkf', host: 'mac' }, principal, cfg).args.host, 'vps');
  assert.equal(remoteArgs('workspace_open', { project: 'cdkf', host: 'mac' }, principal, { macRuntimeRouting: true }).args.host, 'mac');
  assert.equal(remoteArgs('workspace_open', { project: 'cdkf' }, principal, { macRuntimeRouting: true }).args.host, 'vps');
  assert.equal(parseRemoteConfig({owner_sub:'owner123',allowed_client_ids:['client'],mac_runtime_routing:'enabled'}).macRuntimeRouting, true);
  assert.throws(() => parseRemoteConfig({owner_sub:'owner123',allowed_client_ids:['client'],mac_runtime_routing:'true'}), /mac_runtime_routing/);
});
test('without opt-in no Mac route can be persisted or used', async () => {
  const calls = [];
  const route = createWorkspaceHostRouter({requestAgent:async(host)=>{calls.push(host);return {ok:true}}});
  await route.call('vps','workspace_open',{args:{host:'mac'},principal});
  assert.deepEqual(calls,['vps']);
  assert.equal(route.bindingsCount(),0);
  assert.throws(()=>createWorkspaceHostRouter({enabled:true,requestAgent:async()=>({ok:true})}),/durable hub state/);
});
test('accepted Mac workspace, worktree and job retain host affinity across hub restart', async t => {
  const dir = await mkdtemp(join(tmpdir(),'mac-host-route-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls = [];
  const requestAgent = async (host,op) => {
    calls.push([host,op]);
    if(host !== 'mac') return {ok:false,error:'wrong_host'};
    if(op==='workspace_open') return {ok:true,workspace:{workspace_id:'ws_abcdEFGH012345',host:'mac'}};
    if(op==='worktree_create') return {ok:true,worktree:{worktree_id:'wt_abcdEFGH012345',host:'mac'}};
    if(op==='jobs_submit') return {ok:true,job:{job_id:'job_abcdEFGH012345',host:'mac'}};
    return {ok:true};
  };
  let route=createWorkspaceHostRouter({enabled:true,stateDir:dir,requestAgent});
  assert.equal((await route.call('vps','workspace_open',{args:{host:'mac',project:'cdkf'},principal})).ok,true);
  assert.equal((await route.call('vps','task_claim',{args:{workspace_id:'ws_abcdEFGH012345'},principal})).ok,true);
  assert.equal((await route.call('vps','worktree_create',{args:{workspace_id:'ws_abcdEFGH012345'},principal})).ok,true);
  assert.equal((await route.call('vps','jobs_submit',{args:{workspace_id:'ws_abcdEFGH012345',worktree_id:'wt_abcdEFGH012345'},principal})).ok,true);
  route=createWorkspaceHostRouter({enabled:true,stateDir:dir,requestAgent});
  assert.equal(route.bindingsCount(),3);
  assert.equal((await route.call('vps','job_status',{args:{job_id:'job_abcdEFGH012345'},principal})).ok,true);
  assert.equal((await route.call('vps','worktree_status',{args:{worktree_id:'wt_abcdEFGH012345'},principal})).ok,true);
  assert.ok(calls.every(([host])=>host==='mac'));
});
test('a foreign principal never gets to follow the owner Mac workspace route',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mac-host-foreign-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls=[];
  const route=createWorkspaceHostRouter({enabled:true,stateDir:dir,requestAgent:async(host,op)=>{
    calls.push([host,op]);return {ok:true,workspace:{host:'mac',workspace_id:'ws_abcdEFGH012345'}};
  }});
  assert.equal((await route.call('vps','workspace_open',{args:{host:'mac'},principal})).ok,true);
  assert.equal((await route.call('vps','workspace_status',{args:{workspace_id:'ws_abcdEFGH012345'},principal:guest})).error,'workspace_other_principal');
  assert.deepEqual(calls,[['mac','workspace_open']]);
});
test('offline Mac fails closed and never creates a binding',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mac-host-offline-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const route=createWorkspaceHostRouter({enabled:true,stateDir:dir,requestAgent:async()=>({ok:false,error:'host_offline'})});
  assert.equal((await route.call('vps','workspace_open',{args:{host:'mac'},principal})).error,'host_offline');
  assert.equal(route.bindingsCount(),0);
});
