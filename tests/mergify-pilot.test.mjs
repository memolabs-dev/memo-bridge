import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const text = readFileSync(fileURLToPath(new URL('../.mergify.yml', import.meta.url)), 'utf8');

// Local structural regression tests for the autoloop policy (#151, owner decision of
// 2026-10-17). The live Mergify "Configuration changed" check remains the authoritative syntax
// validation.
function conditions() {
  const pos = text.indexOf('land_conditions: &land_conditions');
  assert.ok(pos >= 0, 'missing shared land_conditions');
  const next = text.indexOf('\n\n', pos);
  return text.slice(pos, next < 0 ? undefined : next);
}
const requirements = [
  'base = main', '-draft', '-from-fork',
  'author = memo-labs-automation[bot]', 'author = guillaume-flambard',
  'label != hold-merge', 'label != needs-human-review',
  'check-success = @github-actions/test (22)',
  'check-success = @github-actions/test (24)'
];

test('auto merging is conditional, never enabled for all PRs', () => {
  assert.match(text, /merge_protections_settings:\s*\n\s+auto_merge_conditions: \*land_conditions\n/);
  assert.doesNotMatch(text, /auto_merge_conditions:\s*(true|\[\])/);
  assert.doesNotMatch(text, /autoqueue:/);
  // pull_request_rules need Mergify Workflow Automation, which is not activated (seen on #154).
  assert.doesNotMatch(text, /pull_request_rules:/);
  assert.doesNotMatch(text, /landing:approved|mergify:pilot|approved-reviews-by/);
  assert.match(text, /name: memo-labs-autoloop/);
  assert.match(text, /max_parallel_checks: 1/);
  assert.match(text, /batch_size: 1/);
  assert.match(text, /merge_method: squash/);
});

test('admission, queue entry and merge use the same gates', () => {
  const shared = conditions();
  for (const required of requirements) assert.ok(shared.includes(required), 'missing ' + required);
  assert.match(text, /queue_conditions: \*land_conditions/);
  assert.match(text, /merge_conditions: \*land_conditions/);
});

test('no cutoff date and no size cap: green code PRs are eligible', () => {
  assert.doesNotMatch(text, /created-at/);
  assert.doesNotMatch(text, /#files|#added-lines|#deleted-lines/);
});

test('sensitive paths stay with the owner, code paths land', () => {
  const match = conditions().match(/-files ~= ([^\r\n]+)/);
  assert.ok(match, 'no file deny list');
  const regex = new RegExp(match[1].trim().replace(/^['"]|['"]$/g, ''));
  for (const path of ['.github/workflows/ci.yml', '.mergify.yml', 'CODEOWNERS', 'deploy/install.sh',
    'infra/ansible.yml', '.env.production', 'AGENTS.md']) {
    assert.match(path, regex, 'sensitive path not excluded: ' + path);
  }
  for (const path of ['server/index.mjs', 'bridge/hub-cli.mjs', 'scripts/reap-worktrees.mjs',
    'tests/github.test.mjs', 'package.json', 'pnpm-lock.yaml', 'docs/guide.md', 'docs/AGENTS.md']) {
    assert.doesNotMatch(path, regex, 'code path wrongly excluded: ' + path);
  }
});
