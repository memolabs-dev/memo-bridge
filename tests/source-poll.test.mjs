import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteStore } from '../server/coordinator/store.mjs';
import { sourceChange, sourceHistory } from '../server/source-engine/changes.mjs';
import { discoverSourceChanges, runSourcePollOnce, sourceIdForPull,
  validatePollPolicy } from '../server/source-engine/poll.mjs';
import { tempStateDir } from './helpers/coordinator-fixture.mjs';

const origin = 'memolabs-dev/memo-bridge', issue = origin + '#50';
const wsid = 'ws_' + 'w'.repeat(16), wtid = 'wt_' + 'w'.repeat(16);
const sha = 'a'.repeat(40), baseSha = 'b'.repeat(40), branch = 'agent/50-wwww';
const policy = { enabled: true, apply: true, projects: ['memo-bridge'],
  trustedAuthors: ['memo-labs-automation[bot]'] };
const pr = (patch = {}) => ({ number: 51, author: 'memo-labs-automation[bot]',
  state: 'open', draft: false, head: branch, head_sha: sha,
  base: 'main', base_sha: baseSha, head_repo_full_name: origin, ...patch });
const check = { ok: true, sha, summary: { check_runs: 1, combined_status: 'success' },
  check_runs: [{ status: 'completed', conclusion: 'success' }], statuses: [] };
const fakeGh = (patch = {}) => ({
  projectRepo: async () => origin,
  resolveRepo: async x => ({ ok: x === origin, repo: { full: x } }),
  defaultBranch: async () => ({ ok: true, branch: 'main' }),
  pullRequests: async () => ({ ok: true, pull_requests: [pr()] }),
  checks: async () => check, ...patch
});
async function fixture(t, { durability = 'remote', checkpointSha = sha } = {}) {
  const store = openSqliteStore({ dir: await tempStateDir(t) });
  t.after(() => store.close());
  await store.transaction(db => {
    db.insertWorkspace({ id: wsid, principal: 'local:owner', client_type: 'chatgpt',
      project_id: 'memo-bridge', host: 'vps', status: 'closed',
      created_at: 1000, updated_at: 1000 });
    db.insertWorktree({ id: wtid, workspace_id: wsid, project_id: 'memo-bridge',
      host: 'vps', path: '/private/example', branch, base_ref: 'origin/main',
      base_commit: baseSha, issue_ref: issue, created_at: 1000, updated_at: 1000 });
    db.insertCheckpoint({ issue_ref: issue, claim_id: 'claim', workspace_id: wsid,
      fence_sha: 'f'.repeat(40), branch, commit_sha: checkpointSha, durability, at: 1000 });
  });
  return store;
}
const discover = (store, github, dryRun = false) => discoverSourceChanges({
  store, github, project: 'memo-bridge', origin, trustedAuthors: policy.trustedAuthors,
  dryRun, now: () => 1900000000000
});

test('policy is explicit, bounded and rejects malformed or duplicate inputs', () => {
  assert.equal(validatePollPolicy(policy).ok, true);
  for (const p of [{ ...policy, enabled: 'yes' }, { ...policy, projects: ['../etc'] },
    { ...policy, projects: ['memo-bridge', 'memo-bridge'] },
    { ...policy, trustedAuthors: [] }, { ...policy, trustedAuthors: ['bad\nname'] }]) {
    assert.equal(validatePollPolicy(p).ok, false);
  }
});
test('dry-run can discover exact remote checkpoint but never writes', async t => {
  const store = await fixture(t);
  const value = await discover(store, fakeGh(), true);
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.candidates, 1, JSON.stringify(value));
  assert.equal(value.recorded, 0);
  assert.equal((await sourceChange(store, sourceIdForPull(origin, 51))).change, null);
});
test('trusted checkpoint is imported once and PR/CI observations remain idempotent', async t => {
  const store = await fixture(t);
  const opts = { store, github: fakeGh(), policy,
    catalog: async () => ({ projects: [{ name: 'memo-bridge', kind: 'repo', available: true }] }),
    now: () => 1900000000000 };
  const one = await runSourcePollOnce(opts);
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.equal(one.projects[0].discovery.recorded, 1, JSON.stringify(one));
  const id = sourceIdForPull(origin, 51);
  const row = (await sourceChange(store, id)).change;
  assert.equal(row.issue_ref, issue);
  assert.equal(row.head_sha, sha);
  assert.equal(row.ci_state, 'success');
  const before = (await sourceHistory(store, id)).events.length;
  const second = await runSourcePollOnce(opts);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.projects[0].discovery.recorded, 0);
  assert.equal((await sourceHistory(store, id)).events.length, before);
});
test('foreign author, fork, renamed branch, stale SHA and wrong base are refused', async t => {
  const store = await fixture(t);
  for (const candidate of [
    pr({ author: 'outsider' }), pr({ head_repo_full_name: 'someone/fork' }),
    pr({ head: 'other-branch' }), pr({ head_sha: 'c'.repeat(40) }),
    pr({ base: 'release' })
  ]) {
    const outcome = await discover(store, fakeGh({
      pullRequests: async () => ({ ok: true, pull_requests: [candidate] })
    }));
    assert.equal(outcome.recorded, 0, JSON.stringify(outcome));
  }
});
test('local-only checkpoint and GitHub errors do not create observations', async t => {
  const store = await fixture(t, { durability: 'local_only' });
  assert.equal((await discover(store, fakeGh())).recorded, 0);
  const failed = await discover(store, fakeGh({
    pullRequests: async () => ({ ok: false, error: 'github_rate_limited' })
  }));
  assert.equal(failed.ok, false);
  assert.equal((await sourceChange(store, sourceIdForPull(origin, 51))).change, null);
});
test('disabled or unknown project refuses before any GitHub lookup', async t => {
  const store = await fixture(t);
  let touched = false;
  const github = fakeGh({ projectRepo: async () => { touched = true; return origin; } });
  const catalog = async () => ({ projects: [{ name: 'memo-bridge', kind: 'repo' }] });
  const disabled = await runSourcePollOnce({ store, github, catalog,
    policy: { ...policy, enabled: false } });
  assert.equal(disabled.error, 'disabled');
  const denied = await runSourcePollOnce({ store, github, catalog,
    policy: { ...policy, projects: ['drop'] } });
  assert.equal(denied.projects[0].error, 'unknown_project');
  assert.equal(touched, false);
});
test('in-process concurrent runs on same store fail closed', async t => {
  const store = await fixture(t);
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const github = fakeGh({ projectRepo: async () => { entered(); await blocked; return origin; } });
  const args = { store, github, policy, catalog: async () => ({
    projects: [{ name: 'memo-bridge', kind: 'repo', available: true }] }) };
  const first = runSourcePollOnce(args);
  await started;
  assert.equal((await runSourcePollOnce(args)).error, 'already_running');
  release();
  await first;
});
