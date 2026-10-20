// Reaper (autoloop REQ-C01..C06, Issue #150): remove a worktree once the work in it has landed.
//
// A worktree is removed only when every one of these holds, checked again right before removal:
// - its branch has a MERGED pull request whose head SHA is exactly the worktree HEAD, so every
//   commit in it is in the merged PR (squash merges included: the PR head is what was merged);
// - it is not locked, not in detached HEAD, no process has its cwd inside it;
// - Memo Bridge does not hold it: no active workspace owns its row and no job is active on it;
// - nothing in it was modified within the grace window (another session may be on it).
// Local edits (tracked diff, untracked files, porcelain status) are archived first; when the
// archive cannot be written the worktree is kept. Dry run is the default: nothing on disk changes
// unless `apply` is true. It never touches remote branches, never merges, never deploys.
//
// Every outside call (GitHub, lsof, the Memo Bridge store) is injected, so tests run offline.
import { execFile } from 'node:child_process';
import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { runGit } from './worktrees.mjs';
import { classifyWorktree, lifecycleDecision } from './workspace-lifecycle.mjs';

export const DEFAULT_GRACE_MS = 6 * 60 * 60_000;
export const LOCK_STALE_MS = 2 * 60 * 60_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.build', 'DerivedData', '.next',
  '.nuxt', '.turbo', '.cache', '__pycache__', '.venv', 'venv', 'coverage']);
const SCAN_LIMIT = 20_000;
const out = r => r.stdout.toString('utf8').trim();

// `git worktree list --porcelain` into records. The first record is the main checkout.
export function parseWorktreeList(text) {
  const records = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9), head: null, branch: null, detached: false, locked: false, prunable: false };
      records.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') current.detached = true;
    else if (line === 'locked' || line.startsWith('locked ')) current.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) current.prunable = true;
  }
  return records;
}

// owner/repo from a GitHub remote URL, or null for anything else.
export function githubSlug(url) {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1] : null;
}

const inside = (root, candidate) => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);

// Newest mtime under a worktree, skipping regenerable directories, bounded.
export async function newestMtime(dir) {
  let newest = 0; let seen = 0;
  const stack = [dir];
  while (stack.length && seen < SCAN_LIMIT) {
    const current = stack.pop();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > SCAN_LIMIT) break;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(path);
        continue;
      }
      try { newest = Math.max(newest, (await lstat(path)).mtimeMs); } catch { /* vanished */ }
    }
  }
  return newest;
}

// Decide for one worktree. Pure given its inputs, so every refusal is unit-testable.
export function decide({ wt, pr, dirty, busy, inUse, newest, now, graceMs }) {
  if (wt.locked) return { action: 'keep', reason: 'locked' };
  if (wt.detached || !wt.branch) return { action: 'keep', reason: 'detached_head' };
  if (inUse) return { action: 'keep', reason: 'cwd_in_use' };
  if (busy) return { action: 'keep', reason: busy };
  if (!pr) return { action: 'keep', reason: 'no_pr' };
  if (pr.state !== 'MERGED') return { action: 'keep', reason: `pr_${String(pr.state).toLowerCase()}` };
  if (pr.headRefOid !== wt.head) return { action: 'keep', reason: 'head_differs_from_merged_pr' };
  // graceMs 0 disables the window (file mtimes can round past `now`).
  if (graceMs > 0 && now - newest < graceMs) return { action: 'keep', reason: 'modified_within_grace' };
  return { action: dirty ? 'archive_and_remove' : 'remove', reason: `merged_pr_${pr.number}` };
}

// True when the worktree's `.git` file points at a gitdir that no longer exists, which is what a
// moved repository leaves behind (`git worktree repair` from the new location fixes it).
export async function brokenGitdir(worktreePath) {
  let text;
  try { text = await readFile(join(worktreePath, '.git'), 'utf8'); } catch { return false; }
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (!match) return false;
  try { await lstat(resolve(worktreePath, match[1].trim())); return false; } catch { return true; }
}

async function archive(wt, archiveDir, slug, env) {
  const name = `${slug}-${wt.branch}`.replace(/[^A-Za-z0-9._-]/g, '_');
  await mkdir(archiveDir, { recursive: true, mode: 0o700 });
  const status = await runGit(wt.path, ['status', '--porcelain'], { env });
  const diff = await runGit(wt.path, ['diff', 'HEAD', '--binary'], { env, maxBytes: 64 * 1024 * 1024 });
  if (status.code !== 0 || diff.code !== 0 || diff.truncated) throw new Error('archive_git_failed');
  await writeFile(join(archiveDir, `${name}.status`), status.stdout, { mode: 0o600 });
  await writeFile(join(archiveDir, `${name}.diff`), diff.stdout, { mode: 0o600 });
  const untracked = await runGit(wt.path, ['ls-files', '--others', '--exclude-standard', '-z'], { env });
  if (untracked.code !== 0) throw new Error('archive_git_failed');
  if (untracked.stdout.length) {
    await new Promise((ok, fail) => {
      const child = execFile('tar', ['--null', '-T', '-', '-czf', join(archiveDir, `${name}.untracked.tar.gz`)],
        { cwd: wt.path }, error => (error ? fail(new Error('archive_tar_failed')) : ok()));
      child.stdin.end(untracked.stdout);
    });
  }
  return name;
}

// Reap one repository. `deps.prForBranch(slug, branch)` returns { number, state, headRefOid } or null.
export async function reapRepository(repoPath, deps, options = {}) {
  const { apply = false, now = Date.now(), graceMs = DEFAULT_GRACE_MS, archiveDir, env = process.env, policy } = options;
  const report = [];
  const remote = await runGit(repoPath, ['remote', 'get-url', 'origin'], { env, readOnly: true });
  const slug = remote.code === 0 ? githubSlug(out(remote)) : null;
  if (!slug) return [{ repo: repoPath, action: 'skip', reason: 'no_github_origin' }];
  const list = await runGit(repoPath, ['worktree', 'list', '--porcelain'], { env, readOnly: true });
  if (list.code !== 0) return [{ repo: slug, action: 'skip', reason: 'worktree_list_failed' }];
  const [, ...worktrees] = parseWorktreeList(out(list));
  const cwds = await deps.cwdsInUse();
  let removedAny = false;
  for (const wt of worktrees) {
    const entry = { repo: slug, path: wt.path, branch: wt.branch };
    if (wt.prunable) {
      const mode = policy === undefined ? 'ephemeral' : classifyWorktree({ project: slug, branch: wt.branch, policy }).mode;
      if (mode !== 'ephemeral') report.push({ ...entry, action: 'keep', reason: 'prunable_requires_explicit_ephemeral_policy', mode });
      else { report.push({ ...entry, action: 'prune', reason: 'missing_directory', mode }); removedAny = true; }
      continue;
    }
    const status = await runGit(wt.path, ['status', '--porcelain'], { env, readOnly: true });
    if (status.code !== 0) {
      report.push({ ...entry, action: 'keep', reason: (await brokenGitdir(wt.path)) ? 'broken_gitdir' : 'status_failed' });
      continue;
    }
    const dirty = out(status).length > 0;
    const pr = wt.branch && !wt.detached ? await deps.prForBranch(slug, wt.branch) : null;
    const decision = decide({
      wt, pr, dirty,
      busy: await deps.bridgeHolds(wt.path),
      inUse: [...cwds].some(cwd => inside(resolve(wt.path), resolve(cwd))),
      newest: await newestMtime(wt.path), now, graceMs
    });
    const guarded = policy === undefined ? decision : lifecycleDecision({ classification: classifyWorktree({ project: slug, branch: wt.branch, policy }), cleanup: decision });
    const row = { ...entry, ...guarded, ...(pr ? { pr: pr.number } : {}) };
    if (guarded.action === 'keep' || !apply) { report.push(row); continue; }
    // Re-check HEAD right before acting: the state may have moved since the decision.
    const head = await runGit(wt.path, ['rev-parse', 'HEAD'], { env, readOnly: true });
    if (out(head) !== wt.head) { report.push({ ...row, action: 'keep', reason: 'head_moved' }); continue; }
    if (dirty) {
      try { row.archive = await archive(wt, archiveDir, slug, env); } catch (error) {
        report.push({ ...row, action: 'keep', reason: error.message }); continue;
      }
    }
    const removed = await runGit(repoPath, ['worktree', 'remove', ...(dirty ? ['--force'] : []), wt.path], { env });
    if (removed.code !== 0) { report.push({ ...row, action: 'keep', reason: 'worktree_remove_failed' }); continue; }
    removedAny = true;
    await deps.markRemoved?.(wt.path, now);
    // The branch tip is the merged PR head, so deleting the local ref loses nothing.
    const tip = await runGit(repoPath, ['rev-parse', `refs/heads/${wt.branch}`], { env, readOnly: true });
    if (out(tip) === pr.headRefOid) {
      const del = await runGit(repoPath, ['branch', '-D', '--', wt.branch], { env });
      row.branch_deleted = del.code === 0;
    }
    report.push({ ...row, action: dirty ? 'archived_and_removed' : 'removed' });
  }
  if (apply && removedAny && policy === undefined) await runGit(repoPath, ['worktree', 'prune'], { env });
  return report;
}

// One run at a time per state directory. A lock older than LOCK_STALE_MS is taken over.
export function acquireLock(path, now = Date.now()) {
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeSync(fd, `${process.pid} ${now}\n`);
    closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let age = 0;
    try { age = now - statSync(path).mtimeMs; } catch { return acquireLock(path, now); }
    if (age < LOCK_STALE_MS) return null;
    unlinkSync(path);
    return acquireLock(path, now);
  }
  return () => { try { unlinkSync(path); } catch { /* already gone */ } };
}

// ---------------------------------------------------------------------------------------------
// Real dependencies.

const execText = (file, args, timeout = 30_000) => new Promise(ok => {
  execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => ok(error && !stdout ? null : stdout));
});

// gh, read-only. Any failure means "unknown", which keeps the worktree.
export function githubPrLookup({ gh = 'gh' } = {}) {
  const cache = new Map();
  return async (slug, branch) => {
    const key = `${slug}\n${branch}`;
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        const text = await execText(gh, ['pr', 'list', '-R', slug, '--head', branch, '--state', 'all',
          '--json', 'number,state,headRefOid', '--limit', '5']);
        if (!text) return null;
        let rows;
        try { rows = JSON.parse(text); } catch { return null; }
        // A merged PR wins over a later closed or open one for the same branch name.
        return rows.find(r => r.state === 'MERGED') ?? rows[0] ?? null;
      })());
    }
    return cache.get(key);
  };
}

// Current working directories of every process the user can see (lsof). Unknown means "in use".
export function lsofCwds({ lsof = '/usr/sbin/lsof' } = {}) {
  return async () => {
    const text = await execText(lsof, ['-Fn', '-d', 'cwd', '-w'], 30_000);
    if (text === null) return new Set(['/']);
    return new Set(text.split('\n').filter(l => l.startsWith('n/')).map(l => l.slice(1)));
  };
}

// Memo Bridge holds a worktree when its row is active and its workspace is active, or a job is active on it.
// `store` is openSqliteStore(): repository methods are reached through store.transaction(fn).
export function storeHolds(store, activeStatuses) {
  const active = new Set(activeStatuses);
  const rowFor = (repo, path) => repo.listWorktrees({ status: 'active', limit: 10_000 })
    .find(r => resolve(r.path) === resolve(path)) ?? null;
  return {
    bridgeHolds: path => store.transaction(repo => {
      const row = rowFor(repo, path);
      if (!row) return null;
      if (repo.getWorkspace(row.workspace_id)?.status === 'active') return 'bridge_workspace_active';
      const jobs = repo.listJobs({ workspace_id: row.workspace_id, limit: 500 });
      if (jobs.some(j => j.worktree_id === row.id && active.has(j.status))) return 'bridge_job_active';
      return null;
    }, { write: false }),
    markRemoved: (path, now) => store.transaction(repo => {
      const row = rowFor(repo, path);
      if (row) repo.updateWorktree(row.id, { status: 'removed', removed_at: now, updated_at: now });
    })
  };
}
