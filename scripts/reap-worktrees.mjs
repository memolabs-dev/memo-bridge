#!/usr/bin/env node
// Remove worktrees whose pull request has merged, for every registered repository on this host.
// Dry run unless --apply. One JSON line per worktree on stdout, a summary line last.
// See docs/REAPER.md. Options:
//   --apply                 act (default: report only)
//   --project <name>        only this registered project
//   --grace-hours <n>       keep anything modified in the last n hours (default 6)
//   --archive-dir <path>    where local edits go before removal
//                           (default $MEMOLABS_ROOT/workspace/data/reaper-archive/<date>)
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { readProjectRegistry } from '../server/catalog.mjs';
import { defaultStateDir, openSqliteStore } from '../server/coordinator/store.mjs';
import { memolabsRoot } from '../server/memolabs-root.mjs';
import { ACTIVE_JOB_STATUSES } from '../server/runners/executor.mjs';
import { DEFAULT_GRACE_MS, acquireLock, githubPrLookup, lsofCwds, reapRepository, storeHolds } from '../server/runners/reaper.mjs';

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    project: { type: 'string' },
    'grace-hours': { type: 'string' },
    'archive-dir': { type: 'string' },
    'policy-file': { type: 'string' }
  }
});
const fail = (message, code = 2) => { process.stderr.write(`${message}\n`); process.exit(code); };

const root = memolabsRoot();
const now = Date.now();
const graceMs = values['grace-hours'] !== undefined ? Number(values['grace-hours']) * 3_600_000 : DEFAULT_GRACE_MS;
if (!Number.isFinite(graceMs) || graceMs < 0) fail('--grace-hours must be a non-negative number');
const archiveDir = values['archive-dir'] ?? join(root, 'workspace', 'data', 'reaper-archive', new Date(now).toISOString().slice(0, 10));
if (!isAbsolute(archiveDir)) fail('--archive-dir must be absolute');

// Policy is explicit: unknown worktrees stay untouched. The file must be absolute.
let lifecyclePolicy = null;
if (values['policy-file']) {
  if (!isAbsolute(values['policy-file'])) fail('--policy-file must be absolute');
  try { lifecyclePolicy = JSON.parse(readFileSync(values['policy-file'], 'utf8')); }
  catch (error) { fail('cannot read lifecycle policy: ' + error.message); }
}
const stateDir = defaultStateDir();
let store = null;
let holds = { bridgeHolds: async () => null, markRemoved: async () => {} };
if (existsSync(stateDir)) {
  try {
    store = openSqliteStore({ dir: stateDir });
    holds = storeHolds(store, ACTIVE_JOB_STATUSES);
  } catch (error) {
    // Without the store we cannot tell which worktrees Memo Bridge holds: refuse to act.
    if (values.apply) fail(`memo-bridge store unavailable (${error.message}); refusing --apply`);
  }
}

const release = acquireLock(join(existsSync(stateDir) ? stateDir : root, 'reaper.lock'), now);
if (!release) fail(JSON.stringify({ ok: false, error: 'locked' }), 3);

const deps = { prForBranch: githubPrLookup(), cwdsInUse: lsofCwds(), ...holds };
const counts = {};
try {
  const registry = await readProjectRegistry({ projectsRoot: root, layoutRoot: root });
  const repos = registry.projects.filter(p => p.available && p.kind === 'repo' && (!values.project || p.name === values.project));
  for (const project of repos) {
    if (!existsSync(join(project.path, '.git'))) continue;
    const rows = await reapRepository(project.path, deps, { apply: values.apply, now, graceMs, archiveDir, policy: lifecyclePolicy });
    for (const row of rows) {
      counts[row.action] = (counts[row.action] ?? 0) + 1;
      process.stdout.write(JSON.stringify({ project: project.name, ...row }) + '\n');
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, apply: values.apply, archive_dir: archiveDir, counts }) + '\n');
} finally {
  release();
  store?.close?.();
}
