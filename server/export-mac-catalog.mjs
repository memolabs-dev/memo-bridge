// Publish only allowlisted project metadata from the canonical Mac registry.
// Run on the Mac; transfer the resulting JSON through the approved operator channel.
import { readProjectRegistry } from './catalog.mjs';
import { makeCatalogSnapshot } from './catalog-snapshot.mjs';
import { writeFile, rename, rm } from 'node:fs/promises';
import { dirname, basename, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function exportMacCatalog({ projectsRoot, output, generatedAt } = {}) {
  if (process.platform !== 'darwin' && !projectsRoot) throw new Error('mac_registry_required');
  if (!isAbsolute(output ?? '')) throw new Error('absolute_output_required');
  const registry = await readProjectRegistry({ projectsRoot, layoutRoot: projectsRoot, externalProjects: false });
  const snapshot = makeCatalogSnapshot(registry.projects, generatedAt);
  const temporary = join(dirname(output), '.' + basename(output) + '.' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return { count: snapshot.projects.length, output };
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const output = process.argv[2];
  exportMacCatalog({ output }).then(({count}) => {
    process.stdout.write(JSON.stringify({ ok: true, count }) + '\n');
  }).catch(() => {
    process.stderr.write('catalog_export_failed\n');
    process.exitCode = 1;
  });
}
