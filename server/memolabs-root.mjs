// The one root setting of Memo Labs: MEMOLABS_ROOT, default ~/memolabs. The project registry is
// $MEMOLABS_ROOT/PROJECTS.md and its Path column is relative to that root. A tool finds a project
// by its name in the registry (server/catalog.mjs), never through a folder written in the code.
// ~/projects was retired on 2026-10-14 and is never read.
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function memolabsRoot(env = process.env) {
  const value = env.MEMOLABS_ROOT;
  return value && isAbsolute(value) ? resolve(value) : join(homedir(), 'memolabs');
}
