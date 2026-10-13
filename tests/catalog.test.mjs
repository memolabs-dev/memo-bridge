import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectRegistry, listProjects, projectInfo, projectGitStatus, auditProjectRegistry } from '../server/catalog.mjs';

const HEADER = [
  '# Registry', '## Projets appartenant à Memo Labs',
  '| Name | Path | Kind | Status | Nature | Stack | Vault note |',
  '|---|---|---|---|---|---|---|'
];
async function fixture(t, rows) {
  const root = await mkdtemp(join(tmpdir(), 'memo-catalog-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'PROJECTS.md'),
    [...HEADER, ...rows, '', '## Dépôts de référence', '| skip | skip | repo | active | - | - | - |'].join('\n'));
  return { root, options: { registryFile: join(root, 'PROJECTS.md'), projectsRoot: root } };
}
test('canonical PROJECTS.md drives project list and excludes reference repos', async t => {
  const {root, options} = await fixture(t, [
    '| drop | drop | repo | active | app | Tauri | - |',
    '| kollio-mac | kollio-mac | repo | active | app | Swift | `1-Projects/kollio.md` |'
  ]);
  await mkdir(join(root, 'drop')); await mkdir(join(root, 'kollio-mac'));
  const list = await listProjects({}, options);
  assert.equal(list.total, 2);
  assert.deepEqual(list.projects.map(p=>p.name), ['drop', 'kollio-mac']);
  assert.equal((await projectInfo('drop', options)).project.available, true);
  assert.equal((await listProjects({search:'kollio'}, options)).count, 1);
  assert.equal((await listProjects({status:'parked'}, options)).count, 0);
});
test('registry path traversal, symlink escapes, duplicates and malicious names fail closed', async t => {
  const {root, options} = await fixture(t, [
    '| safe | safe | repo | active | app | JS | - |',
    '| escape | ../outside | repo | active | app | JS | - |',
    '| bad/slug | safe | repo | active | app | JS | - |',
    '| double | safe | repo | active | app | JS | - |',
    '| double | safe | repo | active | app | JS | - |',
    '| symlink-out | link | repo | active | app | JS | - |'
  ]);
  await mkdir(join(root, 'safe'));
  await symlink(tmpdir(), join(root, 'link'));
  const x = await readProjectRegistry(options);
  assert.deepEqual(x.projects.map(p=>p.name), ['safe','double','symlink-out']);
  assert.equal(x.projects.find(p=>p.name==='symlink-out').available, false);
  assert.deepEqual(await projectInfo('../safe',options),{ok:false,error:'invalid_project_name'});
  assert.equal((await projectGitStatus('symlink-out',options)).error,'project_unavailable');
});
test('unknown project and missing registry cannot be used to read arbitrary paths', async t => {
  const {options} = await fixture(t,[]);
  assert.equal((await projectInfo('missing',options)).error,'unknown_project');
  await assert.rejects(readProjectRegistry({...options,registryFile:'/nonexistent/registry.md'}));
});

test('audit flags unregistered repos and aliases without authorizing access', async t => {
  const {root, options} = await fixture(t, [
    '| drop | drop | repo | active | app | Tauri | - |'
  ]);
  await mkdir(join(root, 'drop'));
  await mkdir(join(root, 'emargo')); await mkdir(join(root, 'emargo', '.git'));
  const inventoryFile = join(root, 'inventory.json');
  const aliasesRoot = join(root, 'aliases');
  await mkdir(aliasesRoot);
  await symlink(join(root, 'emargo'), join(aliasesRoot, 'emargo'));
  await writeFile(inventoryFile, JSON.stringify({repos:[{name:'drop'}, {name:'missing-catalogue'}]}));
  const report = await auditProjectRegistry({ ...options, inventoryFile, aliasesRoot });
  assert.equal(report.registered_count, 1);
  assert.deepEqual(report.unregistered.map(x=>x.name), ['emargo','missing-catalogue']);
  assert.equal((await projectInfo('emargo', options)).error,'unknown_project');
});

test('a repository moved into the layout root and linked back from ~/projects stays available', async t => {
  const {root, options} = await fixture(t, [
    '| moved | moved | repo | active | app | JS | - |',
    '| escaped | escaped | repo | active | app | JS | - |'
  ]);
  const layout = join(root, '..', `layout-${Date.now()}`);
  t.after(async () => { await rm(layout, { recursive: true, force: true }); });
  await mkdir(join(layout, 'products', 'moved'), { recursive: true });
  await symlink(join(layout, 'products', 'moved'), join(root, 'moved'));
  const outside = await mkdtemp(join(tmpdir(), 'memo-outside-'));
  t.after(async () => { await rm(outside, { recursive: true, force: true }); });
  await symlink(outside, join(root, 'escaped'));
  const withLayout = { ...options, layoutRoot: layout };
  const info = await projectInfo('moved', withLayout);
  assert.equal(info.project.available, true);
  assert.match(info.project.local_path, /layout-\d+\/products\/moved$/);
  assert.equal((await projectInfo('escaped', withLayout)).project.available, false, 'other symlink escapes stay refused');
  assert.equal((await projectInfo('moved', { ...options, layoutRoot: join(root, 'nope') })).project.available, false);
});
