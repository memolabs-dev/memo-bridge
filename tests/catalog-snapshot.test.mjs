import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCatalogSnapshot, parseCatalogSnapshot, loadCatalogSnapshot, CATALOG_SCHEMA } from '../server/catalog-snapshot.mjs';
import { listProjects, projectInfo, readProjectRegistry } from '../server/catalog.mjs';
import { registerCatalogTools } from '../server/tools/catalog-tools.mjs';
import { makePrincipal, CAPABILITIES } from '../server/coordinator/policy.mjs';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'memo-catalog-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const names = ['memo-bridge', 'cuesheet', 'uni-protocol'];
  await writeFile(join(root, 'PROJECTS.md'), [
    '# Projects', '## Projets appartenant à Memo Labs',
    '| Name | Path | Kind | Status | Nature | Stack | Vault note |',
    '|---|---|---|---|---|---|---|',
    ...names.map(n => `| ${n} | products/${n} | repo | active | app | TypeScript | Vault/private |`),
    '', '## Dépôts de référence'
  ].join('\n'));
  for (const n of names) await mkdir(join(root, 'products', n), { recursive:true });
  const projects = Array.from({length:68}, (_,i)=>({
    name: names[i] ?? `product-${i}`, kind:'repo', status:'active', nature:'app',
    stack:'TypeScript', local_path:'/Users/private', pathRelative:'../private',
    vaultNote:'secret-vault-data'
  }));
  const snapshot = makeCatalogSnapshot(projects, new Date(NOW).toISOString());
  const snapshotFile = join(root,'snapshot.json');
  await writeFile(snapshotFile,JSON.stringify(snapshot));
  return {root,snapshot,snapshotFile, options:{projectsRoot:root,layoutRoot:root,snapshotFile,now:()=>NOW}};
}

test('snapshot exposes strictly validated metadata, never paths or Vault notes', async t => {
  const {snapshot}=await fixture(t);
  assert.equal(snapshot.schema,CATALOG_SCHEMA);
  assert.equal(snapshot.source_host,'mac');
  assert.equal(snapshot.projects.length,68);
  assert.deepEqual(Object.keys(snapshot.projects[0]).sort(),['kind','name','nature','stack','status']);
  assert.equal(JSON.stringify(snapshot).includes('secret-vault-data'),false);
  assert.equal(JSON.stringify(snapshot).includes('/Users/'),false);
  assert.deepEqual(parseCatalogSnapshot(snapshot,{now:NOW}).projects,snapshot.projects);
});
test('68 Mac project names project onto 3 VPS checkouts without widening coordinator authority', async t => {
  const {options}=await fixture(t);
  const list=await listProjects({},options);
  assert.equal(list.total,68);
  assert.equal(list.count,68);
  assert.equal(list.snapshot.stale,false);
  assert.equal(list.projects.filter(p=>p.metadata_only).length,65);
  assert.equal(list.projects.find(p=>p.name==='memo-bridge').available,true);
  const x=list.projects.find(p=>p.name==='product-4');
  assert.deepEqual([x.available,x.metadata_only,x.path_relative,x.vault_note,x.local_path],[false,true,null,null,undefined]);
  assert.equal((await projectInfo('product-4',options)).error,'unknown_project');
  assert.equal((await readProjectRegistry(options)).count,3);
  assert.equal((await listProjects({search:'product-67'},options)).count,1);
});
test('missing, duplicate, tampered or malformed snapshot fails closed', async t => {
  const {snapshot,snapshotFile,options}=await fixture(t);
  for(const invalid of [
    {...snapshot,projects:[...snapshot.projects,snapshot.projects[0]]},
    {...snapshot,projects:[{...snapshot.projects[0],local_path:'/root/private'}]},
    {...snapshot,generated_at:'invalid'},
    {...snapshot,source_host:'vps'},
    {...snapshot,projects:[{...snapshot.projects[0],name:'../escape'}]}
  ]) assert.throws(()=>parseCatalogSnapshot(invalid,{now:NOW}));
  await writeFile(snapshotFile,JSON.stringify({...snapshot,projects:[...snapshot.projects,snapshot.projects[0]]}));
  const list=await listProjects({},options);
  assert.equal(list.count,3);
  assert.equal(list.snapshot.error,'snapshot_unavailable');
  assert.equal((await listProjects({}, {...options,snapshotFile:join(options.projectsRoot,'missing.json')})).total,3);
});
test('snapshot staleness is visible, future timestamps refused', async t=>{
  const {snapshot,options,snapshotFile}=await fixture(t);
  assert.equal(parseCatalogSnapshot(snapshot,{now:NOW+48*3600000}).stale,true);
  assert.throws(()=>parseCatalogSnapshot(snapshot,{now:NOW-10*60000}));
  const list=await listProjects({}, {...options,now:()=>NOW+48*3600000});
  assert.equal(list.snapshot.stale,true);
  assert.equal(list.projects.find(p=>p.name==='product-4').catalog_stale,true);
  assert.equal((await loadCatalogSnapshot(snapshotFile,{now:NOW})).projects.length,68);
});
test('the OIDC owner sees the whole registry; other remote users retain the allowlist', async t=>{
  const {options}=await fixture(t);
  const policy={configured:true,owner_sub:'owner-123',projects:['memo-bridge']};
  let handler,rt;
  registerCatalogTools({registerTool(name,conf,fn){assert.equal(name,'projects_list');handler=fn;}},
    ()=>rt,{remotePolicy:()=>policy});
  const runtime=(id,enabled)=>({
    principal:makePrincipal(id,[CAPABILITIES.READ]), authorize:()=>true,audit:async()=>{},
    catalogOptions:options,catalogDiscoveryEnabled:enabled
  });
  const visible=async()=>JSON.parse((await handler({})).content[0].text);
  // #312 owner decision of 2026-10-27: the owner's list is his registry, discovery opt-in or not.
  rt=runtime('oidc:owner-123',false);
  const ownerNoDiscovery=await visible();
  assert.ok(ownerNoDiscovery.projects.length > 1, 'the owner is no longer limited to the allowlist');
  assert.ok(ownerNoDiscovery.projects.some(p=>p.name==='memo-bridge'));
  rt=runtime('oidc:owner-123',true);
  const owner=await visible();
  assert.equal(owner.projects.length,68);
  assert.ok(owner.projects.filter(p=>p.available).length>=1);
  rt=runtime('oidc:other',true);
  assert.deepEqual((await visible()).projects.map(p=>p.name),['memo-bridge']);
  rt=runtime('oidc:owner-123',true);
  policy.configured=false;
  assert.equal((await visible()).error,'project_not_allowed');
});
