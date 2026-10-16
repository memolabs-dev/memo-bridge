#!/usr/bin/env node
// On the Mac: export validated project *metadata*, never sources, local paths or Vault notes.
// Transfer via the owner's authenticated Memo Bridge operator channel (not a public endpoint).
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readProjectRegistry } from '../server/catalog.mjs';
import { makeCatalogSnapshot, parseCatalogSnapshot } from '../server/catalog-snapshot.mjs';
import { memolabsRoot } from '../server/memolabs-root.mjs';

const root = memolabsRoot();
const target = process.argv[2] ?? join(root, 'workspace', 'data', 'memo-project-catalog.json');
if (!isAbsolute(target)) {
  process.stderr.write('Output path must be absolute\n');
  process.exitCode = 2;
} else {
  let temporary;
  try {
    const source = await readProjectRegistry({ projectsRoot: root, layoutRoot: root });
    const snapshot = makeCatalogSnapshot(source.projects);
    parseCatalogSnapshot(snapshot);
    const payload = JSON.stringify(snapshot, null, 2) + '\n';
    await mkdir(dirname(target), { recursive: true });
    temporary = join(dirname(target), `.${randomUUID()}.catalog.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(payload); } finally { await file.close(); }
    await rename(temporary, target);
    await chmod(target, 0o600);
    process.stdout.write(JSON.stringify({ ok: true, projects: snapshot.projects.length,
      generated_at: snapshot.generated_at, output: target }) + '\n');
  } catch {
    process.stderr.write('Catalog export failed\n');
    process.exitCode = 1;
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
  }
}
