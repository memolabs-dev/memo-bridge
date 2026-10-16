import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const config = readFileSync(fileURLToPath(new URL('../.mergify.yml', import.meta.url)), 'utf8');

// A static opt-in regression check, NOT a substitute for Mergify dashboard
// validation of the actual YAML and live GitHub App configuration.
const ruleText = heading => {
  const match = config.match(new RegExp('^    ' + heading + ':\\n((?:      - .+\\n)+)', 'm'));
  assert.ok(match, heading + ' missing');
  return match[1];
};
const REQUIRED = [
  'base = main',
  '-draft',
  'author = memo-labs-automation[bot]',
  'label = mergify:pilot',
  'label = landing:approved',
  'label != hold-merge',
  '#approved-reviews-by >= 1',
  'check-success = @github-actions/test (22)',
  'check-success = @github-actions/test (24)'
];

test('Mergify canary policy must remain explicit in both queue and merge phases', () => {
  assert.match(config, /^queue_rules:\n/m);
  assert.match(config, /^pull_request_rules:\n/m);
  assert.match(config, /name: memo-labs-canary/);
  assert.match(config, /max_parallel_checks: 1/);
  assert.match(config, /batch_size: 1/);
  assert.match(config, /merge_method: squash/);
  const sections = [
    ruleText('queue_conditions'),
    ruleText('merge_conditions'),
    config.slice(config.indexOf('pull_request_rules:'))
  ];
  for (const section of sections) {
    for (const requirement of REQUIRED) {
      assert.ok(section.includes(JSON.stringify(requirement)), 'missing gate: ' + requirement);
    }
  }
});

test('Mergify pilot cannot implicitly enable all-PR queuing', () => {
  assert.doesNotMatch(config, /autoqueue:\s*true/);
  assert.doesNotMatch(config, /auto_merge_conditions:\s*true/);
  assert.doesNotMatch(config, /^\s+merge:/m);
  assert.match(config, /actions:\n\s+queue:\n\s+name: memo-labs-canary/);
  assert.doesNotMatch(config, /\bforce\b/i);
});
