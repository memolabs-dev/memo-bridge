import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorktree, lifecycleDecision } from '../server/runners/workspace-lifecycle.mjs';

const policy = { version: 1, entries: [
  { project: 'memo-bridge', branch: 'main', mode: 'persistent' },
  { project: 'memo-bridge', branch: 'agent/42', mode: 'ephemeral' },
  { project: 'memo-bridge', branch: 'docs/shared', mode: 'shared' }
]};
test('unknown policy never permits cleanup', () => {
  assert.equal(lifecycleDecision({ classification: classifyWorktree({ project: 'memo-bridge', branch: 'agent/42' }),
    cleanup: { action: 'remove' } }).action, 'keep');
});
test('persistent and shared workspaces stay even with merged PR', () => {
  for (const branch of ['main', 'docs/shared']) {
    assert.equal(lifecycleDecision({ classification: classifyWorktree({ project: 'memo-bridge', branch, policy }),
      cleanup: { action: 'remove', reason: 'merged_pr_4' } }).action, 'keep');
  }
});
test('ephemeral workspace still requires reaper safety checks', () => {
  const classification = classifyWorktree({ project: 'memo-bridge', branch: 'agent/42', policy });
  assert.equal(lifecycleDecision({ classification, cleanup: { action: 'keep', reason: 'pr_open' } }).action, 'keep');
  assert.equal(lifecycleDecision({ classification, cleanup: { action: 'remove', reason: 'merged_pr_4' } }).action, 'remove');
});
test('ambiguous entries fail closed', () => {
  const p = { version: 1, entries: [...policy.entries, { project: 'memo-bridge', branch: 'agent/42', mode: 'persistent' }] };
  assert.equal(classifyWorktree({ project: 'memo-bridge', branch: 'agent/42', policy: p }).mode, 'unclassified');
});
