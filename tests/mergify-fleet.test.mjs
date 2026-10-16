import test from 'node:test';
import assert from 'node:assert/strict';
import { auditRecord, renderCandidate, BASE_DENY, cli } from '../scripts/mergify-fleet.mjs';

const later = '2099-01-01T00:00:00Z';
const now = new Date('2026-10-16T18:00:00Z');
const base = { repo: 'memolabs-dev/drop', branch: 'main', checks: ['test', 'test-macos', 'test-windows'], cutoff: later, now };

test('multi-repo candidate uses that repository’s actual CI names, never memo-bridge names', () => {
  const config = renderCandidate(base);
  for (const check of base.checks) assert.ok(config.includes(JSON.stringify('check-success = @github-actions/' + check)));
  assert.doesNotMatch(config, /test \(22\)|test \(24\)/);
  assert.match(config, /merge_protections_settings:/);
  assert.match(config, /auto_merge_conditions:/);
  assert.match(config, /max_parallel_checks: 1/);
  assert.match(config, /merge_conditions: \*safe_auto_conditions/);
  assert.equal(config.split('check-success = @github-actions/test-macos').length, 3);
  assert.doesNotMatch(config, /pull_request_rules:|mergify:pilot|landing:approved|approved-reviews-by/);
});

test('each repo gets its own check names; international CI names preserved', () => {
  const config = renderCandidate({ repo: 'memolabs-dev/emargo', branch: 'main', checks: ['Lint · Types · Tests'], cutoff: later, now });
  assert.ok(config.includes(JSON.stringify('check-success = @github-actions/Lint · Types · Tests')));
  const config2 = renderCandidate({ repo: 'memolabs-dev/mobile-explorer', branch: 'main', checks: ['swift-build'], cutoff: later, now });
  assert.ok(config2.includes('check-success = @github-actions/swift-build'));
});

test('sensitive paths are excluded by the mandatory baseline regex', () => {
  const pattern = new RegExp(BASE_DENY);
  for (const file of [
    '.github/workflows/ci.yml', '.mergify.yml', 'server/index.mjs', 'src/main.ts', 'lib/engine.rs',
    'scripts/deploy.sh', 'tests/feature.test.mjs', 'infra/ansible.yml', 'docker/service.json',
    'config/production.yaml', '.env', '.env.production', 'secrets/key.txt', 'AGENTS.md',
    'CODEOWNERS', 'Dockerfile', 'package.json', 'pnpm-lock.yaml', 'Cargo.toml',
    'Package.swift', 'pyproject.toml', 'db/migrations/001.sql', 'frontend/main.ts',
    'app/page.tsx', 'ios/App.swift', 'README.sh', 'src/main.go',
  ]) {
    assert.match(file, pattern, 'protected: ' + file);
  }
  for (const file of ['docs/guide.md', 'README.md', 'CHANGELOG.md']) {
    assert.doesNotMatch(file, pattern, 'ordinary documentation permitted: ' + file);
  }
});

test('generator never accepts narrower or invalid protected-file exclusions', () => {
  for (const denyPattern of ['', '^docs/', '.*', BASE_DENY.slice(0, -1)]) {
    assert.throws(() => renderCandidate({ ...base, denyPattern }), /unsafe_deny_pattern/);
  }
  const stricter = BASE_DENY + '|^some-additional-sensitive-path/';
  const policy = renderCandidate({ ...base, denyPattern: stricter });
  assert.ok(policy.includes(JSON.stringify('-files ~= ' + stricter)));
});

test('invalid names, bot, check provenance and missing/current cutoff are rejected', () => {
  const variations = [
    [{ repo: '../evil' }, /invalid_repo/],
    [{ repo: 'memolabs-dev/hi\nconditions' }, /invalid_repo/],
    [{ branch: 'main\n- no-check' }, /invalid_branch/],
    [{ author: 'untrusted-user' }, /invalid_bot_author/],
    [{ checks: [] }, /invalid_checks/],
    [{ checks: ['test (22)', 'test (22)'] }, /invalid_checks/],
    [{ checks: ['test\n- pass'] }, /invalid_checks/],
    [{ cutoff: '2026-10-15T00:00:00Z' }, /cutoff_must_be_future_utc/],
    [{ cutoff: '2026-10-16T18:00:00Z' }, /cutoff_must_be_future_utc/],
    [{ cutoff: 'not-a-date' }, /cutoff_must_be_future_utc/],
    [{ maxFiles: 9000 }, /invalid_size_limit/]
  ];
  for (const [change, error] of variations) {
    assert.throws(() => renderCandidate({ ...base, ...change }), error);
  }
});

test('read-only fleet audit fails closed on unverified old merger and app access', () => {
  const valid = {
    repo: 'memolabs-dev/memo-bridge', accessible: true, defaultBranch: 'main',
    checks: ['test (22)'], legacyMerger: 'disabled',
    mergifyVerified: true, branchRulesReviewed: true, canaryPassed: true
  };
  const ok = auditRecord(valid);
  assert.equal(ok.eligible, true);
  assert.equal(ok.activation_authorized, false);
  for (const [change, reason] of [
    [{ accessible: false }, 'repo_not_verified'],
    [{ checks: [] }, 'ci_checks_unverified'],
    [{ legacyMerger: 'active' }, 'legacy_merger_not_isolated'],
    [{ legacyMerger: 'unknown' }, 'legacy_merger_not_isolated'],
    [{ mergifyVerified: false }, 'mergify_access_not_verified'],
    [{ branchRulesReviewed: false }, 'branch_rules_not_reviewed'],
    [{ canaryPassed: false }, 'positive_negative_canaries_missing']
  ]) {
    const outcome = auditRecord({ ...valid, ...change });
    assert.equal(outcome.eligible, false, reason);
    assert.ok(outcome.blockers.includes(reason));
    assert.equal(outcome.activation_authorized, false);
  }
});

test('candidate CLI is read-only and audit displays blockers for the recorded fleet', async () => {
  const snapshot = 'docs/mergify-fleet-snapshot.json';
  let output = '', logs = '';
  const io = { out: s => { output = s; }, err: s => { logs += s; } };
  assert.equal(await cli(['audit', snapshot], io), 0);
  const results = JSON.parse(output).results;
  assert.ok(results.length >= 10);
  assert.equal(results.find(x => x.repo === 'memolabs-dev/memo-bridge').eligible, true);
  assert.equal(results.find(x => x.repo === 'memolabs-dev/cuesheet').eligible, false);
  assert.ok(results.every(x => x.activation_authorized === false));

  output = '';
  assert.equal(await cli(['candidate', snapshot, 'memolabs-dev/rebuild-radar', later], io), 0);
  assert.match(output, /check-success = @github-actions\/validate/);
  assert.match(logs, /CANDIDATE ONLY/);
  await assert.rejects(cli(['candidate', snapshot, 'memolabs-dev/lab-hub', later], io), /unverified_repo_checks/);
});
