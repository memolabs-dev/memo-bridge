#!/usr/bin/env node
// Collect a conservative GitHub read-only Mergify adoption snapshot for ANY repo.
// Does not mutate GitHub settings, workflows, PRs or App installations.
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export async function scanRepo(repo, api) {
  if (!REPO.test(repo ?? '')) throw new Error('invalid_repo');
  const get = async endpoint => {
    try { return await api(endpoint); } catch { return null; }
  };
  const observedAt = new Date().toISOString();
  const base = 'repos/' + repo;
  const metadata = await get(base);
  if (!metadata) return {
    repo, accessible: false, defaultBranch: null, checks: [],
    legacyMerger: 'unknown', mergifyVerified: false,
    branchRulesReviewed: false, canaryPassed: false,
    observedAt, notes: 'Repository not available with this GitHub credential.'
  };
  const workflows = await get(base + '/actions/workflows?per_page=100');
  const runs = Array.isArray(workflows?.workflows) ? workflows.workflows : [];
  const mergerPaths = runs.filter(w => /(?:^|\/)(?:land|auto[-_]?merge|merge[-_]?queue)\.ya?ml$/i.test(w.path ?? '') ||
    /^(?:land|auto.merge|enable auto.merge|merge queue)$/i.test(w.name ?? ''));
  const legacyMerger = !workflows || workflows.total_count > runs.length ? 'unknown' :
    mergerPaths.some(w => w.state === 'active') ? 'active' :
    mergerPaths.length && mergerPaths.every(w => w.state !== 'active') ? 'disabled' : 'unknown';
  const prs = await get(base + '/pulls?state=all&per_page=10');
  const sample = Array.isArray(prs) ? prs.find(p => p.head?.sha) : null;
  const checkRuns = sample ? await get(base + '/commits/' + sample.head.sha + '/check-runs?per_page=100') : null;
  const checks = Array.isArray(checkRuns?.check_runs) ? checkRuns.check_runs : [];
  // Suggestions only, NEVER assert these constitute the actual required CI.
  const candidateChecks = [...new Set(checks.filter(c => c.app?.slug === 'github-actions' &&
    c.status === 'completed' && c.conclusion === 'success' &&
    !/(?:auto[- ]merge|^land$|enable merge|pause existing)/i.test(c.name ?? ''))
    .map(c => c.name))].slice(0, 30);
  const config = await get(base + '/contents/.mergify.yml');
  const hasMergifyCheck = checks.some(c => c.app?.slug === 'mergify' && c.name === 'Mergify Merge Queue');
  // A config + one provider check is evidence of presence, NOT proof of safe activation.
  const mergifyObserved = Boolean(config && hasMergifyCheck);
  const rulesets = await get(base + '/rulesets');
  return {
    repo, accessible: true, defaultBranch: metadata.default_branch ?? null,
    archived: Boolean(metadata.archived), private: Boolean(metadata.private),
    checks: candidateChecks, legacyMerger,
    mergifyVerified: mergifyObserved,
    branchRulesReviewed: false, canaryPassed: false,
    observedAt, samplePr: sample?.number ?? null,
    evidence: {
      activeLegacyWorkflows: mergerPaths.filter(w => w.state === 'active').map(w => w.path),
      allLegacyWorkflows: mergerPaths.map(w => ({ path: w.path, state: w.state })),
      mergifyConfigFound: Boolean(config), mergifyCheckFound: hasMergifyCheck,
      rulesetNames: Array.isArray(rulesets) ? rulesets.map(r => r.name) : null,
      requiredChecksNotEstablished: true,
      source: 'GitHub REST: repository, workflows, recent PR check runs, rulesets and Mergify config (read-only)'
    },
    notes: 'Never activate from this snapshot: review real required checks, exact CI app, repo protection, App access and competing mergers; run positive/negative canaries.'
  };
}

export async function ghApi(path) {
  try {
    const { stdout } = await exec('gh', ['api', path], { timeout: 15000, maxBuffer: 2_000_000 });
    return JSON.parse(stdout);
  } catch { return null; }
}

export async function cli(argv, { out = console.log, err = console.error, api = ghApi } = {}) {
  const [repo, extra] = argv;
  if (!REPO.test(repo ?? '') || extra !== undefined) {
    err('Usage: node scripts/mergify-scan.mjs owner/repo');
    return 2;
  }
  const row = await scanRepo(repo, api);
  const snapshot = {
    schemaVersion: 1, observedAt: row.observedAt, source: row.evidence?.source,
    repositories: [row]
  };
  out(JSON.stringify(snapshot, null, 2));
  return row.accessible ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).then(code => { process.exitCode = code; })
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}
