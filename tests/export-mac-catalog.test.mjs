import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportMacCatalog } from '../server/export-mac-catalog.mjs';
import { loadCatalogSnapshot } from '../server/catalog-snapshot.mjs';

test('Mac registry exporter publishes metadata only, never local paths or vault references', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cdkf-export-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(join(root,'research','clinical-data-knowledge-foundation'),{recursive:true});
  await writeFile(join(root,'PROJECTS.md'),[
    '## Projets appartenant à Memo Labs',
    '| Name | Path | Kind | Status | Nature | Stack | Vault note |',
    '|---|---|---|---|---|---|---|',
    '| clinical-data-knowledge-foundation | research/clinical-data-knowledge-foundation | repo | active | research | Python / SQLite | secret/notes |',
    '', '## Dépôts de référence'
  ].join('\n'));
  const output = join(root,'catalog.json');
  const result = await exportMacCatalog({projectsRoot:root,output,generatedAt:'2026-10-16T13:00:00.000Z'});
  assert.equal(result.count,1);
  const text = await readFile(output,'utf8');
  assert.equal(text.includes('research/clinical-data-knowledge-foundation'),false);
  assert.equal(text.includes('secret/notes'),false);
  const parsed = await loadCatalogSnapshot(output,{now:Date.parse('2026-10-16T13:00:00.000Z')});
  assert.equal(parsed.projects[0].name,'clinical-data-knowledge-foundation');
  assert.equal((await stat(output)).mode & 0o777,0o600);
});
test('exporter refuses relative output paths',async()=>{
  await assert.rejects(exportMacCatalog({projectsRoot:'/tmp',output:'catalog.json'}),/absolute_output_required/);
});
