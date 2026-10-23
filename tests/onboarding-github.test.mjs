import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ONBOARDING_TARGETS, assessGithubOnboarding } from '../server/onboarding-github.mjs';
const sha = 'a'.repeat(40);
function evidence(name, extra = {}) {
  const repo = ONBOARDING_TARGETS[name].repo;
  const required = ONBOARDING_TARGETS[name].requiredCheck;
  return {
    metadata: { full_name: repo, private: true, archived: false, default_branch: 'main' },
    pull: { number: 1, state: 'open', merged_at: null, base: { ref: 'main' },
      head: { sha, repo: { full_name: repo } } },
    checks: { check_runs: [{ name: required, head_sha: sha, status: 'completed', conclusion: 'success' }] },
    landingFile: { type: 'file', name: 'land.yml' },
    installations: { installations: [{ app_slug: 'memo-labs-automation', repository_selection: 'selected' }] },
    ...extra
  };
}
test('green private repo stays unapproved without selected GitHub App repo grant', () => {
  const a = assessGithubOnboarding('rebuild-radar', evidence('rebuild-radar'));
  assert.equal(a.ci_passed_for_exact_sha, true);
  assert.equal(a.landing_workflow_present, true);
  assert.equal(a.github_app_access_verified, false);
  assert.equal(a.coordinator_execution_authorized, false);
  assert.equal(a.landing_authorized, false);
  assert.deepEqual(a.blockers, ['github_app_selected_repo_access_unverified']);
});
test('missing land.yml prevents any inference of protected landing', () => {
  const a = assessGithubOnboarding('mobile-explorer', evidence('mobile-explorer', { landingFile: null }));
  assert.deepEqual(a.blockers, ['landing_workflow_missing_or_unverified', 'github_app_selected_repo_access_unverified']);
});
test('CI from a different SHA does not count as verified', () => {
  const checkRuns = { check_runs: [{ name: 'validate', head_sha: 'b'.repeat(40),
    status: 'completed', conclusion: 'success' }] };
  const a = assessGithubOnboarding('rebuild-radar', evidence('rebuild-radar', { checks: checkRuns }));
  assert.ok(a.blockers.includes('required_check_not_green_for_pr_sha'));
  assert.equal(a.ci_passed_for_exact_sha, false);
});
test('never accept a mismatched repository or unexpected private metadata', () => {
  for (const metadata of [
    { full_name: 'attacker/rebuild-radar', private: true, archived: false, default_branch: 'main' },
    { full_name: 'memolabs-dev/rebuild-radar', private: false, archived: false, default_branch: 'main' },
    null
  ]) {
    const a = assessGithubOnboarding('rebuild-radar', evidence('rebuild-radar', { metadata }));
    assert.ok(a.blockers.includes('repository_metadata_not_verified'));
    assert.equal(a.pr.head_sha, null);
    assert.equal(a.coordinator_execution_authorized, false);
  }
});
test('installation selection all is still not token or landing verification', () => {
  const a = assessGithubOnboarding('mobile-explorer', evidence('mobile-explorer', {
    installations: { installations: [{ app_slug: 'memo-labs-automation', repository_selection: 'all' }] }
  }));
  assert.equal(a.github_app_installation_selection, 'all');
  assert.equal(a.github_app_access_verified, false);
  assert.equal(a.landing_authorized, false);
});
test('unknown product rejected, CLI help and invalid names do not access GitHub', () => {
  assert.throws(() => assessGithubOnboarding('unknown'), /unknown_product/);
  const cli = resolve('scripts/check-product-github.mjs');
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.endsWith('\n'));
  const invalid = spawnSync(process.execPath, [cli, 'unknown'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).error, 'unknown_or_duplicate_product');
});
