import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinator } from '../server/coordinator/index.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { openSqliteStore } from '../server/coordinator/store.mjs';
import { tempStateDir, stubProjects, stubLedger, stubRemote } from './helpers/coordinator-fixture.mjs';

const owner = makePrincipal('oidc:owner123', Object.values(CAPABILITIES), {client_type:'chatgpt'});
const remotePolicy={configured:true,projects:['drop'],remote_writes:'enabled',session_binding:'warn',allow_mac_runtime:true};
test('remote workspaces stay on the authenticated host with explicit Mac opt-in', async t => {
  for(const host of ['mac','vps']) {
    const store=openSqliteStore({dir:await tempStateDir(t)});
    t.after(()=>store.close());
    const coordinator=createCoordinator({store,principal:owner,host,ledger:stubLedger(),resolveProject:stubProjects(),
      projectRemote:stubRemote,remotePolicy});
    const local=await coordinator.workspaceOpen({project:'drop',client_type:'chatgpt',host});
    assert.equal(local.ok,true,JSON.stringify(local));
    assert.equal(local.workspace.host,host);
    const cross=await coordinator.workspaceOpen({project:'drop',client_type:'chatgpt',host:host==='mac'?'vps':'mac'});
    assert.equal(cross.error,'host_not_remote_enabled');
    const foreign=await coordinator.workspaceOpen({project:'cuesheet',client_type:'chatgpt',host});
    assert.equal(foreign.error,'project_not_allowed');
  }
});
test('without Mac opt-in, legacy remote coordinator defaults to VPS placement',async t=>{
  const store=openSqliteStore({dir:await tempStateDir(t)});
  t.after(()=>store.close());
  const coordinator=createCoordinator({store,principal:owner,host:'mac',ledger:stubLedger(),resolveProject:stubProjects(),
    projectRemote:stubRemote,remotePolicy:{configured:true,projects:['drop'],remote_writes:'enabled',session_binding:'warn'}});
  const opened=await coordinator.workspaceOpen({project:'drop',client_type:'chatgpt'});
  assert.equal(opened.ok,true,JSON.stringify(opened));
  assert.equal(opened.workspace.host,'vps');
  assert.equal((await coordinator.workspaceOpen({project:'drop',client_type:'chatgpt',host:'mac'})).error,'host_not_remote_enabled');
});
