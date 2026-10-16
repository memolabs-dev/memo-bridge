import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPollPolicy, pollBackoffMs, backoffDecision } from '../server/source-engine/poll-cli.mjs';

const valid = {
  enabled: true, apply: false, projects: ['memo-bridge'], trustedAuthors: ['memo-labs-automation[bot]']
};
test('private policy file is required, rejects world-readable and symlink', async t => {
  const root = await mkdtemp(join(tmpdir(), 'source-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'policy.json'), link = join(root, 'link.json');
  assert.equal((await loadPollPolicy(file)).ok, false);
  await writeFile(file, JSON.stringify(valid), { mode: 0o600 });
  assert.equal((await loadPollPolicy(file)).ok, true);
  await chmod(file, 0o644);
  assert.equal((await loadPollPolicy(file)).error, 'policy_permissions_or_size');
  await chmod(file, 0o600);
  await symlink(file, link);
  assert.equal((await loadPollPolicy(link)).error, 'policy_permissions_or_size');
});
test('retry schedule is bounded with exponential delay, success resets history', () => {
  assert.equal(pollBackoffMs(0), 0);
  assert.equal(pollBackoffMs(1), 15 * 60_000);
  assert.equal(pollBackoffMs(2), 30 * 60_000);
  assert.equal(pollBackoffMs(4), 120 * 60_000);
  assert.equal(pollBackoffMs(100), 120 * 60_000);
  const now = Date.parse('2026-10-16T16:00:00Z');
  const failed = [{ at: '2026-10-16T15:50:00Z', ok: false }];
  assert.equal(backoffDecision(failed, now).delay_ms, 5 * 60_000);
  const reset = [{ at: '2026-10-16T15:00:00Z', ok: false },
    { at: '2026-10-16T15:40:00Z', ok: true }];
  assert.equal(backoffDecision(reset, now).delay_ms, 0);
});
