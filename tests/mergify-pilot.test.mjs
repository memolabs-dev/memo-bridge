import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const text = readFileSync(fileURLToPath(new URL('../.mergify.yml', import.meta.url)), 'utf8');

// Local structural regression tests. The live Mergify Config Changed check
// remains the authoritative syntax validation.
function conditions(label) {
  const pos = text.indexOf(label);
  assert.ok(pos >= 0, 'missing '+label);
  const next = text.indexOf('\n\n', pos);
  return text.slice(pos,next<0?undefined:next);
}
const requirements = [
  'base = main', '-draft', '-from-fork',
  'author = memo-labs-automation[bot]',
  'created-at >= 2026-10-16T17:30:00Z',
  'label != hold-merge', 'label != needs-human-review',
  '#files <= 8', '#added-lines <= 400', '#deleted-lines <= 150',
  'check-success = @github-actions/test (22)',
  'check-success = @github-actions/test (24)'
];

test('auto merging is conditional, never enabled for all PRs', () => {
  assert.match(text,/merge_protections_settings:\s*\n\s+auto_merge_conditions:\s*\n/);
  assert.doesNotMatch(text,/auto_merge_conditions:\s*(true|\[\])/);
  assert.doesNotMatch(text,/autoqueue:/);
  assert.doesNotMatch(text,/pull_request_rules:/);
  assert.doesNotMatch(text,/landing:approved|mergify:pilot|approved-reviews-by/);
  assert.match(text,/name: memo-labs-safe-auto/);
  assert.match(text,/max_parallel_checks: 1/);
  assert.match(text,/batch_size: 1/);
  assert.match(text,/merge_method: squash/);
});

test('auto admission and queue match strict gates, merge uses same conditions', () => {
  const admission = conditions('  auto_merge_conditions:');
  const queue = conditions('    queue_conditions: &safe_auto_conditions');
  for(const required of requirements) {
    assert.ok(admission.includes(required),'admission missing '+required);
    assert.ok(queue.includes(required),'queue missing '+required);
  }
  assert.match(text,/merge_conditions: \*safe_auto_conditions/);
});

test('no existing PR is eligible: hard start timestamp and sensitive paths blocked', () => {
  assert.match(text, /created-at >= 2026-10-16T17:30:00Z/g);
  const admission = conditions('  auto_merge_conditions:');
  const queue = conditions('    queue_conditions: &safe_auto_conditions');
  for(const section of [admission,queue]) {
    const match = section.match(/-files ~= ([^\r\n]+)/);
    assert.ok(match,'no file deny list');
    for(const path of [
      '.github/workflows/ci.yml', '.mergify.yml', 'server/index.mjs',
      'bridge/hub-cli.mjs', 'plugin/server/index.mjs', 'deploy/install.sh',
      'scripts/verify.js', 'tests/github.test.mjs', 'infra/ansible.yml',
      '.env.production', 'AGENTS.md', 'CODEOWNERS', 'Dockerfile',
      'package.json', 'pnpm-lock.yaml'
    ]) {
      // The condition is enclosed in YAML single quotes. Strip them and
      // interpret the regex locally to exercise the protected path set.
      let regex = match[1].trim().replace(/^['"]|['"]$/g,'');
      assert.match(path,new RegExp(regex),'protected path not excluded: '+path);
    }
    assert.doesNotMatch('docs/guide.md',new RegExp(match[1].trim().replace(/^['"]|['"]$/g,'')));
  }
});
