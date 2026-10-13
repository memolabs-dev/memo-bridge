import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoordinator } from '../../server/coordinator/index.mjs';
import { CAPABILITIES, makePrincipal } from '../../server/coordinator/policy.mjs';
import { openSqliteStore } from '../../server/coordinator/store.mjs';

export const OWNER = makePrincipal('local:owner', Object.values(CAPABILITIES));

export function stubProjects(repos = {}) {
  const known = new Set(['drop', 'kollio', ...Object.keys(repos)]);
  return async name => {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(name)) return { ok: false, error: 'invalid_project_name' };
    if (!known.has(name)) return { ok: false, error: 'unknown_project' };
    return { ok: true, project: { name, repoPath: repos[name] ?? null } };
  };
}

export async function tempStateDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'memo-coordinator-'));
  t?.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return join(dir, 'state');
}

export function clock(start = Date.UTC(2026, 9, 13, 12)) {
  let value = start;
  return { now: () => value, advance: ms => { value += ms; } };
}

export function coordinatorOn(stateDir, { principal = OWNER, now = Date.now, repos } = {}) {
  const store = openSqliteStore({ dir: stateDir });
  const coordinator = createCoordinator({ store, principal, now, resolveProject: stubProjects(repos), host: 'mac' });
  return { store, coordinator };
}
