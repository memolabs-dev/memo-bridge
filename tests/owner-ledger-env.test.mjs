// #257: the stdio server tells its ledger child who it is, and the ledger's owner refusals map to
// repo_not_allowed. No GitHub, no real ledger: the child is a recorder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIssueLeaseClient, parseIssueRef } from '../server/coordinator/issue-lease.mjs';

async function governance(t) {
  const root = await mkdtemp(join(tmpdir(), 'mb-gov-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts', 'issue_lease.py'), '# stand-in\n');
  return root;
}
const ISSUE = parseIssueRef('guillaume-flambard/private-example#7');

test('the stdio defaults reach the ledger child; variables the owner set win', async t => {
  const root = await governance(t);
  const seen = [];
  const run = async (command, args, { env }) => { seen.push(env); return { code: 0, stdout: '{"state":"unclaimed"}', stderr: '' }; };
  const defaults = { MEMO_BRIDGE_AGENT_MODE: 'stdio', MEMO_BRIDGE_HOST: 'mac' };
  const plain = createIssueLeaseClient({ root, env: { PATH: process.env.PATH }, run, childDefaults: defaults });
  assert.equal((await plain.status(ISSUE)).ok, true);
  assert.equal(seen[0].MEMO_BRIDGE_AGENT_MODE, 'stdio');
  assert.equal(seen[0].MEMO_BRIDGE_HOST, 'mac');
  const runtime = createIssueLeaseClient({ root, run, childDefaults: defaults,
    env: { PATH: process.env.PATH, MEMO_BRIDGE_AGENT_MODE: 'runtime', MEMO_BRIDGE_HOST: 'mac' } });
  await runtime.status(ISSUE);
  assert.equal(seen[1].MEMO_BRIDGE_AGENT_MODE, 'runtime', 'the Mac runtime keeps its own mode');
  const none = createIssueLeaseClient({ root, env: { PATH: process.env.PATH }, run });
  await none.status(ISSUE);
  assert.equal(seen[2].MEMO_BRIDGE_AGENT_MODE, undefined, 'no default unless asked');
});

test('owner-namespace and enrollment refusals of the ledger are repo_not_allowed', async t => {
  const root = await governance(t);
  for (const message of ['Repository not in the owner namespaces allowlist', 'Repository not in the memolabs-dev organization allowlist',
    'Repository privacy or enrollment mismatch']) {
    const run = async () => ({ code: 2, stdout: '', stderr: `LEASE_DENIED: ${message}\n` });
    const ledger = createIssueLeaseClient({ root, env: { PATH: process.env.PATH }, run });
    const result = await ledger.claim(ISSUE, 'mb.mac.ws_test', 300);
    assert.equal(result.error, 'repo_not_allowed', message);
    assert.ok(!JSON.stringify(result).includes('private-example'), 'the refusal never echoes the repository');
  }
});
