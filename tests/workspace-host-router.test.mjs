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
  // No host named: the hub router places it (below); the surface no longer forces vps.
  assert.equal(remoteArgs('workspace_open', { project: 'cdkf' }, principal, { macRuntimeRouting: true }).args.host, undefined);
  assert.equal(remoteArgs('workspace_open', { project: 'cdkf', host: 'vps' }, principal, { macRuntimeRouting: true }).args.host, 'vps');
  assert.equal(remoteArgs('workspace_open', { project: 'cdkf', host: 'nas' }, principal, { macRuntimeRouting: true }).args.host, 'vps');
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

// Zero-friction placement (#110): a workspace_open without host follows where the project is registered.
const macOnlyListing = name => ({ ok:true, projects:[{ name, metadata_only:true, source_host:'mac', available:false }] });
function fakeHosts({ listing, mac = 'runtime' } = {}) {
  const calls = [];
  const requestAgent = async (host, op, envelope) => {
    calls.push([host, op, envelope.args?.host]);
    if (host === 'vps' && op === 'projects_list') return listing(envelope.args.search);
    if (host === 'mac' && mac === 'offline') return { ok:false, error:'host_offline' };
    if (host === 'mac' && mac === 'probe') return { ok:false, error:'unsupported_op' };
    if (op === 'workspace_open') return { ok:true, workspace:{ workspace_id:`ws_${host}EFGH012345`, host } };
    return { ok:true };
  };
  return { calls, requestAgent };
}
test('no host: a project registered only on the Mac opens there and keeps its route', async t => {
  const dir = await mkdtemp(join(tmpdir(),'mac-host-infer-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const hosts = fakeHosts({ listing: macOnlyListing });
  const route = createWorkspaceHostRouter({ enabled:true, stateDir:dir, requestAgent:hosts.requestAgent });
  const out = await route.call('vps','workspace_open',{ args:{ project:'emargo' }, principal });
  assert.equal(out.ok, true);
  assert.equal(out.workspace.host, 'mac');
  assert.deepEqual(out.placement, { host:'mac', inferred:true, reason:'project_registered_on_mac_only' });
  assert.deepEqual(hosts.calls, [['vps','projects_list',undefined], ['mac','workspace_open','mac']]);
  assert.equal(route.bindingsCount(), 1);
  assert.equal((await route.call('vps','task_claim',{ args:{ workspace_id:'ws_macEFGH012345' }, principal })).ok, true);
  assert.equal(hosts.calls.at(-1)[0], 'mac');
});
test('no host: a project the VPS has (or does not know) stays on the VPS, unannotated', async t => {
  const dir = await mkdtemp(join(tmpdir(),'mac-host-infer-vps-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  for (const listing of [
    name => ({ ok:true, projects:[{ name, available:true }] }),
    () => ({ ok:true, projects:[] }),
    () => ({ ok:false, error:'project_not_allowed' }),
    name => ({ ok:true, projects:[{ name:`${name}-other`, metadata_only:true, source_host:'mac' }] }),
    () => { throw new Error('agent gone'); }
  ]) {
    const hosts = fakeHosts({ listing });
    const route = createWorkspaceHostRouter({ enabled:true, stateDir:dir, requestAgent:hosts.requestAgent });
    const out = await route.call('vps','workspace_open',{ args:{ project:'cuesheet' }, principal });
    assert.equal(out.workspace.host, 'vps');
    assert.equal(out.placement, undefined);
    assert.deepEqual(hosts.calls.at(-1), ['vps','workspace_open','vps']);
    assert.equal(route.bindingsCount(), 0);
  }
});
test('no host, Mac-only project, Mac offline or probe-only: host_offline, never the VPS, no binding', async t => {
  const dir = await mkdtemp(join(tmpdir(),'mac-host-infer-off-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  for (const mac of ['offline', 'probe']) {
    const hosts = fakeHosts({ listing: macOnlyListing, mac });
    const route = createWorkspaceHostRouter({ enabled:true, stateDir:dir, requestAgent:hosts.requestAgent });
    const out = await route.call('vps','workspace_open',{ args:{ project:'emargo' }, principal });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'host_offline');
    assert.equal(hosts.calls.filter(([host, op]) => host === 'vps' && op === 'workspace_open').length, 0);
    assert.equal(route.bindingsCount(), 0);
  }
});
test('explicit host=mac on a probe-only Mac answers host_offline with the reason', async t => {
  const dir = await mkdtemp(join(tmpdir(),'mac-host-probe-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const hosts = fakeHosts({ listing: macOnlyListing, mac:'probe' });
  const route = createWorkspaceHostRouter({ enabled:true, stateDir:dir, requestAgent:hosts.requestAgent });
  const out = await route.call('vps','workspace_open',{ args:{ project:'emargo', host:'mac' }, principal });
  assert.equal(out.error, 'host_offline');
  assert.match(out.detail, /probe mode/);
  assert.deepEqual(hosts.calls, [['mac','workspace_open','mac']]);
});

// Implicit workspaces (#169): a workspace tool called without workspace_id is resolved by the runtime
// that receives it, so the router must send it to the host where its project lives.
test('implicit task_claim on a Mac-only Issue goes to the Mac, and its workspace is bound to this conversation', async t => {
  const dir = await mkdtemp(join(tmpdir(),'mac-host-implicit-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls = [];
  const requestAgent = async (host, op, envelope) => {
    calls.push([host, op]);
    if (host === 'vps' && op === 'projects_list') return macOnlyListing(envelope.args.search);
    if (host === 'mac' && op === 'task_claim')
      return { ok:true, claim_id:'c1', implicit_workspace:{ workspace_id:'ws_implicitAB1234', project:'emargo', opened:true } };
    return { ok:true };
  };
  const route = createWorkspaceHostRouter({ enabled:true, stateDir:dir, requestAgent });
  const session = 'a'.repeat(32);
  const claimed = await route.call('vps','task_claim',{ args:{ issue:'memolabs-dev/emargo#4' }, principal, clientSession:session });
  assert.equal(claimed.ok, true);
  assert.deepEqual(calls, [['vps','projects_list'], ['mac','task_claim']]);
  assert.equal(route.bindingsCount(), 1);
  // Same conversation, same project, no id: straight to the Mac, no listing needed.
  calls.length = 0;
  await route.call('vps','worktree_create',{ args:{ issue:'memolabs-dev/emargo#4' }, principal, clientSession:session });
  assert.deepEqual(calls, [['mac','worktree_create']]);
  // The bound workspace id follows the Mac after a restart, and never for another principal.
  const again = createWorkspaceHostRouter({ enabled:true, stateDir:dir, requestAgent });
  calls.length = 0;
  await again.call('vps','workspace_status',{ args:{ workspace_id:'ws_implicitAB1234' }, principal });
  assert.deepEqual(calls, [['mac','workspace_status']]);
  assert.equal((await again.call('vps','workspace_status',{ args:{ workspace_id:'ws_implicitAB1234' }, principal:guest })).error,
    'workspace_other_principal');
});
test('implicit calls stay on the VPS for VPS projects, without a hint, and with an explicit workspace_id', async t => {
  const dir = await mkdtemp(join(tmpdir(),'mac-host-implicit-vps-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls = [];
  const requestAgent = async (host, op, envelope) => {
    calls.push([host, op]);
    if (op === 'projects_list') return { ok:true, projects:[{ name:envelope.args.search, available:true }] };
    return { ok:true };
  };
  const route = createWorkspaceHostRouter({ enabled:true, stateDir:dir, requestAgent });
  await route.call('vps','task_claim',{ args:{ issue:'memolabs-dev/cuesheet#2' }, principal });
  await route.call('vps','task_next',{ args:{}, principal });
  await route.call('vps','task_renew',{ args:{ workspace_id:'ws_unknownAB1234', issue:'memolabs-dev/emargo#4' }, principal });
  assert.deepEqual(calls, [['vps','projects_list'], ['vps','task_claim'], ['vps','task_next'], ['vps','task_renew']]);
  assert.equal(route.bindingsCount(), 0);
});
test('implicit call for a Mac-only project with the Mac offline: host_offline, no binding', async t => {
  const dir = await mkdtemp(join(tmpdir(),'mac-host-implicit-off-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const hosts = fakeHosts({ listing: macOnlyListing, mac:'offline' });
  const route = createWorkspaceHostRouter({ enabled:true, stateDir:dir, requestAgent:hosts.requestAgent });
  const out = await route.call('vps','task_next',{ args:{ project:'emargo' }, principal });
  assert.equal(out.error, 'host_offline');
  assert.equal(hosts.calls.filter(([host, op]) => host === 'vps' && op === 'task_next').length, 0);
  assert.equal(route.bindingsCount(), 0);
});
test('task_status, tasks_list and batch_create without a workspace follow a Mac-only project (CDKF#14 refusal, 2026-10-18)', async t => {
  const dir = await mkdtemp(join(tmpdir(),'mac-host-hinted-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls = [];
  const requestAgent = async (host, op, envelope) => {
    calls.push([host, op]);
    if (host === 'vps' && op === 'projects_list')
      return envelope.args.search === 'cuesheet' ? { ok:true, projects:[{ name:'cuesheet', available:true }] } : macOnlyListing(envelope.args.search);
    return { ok:true };
  };
  const route = createWorkspaceHostRouter({ enabled:true, stateDir:dir, requestAgent });
  await route.call('vps','task_status',{ args:{ issue:'memolabs-dev/clinical-data-knowledge-foundation#14' }, principal });
  await route.call('vps','tasks_list',{ args:{ project:'emargo' }, principal });
  await route.call('vps','batch_create',{ args:{ project:'emargo', tasks:[] }, principal });
  await route.call('vps','task_status',{ args:{ issue:'memolabs-dev/cuesheet#2' }, principal });
  assert.deepEqual(calls, [
    ['vps','projects_list'], ['mac','task_status'],
    ['vps','projects_list'], ['mac','tasks_list'],
    ['vps','projects_list'], ['mac','batch_create'],
    ['vps','projects_list'], ['vps','task_status']]);
});

// Owner console T-A2 (D-A2-1): project_create always runs on the Mac runtime, whatever host it names.
test('project_create goes to the Mac when routing is on, and to the runtime it was sent to otherwise', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mac-host-project-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const requestAgent = async (host, op, envelope) => { calls.push([host, op, envelope.args.host]); return { ok: true, project: 'relay-v2' }; };
  const route = createWorkspaceHostRouter({ enabled: true, stateDir: dir, requestAgent });
  assert.equal((await route.call('vps', 'project_create', { args: { name: 'relay-v2', host: 'vps', visibility: 'public' }, principal })).ok, true);
  assert.equal((await route.call('vps', 'project_create', { args: { name: 'relay-v2' }, principal })).ok, true);
  assert.deepEqual(calls.map(c => c[0]), ['mac', 'mac']);
  assert.equal(calls[0][2], 'vps', 'the host argument reaches the Mac unchanged');
  assert.equal(route.bindingsCount(), 0);
  const probe = createWorkspaceHostRouter({ enabled: true, stateDir: dir, requestAgent: async () => ({ ok: false, error: 'unsupported_op' }) });
  assert.equal((await probe.call('vps', 'project_create', { args: { name: 'relay-v2' }, principal })).error, 'host_offline');
  const off = [];
  const legacy = createWorkspaceHostRouter({ requestAgent: async host => { off.push(host); return { ok: true }; } });
  await legacy.call('vps', 'project_create', { args: { name: 'relay-v2' }, principal });
  assert.deepEqual(off, ['vps']);
});

// Repository-scoped GitHub reads (owner console REQ-A1): `repo` is their only key, the discovery
// snapshot exports no git origin, so placement follows the local registry answer. A repository the
// receiving host does not register is asked of the Mac, which holds the owner's private checkouts
// and re-checks its own registry, policy and enrolment. A policy refusal is never retried.
function repoReadHosts({ vps, mac = { ok: true } } = {}) {
  const calls = [];
  const audit = [];
  const requestAgent = async (host, op) => {
    calls.push([host, op]);
    if (host === 'vps') return vps;
    if (mac === 'offline') return { ok: false, error: 'host_offline' };
    if (mac === 'probe') return { ok: false, error: 'unsupported_op' };
    return mac;
  };
  return { calls, audit, requestAgent };
}
async function repoReadRouter(t, hosts, enabled = true) {
  const dir = await mkdtemp(join(tmpdir(), 'mac-host-repo-read-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return createWorkspaceHostRouter({ enabled, stateDir: dir, requestAgent: hosts.requestAgent,
    audit: event => hosts.audit.push(event) });
}
test('a repo-scoped read the local host does not register is answered by the Mac, and journaled', async t => {
  const hosts = repoReadHosts({ vps: { ok: false, error: 'repo_not_registered' },
    mac: { ok: true, repo: 'memolabs-dev/memo-founder-skills', pull_requests: [] } });
  const route = await repoReadRouter(t, hosts);
  const out = await route.call('vps', 'github_pull_requests', { args: { repo: 'memolabs-dev/memo-founder-skills' }, principal });
  assert.equal(out.ok, true);
  assert.equal(out.repo, 'memolabs-dev/memo-founder-skills');
  assert.deepEqual(hosts.calls, [['vps', 'github_pull_requests'], ['mac', 'github_pull_requests']]);
  assert.deepEqual(hosts.audit, [{ event: 'repo_scoped_read_routed_to_mac', op: 'github_pull_requests',
    repo: 'memolabs-dev/memo-founder-skills', principal: 'oidc:owner123', outcome: 'ok' }]);
  assert.equal(route.bindingsCount(), 0);
});
test('the Mac policy decides: its refusal replaces the local repo_not_registered', async t => {
  const hosts = repoReadHosts({ vps: { ok: false, error: 'repo_not_registered' },
    mac: { ok: false, error: 'project_not_allowed' } });
  const route = await repoReadRouter(t, hosts);
  const out = await route.call('vps', 'github_issues', { args: { repo: 'memolabs-dev/emargo' }, principal });
  assert.deepEqual(out, { ok: false, error: 'project_not_allowed' });
  assert.deepEqual(hosts.calls, [['vps', 'github_issues'], ['mac', 'github_issues']]);
  assert.equal(hosts.audit.at(-1).outcome, 'project_not_allowed');
});
test('no repo-scoped retry on a policy refusal, a registered repo, another tool or without the opt-in', async t => {
  for (const vps of [{ ok: false, error: 'project_not_allowed' }, { ok: false, error: 'forbidden' }, { ok: true, count: 0 }]) {
    const hosts = repoReadHosts({ vps, mac: { ok: true } });
    const route = await repoReadRouter(t, hosts);
    const out = await route.call('vps', 'github_checks', { args: { repo: 'memolabs-dev/cuesheet' }, principal });
    assert.equal(out.ok, vps.ok);
    assert.deepEqual(hosts.calls, [['vps', 'github_checks']]);
    assert.deepEqual(hosts.audit, []);
  }
  // github_create_pr is not in the set: it carries a worktree_id and follows its workspace route.
  const cr = repoReadHosts({ vps: { ok: false, error: 'repo_not_registered' }, mac: { ok: true } });
  await (await repoReadRouter(t, cr)).call('vps', 'github_create_pr', { args: { repo: 'memolabs-dev/emargo' }, principal });
  assert.deepEqual(cr.calls, [['vps', 'github_create_pr']]);
  // Without the opt-in the VPS answers exactly as before.
  const off = repoReadHosts({ vps: { ok: false, error: 'repo_not_registered' }, mac: { ok: true } });
  const out = await (await repoReadRouter(t, off, false)).call('vps', 'github_issues', { args: { repo: 'memolabs-dev/emargo' }, principal });
  assert.deepEqual(out, { ok: false, error: 'repo_not_registered' });
  assert.deepEqual(off.calls, [['vps', 'github_issues']]);
  assert.deepEqual(off.audit, []);
});
test('a Mac that cannot answer leaves the local refusal standing, and a malformed repo is never sent', async t => {
  for (const mac of ['offline', 'probe']) {
    const hosts = repoReadHosts({ vps: { ok: false, error: 'repo_not_registered' }, mac });
    const out = await (await repoReadRouter(t, hosts)).call('vps', 'github_workflows', { args: { repo: 'memolabs-dev/emargo' }, principal });
    assert.deepEqual(out, { ok: false, error: 'repo_not_registered' });
    assert.deepEqual(hosts.audit, []);
  }
  const bad = repoReadHosts({ vps: { ok: false, error: 'repo_not_registered' }, mac: { ok: true } });
  const route = await repoReadRouter(t, bad);
  await route.call('vps', 'github_issues', { args: { repo: 'emargo' }, principal });
  await route.call('vps', 'github_issues', { args: {}, principal });
  await route.call('vps', 'github_issues', { args: { repo: 'memolabs-dev/emargo/extra' }, principal });
  assert.deepEqual(bad.calls, [['vps', 'github_issues'], ['vps', 'github_issues'], ['vps', 'github_issues']]);
  assert.deepEqual(bad.audit, []);
});
