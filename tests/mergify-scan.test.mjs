import test from 'node:test';
import assert from 'node:assert/strict';
import { scanRepo, cli } from '../scripts/mergify-scan.mjs';

function provider(routes) {
  const visited = [];
  return {
    visited,
    api: async path => {
      visited.push(path);
      if (!Object.hasOwn(routes, path)) throw Error('unavailable');
      return routes[path];
    }
  };
}

test('repo scan is read-only and detects legacy merge controller', async () => {
  const repo = 'memolabs-dev/cuesheet', prefix = 'repos/' + repo;
  const p = provider({
    [prefix]: { default_branch: 'main', archived: false, private: false },
    [prefix + '/actions/workflows?per_page=100']: {
      total_count: 2, workflows: [
        { path: '.github/workflows/ci.yml', state: 'active', name: 'CI' },
        { path: '.github/workflows/auto-merge.yml', state: 'active', name: 'Enable auto-merge' }
      ]
    },
    [prefix + '/pulls?state=all&per_page=10']: [{
      number: 72, head: { sha: 'a'.repeat(40) }
    }],
    [prefix + '/commits/' + 'a'.repeat(40) + '/check-runs?per_page=100']: {
      check_runs: [
        { name: 'Core and integration tests', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' },
        { name: 'Enable merge after required CI', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' },
        { name: 'Mergify Merge Queue', app: { slug: 'mergify' }, status: 'completed', conclusion: 'neutral' }
      ]
    },
    [prefix + '/rulesets']: [{ name: 'main: PR only' }]
  });
  const row = await scanRepo(repo, p.api);
  assert.deepEqual(row.checks, ['Core and integration tests']);
  assert.equal(row.legacyMerger, 'active');
  assert.equal(row.mergifyVerified, false);
  assert.equal(row.branchRulesReviewed, false);
  assert.equal(row.canaryPassed, false);
  assert.deepEqual(row.evidence.activeLegacyWorkflows, ['.github/workflows/auto-merge.yml']);
  assert.ok(p.visited.every(v => v.startsWith('repos/' + repo)));
  assert.ok(p.visited.every(v => !/DELETE|POST|PUT|PATCH/.test(v)));
});

test('scan fails closed if GitHub is unavailable, no stale optimistic status', async () => {
  const row = await scanRepo('memolabs-dev/unknown', async () => { throw Error('private credential'); });
  assert.equal(row.accessible, false);
  assert.equal(row.legacyMerger, 'unknown');
  assert.equal(row.mergifyVerified, false);
  assert.equal(row.checks.length, 0);
  assert.ok(!JSON.stringify(row).includes('private credential'));
});

test('scan does not assume no legacy merger just because none appears', async () => {
  const repo = 'memolabs-dev/drop';
  const p = provider({
    ['repos/' + repo]: { default_branch: 'main', archived: false, private: false },
    ['repos/' + repo + '/actions/workflows?per_page=100']: { total_count: 1, workflows: [{ name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] },
    ['repos/' + repo + '/pulls?state=all&per_page=10']: []
  });
  const row = await scanRepo(repo, p.api);
  assert.equal(row.legacyMerger, 'unknown');
  assert.equal(row.mergifyVerified, false);
  assert.deepEqual(row.checks, []);
});

test('refuses malformed repo and outputs a portable snapshot', async () => {
  await assert.rejects(scanRepo('../repo', async () => ({})), /invalid_repo/);
  let output = '';
  const repo = 'memolabs-dev/test-repo';
  const p = provider({ ['repos/' + repo]: { default_branch: 'main', private: true } });
  const code = await cli([repo], { out: s => { output = s; }, err: () => {}, api: p.api });
  assert.equal(code, 0);
  const snapshot = JSON.parse(output);
  assert.equal(snapshot.repositories.length, 1);
  assert.equal(snapshot.repositories[0].repo, repo);
  assert.equal(snapshot.repositories[0].legacyMerger, 'unknown');
  assert.equal(snapshot.repositories[0].mergifyVerified, false);
});
