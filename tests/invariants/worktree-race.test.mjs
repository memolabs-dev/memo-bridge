// Invariant: up to 6 parallel sessions (12 for margin) never share a worktree.
//   - N sessions in N processes, each holding its own Issue, call worktree_create on ONE branch:
//     exactly one wins; every other result is branch_exists or path_exists; the store keeps one
//     active row for the branch; git shows one worktree beyond the main checkout; a loser leaves
//     no directory and no branch behind.
//   - The same for ONE path. The path is derived from the branch (`/` becomes `-`), so N distinct
//     branches that differ only in their separators (`a/b-c`, `a-b/c`, ...) resolve to one path and
//     are only stopped by path_exists, never by the branch checks.
//   - The store's own partial UNIQUE indexes (worktrees_live_branch, worktrees_live_path, v9) refuse
//     a second active row for a branch or a path, whatever the caller checked beforehand.
//
// Each racing process opens a full runtime (its own SQLite connection) on a shared state directory,
// a git project with a bare origin and the offline fake gh ledger (issue_lease.py), as in claim-race.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { demoGh, fakeGitHub, gitRuntime, isolateGit, memoryLedger, skipWithoutLedger, tempStateDir } from './lib/fixture.mjs';
import { raceWorktreeInserts, raceWorktrees, startWorkers, stopWorkers } from './lib/race.mjs';
import { openSqliteStore } from '../../server/coordinator/store.mjs';

const SIZES = [6, 12];
// The git project is registered as `demo` but its worker runtimes report the allowlisted origin memolabs-dev/drop
// (the public ledger refuses any other repository), so its Issues are drop#101..112.
const issueOf = i => `memolabs-dev/drop#${101 + i}`;
const GITHUB_ISSUES = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [issueOf(i).replace('memolabs-dev/', 'memolabs-dev/'), {}]));
const REFUSALS = new Set(['branch_exists', 'path_exists']);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// i-th spelling of p/q/r/s/t: each separator is a `/` or a `-`, all of them resolve to p-q-r-s-t.
const spelling = i => ['p', 'q', 'r', 's', 't'].reduce((acc, part, k) => (k === 0 ? part : acc + ((i >> (k - 1)) & 1 ? '-' : '/') + part), '');

async function setup(t, n) {
  await isolateGit(t);
  const github = await fakeGitHub(t, GITHUB_ISSUES);
  const { gh } = demoGh();
  const g = await gitRuntime(t, { ledger: memoryLedger(Date.now), now: Date.now, gh });
  const worktreesRoot = process.env.MEMO_BRIDGE_WORKTREES_ROOT;
  const { workers } = await startWorkers(g.stateDir, github.file, n, { project: 'demo' });
  t.after(() => stopWorkers(workers).catch(() => {}));
  const issues = Array.from({ length: n }, (_, i) => issueOf(i));
  const race = argsFor => raceWorktrees(workers, { projectsRoot: g.projectsRoot, worktreesRoot, issues, argsFor });
  const repo = join(g.projectsRoot, 'demo');
  const rows = () => g.rt.store().transaction(r => r.listWorktrees({ project_id: 'demo', limit: 200 }), { write: false });
  return { g, race, repo, worktreesRoot, rows, workers };
}

// One winner, only clean refusals, and nothing left behind by the others.
async function assertExclusive(results, { repo, worktreesRoot, rows }, n, key) {
  const winners = results.filter(r => r.ok);
  assert.equal(winners.length, 1, JSON.stringify(results));
  const losers = results.filter(r => !r.ok);
  assert.equal(losers.length, n - 1);
  assert.ok(losers.every(r => REFUSALS.has(r.error)), `only branch_exists / path_exists: ${JSON.stringify(losers)}`);
  // The tool's answer hides the path; the store holds it.
  const all = await rows();
  const active = all.filter(r => r.status === 'active');
  assert.equal(all.length, 1, `the losers left no row behind: ${JSON.stringify(all)}`);
  assert.deepEqual(active.map(r => r.id), [winners[0].worktree.worktree_id], `one active row for the ${key}: ${JSON.stringify(active)}`);
  const win = active[0];

  const listed = git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree '));
  assert.equal(listed.length, 2, `the main checkout plus one: ${listed.join(' | ')}`);
  assert.deepEqual(await readdir(join(worktreesRoot, 'demo')), [win.path.split('/').pop()], 'no stray directory');
  const heads = git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();
  assert.deepEqual(heads, ['main', win.branch].sort(), 'a loser leaves no branch behind');
}

for (const n of SIZES) {
  test(`${n} worktree_create on one branch: one succeeds, one active row, one git worktree`,
    { skip: skipWithoutLedger, timeout: 180000 }, async t => {
      const s = await setup(t, n);
      const results = await s.race(() => ({ branch: 'agent/shared-branch' }));
      await assertExclusive(results, s, n, 'branch');
    });

  test(`${n} worktree_create resolving to one path: one succeeds, one active row, one git worktree`,
    { skip: skipWithoutLedger, timeout: 180000 }, async t => {
      const s = await setup(t, n);
      const results = await s.race(i => ({ branch: spelling(i) }));
      await assertExclusive(results, s, n, 'path');
    });
}

// The store refuses a second active row on its own, whatever the callers checked beforehand: the
// same insert from N processes, as production does it (one write transaction), reaches the v9
// partial UNIQUE indexes directly. Needs no git and no ledger.
for (const n of SIZES) {
  for (const [label, index, rowFor] of [
    ['branch', 'worktrees.branch', i => ({ branch: 'agent/one', path: `/wt/path-${i}` })],
    ['path', 'worktrees.path', i => ({ branch: `agent/b-${i}`, path: '/wt/one' })]
  ]) {
    test(`${n} store inserts of one ${label}: one active row, the rest refused by the ${label} index`, { timeout: 120000 }, async t => {
      const stateDir = await tempStateDir(t);
      const { workers } = await startWorkers(stateDir, '/nonexistent', n, { project: 'drop' });
      t.after(() => stopWorkers(workers).catch(() => {}));
      const results = await raceWorktreeInserts(workers, rowFor);
      assert.equal(results.filter(r => r.ok).length, 1, JSON.stringify(results));
      const losers = results.filter(r => !r.ok);
      assert.equal(losers.length, n - 1);
      assert.ok(losers.every(r => r.error.includes('UNIQUE constraint failed') && r.error.includes(index)), JSON.stringify(losers));
      await stopWorkers(workers);
      const store = openSqliteStore({ dir: stateDir });
      t.after(() => store.close());
      const rows = await store.transaction(repo => repo.listWorktrees({ project_id: 'drop', limit: 200 }), { write: false });
      assert.equal(rows.length, 1, JSON.stringify(rows));
      assert.equal(rows[0].status, 'active');
    });
  }
}

// A UNIQUE violation at the store is a refusal of the same kind as the checks before it, and the
// worktree git just made is taken back: no store_unavailable, no worktree, directory or branch left.
// The rows are planted straight in the store with a path (or a branch) git knows nothing about, so
// every earlier check passes and only the index can refuse.
for (const [label, expected, plant, args] of [
  ['branch', 'branch_exists', w => ({ branch: 'agent/planted', path: `${w}/elsewhere` }), { branch: 'agent/planted' }],
  ['path', 'path_exists', w => ({ branch: 'planted-other', path: `${w}/demo/agent-planted` }), { branch: 'agent/planted' }]
]) {
  test(`a live ${label} already in the store: worktree_create answers ${expected} and undoes the worktree`,
    { skip: skipWithoutLedger, timeout: 120000 }, async t => {
      await isolateGit(t);
      const github = await fakeGitHub(t, GITHUB_ISSUES);
      const g = await gitRuntime(t, { ledger: memoryLedger(Date.now), now: Date.now, gh: demoGh().gh });
      const worktreesRoot = process.env.MEMO_BRIDGE_WORKTREES_ROOT;
      const { workers } = await startWorkers(g.stateDir, github.file, 1, { project: 'demo' });
      t.after(() => stopWorkers(workers).catch(() => {}));
      // The racing worker's workspace owns the planted row (a foreign live worktree).
      workers[0].child.send({ type: 'insert_worktree', id: 'wt_planted0000000000', ...plant(worktreesRoot) });
      assert.equal((await workers[0].next('inserted_worktree')).ok, true);
      const [result] = await raceWorktrees([workers[0]], { projectsRoot: g.projectsRoot, worktreesRoot, issues: [issueOf(0)], argsFor: () => args });
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.error, expected, JSON.stringify(result));
      const repo = join(g.projectsRoot, 'demo');
      const listed = git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree '));
      assert.equal(listed.length, 1, 'git keeps only the main checkout');
      assert.deepEqual(await readdir(join(worktreesRoot, 'demo')).catch(() => []), [], 'no directory left');
      assert.equal(git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').trim(), 'main', 'the branch was taken back');
      assert.equal((await g.rt.store().transaction(r => r.listWorktrees({ project_id: 'demo', limit: 10 }), { write: false })).length, 1,
        'only the planted row');
    });
}
