// The owner's checkouts outside MEMOLABS_ROOT (#257), Mac only.
//
// PROJECTS.md lists only checkouts under MEMOLABS_ROOT, and some of the owner's repositories
// live elsewhere on purpose. The owner enrolls them in one file he provisions himself:
//
//   ~/.local/share/memo-bridge/owner-policy/external-projects.json   (0600, his uid, no symlink)
//   {"schema": "memolabs.owner-external-projects.v1", "owner_sub": "<his OIDC sub>",
//    "projects": [{"name": "<catalog name>", "path": "/Users/<him>/<checkout>", "repo": "<owner>/<repo>"}]}
//
// Read only when MEMO_BRIDGE_OWNER_EXTERNAL_PROJECTS_FILE names exactly that file and
// MEMO_BRIDGE_OWNER_SUB equals its owner_sub, with the checks of private-repos.json
// (owner-private-repos.mjs readOwnerFile). The governance ledger reads the same file and counts
// each `repo` as enrolled (scripts/private_owner_allowlist.py). A row becomes a catalog project
// only when its path is a real directory in the owner's home, outside the private folders below
// and outside MEMOLABS_ROOT (a checkout there belongs in PROJECTS.md), holds a .git directory, and
// its origin is `repo`. A PROJECTS.md row of the same name always wins. Memo Bridge never writes in
// the checkout itself: its worktrees go under $MEMOLABS_ROOT/workspace/worktrees/<name>/, and
// only the checkout's .git receives fetched refs and worktree metadata.
import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { OWNER_REPO, readOwnerFile } from '../coordinator/owner-private-repos.mjs';
import { memolabsRoot } from '../memolabs-root.mjs';

export const EXTERNAL_SCHEMA = 'memolabs.owner-external-projects.v1';
export const EXTERNAL_FILE = 'external-projects.json';
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SUB_RE = /^[A-Za-z0-9._@-]{1,120}$/;
const MAX_EXTERNAL = 20;
// Never a project, whatever the file says (the owner's hard rules: private documents, secrets,
// credentials, application data).
const DENIED_HOME_DIRS = Object.freeze(['Documents', 'Downloads', 'Desktop', 'Library', 'Pictures', 'Movies', 'Music',
  '.ssh', '.aws', '.gnupg', '.config', '.local', '.claude', '.codex']);

const fail = error => ({ ok: false, error });
const inside = (root, candidate) => {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const exact = (o, keys) => plain(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));

// The validated rows of the file, or {ok:false}. Pure: no disk access beyond the file itself.
export function parseExternalProjects(raw, { ownerSub } = {}) {
  if (!exact(raw, ['schema', 'owner_sub', 'projects'])) return fail('external_policy_invalid');
  if (raw.schema !== EXTERNAL_SCHEMA || typeof ownerSub !== 'string' || !SUB_RE.test(ownerSub) || raw.owner_sub !== ownerSub)
    return fail('external_policy_owner_mismatch');
  if (!Array.isArray(raw.projects) || raw.projects.length > MAX_EXTERNAL) return fail('external_policy_invalid');
  const names = new Set(); const repos = new Set();
  for (const item of raw.projects) {
    if (!exact(item, ['name', 'path', 'repo']) || typeof item.name !== 'string' || !NAME_RE.test(item.name) ||
      typeof item.path !== 'string' || !isAbsolute(item.path) || item.path.includes('\0') || resolve(item.path) !== item.path ||
      typeof item.repo !== 'string' || !OWNER_REPO.test(item.repo) ||
      names.has(item.name) || repos.has(item.repo.toLowerCase())) return fail('external_policy_invalid');
    names.add(item.name); repos.add(item.repo.toLowerCase());
  }
  return { ok: true, projects: Object.freeze(raw.projects.map(p => Object.freeze({ ...p }))) };
}

function originOf(path) {
  return new Promise(done => {
    execFile('git', ['-C', path, 'remote', 'get-url', 'origin'], {
      timeout: 6000, maxBuffer: 4096, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    }, (error, stdout) => {
      if (error) return done(null);
      const match = /[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?\s*$/.exec(String(stdout).trim());
      done(match ? `${match[1]}/${match[2]}` : null);
    });
  });
}

// Whether a declared path may be a project: {ok:true, path} (its real path) or {ok:false, error}.
export async function checkExternalPath(path, { home, root, fs = { realpath, stat, lstat } } = {}) {
  if (!home || !isAbsolute(home)) return fail('external_path_invalid');
  let real;
  try { real = await fs.realpath(path); } catch { return fail('external_path_missing'); }
  if (real !== path) return fail('external_path_not_canonical');
  const realHome = await fs.realpath(home).catch(() => null);
  if (!realHome || real === realHome || !inside(realHome, real)) return fail('external_path_outside_home');
  const first = relative(realHome, real).split(sep)[0];
  if (DENIED_HOME_DIRS.includes(first)) return fail('external_path_denied');
  const realRoot = root ? await fs.realpath(root).catch(() => resolve(root)) : null;
  if (realRoot && inside(realRoot, real)) return fail('external_path_in_registry_root');
  try {
    if (!(await fs.stat(real)).isDirectory()) return fail('external_path_not_directory');
    const git = await fs.lstat(join(real, '.git'));
    if (!git.isDirectory() || git.isSymbolicLink()) return fail('external_path_not_repository');
  } catch { return fail('external_path_not_repository'); }
  return { ok: true, path: real };
}

// The owner's external projects as catalog rows ({name, path, available, external: true...}).
// Any problem with the file yields no row; a problem with one row makes that row unavailable.
export async function readExternalProjects({ env = process.env, file = env.MEMO_BRIDGE_OWNER_EXTERNAL_PROJECTS_FILE,
  ownerSub = env.MEMO_BRIDGE_OWNER_SUB, home = env.HOME, uid = process.getuid?.(), platform = process.platform,
  root = memolabsRoot(env), origin = originOf, fs } = {}) {
  if (!file || platform !== 'darwin') return [];
  const read = await readOwnerFile({ file, name: EXTERNAL_FILE, home, uid, fs: fs ?? { lstat, realpath, readFile } });
  if (read.error) return [];
  const parsed = parseExternalProjects(read.value, { ownerSub });
  if (!parsed.ok) return [];
  return Promise.all(parsed.projects.map(async item => {
    const checked = await checkExternalPath(item.path, { home, root, ...(fs ? { fs } : {}) });
    const available = checked.ok && (await origin(checked.path))?.toLowerCase() === item.repo.toLowerCase();
    return { name: item.name, pathRelative: null, kind: 'repo', status: 'active', nature: 'owner external checkout',
      stack: '-', vaultNote: null, available, path: available ? checked.path : null, external: true };
  }));
}
