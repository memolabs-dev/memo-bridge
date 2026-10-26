#!/usr/bin/env node
// Global cross-repo Issues and PRs inventory for registered Memo Labs projects.
//
// Read-only: reads PROJECTS.md, lists open Issues and pull requests for every
// available repo project, ranks them into a single priority queue (p0/p1/p2,
// blocking PR, drafts, no-priority, unassigned, stale), and reports the next
// recommended task. No claims, no mutations, no deployment.
//
// Usage: node scripts/portfolio-inventory.mjs [--limit N] [--concurrency N]
//   --limit        Max open items per repo (default 100, hard ceiling of the GitHub integration)
//   --concurrency  Max simultaneous per-project fetches (default 4)
//
// Output: a JSON report on stdout with `next`, `queue`, `totals`, `errors`,
// `observed_projects`, `unobserved_projects`, `scope` and `snapshot_at`.
// Exit code 0 on success, 1 on failure.
import { readProjectRegistry } from '../server/catalog.mjs';
import { createGitHub } from '../server/integrations/github.mjs';
import { livePortfolio } from '../server/portfolio-live.mjs';
import { memolabsRoot } from '../server/memolabs-root.mjs';

const root = memolabsRoot();
const args = process.argv.slice(2);
let limit = 100;
let concurrency = 4;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--limit') limit = Number(args[++i]) ?? 100;
  else if (args[i] === '--concurrency') concurrency = Number(args[++i]) ?? 4;
}
if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
  process.stderr.write('--limit must be an integer between 1 and 100\n');
  process.exitCode = 2;
} else if (!Number.isInteger(concurrency) || concurrency < 1) {
  process.stderr.write('--concurrency must be a positive integer\n');
  process.exitCode = 2;
} else {
  run().catch(err => {
    process.stderr.write(String(err?.message ?? err) + '\n');
    process.exitCode = 1;
  });
}

async function run() {
  const catalog = await readProjectRegistry({ projectsRoot: root, layoutRoot: root });
  const projects = catalog.projects.filter(p => p.kind === 'repo' && p.available);
  const github = createGitHub({ catalogOptions: { projectsRoot: root, layoutRoot: root } });
  const report = await livePortfolio({ projects, github, limit, concurrency });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
