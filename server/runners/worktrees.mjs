// Isolated Git worktrees for workspaces (Phase 3, Mac runner).
//
// A workspace (ws_...) gets its own worktree of a registered repository, on its own branch,
// under ~/projects/_worktrees/<project>/<branch>. Models read, list and write files only inside
// that worktree, then commit and push the branch. Rules enforced here:
// - the worktree belongs to the workspace's principal, and writes need an active workspace;
// - repository writes need a live claim on the worktree's Issue (local mirror on every write;
//   at commit and push, the ledger verifies worker, claim and fence immediately before);
// - never the default branch, never main or master, never --force, never a merge;
// - no shell: git runs with fixed argv arrays, hooks disabled (a model can write files a
//   hook path could point to), external diff drivers and textconv disabled;
// - every path stays inside the worktree after realpath, and never under .git;
// - every output is bounded, and text returned to models has control and bidi characters
//   replaced.
// Authorization and audit happen in server/tools/worktree-tools.mjs before these functions run.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { projectInfo } from '../catalog.mjs';
import { COMMIT_RE, validBranch } from '../coordinator/checkpoints.mjs';
import { workerFor } from '../coordinator/index.mjs';
import { parseIssueRef } from '../coordinator/issue-lease.mjs';
import { ownsWorkspace } from '../coordinator/policy.mjs';

export const LIMITS = Object.freeze({
  readBytes: 256 * 1024,
  writeBytes: 512 * 1024,
  diffBytes: 200 * 1024,
  statBytes: 32 * 1024,
  listDefault: 500,
  listMax: 5000,
  statusEntries: 200,
  messageChars: 4000,
  pathChars: 1024,
  trackedFiles: 2000
});

export const WT_RE = /^wt_[A-Za-z0-9_-]{16}$/;
const WS_RE = /^ws_[A-Za-z0-9_-]{16}$/;
const PROTECTED = new Set(['main', 'master']);
const GIT_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000;

const fail = (error, detail) => ({ ok: false, error, ...(detail !== undefined ? { detail } : {}) });
const iso = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

// ---------------------------------------------------------------------------------------------
// Text returned to models.

// C0 controls (tab, newline and carriage return are kept in file text), DEL, C1 controls and
// the bidirectional overrides/isolates/marks used by "Trojan Source" attacks.
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const UNSAFE_LINE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Multi-line text (file content, diffs): unsafe characters become U+FFFD and are counted, so
// the caller knows the text it sees is not byte-for-byte the file.
export function cleanText(value) {
  let replaced = 0;
  const text = String(value).replace(UNSAFE_TEXT, () => { replaced++; return '\ufffd'; });
  return { text, replaced };
}
// One-line text (paths, commit subjects, author names).
export function cleanLine(value, max = 300) {
  return String(value).replace(UNSAFE_LINE, '\ufffd').slice(0, max);
}

// End of the last complete UTF-8 character in buffer[start, end).
function utf8End(buffer, start, end) {
  let lead = end - 1; let continuation = 0;
  while (lead > start && continuation < 3 && (buffer[lead] & 0xc0) === 0x80) { lead--; continuation++; }
  const byte = buffer[lead];
  const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return continuation + 1 >= length ? end : lead;
}

// ---------------------------------------------------------------------------------------------
// Paths.

// Characters never accepted in a path argument: controls, bidi controls, zero-width and other
// ignorable code points (HFS+ ignores some of them, which once let ".g\u200cit" reach .git),
// and backslashes (no Windows spelling).
const BAD_PATH_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\\]/;
const isGitName = part => part.replace(/[. ]+$/, '').toLowerCase() === '.git';

// Normalize a relative path argument. Returns '' for the worktree root when allowed, the
// normalized relative path, or null when the value is refused.
export function normalizeRelPath(value, { allowRoot = false } = {}) {
  if (value === undefined || value === null || value === '' || value === '.') return allowRoot ? '' : null;
  if (typeof value !== 'string' || value.length > LIMITS.pathChars || BAD_PATH_CHARS.test(value)) return null;
  if (value.startsWith('/') || value.startsWith('~')) return null;
  const parts = value.split('/').filter(part => part !== '' && part !== '.');
  if (!parts.length) return allowRoot ? '' : null;
  if (parts.some(part => part === '..' || isGitName(part))) return null;
  return parts.join('/');
}

// True when `candidate` (a real path) is `root` or below it, and not inside any .git entry.
export function insideWorktree(root, candidate) {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return false;
  return !rel.split(sep).some(isGitName);
}

// The worktree directory, resolved. Fails when it disappeared from disk.
async function worktreeRoot(row) {
  try {
    const root = await realpath(row.path);
    if (!(await stat(root)).isDirectory()) return { error: fail('worktree_missing') };
    return { root };
  } catch {
    return { error: fail('worktree_missing') };
  }
}

// Resolve an existing entry inside the worktree, following symlinks, and refuse escapes.
async function resolveExisting(root, rel) {
  let real;
  try { real = await realpath(join(root, rel)); } catch { return { error: fail('not_found') }; }
  if (!insideWorktree(root, real)) return { error: fail('path_not_allowed', 'outside the worktree or under .git') };
  return { real };
}

export function worktreesRoot(env = process.env) {
  const override = env.MEMO_BRIDGE_WORKTREES_ROOT;
  if (override !== undefined && override !== '') return isAbsolute(override) ? resolve(override) : null;
  return join(homedir(), 'projects', '_worktrees');
}

// ---------------------------------------------------------------------------------------------
// Git, without a shell.

// Every invocation disables hooks and the fsmonitor hook: a hook path such as .husky can point
// into the worktree, where a model writes files, and running it would be arbitrary execution.
const GIT_SAFETY = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

// Run git with a fixed argv. stdout is kept up to maxBytes (then the process is killed and
// `truncated` is set); stderr is kept up to 16 KiB and never returned to models as is.
export function runGit(cwd, args, { timeoutMs = GIT_TIMEOUT_MS, maxBytes = 1024 * 1024, readOnly = false, env = process.env } = {}) {
  return new Promise(resolvePromise => {
    const chunks = []; let size = 0; let stderr = ''; let truncated = false; let timedOut = false;
    const child = spawn('git', ['-C', cwd, ...GIT_SAFETY, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_LITERAL_PATHSPECS: '1',
        ...(readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {})
      }
    });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => {
      if (truncated) return;
      if (size + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size));
        size = maxBytes; truncated = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk); size += chunk.length;
    });
    child.stderr.on('data', chunk => { if (stderr.length < 16384) stderr += chunk; });
    child.on('error', () => { clearTimeout(timer); resolvePromise({ code: -1, stdout: Buffer.alloc(0), stderr: '', truncated: false, timedOut: false }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr, truncated, timedOut });
    });
  });
}
const out = r => r.stdout.toString('utf8').trim();

async function revParse(cwd, ref, env) {
  const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { readOnly: true, env, maxBytes: 200 });
  return r.code === 0 ? out(r) : null;
}
async function refExists(cwd, ref, env) {
  const r = await runGit(cwd, ['show-ref', '--verify', '--quiet', ref], { readOnly: true, env, maxBytes: 200 });
  return r.code === 0;
}
async function currentBranch(cwd, env) {
  const r = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { readOnly: true, env, maxBytes: 400 });
  return r.code === 0 ? out(r) : null;
}

// The remote's default branch, from the local origin/HEAD, else origin/main or origin/master.
async function defaultBranch(cwd, env) {
  const head = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { readOnly: true, env, maxBytes: 400 });
  if (head.code === 0 && out(head).startsWith('origin/')) return out(head).slice('origin/'.length);
  for (const name of ['main', 'master']) {
    if (await refExists(cwd, `refs/remotes/origin/${name}`, env)) return name;
  }
  return null;
}

// "<behind> <ahead>" of HEAD relative to `ref`.
async function aheadBehind(cwd, ref, env) {
  const r = await runGit(cwd, ['rev-list', '--left-right', '--count', `${ref}...HEAD`], { readOnly: true, env, maxBytes: 200 });
  if (r.code !== 0) return null;
  const [behind, ahead] = out(r).split(/\s+/).map(Number);
  return Number.isInteger(behind) && Number.isInteger(ahead) ? { ahead, behind } : null;
}

// Porcelain v1 with NUL separators, bounded. Renames and copies carry their source path.
async function statusEntries(cwd, env, max = LIMITS.statusEntries) {
  const r = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { readOnly: true, env, maxBytes: 256 * 1024 });
  if (r.code !== 0 && !r.truncated) return null;
  const fields = r.stdout.toString('utf8').split('\0');
  if (r.truncated) fields.pop(); // the last field may be cut
  const entries = []; let count = 0;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    const code = field.slice(0, 2); const path = field.slice(3);
    const entry = { status: code, path: cleanLine(path, LIMITS.pathChars), raw: path };
    if (code[0] === 'R' || code[0] === 'C') { entry.from = cleanLine(fields[i + 1] ?? '', LIMITS.pathChars); i++; }
    count++;
    if (entries.length < max) entries.push(entry);
  }
  return { entries, count, truncated: r.truncated || count > entries.length };
}

// ---------------------------------------------------------------------------------------------
// Tracking what Memo Bridge itself did in a worktree, so worktree_status can tell edits made
// outside it (an IDE, a plain git command, another tool). Kept in the private state directory,
// never in the repository: the last HEAD Memo Bridge saw or produced, and a digest of every
// file it wrote since the last commit.

const trackQueues = new Map();
function withTrack(rt, id, fn) {
  const previous = trackQueues.get(id) ?? Promise.resolve();
  const next = previous.then(async () => {
    const file = await trackFile(rt, id);
    let track = { head: null, written: {} };
    try { track = { ...track, ...JSON.parse(await readFile(file, 'utf8')) }; } catch { /* first use */ }
    const updated = await fn(track);
    if (updated) {
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmp, JSON.stringify(updated), { mode: 0o600, flag: 'wx' });
      await rename(tmp, file);
    }
    return updated ?? track;
  });
  trackQueues.set(id, next.catch(() => {}));
  return next;
}
async function trackFile(rt, id) {
  rt.store(); // opening the store validates that stateDir is private (0700, not synced, not a repo)
  const dir = join(rt.stateDir, 'worktrees');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${id}.json`);
}
const readTrack = (rt, id) => withTrack(rt, id, () => null).catch(() => ({ head: null, written: {} }));
const digest = buffer => createHash('sha256').update(buffer).digest('hex');

// ---------------------------------------------------------------------------------------------
// Public views.

// The local filesystem path never leaves the server (same rule as the Coordinator's views).
export function publicWorktree(w) {
  return {
    worktree_id: w.id, workspace_id: w.workspace_id, project: w.project_id, host: w.host,
    branch: w.branch, base_ref: w.base_ref, base_commit: w.base_commit, issue: w.issue_ref, status: w.status,
    created_at: iso(w.created_at), removed_at: iso(w.removed_at)
  };
}

// Commit messages go out under the user's name: never with an AI attribution trailer.
const MESSAGE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const AI_ATTRIBUTION = [
  /^\s*co-authored-by:.*\b(claude|anthropic|openai|chatgpt|gpt-?\d*|codex|copilot|gemini|cursor)\b/im,
  /generated (with|by) .*\b(claude|chatgpt|codex|copilot|gemini|ai)\b/i,
  /\u{1F916}/u
];
function commitMessage(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n/g, '\n').trim();
  if (!text || text.length > LIMITS.messageChars || MESSAGE_CONTROL.test(text)) return null;
  if (!text.split('\n')[0].trim()) return null;
  return text;
}

// ---------------------------------------------------------------------------------------------

export function createWorktreeRunner(rt, { env = process.env } = {}) {
  const read = fn => rt.store().transaction(repo => fn(repo), { write: false });
  const write = fn => rt.store().transaction(repo => fn(repo));
  const now = () => rt.now();

  async function ownedWorkspace(workspaceId, ctx, { requireActive = true } = {}) {
    if (typeof workspaceId !== 'string' || !WS_RE.test(workspaceId)) return { error: fail('invalid_input', 'workspace_id') };
    const workspace = await read(repo => repo.getWorkspace(workspaceId));
    if (!workspace) return { error: fail('unknown_workspace') };
    ctx.ids.workspace_id = workspace.id;
    if (!ownsWorkspace(rt.principal, workspace)) return { error: fail('forbidden') };
    if (requireActive && workspace.status !== 'active') return { error: fail('workspace_closed') };
    return { workspace };
  }

  // Owned worktree on this host. `write` also requires the workspace to be active.
  async function ownedWorktree(worktreeId, ctx, { write: forWrite = false, allowRemoved = false } = {}) {
    if (typeof worktreeId !== 'string' || !WT_RE.test(worktreeId)) return { error: fail('invalid_input', 'worktree_id') };
    const found = await read(repo => {
      const row = repo.getWorktree(worktreeId);
      return row ? { row, workspace: repo.getWorkspace(row.workspace_id) } : null;
    });
    if (!found) return { error: fail('unknown_worktree') };
    const { row, workspace } = found;
    ctx.ids.workspace_id = row.workspace_id;
    if (row.issue_ref) ctx.ids.issue = row.issue_ref;
    if (!ownsWorkspace(rt.principal, workspace)) return { error: fail('forbidden') };
    if (row.host !== rt.host) return { error: fail('wrong_host', `worktree lives on ${row.host}`) };
    if (row.status !== 'active' && !allowRemoved) return { error: fail('worktree_removed') };
    if (forWrite && workspace.status !== 'active') return { error: fail('workspace_closed') };
    return { row, workspace };
  }

  // Local mirror check: the workspace holds an unexpired claim on the worktree's Issue.
  async function liveClaim(row, workspace) {
    if (!row.issue_ref) return { error: fail('no_live_claim', 'worktree has no issue; create it with issue') };
    const claims = await read(repo => repo.claimsOf(workspace.id, 'claimed'));
    const claim = claims.find(c => c.issue_ref === row.issue_ref && Date.parse(c.expires_at) > now());
    return claim ? { claim } : { error: fail('no_live_claim') };
  }

  // Write boundary (commit, push): the ledger re-verifies worker, claim and fence.
  async function verifiedClaim(row, workspace) {
    const held = await liveClaim(row, workspace);
    if (held.error) return held;
    const verified = await rt.ledger.verify(parseIssueRef(row.issue_ref), workerFor(workspace), held.claim.claim_id, held.claim.fence_sha);
    if (!verified?.ok) return { error: verified?.error ? fail(verified.error, verified.detail) : fail('ledger_unavailable') };
    return held;
  }

  // The worktree must still be on its own branch, which is never a protected one.
  async function onOwnBranch(root, row) {
    const branch = await currentBranch(root, env);
    if (branch !== row.branch) return { error: fail('branch_changed', 'the worktree is no longer on its branch') };
    const base = await defaultBranch(root, env);
    if (PROTECTED.has(branch) || branch === base) return { error: fail('protected_branch') };
    return { branch };
  }

  return {
    async list(args, ctx) {
      if (args.workspace_id !== undefined) {
        const ws = await ownedWorkspace(args.workspace_id, ctx, { requireActive: false });
        if (ws.error) return ws.error;
        const rows = await read(repo => repo.listWorktrees({ workspace_id: ws.workspace.id, limit: 200 }));
        return { ok: true, count: rows.length, worktrees: rows.map(publicWorktree) };
      }
      const rows = await read(repo => {
        const mine = new Set(repo.listWorkspaces({ principal: rt.principal.id, limit: 1000 }).map(w => w.id));
        return repo.listWorktrees({ limit: 1000 }).filter(w => mine.has(w.workspace_id)).slice(0, 200);
      });
      return { ok: true, count: rows.length, worktrees: rows.map(publicWorktree) };
    },

    async create(args, ctx) {
      let issue = null;
      if (args.issue !== undefined) {
        issue = parseIssueRef(args.issue);
        if (!issue) return fail('invalid_input', 'issue');
        ctx.ids.issue = issue.ref;
      }
      if (args.branch !== undefined && !validBranch(args.branch)) return fail('invalid_input', 'branch');
      if (args.base !== undefined && !(validBranch(args.base) || COMMIT_RE.test(args.base))) return fail('invalid_input', 'base');
      const root = worktreesRoot(env);
      if (!root) return fail('invalid_configuration', 'MEMO_BRIDGE_WORKTREES_ROOT must be absolute');

      const ws = await ownedWorkspace(args.workspace_id, ctx);
      if (ws.error) return ws.error;
      const { workspace } = ws;
      if (workspace.host !== rt.host) return fail('wrong_host', `workspace works on ${workspace.host}`);
      if (issue) {
        const claims = await read(repo => repo.claimsOf(workspace.id, 'claimed'));
        if (!claims.some(c => c.issue_ref === issue.ref && Date.parse(c.expires_at) > now())) return fail('no_live_claim');
      }

      const info = await projectInfo(workspace.project_id, rt.catalogOptions);
      if (!info.ok) return fail('unknown_project');
      const project = info.project;
      if (project.kind !== 'repo' || !project.available || !project.local_path) return fail('project_not_a_repo');
      const repoPath = project.local_path;

      // Documented network call: refresh remote-tracking refs so the base is current and a
      // branch that exists only on the remote is detected. Never prunes, never fetches tags.
      const fetched = await runGit(repoPath, ['fetch', '--no-tags', '--quiet', 'origin'], { timeoutMs: NETWORK_TIMEOUT_MS, maxBytes: 64 * 1024, env });
      if (fetched.code !== 0) return fail('fetch_failed', fetched.timedOut ? 'timeout' : `exit ${fetched.code}`);
      const defaultName = await defaultBranch(repoPath, env);
      if (!defaultName) return fail('default_branch_unknown');

      const suffix = workspace.id.slice(3, 11).toLowerCase();
      const branch = args.branch ?? (issue ? `agent/${issue.number}-${suffix}` : `agent/ws-${suffix}`);
      if (!validBranch(branch)) return fail('invalid_input', 'branch');
      if (PROTECTED.has(branch) || branch === defaultName) return fail('protected_branch');
      if (await refExists(repoPath, `refs/heads/${branch}`, env)) return fail('branch_exists', 'local');
      if (await refExists(repoPath, `refs/remotes/origin/${branch}`, env)) return fail('branch_exists', 'remote');

      const baseRef = args.base ?? `origin/${defaultName}`;
      const baseCommit = await revParse(repoPath, baseRef, env);
      if (!baseCommit) return fail('unknown_base');

      const path = join(root, project.name, branch.replaceAll('/', '-'));
      try { await lstat(path); return fail('path_exists'); } catch { /* free */ }
      await mkdir(dirname(path), { recursive: true });

      const added = await runGit(repoPath, ['worktree', 'add', '--quiet', '--no-track', '-b', branch, '--', path, baseCommit],
        { timeoutMs: NETWORK_TIMEOUT_MS, maxBytes: 64 * 1024, env });
      if (added.code !== 0) {
        if (await refExists(repoPath, `refs/heads/${branch}`, env) && !(await lstat(path).catch(() => null))) {
          // Someone else created the branch between our check and the add.
          return fail('branch_exists', 'local');
        }
        return fail('git_failed', 'worktree add');
      }

      const id = `wt_${randomBytes(12).toString('base64url')}`;
      const at = now();
      const row = { id, workspace_id: workspace.id, project_id: project.name, host: rt.host, path, branch,
        base_ref: baseRef, base_commit: baseCommit, issue_ref: issue?.ref ?? null, created_at: at, updated_at: at };
      let recorded;
      try {
        recorded = await write(repo => {
          // Re-read inside the transaction: a concurrent workspace_close wins.
          if (repo.getWorkspace(workspace.id)?.status !== 'active') return false;
          repo.insertWorktree(row);
          return true;
        });
      } catch {
        recorded = null;
      }
      if (!recorded) {
        // Undo: remove the clean worktree, and delete the branch only if it still points at
        // the base (a conditional ref delete, never a forced branch deletion).
        await runGit(repoPath, ['worktree', 'remove', '--', path], { env });
        await runGit(repoPath, ['update-ref', '-d', `refs/heads/${branch}`, baseCommit], { env });
        return fail(recorded === false ? 'workspace_closed' : 'store_unavailable');
      }
      await withTrack(rt, id, () => ({ head: baseCommit, written: {} })).catch(() => {});
      return { ok: true, worktree: publicWorktree({ ...row, status: 'active', removed_at: null }) };
    },

    async status(args, ctx) {
      const wt = await ownedWorktree(args.worktree_id, ctx);
      if (wt.error) return wt.error;
      const { row } = wt;
      const located = await worktreeRoot(row);
      if (located.error) return located.error;
      const { root } = located;
      const head = await revParse(root, 'HEAD', env);
      if (!head) return fail('git_failed', 'HEAD');
      const branch = await currentBranch(root, env);
      const vsBase = await aheadBehind(root, (await revParse(root, row.base_ref, env)) ? row.base_ref : row.base_commit, env);
      const remoteRef = `refs/remotes/origin/${row.branch}`;
      const vsRemote = (await refExists(root, remoteRef, env)) ? await aheadBehind(root, remoteRef, env) : null;
      const changes = await statusEntries(root, env);
      if (!changes) return fail('git_failed', 'status');
      const log = await runGit(root, ['log', '-5', '--format=%H%x1f%an%x1f%aI%x1f%s%x1e'], { readOnly: true, env, maxBytes: 16 * 1024 });
      const commits = out(log).split('\x1e').map(s => s.trim()).filter(Boolean).map(entry => {
        const [sha, author, date, subject] = entry.split('\x1f');
        return { commit: sha, author: cleanLine(author ?? '', 120), date, subject: cleanLine(subject ?? '', 200) };
      });

      // Edits made outside Memo Bridge: a HEAD it did not produce, a branch switch, changed
      // files it never wrote, or files whose content differs from what it wrote.
      const track = await readTrack(rt, row.id);
      const unknownChanges = []; const modifiedAfterWrite = [];
      for (const entry of changes.entries) {
        const written = track.written?.[entry.raw];
        if (!written || entry.status.includes('D')) { unknownChanges.push(entry.path); continue; }
        try {
          const real = await realpath(join(root, entry.raw));
          const info = await stat(real);
          if (!insideWorktree(root, real) || info.size > LIMITS.writeBytes || digest(await readFile(real)) !== written) {
            modifiedAfterWrite.push(entry.path);
          }
        } catch { modifiedAfterWrite.push(entry.path); }
      }
      const external = {
        head_moved: Boolean(track.head && track.head !== head),
        branch_switched: branch !== row.branch,
        unknown_changes: unknownChanges,
        modified_after_write: modifiedAfterWrite
      };
      external.detected = external.head_moved || external.branch_switched || unknownChanges.length > 0 || modifiedAfterWrite.length > 0;

      return {
        ok: true,
        worktree: publicWorktree(row),
        branch: branch === null ? null : cleanLine(branch, 200), head,
        base: { ref: row.base_ref, ...(vsBase ?? { ahead: null, behind: null }) },
        remote: vsRemote ? { ref: `origin/${row.branch}`, ...vsRemote } : null,
        changes: changes.entries.map(({ raw, ...rest }) => rest), changes_count: changes.count, changes_truncated: changes.truncated,
        clean: changes.count === 0,
        last_commits: commits,
        external_edits: external
      };
    },

    async listFiles(args, ctx) {
      const rel = normalizeRelPath(args.path, { allowRoot: true });
      if (rel === null) return fail('invalid_input', 'path');
      const max = args.limit ?? LIMITS.listDefault;
      if (!Number.isInteger(max) || max < 1 || max > LIMITS.listMax) return fail('invalid_input', 'limit');
      const wt = await ownedWorktree(args.worktree_id, ctx);
      if (wt.error) return wt.error;
      const located = await worktreeRoot(wt.row);
      if (located.error) return located.error;
      const { root } = located;
      if (rel) {
        const target = await resolveExisting(root, rel);
        if (target.error) return target.error;
      }
      // Tracked plus untracked-but-not-ignored files: the project's own .gitignore keeps
      // dependency and build directories out.
      const r = await runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', rel || '.'],
        { readOnly: true, env, maxBytes: 4 * 1024 * 1024 });
      if (r.code !== 0 && !r.truncated) return fail('git_failed', 'ls-files');
      const names = r.stdout.toString('utf8').split('\0');
      if (r.truncated) names.pop();
      const seen = new Set(); const files = [];
      for (const name of names) {
        if (!name || seen.has(name)) continue;
        seen.add(name);
        if (files.length < max) files.push(cleanLine(name, LIMITS.pathChars));
      }
      return { ok: true, path: rel, count: files.length, files, truncated: r.truncated || seen.size > files.length };
    },

    async readFile(args, ctx) {
      const rel = normalizeRelPath(args.path);
      if (rel === null) return fail('invalid_input', 'path');
      const offset = args.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0) return fail('invalid_input', 'offset');
      const limit = args.limit ?? LIMITS.readBytes;
      if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.readBytes) return fail('invalid_input', 'limit');
      const wt = await ownedWorktree(args.worktree_id, ctx);
      if (wt.error) return wt.error;
      const located = await worktreeRoot(wt.row);
      if (located.error) return located.error;
      const target = await resolveExisting(located.root, rel);
      if (target.error) return target.error;
      const info = await stat(target.real);
      if (!info.isFile()) return fail('not_a_file');
      if (offset > info.size) return fail('invalid_input', 'offset');

      const handle = await open(target.real, 'r');
      try {
        // Binary detection on the head of the file, whatever the requested window.
        const head = Buffer.alloc(Math.min(8192, info.size));
        await handle.read(head, 0, head.length, 0);
        if (head.includes(0)) return fail('binary_file');
        const buffer = Buffer.alloc(Math.min(limit, info.size - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        // Never split a UTF-8 sequence: skip leading continuation bytes (a window that starts
        // inside a character), and stop before a character cut by the end of the window.
        let start = 0;
        while (offset > 0 && start < 3 && start < bytesRead && (buffer[start] & 0xc0) === 0x80) start++;
        const end = offset + bytesRead < info.size ? utf8End(buffer, start, bytesRead) : bytesRead;
        let decoded;
        try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(start, end)); } catch { return fail('binary_file'); }
        const { text, replaced } = cleanText(decoded);
        const nextOffset = offset + end;
        return {
          ok: true, path: rel, size: info.size, offset: offset + start, bytes: end - start, content: text,
          truncated: nextOffset < info.size, ...(nextOffset < info.size ? { next_offset: nextOffset } : {}),
          ...(replaced ? { replaced_characters: replaced, warning: 'control or bidi characters were replaced with U+FFFD' } : {})
        };
      } finally {
        await handle.close();
      }
    },

    async writeFile(args, ctx) {
      const rel = normalizeRelPath(args.path);
      if (rel === null) return fail('invalid_input', 'path');
      if (typeof args.content !== 'string') return fail('invalid_input', 'content');
      const data = Buffer.from(args.content, 'utf8');
      if (data.length > LIMITS.writeBytes) return fail('invalid_input', 'content too large');
      const wt = await ownedWorktree(args.worktree_id, ctx, { write: true });
      if (wt.error) return wt.error;
      const { row, workspace } = wt;
      const held = await liveClaim(row, workspace);
      if (held.error) return held.error;
      const located = await worktreeRoot(row);
      if (located.error) return located.error;
      const { root } = located;
      const own = await onOwnBranch(root, row);
      if (own.error) return own.error;

      // Find the nearest existing ancestor and check it before creating anything.
      const parts = rel.split('/');
      const name = parts.pop();
      let existing = parts.length; let ancestor;
      for (;;) {
        const candidate = join(root, ...parts.slice(0, existing));
        try { await lstat(candidate); ancestor = candidate; break; } catch {
          if (existing === 0) return fail('worktree_missing');
          existing--;
        }
      }
      let dir = await realpath(ancestor);
      if (!insideWorktree(root, dir) || !(await stat(dir)).isDirectory()) return fail('path_not_allowed', 'outside the worktree or under .git');
      for (const part of parts.slice(existing)) {
        dir = join(dir, part);
        try { await mkdir(dir, { mode: 0o755 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
        const info = await lstat(dir);
        if (!info.isDirectory()) return fail('path_not_allowed', 'a parent is not a directory');
      }
      const target = join(dir, name);
      let mode = 0o644; let created = true;
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink()) return fail('path_not_allowed', 'symlink');
        if (!info.isFile()) return fail('not_a_file');
        mode = info.mode & 0o777; created = false;
      } catch { /* new file */ }

      // Atomic: write a temporary file next to the target, then rename over it.
      const tmp = join(dir, `.${name.slice(0, 100)}.memo-bridge-${randomBytes(6).toString('hex')}.tmp`);
      const handle = await open(tmp, 'wx', mode);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try { await rename(tmp, target); } catch (error) { await unlink(tmp).catch(() => {}); throw error; }

      const relReal = relative(root, target).split(sep).join('/');
      await withTrack(rt, row.id, track => {
        const written = { ...track.written, [relReal]: digest(data) };
        const keys = Object.keys(written);
        if (keys.length > LIMITS.trackedFiles) delete written[keys[0]];
        return { ...track, written };
      }).catch(() => {});
      return { ok: true, path: relReal, bytes: data.length, created };
    },

    async diff(args, ctx) {
      if (args.staged !== undefined && typeof args.staged !== 'boolean') return fail('invalid_input', 'staged');
      const wt = await ownedWorktree(args.worktree_id, ctx);
      if (wt.error) return wt.error;
      const located = await worktreeRoot(wt.row);
      if (located.error) return located.error;
      const { root } = located;
      // No external diff programs and no textconv filters: only git's own diff runs.
      const base = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', ...(args.staged ? ['--cached'] : [])];
      const statOut = await runGit(root, [...base, '--stat=200'], { readOnly: true, env, maxBytes: LIMITS.statBytes });
      const patch = await runGit(root, [...base, '--patch'], { readOnly: true, env, maxBytes: LIMITS.diffBytes });
      if ((statOut.code !== 0 && !statOut.truncated) || (patch.code !== 0 && !patch.truncated)) return fail('git_failed', 'diff');
      const changes = await statusEntries(root, env);
      const untracked = (changes?.entries ?? []).filter(e => e.status === '??').map(e => e.path);
      const cleanedPatch = cleanText(patch.stdout.toString('utf8'));
      return {
        ok: true, staged: Boolean(args.staged),
        stat: cleanText(statOut.stdout.toString('utf8')).text,
        diff: cleanedPatch.text, bytes: patch.stdout.length, truncated: patch.truncated || statOut.truncated,
        untracked, ...(cleanedPatch.replaced ? { replaced_characters: cleanedPatch.replaced } : {})
      };
    },

    async commit(args, ctx) {
      const message = commitMessage(args.message);
      if (message === null) return fail('invalid_input', 'message');
      if (AI_ATTRIBUTION.some(rx => rx.test(message))) return fail('invalid_input', 'message carries an AI attribution');
      const wt = await ownedWorktree(args.worktree_id, ctx, { write: true });
      if (wt.error) return wt.error;
      const { row, workspace } = wt;
      const located = await worktreeRoot(row);
      if (located.error) return located.error;
      const { root } = located;
      const own = await onOwnBranch(root, row);
      if (own.error) return own.error;
      // The commit is authored by the user's own Git identity; nothing is added to it.
      const ident = await runGit(root, ['var', 'GIT_AUTHOR_IDENT'], { readOnly: true, env, maxBytes: 1024 });
      if (ident.code !== 0) return fail('git_identity_missing');
      const held = await verifiedClaim(row, workspace);
      if (held.error) return held.error;

      const added = await runGit(root, ['add', '-A', '--', '.'], { env, maxBytes: 64 * 1024 });
      if (added.code !== 0) return fail('git_failed', 'add');
      const staged = await runGit(root, ['diff', '--cached', '--quiet', '--no-ext-diff'], { readOnly: true, env, maxBytes: 1024 });
      if (staged.code === 0) return fail('nothing_to_commit');
      if (staged.code !== 1) return fail('git_failed', 'diff --cached');
      const committed = await runGit(root, ['commit', '--quiet', '--no-verify', '-m', message], { env, maxBytes: 64 * 1024, timeoutMs: 60_000 });
      if (committed.code !== 0) return fail('git_failed', committed.timedOut ? 'commit timeout' : 'commit');
      const head = await revParse(root, 'HEAD', env);
      const shortstat = await runGit(root, ['show', '--shortstat', '--format=', '--no-ext-diff', 'HEAD'], { readOnly: true, env, maxBytes: 1024 });
      await withTrack(rt, row.id, () => ({ head, written: {} })).catch(() => {});
      await write(repo => repo.updateWorktree(row.id, { updated_at: now() })).catch(() => {});
      return { ok: true, commit: head, branch: row.branch, summary: cleanLine(out(shortstat), 200) };
    },

    async push(args, ctx) {
      const wt = await ownedWorktree(args.worktree_id, ctx, { write: true });
      if (wt.error) return wt.error;
      const { row, workspace } = wt;
      const located = await worktreeRoot(row);
      if (located.error) return located.error;
      const { root } = located;
      const own = await onOwnBranch(root, row);
      if (own.error) return own.error;
      const head = await revParse(root, 'HEAD', env);
      if (!head) return fail('git_failed', 'HEAD');
      const held = await verifiedClaim(row, workspace);
      if (held.error) return held.error;

      // Explicit refspec without '+': a non-fast-forward is rejected by the remote, never forced.
      const ref = `refs/heads/${row.branch}`;
      const pushed = await runGit(root, ['push', '--porcelain', '--set-upstream', 'origin', `${ref}:${ref}`],
        { timeoutMs: NETWORK_TIMEOUT_MS, maxBytes: 64 * 1024, env });
      if (pushed.code !== 0) {
        const text = `${pushed.stdout.toString('utf8')}\n${pushed.stderr}`;
        if (/\[rejected\]|non-fast-forward|fetch first/.test(text)) return fail('push_rejected', 'non_fast_forward');
        if (/\[remote rejected\]/.test(text)) return fail('push_rejected', 'remote_rejected');
        return fail('push_failed', pushed.timedOut ? 'timeout' : `exit ${pushed.code}`);
      }
      const remoteCommit = await revParse(root, `refs/remotes/origin/${row.branch}`, env);
      await withTrack(rt, row.id, track => ({ ...track, head })).catch(() => {});

      // Durability is tracked by the Coordinator: a checkpoint under the workspace's claim.
      let checkpoint;
      try {
        const coordinator = rt.coordinator();
        const record = coordinator.taskCheckpoint ?? coordinator.issueCheckpoint;
        const result = await record({ workspace_id: workspace.id, issue: row.issue_ref, task: row.issue_ref,
          claim_id: held.claim.claim_id, fence: held.claim.fence_sha, branch: row.branch, commit: head,
          note: `pushed from worktree ${row.id}` });
        checkpoint = result?.ok ? { ok: true, durability: result.durability } : fail(result?.error ?? 'checkpoint_failed', result?.detail);
      } catch {
        checkpoint = fail('store_unavailable');
      }
      return {
        ok: true, branch: row.branch, remote: 'origin', remote_ref: ref, commit: head, remote_commit: remoteCommit, checkpoint,
        ...(checkpoint.ok ? {} : { warning: 'pushed, but the checkpoint was not recorded; record it again with task_checkpoint' })
      };
    },

    async remove(args, ctx) {
      // Cleanup is allowed from a closed workspace too, like releasing a claim.
      const wt = await ownedWorktree(args.worktree_id, ctx, { allowRemoved: true });
      if (wt.error) return wt.error;
      const { row } = wt;
      if (row.status === 'removed') return { ok: true, worktree: publicWorktree(row), already_removed: true };
      const markRemoved = async detail => {
        const at = now();
        await write(repo => repo.updateWorktree(row.id, { status: 'removed', removed_at: at, updated_at: at }));
        trackQueues.delete(row.id);
        await trackFile(rt, row.id).then(file => rm(file, { force: true })).catch(() => {});
        return { ok: true, worktree: publicWorktree({ ...row, status: 'removed', removed_at: at }), ...(detail ? { detail } : {}) };
      };
      let located = await worktreeRoot(row);
      if (located.error) {
        // Deleted by hand: nothing left to lose here. Git's own administrative entry is left for
        // `git worktree prune`, which also touches other worktrees and is not run from here.
        return markRemoved('path was already gone');
      }
      const { root } = located;
      const changes = await statusEntries(root, env);
      if (!changes) return fail('git_failed', 'status');
      if (changes.count > 0) {
        const untracked = changes.entries.filter(e => e.status === '??').length;
        return fail('worktree_dirty', `${changes.count - untracked} modified, ${untracked} untracked`);
      }
      const unpushed = await runGit(root, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'], { readOnly: true, env, maxBytes: 100 });
      if (unpushed.code !== 0) return fail('git_failed', 'rev-list');
      const count = Number(out(unpushed));
      if (count > 0) return fail('unpushed_commits', `${count} commit(s) not on origin`);
      const common = await runGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { readOnly: true, env, maxBytes: 4096 });
      if (common.code !== 0) return fail('git_failed', 'common dir');
      // No --force: git itself refuses a worktree that became dirty in the meantime.
      const removed = await runGit(out(common), ['worktree', 'remove', '--', row.path], { env, maxBytes: 16 * 1024 });
      if (removed.code !== 0) return fail('git_failed', 'worktree remove');
      return markRemoved();
    }
  };
}
