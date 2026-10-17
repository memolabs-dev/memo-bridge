// Reaper (#150): temporary repositories with real git worktrees; GitHub, lsof and the Memo Bridge
// store are stubs, so nothing here touches the network, the user's state or real checkouts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, utimesSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, decide, githubSlug, parseWorktreeList, reapRepository } from '../server/runners/reaper.mjs';

const SANDBOX = await mkdtemp(join(tmpdir(), 'memo-reaper-gitconfig-'));
await writeFile(join(SANDBOX, 'gitconfig'), [
  '[user]', '\tname = Test Owner', '\temail = owner@example.test',
  '[init]', '\tdefaultBranch = main',
  '[commit]', '\tgpgsign = false', ''
].join('\n'));
process.env.GIT_CONFIG_GLOBAL = join(SANDBOX, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE']) {
  delete process.env[name];
}
test.after(() => rm(SANDBOX, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const SLUG = 'acme/demo';

// A repository with one worktree on `feat/x` holding one commit. Returns paths and the HEAD.
async function fixture(t, { branch = 'feat/x' } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'memo-reaper-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'remote', 'add', 'origin', `https://github.com/${SLUG}.git`);
  await writeFile(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
  const wt = join(base, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt);
  await writeFile(join(wt, 'b.txt'), 'two\n');
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'work');
  const head = git(wt, 'rev-parse', 'HEAD');
  return { base, repo, wt, head, branch, archiveDir: join(base, 'archive') };
}

// Stubs. `pr` is what GitHub would say for the branch.
const deps = ({ pr = null, cwds = [], busy = null } = {}) => {
  const marked = [];
  return {
    marked,
    prForBranch: async () => pr,
    cwdsInUse: async () => new Set(cwds),
    bridgeHolds: async () => busy,
    markRemoved: async path => { marked.push(path); }
  };
};
const merged = head => ({ number: 7, state: 'MERGED', headRefOid: head });
const branches = repo => git(repo, 'branch', '--format=%(refname:short)').split('\n');
const snapshot = dir => execFileSync('find', [dir, '-path', '*/.git', '-prune', '-o', '-print'], { encoding: 'utf8' })
  .split('\n').sort().join('\n');

test('AC-C01: merged PR with HEAD equal to its head: worktree and local branch removed', async t => {
  const f = await fixture(t);
  const d = deps({ pr: merged(f.head) });
  const report = await reapRepository(f.repo, d, { apply: true, graceMs: 0, archiveDir: f.archiveDir });
  assert.equal(report.length, 1);
  assert.equal(report[0].action, 'removed');
  assert.equal(report[0].branch_deleted, true);
  assert.equal(existsSync(f.wt), false);
  assert.ok(!git(f.repo, 'worktree', 'list').includes(f.wt));
  assert.ok(!branches(f.repo).includes(f.branch));
  assert.deepEqual(d.marked, [f.wt]);
});

test('AC-C04: dry run changes nothing on disk', async t => {
  const f = await fixture(t);
  await writeFile(join(f.wt, 'a.txt'), 'edited\n');
  const before = snapshot(f.base) + git(f.repo, 'worktree', 'list') + branches(f.repo).join();
  const report = await reapRepository(f.repo, deps({ pr: merged(f.head) }), { apply: false, graceMs: 0, archiveDir: f.archiveDir });
  assert.equal(report[0].action, 'archive_and_remove');
  assert.equal(snapshot(f.base) + git(f.repo, 'worktree', 'list') + branches(f.repo).join(), before);
  assert.equal(existsSync(f.archiveDir), false);
});

test('AC-C02: local edits are archived (diff, untracked, status) before removal', async t => {
  const f = await fixture(t);
  await writeFile(join(f.wt, 'a.txt'), 'edited\n');
  await writeFile(join(f.wt, 'NOTES.md'), 'agent notes\n');
  const report = await reapRepository(f.repo, deps({ pr: merged(f.head) }), { apply: true, graceMs: 0, archiveDir: f.archiveDir });
  assert.equal(report[0].action, "archived_and_removed", JSON.stringify(report[0]));
  assert.equal(existsSync(f.wt), false);
  const files = readdirSync(f.archiveDir).sort();
  const name = 'acme_demo-feat_x';
  assert.deepEqual(files, [`${name}.diff`, `${name}.status`, `${name}.untracked.tar.gz`]);
  assert.match(await readFile(join(f.archiveDir, `${name}.diff`), 'utf8'), /\+edited/);
  assert.match(await readFile(join(f.archiveDir, `${name}.status`), 'utf8'), /NOTES\.md/);
  const listing = execFileSync('tar', ['-tzf', join(f.archiveDir, `${name}.untracked.tar.gz`)], { encoding: 'utf8' });
  assert.match(listing, /NOTES\.md/);
});

test('AC-C02: when the archive cannot be written the worktree is kept', async t => {
  const f = await fixture(t);
  await writeFile(join(f.wt, 'a.txt'), 'edited\n');
  const blocker = join(f.base, 'not-a-dir');
  await writeFile(blocker, 'file');
  const report = await reapRepository(f.repo, deps({ pr: merged(f.head) }), { apply: true, graceMs: 0, archiveDir: join(blocker, 'x') });
  assert.equal(report[0].action, 'keep');
  assert.equal(existsSync(join(f.wt, 'a.txt')), true);
  assert.ok(branches(f.repo).includes(f.branch));
});

const KEEP_CASES = [
  ['open PR', { pr: { number: 7, state: 'OPEN', headRefOid: 'x' } }, 'pr_open'],
  ['closed PR', { pr: { number: 7, state: 'CLOSED', headRefOid: 'x' } }, 'pr_closed'],
  ['no PR', { pr: null }, 'no_pr'],
  ['HEAD ahead of merged head', { pr: merged('0'.repeat(40)) }, 'head_differs_from_merged_pr'],
  ['Memo Bridge workspace active', { busy: 'bridge_workspace_active', merged: true }, 'bridge_workspace_active'],
  ['process cwd inside', { cwdInside: true, merged: true }, 'cwd_in_use']
];
for (const [label, setup, reason] of KEEP_CASES) {
  test(`AC-C03: kept when ${label}`, async t => {
    const f = await fixture(t);
    const d = deps({
      pr: setup.merged ? merged(f.head) : setup.pr,
      busy: setup.busy ?? null,
      cwds: setup.cwdInside ? [join(f.wt, 'sub')] : []
    });
    const report = await reapRepository(f.repo, d, { apply: true, graceMs: 0, archiveDir: f.archiveDir });
    assert.equal(report[0].action, 'keep');
    assert.equal(report[0].reason, reason);
    assert.equal(existsSync(f.wt), true);
    assert.ok(branches(f.repo).includes(f.branch));
  });
}

test('AC-C03: kept when locked', async t => {
  const f = await fixture(t);
  git(f.repo, 'worktree', 'lock', f.wt);
  const report = await reapRepository(f.repo, deps({ pr: merged(f.head) }), { apply: true, graceMs: 0, archiveDir: f.archiveDir });
  assert.equal(report[0].reason, 'locked');
  assert.equal(existsSync(f.wt), true);
});

test('AC-C03: kept when modified within the grace window', async t => {
  const f = await fixture(t);
  const report = await reapRepository(f.repo, deps({ pr: merged(f.head) }), { apply: true, graceMs: 3_600_000, archiveDir: f.archiveDir });
  assert.equal(report[0].reason, 'modified_within_grace');
  assert.equal(existsSync(f.wt), true);
});

test('AC-C03: old files pass the grace window', async t => {
  const f = await fixture(t);
  const old = new Date(Date.now() - 48 * 3_600_000);
  for (const name of ['a.txt', 'b.txt', '.git']) utimesSync(join(f.wt, name), old, old);
  const report = await reapRepository(f.repo, deps({ pr: merged(f.head) }), { apply: true, graceMs: 24 * 3_600_000, archiveDir: f.archiveDir });
  assert.equal(report[0].action, 'removed');
});

test('AC-C03: kept when HEAD is detached', async t => {
  const f = await fixture(t);
  git(f.wt, 'checkout', '-q', '--detach');
  const report = await reapRepository(f.repo, deps({ pr: merged(f.head) }), { apply: true, graceMs: 0, archiveDir: f.archiveDir });
  assert.equal(report[0].reason, 'detached_head');
  assert.equal(existsSync(f.wt), true);
});

test('AC-C05: a worktree whose directory vanished is pruned', async t => {
  const f = await fixture(t);
  await rm(f.wt, { recursive: true, force: true });
  const report = await reapRepository(f.repo, deps(), { apply: true, graceMs: 0, archiveDir: f.archiveDir });
  assert.equal(report[0].action, 'prune');
  assert.ok(!git(f.repo, 'worktree', 'list').includes(f.wt));
});

test('a repository without a GitHub origin is skipped', async t => {
  const f = await fixture(t);
  git(f.repo, 'remote', 'set-url', 'origin', 'https://gitlab.example/acme/demo.git');
  const report = await reapRepository(f.repo, deps({ pr: merged(f.head) }), { apply: true, graceMs: 0, archiveDir: f.archiveDir });
  assert.deepEqual(report.map(r => r.reason), ['no_github_origin']);
  assert.equal(existsSync(f.wt), true);
});

test('AC-C05: a second concurrent run is refused, a stale lock is taken over', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'memo-reaper-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'reaper.lock');
  const release = acquireLock(path);
  assert.equal(typeof release, 'function');
  assert.equal(acquireLock(path), null);
  assert.equal(typeof acquireLock(path, Date.now() + 3 * 3_600_000), 'function');
  release();
});

test('parsers: worktree list, GitHub slug, decide order', () => {
  const rows = parseWorktreeList([
    'worktree /r', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree /w1', 'HEAD bbb', 'branch refs/heads/feat/x', 'locked reason here', '',
    'worktree /w2', 'HEAD ccc', 'detached', '',
    'worktree /w3', 'HEAD ddd', 'branch refs/heads/y', 'prunable gitdir file points to non-existent location', ''
  ].join('\n'));
  assert.deepEqual(rows.map(r => [r.path, r.branch, r.locked, r.detached, r.prunable]), [
    ['/r', 'main', false, false, false], ['/w1', 'feat/x', true, false, false],
    ['/w2', null, false, true, false], ['/w3', 'y', false, false, true]
  ]);
  assert.equal(githubSlug('git@github.com:memolabs-dev/drop.git'), 'memolabs-dev/drop');
  assert.equal(githubSlug('https://github.com/guillaume-flambard/lab-infra'), 'guillaume-flambard/lab-infra');
  assert.equal(githubSlug('https://gitlab.com/a/b.git'), null);
  const wt = { locked: false, detached: false, branch: 'b', head: 'h' };
  assert.equal(decide({ wt, pr: { state: 'MERGED', headRefOid: 'h', number: 1 }, dirty: false, busy: null, inUse: false,
    newest: 0, now: 10, graceMs: 5 }).action, 'remove');
  assert.equal(decide({ wt: { ...wt, locked: true }, pr: null, dirty: false, busy: 'x', inUse: true, newest: 0, now: 0, graceMs: 0 }).reason, 'locked');
});
