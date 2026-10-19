// Isolated Git worktrees for workspaces (Phase 3, Mac runner).
//
// A workspace (ws_...) gets its own worktree of a registered repository, on its own branch,
// under $MEMOLABS_ROOT/workspace/worktrees/<project>/<branch>. Models read, list and write files only inside
// that worktree, then commit and push the branch. Rules enforced here:
// - the worktree belongs to the workspace's principal, and writes need an active workspace;
// - repository writes need a live claim on the worktree's Issue (local mirror on every write;
//   at commit and push, the ledger verifies worker, claim and fence immediately before);
// - never the default branch, never main or master, never --force, never a merge; branch
//   names are compared without case (APFS is case-insensitive: refs/heads/Main is the file
//   refs/heads/main), and the remote's own default branch and branches are read with
//   ls-remote before creating and before pushing, so a narrow fetch refspec hides nothing;
// - a push only creates the remote branch or moves it from a commit this worktree pushed;
// - the worktree's `.git` link must still point at the project's repository (a job could
//   otherwise redirect the server's own Git commands to a repository and configuration it
//   wrote);
// - no shell: git runs with fixed argv arrays, hooks disabled (a model can write files a
//   hook path could point to), external diff drivers and textconv disabled;
// - on the VPS runner (systemd credentials present), Git's network calls authenticate only with
//   the push-gh credential, through the GIT_ASKPASS helper git-askpass.mjs; every other
//   credential helper is switched off for those calls and no token is ever in argv or env;
// - every path stays inside the worktree after realpath, and never under .git;
// - every output is bounded, and text returned to models has control and bidi characters
//   replaced;
// - Phase 5 (D9): nothing under .github/workflows, .github/actions or .github/dependabot.yml is
//   written, committed or pushed, whoever asks (a workflow change on a same-repository branch
//   runs on CI runners: lab-infra #161); a remote principal creates worktrees only for an
//   allowlisted project; writes check the D8 session binding when the caller's session hash
//   is known; worktree_push takes client_request_id (a retry returns the first result).
// Authorization and audit happen in server/tools/worktree-tools.mjs before these functions run.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectInfo } from '../catalog.mjs';
import { memolabsRoot } from '../memolabs-root.mjs';
import { COMMIT_RE, validBranch } from '../coordinator/checkpoints.mjs';
import { PUSH_CREDENTIAL, credentialsRequired } from '../coordinator/credentials.mjs';
import { inExpiryWindow, leaseExpiring, parseIssueRef } from '../coordinator/issue-lease.mjs';
import { createGitHubCredentials } from '../integrations/github-app.mjs';
import { ownsWorkspace, workerFor } from '../coordinator/policy.mjs';
import { runOnce } from '../coordinator/store.mjs';
import { isProtectedRepoPath, isRemotePrincipal, protectedPaths, remotePolicyFromEnv, remoteProjectRefusal, requestMeta,
  sessionBindingDecision } from '../../bridge/write-gate.mjs';
import { ACTIVE_JOB_STATUSES } from './executor.mjs';
import { reconcileJob } from './jobs.mjs';
import { callerChild, childState, renewParentLease, worktreeWriteAllowed } from '../coordinator/delegation.mjs';

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
const PROTECTED = Object.freeze(['main', 'master']);
// Remote heads listed by ls-remote are bounded; a remote with more is refused rather than guessed.
const REMOTE_REFS_BYTES = 8 * 1024 * 1024;
// Commits this worktree pushed, remembered so a later push only moves the remote branch from one of them.
const PUSHED_KEEP = 50;
// Active jobs block worktree_remove (they run inside the directory): queued, deferred,
// dispatched and running (executor.mjs ACTIVE_JOB_STATUSES, Phase 4).
const GIT_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000;

const fail = (error, detail) => ({ ok: false, error, ...(detail !== undefined ? { detail } : {}) });

// A UNIQUE violation on the live-worktree indexes (store v9), read from SQLite's own message
// ("UNIQUE constraint failed: worktrees.project_id, worktrees.host, worktrees.branch" or
// "...: worktrees.host, worktrees.path"). Returns the refusal it stands for, null for any other error.
export function liveWorktreeConflict(error) {
  const message = String(error?.message ?? '');
  if (!/UNIQUE constraint failed: worktrees\./.test(message)) return null;
  if (/worktrees\.branch\b/.test(message)) return 'branch_exists';
  if (/worktrees\.path\b/.test(message)) return 'path_exists';
  return null;
}
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

// Read a regular file without ever blocking: O_NONBLOCK so a FIFO swapped in after a check
// cannot hang the server, then fstat on the opened descriptor. Returns null for anything that
// is not a regular file of at most maxBytes.
async function readRegular(path, maxBytes) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function worktreesRoot(env = process.env) {
  const override = env.MEMO_BRIDGE_WORKTREES_ROOT;
  if (override !== undefined && override !== '') return isAbsolute(override) ? resolve(override) : null;
  return join(memolabsRoot(env), 'workspace', 'worktrees');
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

// ---------------------------------------------------------------------------------------------
// Credentials for Git's network calls (Phase 4, D6, TODO-P4-11).
//
// On the Mac ($CREDENTIALS_DIRECTORY unset) nothing changes: Git uses the owner's own setup.
// On the VPS the token comes from the runtime's GitHub credentials provider
// (server/integrations/github-app.mjs): a GitHub App installation token narrowed to the
// origin repository with contents:write when the `app-key` credential and the App settings are
// present, else the push-gh PAT (LoadCredential=push-gh; systemd.exec(5), systemd 257: the
// copy in $CREDENTIALS_DIRECTORY is readable only by the unit's user and root). Then:
// - fetch, ls-remote and push get GIT_ASKPASS=git-askpass.mjs and a credential file *path* in
//   MEMO_BRIDGE_ASKPASS_CREDENTIAL; the helper answers GitHub HTTPS prompts only. With the
//   PAT it is the credential itself; with an App token it is a file written for this call
//   only (0600, in a 0700 directory of the state directory) and removed right after it
//   (release()); a leftover from a crash is removed after ASKPASS_STALE_MS, and the token in
//   it expires within an hour anyway;
// - `-c credential.helper=` empties the helper list, so no other helper (system, global,
//   URL-specific) can supply or store a credential (gitcredentials(7): an empty helper value
//   resets the list; checked with git 2.54, url-specific helpers included; the VPS has git
//   2.47.3, to verify in the TODO-P4-31 smoke);
// - GIT_SAFETY (hooks and fsmonitor off) still prefixes every call (runGit);
// - a missing or malformed credential fails closed (credential_unavailable): no fallback to an
//   ambient login;
// - every Git call, local or network, runs without CREDENTIALS_DIRECTORY or token variables.
export const ASKPASS_PATH = fileURLToPath(new URL('./git-askpass.mjs', import.meta.url));
export const ASKPASS_CREDENTIAL_VAR = 'MEMO_BRIDGE_ASKPASS_CREDENTIAL';
const GIT_CREDENTIAL_VARS = ['CREDENTIALS_DIRECTORY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  'GIT_ASKPASS', 'SSH_ASKPASS', ASKPASS_CREDENTIAL_VAR];

export function gitBaseEnv(env) {
  if (!credentialsRequired(env)) return env;
  const clean = { ...env };
  for (const name of GIT_CREDENTIAL_VARS) delete clean[name];
  return clean;
}

// The askpass program Git can execute. Git runs GIT_ASKPASS without a shell (prompt.c
// do_askpass), so the file must be executable. lab-infra installs server/ with mode 0644
// (role memo-bridge, tasks/app.yml), so where the installed helper is not executable a private
// copy is kept under $MEMO_BRIDGE_STATE_DIR/bin (folder and file 0700, owned by this user) and
// refreshed whenever the installed helper changes. null when neither is possible (fail closed).
export async function askpassProgram(env, { source = ASKPASS_PATH } = {}) {
  try { await access(source, fsConstants.X_OK); return source; } catch { /* not executable here: private copy */ }
  const stateDir = env.MEMO_BRIDGE_STATE_DIR;
  if (!isAbsolute(stateDir ?? '')) return null;
  try {
    const dir = join(stateDir, 'bin');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) return null;
    const target = join(dir, 'git-askpass.mjs');
    const content = await readFile(source);
    let current = null;
    try {
      const t = await lstat(target);
      if (t.isFile() && (t.mode & 0o777) === 0o700) current = await readFile(target);
    } catch { current = null; }
    if (!current || !current.equals(content)) {
      const tmp = join(dir, `.git-askpass.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      await writeFile(tmp, content, { mode: 0o700, flag: 'wx' });
      await chmod(tmp, 0o700);
      await rename(tmp, target);
    }
    return target;
  } catch {
    return null;
  }
}

export const ASKPASS_STALE_MS = 2 * 60 * 60_000;
const ASKPASS_FILE_RE = /^tok-[0-9a-f]{32}$/;

// Write an App token for one Git call: a private directory (0700, ours), a new 0600 file.
// Returns the path, or null (fail closed).
async function writeAskpassToken(dir, token) {
  if (!isAbsolute(dir ?? '')) return null;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) return null;
    for (const name of await readdir(dir)) {
      if (!ASKPASS_FILE_RE.test(name)) continue;
      const entry = await lstat(join(dir, name)).catch(() => null);
      if (entry && Date.now() - entry.mtimeMs > ASKPASS_STALE_MS) await unlink(join(dir, name)).catch(() => {});
    }
    const file = join(dir, `tok-${randomBytes(16).toString('hex')}`);
    await writeFile(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
    return file;
  } catch {
    return null;
  }
}

// owner/name of a repository's origin, read locally (no network); null when unknown.
export async function originRepo(cwd, env) {
  const r = await runGit(cwd, ['remote', 'get-url', 'origin'], { readOnly: true, env, maxBytes: 4096 });
  if (r.code !== 0) return null;
  const match = /[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(out(r));
  return match ? `${match[1]}/${match[2]}` : null;
}

// {config, env, release?} for one network call, or {error}. `env` is the runner's environment,
// `repo` the owner/name of the origin (it selects the App token), `credentials` the runtime's
// provider (built from env when absent), `scratchDir` where an App token file is written
// (default <MEMO_BRIDGE_STATE_DIR>/askpass). The caller runs release() once its network calls
// are done; it exists only for an App token.
export async function networkGit(env, { repo = null, credentials = null, scratchDir = null } = {}) {
  if (!credentialsRequired(env)) return { config: [], env };
  const got = await (credentials ?? createGitHubCredentials({ env })).token('push', repo);
  if (got.error) return { error: fail('credential_unavailable', `${got.credential} ${got.error}`) };
  if (!got.token) return { error: fail('credential_unavailable', `${PUSH_CREDENTIAL} credential_missing`) };
  const askpass = await askpassProgram(env);
  if (!askpass) return { error: fail('credential_unavailable', 'askpass_unavailable') };
  const config = ['-c', 'credential.helper='];
  if (got.source === 'pat') return { config, env: { ...gitBaseEnv(env), GIT_ASKPASS: askpass, [ASKPASS_CREDENTIAL_VAR]: got.file } };
  const dir = scratchDir ?? (isAbsolute(env.MEMO_BRIDGE_STATE_DIR ?? '') ? join(env.MEMO_BRIDGE_STATE_DIR, 'askpass') : null);
  const file = await writeAskpassToken(dir, got.token);
  if (!file) return { error: fail('credential_unavailable', 'askpass_unavailable') };
  return {
    config,
    env: { ...gitBaseEnv(env), GIT_ASKPASS: askpass, [ASKPASS_CREDENTIAL_VAR]: file },
    release: () => unlink(file).catch(() => {})
  };
}

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

// Branch names are compared without case: on APFS (case-insensitive) a loose ref
// refs/heads/Main is the same file as refs/heads/main.
const fold = name => String(name).toLowerCase();
export function isProtectedBranch(branch, defaults = []) {
  const folded = fold(branch);
  return [...PROTECTED, ...defaults.filter(Boolean)].some(name => fold(name) === folded);
}
// Names in `names` equal to `name` once case is ignored (including `name` itself).
const sameIgnoringCase = (names, name) => names.filter(other => fold(other) === fold(name));

// Every local branch and remote-tracking ref of origin, full names.
async function localRefs(cwd, env) {
  const r = await runGit(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'],
    { readOnly: true, env, maxBytes: REMOTE_REFS_BYTES });
  if (r.code !== 0 || r.truncated) return null;
  return out(r).split('\n').filter(Boolean);
}

// The remote's own view, asked over the network: its default branch (HEAD symref) and every
// branch with its commit. A local fetch refspec narrowed to one branch (--single-branch,
// --depth clones) would otherwise hide both.
export function parseLsRemote(text) {
  let head = null; const heads = new Map();
  for (const line of String(text).split('\n')) {
    const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (symref) { head = symref[1]; continue; }
    const ref = /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/heads\/(\S+)$/.exec(line);
    if (ref) heads.set(ref[2], ref[1]);
  }
  return { head, heads };
}
// `net` comes from networkGit(): credential configuration and environment for this call.
async function remoteBranches(cwd, net) {
  const r = await runGit(cwd, [...net.config, 'ls-remote', '--symref', 'origin', 'HEAD', 'refs/heads/*'],
    { readOnly: true, env: net.env, timeoutMs: NETWORK_TIMEOUT_MS, maxBytes: REMOTE_REFS_BYTES });
  if (r.code !== 0 || r.truncated) return null;
  return parseLsRemote(r.stdout.toString('utf8'));
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
// Commits worktree_push sent for this worktree (newest last), for github_create_pr: a remote
// pull request is opened only on a head this workspace pushed itself.
export async function pushedCommits(rt, worktreeId) {
  if (typeof worktreeId !== 'string' || !WT_RE.test(worktreeId)) return [];
  const track = await readTrack(rt, worktreeId);
  return Array.isArray(track.pushed) ? track.pushed.filter(c => typeof c === 'string') : [];
}
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

// Commit messages go out under the user's name: never with an AI attribution, as a trailer or
// as prose ("Written by Claude", "Made with Claude Code", "AI-generated").
const MESSAGE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const AI_NAMES = '(?:claude(?:[ -]code)?|anthropic|openai|chat-?gpt|gpt[-\\d.o]*|codex|copilot|gemini|cursor|llms?|ai|an? (?:ai|llm|language model))';
export const AI_ATTRIBUTION = Object.freeze([
  // Any trailer (Co-authored-by, Signed-off-by, Assisted-by, Generated-by...) naming an assistant.
  new RegExp(`^\\s*[a-z-]+-by:.*\\b${AI_NAMES}\\b`, 'im'),
  // "Generated with/by", "Written by", "Made with", "Created using the help of"... an assistant.
  new RegExp(`\\b(?:generated|written|created|made|authored|produced|assisted|built|drafted|co-?authored)\\s+(?:with|by|using|via|in|thanks to)\\s+(?:the\\s+)?(?:help\\s+of\\s+)?${AI_NAMES}\\b`, 'i'),
  /\bai[- ](?:generated|assisted|written|authored)\b/i,
  /noreply@anthropic\.com|claude\.(?:ai|com)\/(?:code|claude-code)/i,
  /\u{1F916}/u
]);
function commitMessage(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n/g, '\n').trim();
  if (!text || text.length > LIMITS.messageChars || MESSAGE_CONTROL.test(text)) return null;
  if (!text.split('\n')[0].trim()) return null;
  return text;
}

// ---------------------------------------------------------------------------------------------

// Paths a commit or a push would carry that touch a protected path (D9), bounded. `range` is
// either ['--cached'] (the index against HEAD) or [base, 'HEAD'] plus the per-commit history of
// base..HEAD, so a change added then reverted in a later commit is still seen.
async function protectedChanges(root, env, { staged = false, base = null, tip = 'HEAD' } = {}) {
  const names = [];
  const collect = r => {
    if (r.code !== 0 || r.truncated) return false;
    names.push(...r.stdout.toString('utf8').split('\0').filter(Boolean));
    return true;
  };
  const diffArgs = ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv'];
  if (staged) {
    if (!collect(await runGit(root, [...diffArgs, '--cached'], { readOnly: true, env, maxBytes: 4 * 1024 * 1024 }))) return null;
  } else {
    if (!collect(await runGit(root, [...diffArgs, base, tip], { readOnly: true, env, maxBytes: 4 * 1024 * 1024 }))) return null;
    if (!collect(await runGit(root, ['log', '--format=', '--name-only', '-z', '--no-renames', '-m', `${base}..${tip}`],
      { readOnly: true, env, maxBytes: 4 * 1024 * 1024 }))) return null;
  }
  return protectedPaths([...new Set(names)]);
}
// Protected changes `tip` carries that the remote's default branch does not (F1, D9): measured
// from the merge-base with the default branch, so a branch started from another branch (a WIP
// branch, a Dependabot bump) cannot carry that branch's workflow change into a pull request.
// The default branch is `commit` (its tip as the remote reported it) when that commit is
// known locally, else the remote-tracking ref of each name in `names`, first found; none: null.
const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
export async function protectedSinceDefault(root, tip, names, env, { commit = null } = {}) {
  if (typeof tip !== 'string' || !(SHA_RE.test(tip) || tip === 'HEAD')) return null;
  const refs = [...(SHA_RE.test(commit ?? '') ? [commit] : []),
    ...[names].flat().filter(name => typeof name === 'string' && validBranch(name)).map(name => `refs/remotes/origin/${name}`)];
  let against = null;
  for (const ref of refs) { against = await revParse(root, ref, env); if (against) break; }
  if (!against) return null;
  const mb = await runGit(root, ['merge-base', '--end-of-options', tip, against], { readOnly: true, env, maxBytes: 200 });
  if (mb.code !== 0) return null;
  return protectedChanges(root, env, { base: out(mb), tip });
}
const protectedRefusal = hits => fail('path_protected',
  `${hits.count} change(s) under .github/workflows, .github/actions or .github/dependabot.yml: ${hits.shown.join(', ')}`);

export function createWorktreeRunner(rt, { env: explicitEnv, credentials: explicitCredentials,
  remotePolicy: remotePolicyOption = typeof rt?.remotePolicy === 'function' ? () => rt.remotePolicy()
    : () => remotePolicyFromEnv(explicitEnv ?? process.env) } = {}) {
  // Read at each call, not when the runner is built: project_create adds projects to remote.json
  // while the runtime runs (#216). A fixed policy object (tests) stays fixed.
  const currentRemotePolicy = typeof remotePolicyOption === 'function' ? remotePolicyOption : () => remotePolicyOption;
  const runnerEnv = explicitEnv ?? process.env;
  // The runtime's shared provider, unless the caller passed its own environment.
  const credentials = explicitCredentials ?? (explicitEnv === undefined && rt?.githubCredentials
    ? rt.githubCredentials : createGitHubCredentials({ env: runnerEnv }));
  const askpassDir = isAbsolute(rt?.stateDir ?? '') ? join(rt.stateDir, 'askpass') : null;
  const netFor = async (repoPath, gitEnv) => networkGit(runnerEnv, { credentials, scratchDir: askpassDir,
    repo: credentialsRequired(runnerEnv) ? await originRepo(repoPath, gitEnv) : null });
  // Local Git calls never see the credentials directory; network calls get networkGit(runnerEnv).
  const env = gitBaseEnv(runnerEnv);
  const baseGitEnv = env; // methods below shadow `env` with the pinned one from locate()
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

  // D8: a write from a conversation other than the one the workspace is bound to. ctx.meta is
  // the per-request metadata the runtime received next to the principal, never tool
  // arguments. In 'warn' mode the call goes on and its result carries session_warning.
  function sessionCheck(workspace, ctx) {
    const decision = sessionBindingDecision(workspace.client_session, requestMeta(ctx.meta).client_session, currentRemotePolicy().session_binding,
      { remote: isRemotePrincipal(rt.principal) });
    if (!decision.ok) return { error: decision };
    if (decision.warning) ctx.sessionWarning = decision.warning;
    return {};
  }
  const warned = (ctx, result) => (ctx.sessionWarning && result?.ok ? { ...result, session_warning: ctx.sessionWarning } : result);

  // Delegation (#47, spec D6 and D7): the caller as a child on this worktree, or {child: null}.
  // The child is the workspace named by `workspace_id` when it is one, else the conversation's most
  // recent workspace when it is one, so a child never acts as its parent by leaving it out. A child
  // reaches only the worktree of its live delegation, and its own session binding is what counts.
  async function childOn(row, args, ctx) {
    if (args.workspace_id !== undefined && !WS_RE.test(args.workspace_id ?? '')) return { error: fail('invalid_input', 'workspace_id') };
    const session = requestMeta(ctx.meta).client_session;
    const info = await read(repo => {
      const raw = args.workspace_id !== undefined ? repo.getWorkspace(args.workspace_id) : null;
      const named = raw && ownsWorkspace(rt.principal, raw) ? raw : null;
      if (args.workspace_id !== undefined && !named) return { error: fail('unknown_workspace') };
      const child = callerChild(repo, rt.principal.id, { workspace: named, session });
      return child ? { named, ...childState(repo, child, now()) } : { named };
    });
    if (info.error) return info;
    if (!info.child) {
      if (info.named && info.named.id !== row.workspace_id) return { error: fail('invalid_input', 'workspace_id: not the workspace of this worktree') };
      return { child: null };
    }
    if (info.named && info.named.id !== info.child.id) {
      return { error: fail('outside_delegation_scope', `this conversation works for delegation ${info.child.delegation_id}: use workspace ${info.child.id}`) };
    }
    if (info.reason) return { error: { ok: false, error: 'delegation_ended', end_reason: info.reason } };
    if (info.delegation.parent_workspace_id !== row.workspace_id || info.delegation.worktree_id !== row.id) {
      return { error: fail('outside_delegation_scope', 'not the worktree of your delegation') };
    }
    const decision = sessionBindingDecision(info.child.client_session, session, currentRemotePolicy().session_binding,
      { remote: isRemotePrincipal(rt.principal) });
    if (!decision.ok) return { error: decision };
    if (decision.warning) ctx.sessionWarning = decision.warning;
    return { child: info.child, delegation: info.delegation };
  }
  const parentOnly = what => fail('outside_delegation_scope', `${what} stays with the parent conversation: report with delegation_report`);

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
    // The last 60 s of a lease are a clock margin: no write until task_renew (issue-lease.mjs).
    if (inExpiryWindow(held.claim.expires_at, now())) return { error: leaseExpiring() };
    const verified = await rt.ledger.verify(parseIssueRef(row.issue_ref), workerFor(workspace), held.claim.claim_id, held.claim.fence_sha);
    if (!verified?.ok) return { error: verified?.error ? fail(verified.error, verified.detail) : fail('ledger_unavailable') };
    return held;
  }

  // The worktree must still be on its own branch, which is never a protected one (any case).
  async function onOwnBranch(root, row, gitEnv) {
    const branch = await currentBranch(root, gitEnv);
    if (branch !== row.branch) return { error: fail('branch_changed', 'the worktree is no longer on its branch') };
    if (isProtectedBranch(branch, [await defaultBranch(root, gitEnv)])) return { error: fail('protected_branch') };
    return { branch };
  }

  // A VPS job (a memo-job unit) waiting or running in the worktree: runner-side Git that writes
  // or uses the network (commit, push) waits until it ends (verifier finding 5, defense in
  // depth behind the pinned GIT_DIR). On the Mac the job runs as the same user, so nothing is
  // gained and Phase 3 behaviour is kept.
  async function unitJobActive(row) {
    const active = await write(repo => ACTIVE_JOB_STATUSES.flatMap(status =>
      repo.listJobs({ workspace_id: row.workspace_id, status, limit: 1000 }).filter(job => job.worktree_id === row.id && job.unit))
      .map(job => reconcileJob(repo, job, now())).filter(job => ACTIVE_JOB_STATUSES.includes(job.status)));
    return active.length
      ? { error: fail('job_active', `${active.length} job(s) waiting or running in this worktree; wait for them or cancel them with job_cancel`) }
      : null;
  }

  // The worktree directory, and proof that its `.git` link still points at this project's
  // repository: a plain file "gitdir: <repo>/.git/worktrees/<name>". Anything else (a
  // directory, a symlink, another repository) would make every Git command below run against
  // a repository and configuration that someone else wrote.
  //
  // The link is read once, here. Every Git call that follows gets the validated paths pinned in
  // GIT_DIR and GIT_WORK_TREE (git(1), ENVIRONMENT), so Git never reads the link file again
  // (verifier finding 5): on the VPS the worktree is group-writable by memo-job (setgid 2770,
  // UMask=0007), and a running job could otherwise swap the link between this check and a later
  // Git call (commit waits on a ledger verify in between) and point Git at a configuration it
  // wrote. The gitdir and the common dir live under repos/, read-only to the job.
  async function locate(row) {
    const located = await worktreeRoot(row);
    if (located.error) return located;
    const { root } = located;
    const bad = { error: fail('worktree_link_changed', 'the worktree .git link no longer points at the project repository') };
    let gitdir; let commonDir;
    try {
      const link = join(root, '.git');
      if (!(await lstat(link)).isFile()) return bad;
      const text = await readRegular(link, 4096);
      const match = text && /^gitdir: (\/.+)\n?$/.exec(text.toString('utf8'));
      if (!match) return bad;
      gitdir = await realpath(match[1]);
      if (basename(dirname(gitdir)) !== 'worktrees') return bad;
      const info = await projectInfo(row.project_id, rt.catalogOptions);
      if (!info.ok || !info.project.local_path) return bad;
      commonDir = dirname(dirname(gitdir));
      if (commonDir !== await realpath(join(info.project.local_path, '.git'))) return bad;
      if (!(await stat(gitdir)).isDirectory()) return bad;
    } catch {
      return bad;
    }
    const pins = { GIT_DIR: gitdir, GIT_WORK_TREE: root };
    return { root, gitdir, commonDir, pins, env: { ...env, ...pins } };
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
      const asChild = await read(repo => callerChild(repo, rt.principal.id, { workspace, session: requestMeta(ctx.meta).client_session }));
      if (asChild) return parentOnly('worktree_create');
      const notAllowed = remoteProjectRefusal(rt.principal, workspace.project_id, currentRemotePolicy(), { host: rt.host });
      if (notAllowed) return notAllowed;
      const bound = sessionCheck(workspace, ctx);
      if (bound.error) return bound.error;
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
      // Then the remote's own default branch and branches (ls-remote); both network calls share
      // one credential, released right after them.
      const net = await netFor(repoPath, env);
      if (net.error) return net.error;
      let fetched; let remote = null;
      try {
        fetched = await runGit(repoPath, [...net.config, 'fetch', '--no-tags', '--quiet', 'origin'],
          { timeoutMs: NETWORK_TIMEOUT_MS, maxBytes: 64 * 1024, env: net.env });
        if (fetched.code === 0) remote = await remoteBranches(repoPath, net);
      } finally {
        await net.release?.();
      }
      if (fetched.code !== 0) return fail('fetch_failed', fetched.timedOut ? 'timeout' : `exit ${fetched.code}`);
      const defaultName = await defaultBranch(repoPath, env);
      if (!defaultName) return fail('default_branch_unknown');

      const suffix = workspace.id.slice(3, 11).toLowerCase();
      const branch = args.branch ?? (issue ? `agent/${issue.number}-${suffix}` : `agent/ws-${suffix}`);
      if (!validBranch(branch)) return fail('invalid_input', 'branch');
      if (!remote) return fail('fetch_failed', 'ls-remote');
      if (isProtectedBranch(branch, [defaultName, remote.head])) return fail('protected_branch');
      // Any existing branch with the same name in another case is the same ref file on APFS.
      const refs = await localRefs(repoPath, env);
      if (!refs) return fail('git_failed', 'for-each-ref');
      if (sameIgnoringCase(refs, `refs/heads/${branch}`).length) return fail('branch_exists', 'local');
      if (sameIgnoringCase(refs, `refs/remotes/origin/${branch}`).length) return fail('branch_exists', 'remote');
      if (sameIgnoringCase([...remote.heads.keys()], branch).length) return fail('branch_exists', 'remote');

      const baseRef = args.base ?? `origin/${defaultName}`;
      const baseCommit = await revParse(repoPath, baseRef, env);
      if (!baseCommit) return fail('unknown_base');
      // F1 (D9): a remote conversation starts only from the remote's default branch. Another
      // branch could carry a workflow change that the push check, measured from the base,
      // would never see.
      if (isRemotePrincipal(rt.principal) && args.base !== undefined
        && baseCommit !== await revParse(repoPath, `refs/remotes/origin/${defaultName}`, env)) return fail('base_not_allowed');

      const path = join(root, project.name, branch.replaceAll('/', '-'));
      // The path is claimed by creating the (empty) directory itself: mkdir without `recursive` is
      // atomic and fails with EEXIST for every session but one. A look-then-create would let two
      // sessions whose branches differ only in their separators (a/b-c, a-b/c) both pass, and both
      // `git worktree add` into the same empty directory.
      await mkdir(dirname(path), { recursive: true });
      try { await mkdir(path); } catch (error) { return error?.code === 'EEXIST' ? fail('path_exists') : fail('git_failed', 'mkdir'); }

      const added = await runGit(repoPath, ['worktree', 'add', '--quiet', '--no-track', '-b', branch, '--', path, baseCommit],
        { timeoutMs: NETWORK_TIMEOUT_MS, maxBytes: 64 * 1024, env });
      if (added.code !== 0) {
        // Git refuses a branch another session just created; whatever it refused, the directory
        // taken above is ours and is empty again (rmdir never removes a populated one).
        await rmdir(path).catch(() => {});
        if (await refExists(repoPath, `refs/heads/${branch}`, env)) return fail('branch_exists', 'local');
        return fail('git_failed', 'worktree add');
      }

      const id = `wt_${randomBytes(12).toString('base64url')}`;
      const at = now();
      const row = { id, workspace_id: workspace.id, project_id: project.name, host: rt.host, path, branch,
        base_ref: baseRef, base_commit: baseCommit, issue_ref: issue?.ref ?? null, created_at: at, updated_at: at };
      let recorded; let conflict = null;
      try {
        recorded = await write(repo => {
          // Re-read inside the transaction: a concurrent workspace_close wins.
          if (repo.getWorkspace(workspace.id)?.status !== 'active') return false;
          repo.insertWorktree(row);
          return true;
        });
      } catch (error) {
        // The v9 partial UNIQUE indexes (worktrees_live_branch, worktrees_live_path) are the last
        // word on exclusivity: whichever fired is a refusal of the same kind as the checks above.
        conflict = liveWorktreeConflict(error);
        recorded = null;
      }
      if (!recorded) {
        // Undo: remove the clean worktree, and delete the branch only if it still points at
        // the base (a conditional ref delete, never a forced branch deletion).
        await runGit(repoPath, ['worktree', 'remove', '--', path], { env });
        await runGit(repoPath, ['update-ref', '-d', `refs/heads/${branch}`, baseCommit], { env });
        if (conflict) return fail(conflict, 'store');
        return fail(recorded === false ? 'workspace_closed' : 'store_unavailable');
      }
      await withTrack(rt, id, () => ({ head: baseCommit, written: {} })).catch(() => {});
      return warned(ctx, { ok: true, worktree: publicWorktree({ ...row, status: 'active', removed_at: null }) });
    },

    async status(args, ctx) {
      const wt = await ownedWorktree(args.worktree_id, ctx);
      if (wt.error) return wt.error;
      const acting = await childOn(wt.row, args, ctx);
      if (acting.error) return acting.error;
      const { row } = wt;
      const located = await locate(row);
      if (located.error) return located.error;
      const { root } = located;
      const env = located.env; // GIT_DIR and GIT_WORK_TREE pinned (locate)
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
          // Never blocks: a FIFO or device put in place of a written file is just "modified".
          const content = insideWorktree(root, real) ? await readRegular(real, LIMITS.writeBytes) : null;
          if (content === null || digest(content) !== written) modifiedAfterWrite.push(entry.path);
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
      const acting = await childOn(wt.row, args, ctx);
      if (acting.error) return acting.error;
      const located = await locate(wt.row);
      if (located.error) return located.error;
      const { root } = located;
      const env = located.env; // GIT_DIR and GIT_WORK_TREE pinned (locate)
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
      const acting = await childOn(wt.row, args, ctx);
      if (acting.error) return acting.error;
      const located = await locate(wt.row);
      if (located.error) return located.error;
      const target = await resolveExisting(located.root, rel);
      if (target.error) return target.error;
      if (!(await stat(target.real)).isFile()) return fail('not_a_file');
      // O_NONBLOCK and a check on the opened descriptor: the entry may have been replaced by a
      // FIFO since the check above, and opening a FIFO for reading would hang.
      let handle;
      try { handle = await open(target.real, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK); } catch { return fail('not_found'); }
      const info = await handle.stat();
      if (!info.isFile()) { await handle.close(); return fail('not_a_file'); }
      if (offset > info.size) { await handle.close(); return fail('invalid_input', 'offset'); }
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
      if (isProtectedRepoPath(rel)) return protectedRefusal(protectedPaths([rel]));
      if (typeof args.content !== 'string') return fail('invalid_input', 'content');
      const data = Buffer.from(args.content, 'utf8');
      if (data.length > LIMITS.writeBytes) return fail('invalid_input', 'content too large');
      const wt = await ownedWorktree(args.worktree_id, ctx, { write: true });
      if (wt.error) return wt.error;
      const { row, workspace } = wt;
      const acting = await childOn(row, args, ctx);
      if (acting.error) return acting.error;
      const delegation = acting.delegation ?? null;
      if (delegation) {
        // A child writes only inside its scope, under the parent's claim, which it renews when it runs low.
        if (!worktreeWriteAllowed(delegation, rel)) return fail('outside_delegation_scope', `${rel} is outside your scope`);
        await renewParentLease({ store: rt.store(), ledger: rt.ledger, parent: workspace, claimId: delegation.claim_id, now });
      } else {
        const bound = sessionCheck(workspace, ctx);
        if (bound.error) return bound.error;
      }
      const held = await liveClaim(row, workspace);
      if (held.error) return held.error;
      if (delegation && held.claim.claim_id !== delegation.claim_id) return { ok: false, error: 'delegation_ended', end_reason: 'task_released' };
      const located = await locate(row);
      if (located.error) return located.error;
      const { root } = located;
      const env = located.env; // GIT_DIR and GIT_WORK_TREE pinned (locate)
      const own = await onOwnBranch(root, row, env);
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
      // The path as it lands after symlinked parents are resolved: a link to .github must not
      // carry a write into a protected directory.
      const landing = [relative(root, dir).split(sep).filter(Boolean).join('/'), ...parts.slice(existing), name].filter(Boolean).join('/');
      if (isProtectedRepoPath(landing)) return protectedRefusal(protectedPaths([landing]));
      if (delegation && !worktreeWriteAllowed(delegation, landing)) return fail('outside_delegation_scope', `${landing} is outside your scope`);
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
      return warned(ctx, { ok: true, path: relReal, bytes: data.length, created });
    },

    async diff(args, ctx) {
      if (args.staged !== undefined && typeof args.staged !== 'boolean') return fail('invalid_input', 'staged');
      const wt = await ownedWorktree(args.worktree_id, ctx);
      if (wt.error) return wt.error;
      const acting = await childOn(wt.row, args, ctx);
      if (acting.error) return acting.error;
      const located = await locate(wt.row);
      if (located.error) return located.error;
      const { root } = located;
      const env = located.env; // GIT_DIR and GIT_WORK_TREE pinned (locate)
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
      const acting = await childOn(row, args, ctx);
      if (acting.error) return acting.error;
      if (acting.child) return parentOnly('worktree_commit');
      const bound = sessionCheck(workspace, ctx);
      if (bound.error) return bound.error;
      const busy = await unitJobActive(row);
      if (busy) return busy.error;
      const located = await locate(row);
      if (located.error) return located.error;
      const { root } = located;
      const env = located.env; // GIT_DIR and GIT_WORK_TREE pinned (locate)
      const own = await onOwnBranch(root, row, env);
      if (own.error) return own.error;
      // The commit is authored by the user's own Git identity; nothing is added to it.
      const ident = await runGit(root, ['var', 'GIT_AUTHOR_IDENT'], { readOnly: true, env, maxBytes: 1024 });
      if (ident.code !== 0) return fail('git_identity_missing');
      const held = await verifiedClaim(row, workspace);
      if (held.error) return held.error;
      // A job may have been queued and dispatched during the ledger call.
      const busyAfter = await unitJobActive(row);
      if (busyAfter) return busyAfter.error;

      const added = await runGit(root, ['add', '-A', '--', '.'], { env, maxBytes: 64 * 1024 });
      if (added.code !== 0) return fail('git_failed', 'add');
      const staged = await runGit(root, ['diff', '--cached', '--quiet', '--no-ext-diff'], { readOnly: true, env, maxBytes: 1024 });
      if (staged.code === 0) return fail('nothing_to_commit');
      if (staged.code !== 1) return fail('git_failed', 'diff --cached');
      // Whatever wrote them (a job, an editor, a symlink), protected paths are never committed.
      // The index is put back to HEAD (the working tree is untouched) so nothing stays staged.
      const touched = await protectedChanges(root, env, { staged: true });
      if (!touched || touched.count) {
        await runGit(root, ['reset', '--quiet'], { env, maxBytes: 16 * 1024 });
        return touched ? protectedRefusal(touched) : fail('git_failed', 'diff --cached --name-only');
      }
      const committed = await runGit(root, ['commit', '--quiet', '--no-verify', '-m', message], { env, maxBytes: 64 * 1024, timeoutMs: 60_000 });
      if (committed.code !== 0) return fail('git_failed', committed.timedOut ? 'commit timeout' : 'commit');
      const head = await revParse(root, 'HEAD', env);
      const shortstat = await runGit(root, ['show', '--shortstat', '--format=', '--no-ext-diff', 'HEAD'], { readOnly: true, env, maxBytes: 1024 });
      await withTrack(rt, row.id, track => ({ ...track, head, written: {} })).catch(() => {});
      await write(repo => repo.updateWorktree(row.id, { updated_at: now() })).catch(() => {});
      return warned(ctx, { ok: true, commit: head, branch: row.branch, summary: cleanLine(out(shortstat), 200) });
    },

    async push(args, ctx) {
      const wt = await ownedWorktree(args.worktree_id, ctx, { write: true });
      if (wt.error) return wt.error;
      const { row, workspace } = wt;
      const acting = await childOn(row, args, ctx);
      if (acting.error) return acting.error;
      if (acting.child) return parentOnly('worktree_push');
      const bound = sessionCheck(workspace, ctx);
      if (bound.error) return bound.error;
      // Idempotency (Phase 4 FU-5, REQ-P5-15): a retry with the same client_request_id returns
      // the first successful push instead of pushing again.
      const result = await runOnce(rt.store(), { principal: rt.principal.id, op: 'worktree_push',
        clientRequestId: args.client_request_id, now: now() }, () => pushOnce(row, workspace, ctx?.meta));
      return warned(ctx, result);
    },

    async remove(args, ctx) {
      return removeWorktree(args, ctx);
    }
  };

  // The credential of a push lives from its first network call to its last; released here
  // whatever the outcome.
  async function pushOnce(row, workspace, meta) {
    const nets = [];
    try {
      return await pushSteps(row, workspace, nets, meta);
    } finally {
      for (const net of nets) await net.release?.();
    }
  }

  async function pushSteps(row, workspace, nets, meta) {
    const busy = await unitJobActive(row);
    if (busy) return busy.error;
    const located = await locate(row);
    if (located.error) return located.error;
    const { root } = located;
    const env = located.env; // GIT_DIR and GIT_WORK_TREE pinned (locate)
    const own = await onOwnBranch(root, row, env);
    if (own.error) return own.error;
    const head = await revParse(root, 'HEAD', env);
    if (!head) return fail('git_failed', 'HEAD');
    // Nothing the branch carries since its base may touch a protected path, including commits
    // made outside Memo Bridge (a job, a terminal) and changes reverted by a later commit.
    const touched = await protectedChanges(root, env, { base: row.base_commit });
    if (!touched) return fail('git_failed', 'protected path check');
    if (touched.count) return protectedRefusal(touched);
    // Ask the remote itself (network): its default branch and its branches. The local
    // origin/HEAD can be missing or stale, and a narrow fetch refspec hides other branches.
    const unpinned = await netFor(root, env);
    if (unpinned.error) return unpinned.error;
    nets.push(unpinned);
    const net = { ...unpinned, env: { ...unpinned.env, ...located.pins } };
    const remote = await remoteBranches(root, net);
    if (!remote) return fail('push_failed', 'ls-remote');
    const defaultName = await defaultBranch(root, env);
    if (isProtectedBranch(row.branch, [remote.head, defaultName])) return fail('protected_branch');
    // F1 (D9): also measured from the merge-base with the remote's default branch, whatever the
    // worktree's recorded base was.
    const sinceDefault = await protectedSinceDefault(root, head, [remote.head, defaultName], env,
      { commit: remote.head ? remote.heads.get(remote.head) : null });
    if (!sinceDefault) return fail('git_failed', 'protected path check');
    if (sinceDefault.count) return protectedRefusal(sinceDefault);
    const variants = sameIgnoringCase([...remote.heads.keys()], row.branch).filter(name => name !== row.branch);
    if (variants.length) return fail('push_rejected', 'remote_case_variant');
    // The remote branch must not exist yet, or be at a commit this worktree pushed: a push
    // never takes over (fast-forwards) a branch someone else created or moved.
    const existing = remote.heads.get(row.branch);
    if (existing) {
      const track = await readTrack(rt, row.id);
      if (!(track.pushed ?? []).includes(existing)) return fail('push_rejected', 'remote_branch_not_ours');
    }
    const held = await verifiedClaim(row, workspace);
    if (held.error) return held.error;
    const busyAfter = await unitJobActive(row);
    if (busyAfter) return busyAfter.error;

    // Explicit refspec without '+': a non-fast-forward is rejected by the remote, never forced.
    const ref = `refs/heads/${row.branch}`;
    const pushed = await runGit(root, [...net.config, 'push', '--porcelain', '--set-upstream', 'origin', `${ref}:${ref}`],
      { timeoutMs: NETWORK_TIMEOUT_MS, maxBytes: 64 * 1024, env: net.env });
    if (pushed.code !== 0) {
      const text = `${pushed.stdout.toString('utf8')}\n${pushed.stderr}`;
      if (/\[rejected\]|non-fast-forward|fetch first/.test(text)) return fail('push_rejected', 'non_fast_forward');
      if (/\[remote rejected\]/.test(text)) return fail('push_rejected', 'remote_rejected');
      return fail('push_failed', pushed.timedOut ? 'timeout' : `exit ${pushed.code}`);
    }
    const remoteCommit = await revParse(root, `refs/remotes/origin/${row.branch}`, env);
    await withTrack(rt, row.id, track => ({ ...track, head, pushed: [...(track.pushed ?? []).filter(c => c !== head), head].slice(-PUSHED_KEEP) }))
      .catch(() => {});

    // Durability is tracked by the Coordinator: a checkpoint under the workspace's claim. The
    // request metadata goes along: under session_binding enforce the Coordinator refuses a
    // remote call without the conversation's session (#60, PR #59 on 2026-10-15).
    let checkpoint;
    try {
      const coordinator = rt.coordinator();
      const record = coordinator.taskCheckpoint ?? coordinator.issueCheckpoint;
      const result = await record({ workspace_id: workspace.id, issue: row.issue_ref, task: row.issue_ref,
        claim_id: held.claim.claim_id, fence: held.claim.fence_sha, branch: row.branch, commit: head,
        note: `pushed from worktree ${row.id}` }, meta ?? null);
      checkpoint = result?.ok ? { ok: true, durability: result.durability } : fail(result?.error ?? 'checkpoint_failed', result?.detail);
    } catch {
      checkpoint = fail('store_unavailable');
    }
    return {
      ok: true, branch: row.branch, remote: 'origin', remote_ref: ref, commit: head, remote_commit: remoteCommit, checkpoint,
      ...(checkpoint.ok ? {} : { warning: 'pushed, but the checkpoint was not recorded; record it again with task_checkpoint' })
    };
  }

  async function removeWorktree(args, ctx) {
    // Cleanup is allowed from a closed workspace too, like releasing a claim.
    const wt = await ownedWorktree(args.worktree_id, ctx, { allowRemoved: true });
    if (wt.error) return wt.error;
    const { row } = wt;
    const acting = await childOn(row, args, ctx);
    if (acting.error) return acting.error;
    if (acting.child) return parentOnly('worktree_remove');
    const bound = sessionCheck(wt.workspace, ctx);
    if (bound.error) return bound.error;
    if (row.status === 'removed') return { ok: true, worktree: publicWorktree(row), already_removed: true };
    if (args.discard_ignored !== undefined && typeof args.discard_ignored !== 'boolean') return fail('invalid_input', 'discard_ignored');
    // A job runs inside the directory: cancel it first (job_cancel).
    // Reconciled first: a job whose processes are gone does not block the removal.
    const activeJobs = await write(repo => ACTIVE_JOB_STATUSES.flatMap(status =>
      repo.listJobs({ workspace_id: row.workspace_id, status, limit: 1000 }).filter(job => job.worktree_id === row.id))
      .map(job => reconcileJob(repo, job, now())).filter(job => ACTIVE_JOB_STATUSES.includes(job.status)));
    if (activeJobs.length) return fail('job_active', `${activeJobs.length} job(s) waiting or running in this worktree; cancel them with job_cancel`);
    const markRemoved = async detail => {
      const at = now();
      await write(repo => repo.updateWorktree(row.id, { status: 'removed', removed_at: at, updated_at: at }));
      trackQueues.delete(row.id);
      await trackFile(rt, row.id).then(file => rm(file, { force: true })).catch(() => {});
      return { ok: true, worktree: publicWorktree({ ...row, status: 'removed', removed_at: at }), ...(detail ? { detail } : {}) };
    };
    const located = await locate(row);
    if (located.error?.error === 'worktree_missing') {
      // Deleted by hand: nothing left to lose here. Git's own administrative entry is left for
      // `git worktree prune`, which also touches other worktrees and is not run from here.
      return markRemoved('path was already gone');
    }
    if (located.error) return located.error;
    const { root } = located;
    const env = located.env; // GIT_DIR and GIT_WORK_TREE pinned (locate)
    const changes = await statusEntries(root, env);
    if (!changes) return fail('git_failed', 'status');
    if (changes.count > 0) {
      const untracked = changes.entries.filter(e => e.status === '??').length;
      return fail('worktree_dirty', `${changes.count - untracked} modified, ${untracked} untracked`);
    }
    // Ignored files (.env, node_modules, build output) are not in the status above, and
    // `git worktree remove` deletes them: only with explicit consent.
    const ignored = await runGit(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
      { readOnly: true, env, maxBytes: 256 * 1024 });
    if (ignored.code !== 0 && !ignored.truncated) return fail('git_failed', 'ls-files');
    const ignoredNames = ignored.stdout.toString('utf8').split('\0').filter(Boolean);
    if (ignored.truncated) ignoredNames.pop();
    if (ignoredNames.length && args.discard_ignored !== true) {
      const shown = ignoredNames.slice(0, 10).map(name => cleanLine(name, 200)).join(', ');
      return fail('ignored_files', `${ignoredNames.length}${ignored.truncated ? '+' : ''} ignored entr${ignoredNames.length === 1 ? 'y' : 'ies'} would be deleted (${shown}${ignoredNames.length > 10 ? ', ...' : ''}); pass discard_ignored: true to delete them`);
    }
    const unpushed = await runGit(root, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'], { readOnly: true, env, maxBytes: 100 });
    if (unpushed.code !== 0) return fail('git_failed', 'rev-list');
    const count = Number(out(unpushed));
    if (count > 0) return fail('unpushed_commits', `${count} commit(s) not on origin`);
    // The common dir validated by locate(), not asked from inside the worktree; `worktree
    // remove` runs from the repository itself, without the worktree's pins.
    // No --force: git itself refuses a worktree that became dirty in the meantime.
    const removed = await runGit(located.commonDir, ['worktree', 'remove', '--', row.path], { env: baseGitEnv, maxBytes: 16 * 1024 });
    if (removed.code !== 0) return fail('git_failed', 'worktree remove');
    return markRemoved(ignoredNames.length ? `${ignoredNames.length} ignored entr${ignoredNames.length === 1 ? 'y' : 'ies'} deleted` : undefined);
  }
}
