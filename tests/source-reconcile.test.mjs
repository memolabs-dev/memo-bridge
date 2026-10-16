import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteStore } from '../server/coordinator/store.mjs';
import { recordSourceChange, sourceChange, sourceHistory } from '../server/source-engine/changes.mjs';
import { observedCi, reconcileSourceProject } from '../server/source-engine/reconcile.mjs';
import { registerSourceReconcileTools } from '../server/tools/source-reconcile-tools.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { tempStateDir } from './helpers/coordinator-fixture.mjs';

const origin = 'memolabs-dev/drop';
const issue = origin + '#7';
const head = 'a'.repeat(40);
const nextHead = 'b'.repeat(40);
const base = 'c'.repeat(40);
const commit = 'd'.repeat(40);
const pull = (changes = {}) => ({
  number: 18, state: 'open', head: 'agent/7-test', head_sha: head,
  head_repo_full_name: origin, base_sha: base, ...changes
});
const checks = (sha = head, runs = [{ status: 'completed', conclusion: 'success' }]) => ({
  ok: true, sha, summary: { check_runs: runs.length, combined_status: 'success' },
  check_runs: runs, statuses: []
});
const fakeGitHub = ({ prs = [pull()], check = checks(), fail = false } = {}) => ({
  projectRepo: async () => origin,
  resolveRepo: async name => name === origin ? { ok: true, repo: { full: origin } } : { ok: false },
  pullRequests: async () => fail ? { ok: false, error: 'offline' } : { ok: true, pull_requests: prs },
  checks: async () => check
});

async function fixture(t, extra = {}) {
  const store = openSqliteStore({ dir: await tempStateDir(t) });
  t.after(() => store.close());
  await recordSourceChange(store, {
    id: 'drop.change7',
    patch: { project_id: 'drop', issue_ref: issue, branch: 'agent/7-test',
      head_sha: head, ci_state: 'pending', landing_state: 'queued' }
  });
  return { store, ...extra };
}
async function reconcile(store, github = fakeGitHub(), now = () => 1900000000000) {
  return reconcileSourceProject({ store, github, project: 'drop', origin, now });
}
test('Source Engine reconciliation tracks exact-head GitHub checks and is idempotent', async t => {
  const { store } = await fixture(t);
  const first = await reconcile(store);
  assert.equal(first.ok, true);
  assert.equal(first.committed, 1);
  assert.equal(first.merge_performed, false);
  let row = (await sourceChange(store, 'drop.change7')).change;
  assert.equal(row.ci_state, 'success');
  assert.equal(row.landing_state, 'open');
  assert.equal(row.base_sha, base);
  const before = (await sourceHistory(store, 'drop.change7')).events.length;
  const second = await reconcile(store);
  assert.equal(second.committed, 0);
  assert.equal(second.decisions[0].result, 'unchanged');
  assert.equal((await sourceHistory(store, 'drop.change7')).events.length, before);
});

test('Source Engine refuses fork, unknown and missing PR evidence', async t => {
  const { store } = await fixture(t);
  const fork = await reconcile(store, fakeGitHub({ prs: [pull({ head_repo_full_name: 'outside/fork' })] }));
  assert.equal(fork.committed, 0);
  assert.equal(fork.decisions[0].result, 'pr_not_verified');
  const missing = await reconcile(store, fakeGitHub({ prs: [] }));
  assert.equal(missing.committed, 0);
  assert.equal((await sourceChange(store, 'drop.change7')).change.landing_state, 'queued');
});

test('failed/pending/empty or stale SHA checks never appear green', async t => {
  const { store } = await fixture(t);
  const failed = await reconcile(store, fakeGitHub({ check: checks(head, [{ status: 'completed', conclusion: 'failure' }]) }));
  assert.equal(failed.committed, 1);
  assert.equal((await sourceChange(store, 'drop.change7')).change.ci_state, 'failed');
  await reconcile(store, fakeGitHub({ check: checks(head, [{ status: 'in_progress', conclusion: null }]) }));
  assert.equal((await sourceChange(store, 'drop.change7')).change.ci_state, 'pending');
  await reconcile(store, fakeGitHub({ check: checks(head, []) }));
  assert.equal((await sourceChange(store, 'drop.change7')).change.ci_state, 'unknown');
  await reconcile(store, fakeGitHub({ check: checks(nextHead) }));
  assert.equal((await sourceChange(store, 'drop.change7')).change.ci_state, 'unknown');
});

test('moved head marks source blocked and merged PR is terminal remote fact', async t => {
  const { store } = await fixture(t);
  let x = await reconcile(store, fakeGitHub({
    prs: [pull({ head_sha: nextHead })], check: checks(nextHead)
  }));
  assert.equal(x.decisions[0].head_moved, true);
  let row = (await sourceChange(store, 'drop.change7')).change;
  assert.equal(row.landing_state, 'blocked');
  assert.equal(row.head_sha, nextHead);
  x = await reconcile(store, fakeGitHub({
    prs: [pull({ head_sha: nextHead, state: 'merged' })], check: checks(nextHead)
  }));
  assert.equal(x.committed, 1);
  row = (await sourceChange(store, 'drop.change7')).change;
  assert.equal(row.landing_state, 'landed');
  const terminal = await reconcile(store, fakeGitHub());
  assert.equal(terminal.decisions[0].result, 'terminal_observation');
  assert.equal((await sourceChange(store, 'drop.change7')).change.head_sha, nextHead);
});

test('Github failure preserves prior state and does not erase snapshots', async t => {
  const { store } = await fixture(t);
  const outcome = await reconcile(store, fakeGitHub({ fail: true }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.committed, 0);
  assert.equal((await sourceChange(store, 'drop.change7')).change.revision, 1);
});

test('MCP source_reconcile is authorized, allowlisted and readOnlyHint false', async t => {
  const { store } = await fixture(t);
  const tools = new Map();
  const remote = makePrincipal('oidc:reader', [CAPABILITIES.READ, CAPABILITIES.WRITE]);
  let principal = remote;
  let repoCount = 0;
  const rt = {
    principal: remote, store: () => store, now: () => 1900000000000,
    catalogOptions: {}, audit: async () => {},
    authorize: op => op === 'source_reconcile' && principal.capabilities.has(CAPABILITIES.WRITE)
  };
  registerSourceReconcileTools({ registerTool: (n, cfg, handler) => tools.set(n, { cfg, handler }) },
    () => rt, {
      listProjects: async () => ({ projects: [{ name: 'drop', kind: 'repo' }] }),
      remotePolicy: () => ({ configured: true, projects: ['drop'] }),
      repoFor: async () => { repoCount++; return origin; }, github: fakeGitHub()
    });
  const tool = tools.get('source_reconcile');
  assert.equal(tool.cfg.annotations.readOnlyHint, false);
  const ask = async args => JSON.parse((await tool.handler(args)).content[0].text);
  assert.equal((await ask({ project: 'elsewhere' })).error, 'project_not_allowed');
  assert.equal(repoCount, 0);
  const ok = await ask({ project: 'drop' });
  assert.equal(ok.committed, 1);
  principal = makePrincipal('oidc:reader', [CAPABILITIES.READ]);
  assert.equal((await ask({ project: 'drop' })).error, 'forbidden');
});
