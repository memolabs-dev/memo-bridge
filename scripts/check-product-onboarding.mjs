#!/usr/bin/env node
// A LOCAL read-only preflight. Never writes allowlists, modifies GitHub permissions or deploys.
// Run on each host independently; the Mac registry is authoritative only on the Mac.
import { readProjectRegistry } from '../server/catalog.mjs';
import { gitHubRemote, readPublicAllowlist } from '../server/coordinator/index.mjs';
import { assessProductOnboarding } from '../server/onboarding-readiness.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('Usage: node scripts/check-product-onboarding.mjs <project-name> [...]\n');
} else {
  try {
    const names = args.length ? args : ['rebuild-radar', 'mobile-explorer'];
    const catalog = await readProjectRegistry();
    const origins = {};
    for (const name of names) {
      const project = catalog.projects.find(p => p.name === name && p.kind === 'repo' && p.available);
      // Only inspect Git origin for registered, available checkouts; never probe guessed paths.
      if (project) origins[name] = await gitHubRemote({ repoPath: project.path });
    }
    const ledger = await readPublicAllowlist();
    const result = assessProductOnboarding({
      names, projects: catalog.projects, origins,
      ledgerRepos: ledger.ok ? ledger.repos : []
    });
    process.stdout.write(JSON.stringify({
      ...result, ledger_readable: Boolean(ledger.ok),
      note: 'Neither GitHub App installation nor landing eligibility is proven by this preflight.'
    }, null, 2) + '\n');
    if (!result.all_coordinator_ready || !ledger.ok) process.exitCode = 1;
  } catch (error) {
    // No raw exception paths or environment values leak to logs.
    process.stderr.write(JSON.stringify({ ok: false,
      error: error?.message === 'invalid_names' ? 'invalid_names' : 'preflight_unavailable' }) + '\n');
    process.exitCode = 2;
  }
}
