// operator_snapshot (T0, repatriated SentinelX project_snapshot, spec D5): a one-call orientation
// of any directory inside the host's read roots, registered project or not.
//
//  - git state through fixed argv (rev-parse, status --porcelain=v2, log), with
//    GIT_OPTIONAL_LOCKS=0, no system or global config (no HOME), core.fsmonitor and
//    log.showSignature forced off, submodules ignored. git's own safe.directory check is kept on
//    purpose: in a repository owned by another user, git refuses to read its config (filters,
//    fsmonitor could run a program), so the snapshot falls back to reading .git/HEAD as a file;
//  - a tree summary without following symlinks: top entries with their file counts and sizes,
//    extension counts, totals, project markers; noise directories skipped, secret paths skipped
//    and counted; bounded in depth, entries and time;
//  - the head of the README, as untrusted_content (the agent redacts and bounds the result).
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { createDenylist, catalogProjects, resolveOperatorPath } from './operator-paths.mjs';
import { NOISE_DIRS, SAFE_ENV, runArgv } from './operator-tools.mjs';
import { untrusted } from './operator-output.mjs';

export const SNAPSHOT_LIMITS = Object.freeze({ depth: 4, entries: 20_000, budgetMs: 5_000, topEntries: 60, extensions: 20,
  readmeBytes: 4096, commits: 10, gitTimeoutMs: 10_000, gitMaxBytes: 2 * 1024 * 1024, changedListed: 50 });
const README_NAMES = Object.freeze(['README.md', 'README', 'readme.md', 'Readme.md', 'README.rst', 'README.txt']);
const MARKERS = Object.freeze(['package.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod',
  'Package.swift', 'Gemfile', 'pom.xml', 'build.gradle', 'Makefile', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'compose.yml', 'compose.yaml', 'AGENTS.md', 'CLAUDE.md', '.github']);
export const GIT_ENV = Object.freeze({ ...SAFE_ENV, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

// Parse `git status --porcelain=v2 --branch`.
export function parseStatusV2(text) {
  const out = { head: null, branch: null, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, changed: [] };
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.oid ')) out.head = line.slice(13) === '(initial)' ? null : line.slice(13);
    else if (line.startsWith('# branch.head ')) out.branch = line.slice(14) === '(detached)' ? null : line.slice(14);
    else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /^\+(\d+) -(\d+)$/.exec(line.slice(12));
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4);
      if (xy[0] !== '.') out.staged++;
      if (xy[1] !== '.') out.unstaged++;
      const path = line.startsWith('1 ') ? line.split(' ').slice(8).join(' ') : line.split(' ').slice(9).join(' ').split('\t')[0];
      if (out.changed.length < SNAPSHOT_LIMITS.changedListed) out.changed.push({ xy, path });
    } else if (line.startsWith('u ')) out.conflicts++;
    else if (line.startsWith('? ')) {
      out.untracked++;
      if (out.changed.length < SNAPSHOT_LIMITS.changedListed) out.changed.push({ xy: '??', path: line.slice(2) });
    }
  }
  return out;
}

export function createSnapshotTool(policy, { run = runArgv, projects = catalogProjects(policy.repositories), now = Date.now } = {}) {
  const denylist = createDenylist(policy);
  const resolve = raw => resolveOperatorPath(policy, raw, { access: 'r', denylist, projects });
  const git = (dir, args) => run(['git', '-C', dir, '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', ...args],
    { timeoutMs: SNAPSHOT_LIMITS.gitTimeoutMs, maxBytes: SNAPSHOT_LIMITS.gitMaxBytes, env: GIT_ENV });

  // .git/HEAD read as a file (no git): the branch or the detached commit.
  async function headFromFile(top) {
    try {
      const fh = await open(join(top, '.git', 'HEAD'), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const text = (await fh.read(Buffer.alloc(512), 0, 512, 0)).buffer.toString('utf8').split('\0')[0].trim();
        const m = /^ref: refs\/heads\/(.{1,200})$/.exec(text);
        return m ? { branch: m[1], head: null } : /^[0-9a-f]{40,64}$/.test(text) ? { branch: null, head: text } : null;
      } finally { await fh.close(); }
    } catch { return null; }
  }

  async function gitState(dir) {
    const top = await git(dir, ['rev-parse', '--show-toplevel']);
    if (top.code === null) return { available: false, reason: 'git_unavailable' };
    if (top.code !== 0) {
      if (/dubious ownership/i.test(top.stderr)) {
        // Owned by another user: git will not read its config, and neither do we. HEAD only.
        let up = dir;
        for (let i = 0; i < 40; i++) {
          const head = await headFromFile(up);
          if (head) return { repository: true, root: up, ...head, partial: 'owned_by_another_user', detail: 'branch read from .git/HEAD only' };
          const parent = dirname(up);
          if (parent === up) break;
          up = parent;
        }
        return { repository: true, partial: 'owned_by_another_user' };
      }
      return { repository: false };
    }
    const root = top.stdout.trim();
    const status = await git(dir, ['status', '--porcelain=v2', '--branch', '--ignore-submodules=all', '--untracked-files=normal']);
    const log = await git(dir, ['log', `-n${SNAPSHOT_LIMITS.commits}`, '--no-show-signature', '--format=%h%x1f%an%x1f%aI%x1f%s']);
    const parsed = status.code === 0 ? parseStatusV2(status.stdout) : null;
    const commits = log.code === 0 ? log.stdout.split('\n').filter(Boolean).map(line => {
      const [sha, author, date, subject] = line.split(String.fromCharCode(0x1f));
      return { sha, author, date, subject: (subject ?? '').slice(0, 200) };
    }) : [];
    const { changed = [], ...state } = parsed ?? {};
    return { repository: true, root, ...state, ...(parsed ? {} : { status_error: status.timedOut ? 'timeout' : 'failed' }),
      dirty: parsed ? parsed.staged + parsed.unstaged + parsed.untracked + parsed.conflicts > 0 : null,
      ...untrusted({ changed, recent_commits: commits }) };
  }

  async function tree(dir) {
    const deadline = now() + SNAPSHOT_LIMITS.budgetMs;
    const top = new Map(); const extensions = new Map();
    const totals = { files: 0, dirs: 0, bytes: 0, symlinks: 0 };
    let secretSkipped = 0; let seen = 0; let stopped = null;
    const noise = new Set();
    const queue = [[dir, 0, null]];
    while (queue.length && !stopped) {
      const [current, level, topName] = queue.shift();
      let entries;
      try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (now() > deadline) { stopped = 'time_budget'; break; }
        if (++seen > SNAPSHOT_LIMITS.entries) { stopped = 'max_entries'; break; }
        const full = join(current, entry.name);
        if (denylist.denied(full)) { secretSkipped++; continue; }
        const owner = topName ?? entry.name;
        if (level === 0) top.set(entry.name, { name: entry.name, type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other', files: 0, bytes: 0 });
        if (entry.isDirectory()) {
          if (NOISE_DIRS.has(entry.name)) { noise.add(entry.name); continue; }
          totals.dirs++;
          if (level + 1 < SNAPSHOT_LIMITS.depth) queue.push([full, level + 1, owner]);
        } else if (entry.isSymbolicLink()) totals.symlinks++;
        else if (entry.isFile()) {
          let size = 0;
          try { size = (await lstat(full)).size; } catch { /* vanished */ }
          totals.files++; totals.bytes += size;
          const ext = extname(entry.name).toLowerCase() || '(none)';
          extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
          const t = top.get(owner);
          if (t) { t.files++; t.bytes += size; }
        }
      }
    }
    return { totals, depth: SNAPSHOT_LIMITS.depth, truncated: stopped, secret_entries_skipped: secretSkipped,
      noise_dirs_skipped: [...noise].sort(),
      extensions: [...extensions].sort((a, b) => b[1] - a[1]).slice(0, SNAPSHOT_LIMITS.extensions).map(([ext, files]) => ({ ext, files })),
      top: [...top.values()].slice(0, SNAPSHOT_LIMITS.topEntries), top_truncated: top.size > SNAPSHOT_LIMITS.topEntries };
  }

  async function readme(dir) {
    for (const name of README_NAMES) {
      const full = join(dir, name);
      if (denylist.denied(full)) continue;
      let fh;
      try { fh = await open(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0)); } catch { continue; }
      try {
        const info = await fh.stat();
        if (!info.isFile()) continue;
        const buf = Buffer.alloc(Math.min(SNAPSHOT_LIMITS.readmeBytes, info.size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const slice = buf.subarray(0, bytesRead);
        if (slice.includes(0)) continue;
        return { name, size: info.size, truncated: info.size > bytesRead, text: slice.toString('utf8') };
      } finally { await fh.close(); }
    }
    return null;
  }

  return {
    async operator_snapshot({ path }) {
      const at = await resolve(path);
      if (!at.ok) return at;
      const info = await lstat(at.path);
      if (!info.isDirectory()) return fail('not_a_directory');
      const [gitInfo, treeInfo, head] = [await gitState(at.path), await tree(at.path), await readme(at.path)];
      const markers = treeInfo.top.filter(e => MARKERS.includes(e.name)).map(e => e.name);
      return { ok: true, host: policy.host, path: at.path, kind: gitInfo.repository ? 'git_repository' : 'directory', markers,
        git: gitInfo, tree: treeInfo, ...(head ? { readme: { name: head.name, size: head.size, truncated: head.truncated, ...untrusted({ head: head.text }) } } : {}),
        next: 'operator_read a file, operator_list a subdirectory, operator_search for a symbol' };
    }
  };
}
