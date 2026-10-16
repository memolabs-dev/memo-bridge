#!/usr/bin/env node
// Read-only checks of two fixed, owner-selected repositories. No credential output,
// installation-token creation, permission mutations, default-branch writes, or merges.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ONBOARDING_TARGETS, assessGithubOnboarding } from '../server/onboarding-github.mjs';
const run = promisify(execFile);
const targets = process.argv.slice(2);
if (targets.includes('--help')) {
  process.stdout.write('Usage: node scripts/check-product-github.mjs [rebuild-radar] [mobile-explorer]\n');
} else if (targets.length && (targets.some(x => !Object.hasOwn(ONBOARDING_TARGETS, x)) ||
  new Set(targets).size !== targets.length)) {
  process.stdout.write(JSON.stringify({ ok: false, error: 'unknown_or_duplicate_product' }) + '\n');
  process.exitCode = 2;
} else {
  async function readGitHub(endpoint) {
    try {
      const { stdout } = await run('gh', ['api', '-X', 'GET', endpoint], {
        timeout: 12000, maxBuffer: 256 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0',
          GH_NO_UPDATE_NOTIFIER: '1' }
      });
      return JSON.parse(stdout);
    } catch { return null; }
  }
  const installations = await readGitHub('orgs/memolabs-dev/installations');
  const rows = [];
  for (const name of targets.length ? targets : Object.keys(ONBOARDING_TARGETS)) {
    const repo = ONBOARDING_TARGETS[name].repo;
    const metadata = await readGitHub('repos/' + repo);
    const pull = await readGitHub('repos/' + repo + '/pulls/1');
    const head = pull?.head?.sha;
    const checks = /^[0-9a-f]{40}$/.test(head ?? '') ?
      await readGitHub('repos/' + repo + '/commits/' + head + '/check-runs') : null;
    const landingFile = await readGitHub('repos/' + repo + '/contents/.github/workflows/land.yml');
    rows.push(assessGithubOnboarding(name, { metadata, pull, checks, landingFile, installations }));
  }
  process.stdout.write(JSON.stringify({ schema: 'memo-bridge.github-onboarding-report.v1',
    checked_at: new Date().toISOString(), read_only: true, projects: rows }, null, 2) + '\n');
  // Missing prerequisites are a refusal by design, not a reason to broaden access.
  if (rows.some(x => x.blockers.length || !x.github_app_access_verified ||
    !x.coordinator_execution_authorized || !x.landing_authorized)) process.exitCode = 1;
}
