// Enrollment of a private project the owner just created, on the Mac runtime that serves it (#216).
//
// Until #216 a project made by project_create stayed refused (project_not_allowed) until the owner
// reran deploy/mac/install-runtime-agent.sh --from-registry --install: the two owner-policy files
// were a snapshot of install time. project_create now adds its own repository to them, with the
// smallest authority that does it:
//  - only the two files the installer writes, under ~/.local/share/memo-bridge/owner-policy, and
//    only when this runtime reads exactly them (never the VPS /etc/memo-bridge/remote.json);
//  - only memolabs-dev/<name>, for the name project_create validated; the caller enrolls only a
//    private repository it created or verified on GitHub (server/projects/create.mjs);
//  - only files the readers would trust (regular, not a link, 0600, this uid, the expected owner),
//    so a file someone else could have written is never extended;
//  - at most 100 entries, the readers' limit (owner-private-repos.mjs, write-gate.mjs);
//  - under a lock, read, append, write through a temporary sibling and one rename; private-repos.json
//    first (the ledger's file), then remote.json (the gate's), so a crash between the two leaves a
//    repository the gate still refuses, which the next call finishes.
// The installer regenerates both files from the registry, where project_create also wrote the row,
// so the two writers agree.
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, open, readFile, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parseOwnerPrivatePolicy } from '../coordinator/owner-private-repos.mjs';
import { parseRemotePolicy } from '../../bridge/write-gate.mjs';
import { acquireLock } from './registry-writer.mjs';

const NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MAX_ENTRIES = 100;
const MAX_BYTES = 16384;
// An enrollment holds the lock for milliseconds; one older than this was left by a crashed runtime.
const STALE_LOCK_MS = 2 * 60_000;
const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail } : {}) });

export const ENROLL_LOCK = '.enroll.lock';
export const ownerPolicyDir = home => resolve(home, '.local', 'share', 'memo-bridge', 'owner-policy');

// The text of a file the readers would trust, or null.
async function trustedText(path, uid) {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.isSymbolicLink() || st.size === 0 || st.size > MAX_BYTES || (st.mode & 0o077) !== 0 || st.uid !== uid) return null;
    if (await realpath(path) !== path) return null;
    const text = await readFile(path, 'utf8');
    return Buffer.byteLength(text) > MAX_BYTES ? null : text;
  } catch { return null; }
}

async function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

// {home, ownerSub, name, repo, remoteConfigPath, privatePolicyPath} -> {ok:true, enrolled} or a
// refusal: enroll_unsupported (this runtime does not read the Mac owner-policy files),
// enroll_invalid, enroll_policy_untrusted, enroll_limit, enroll_locked, enroll_write_failed.
export async function enrollOnMac({ home, ownerSub, name, repo, remoteConfigPath, privatePolicyPath,
  uid = process.getuid?.(), lockWaitMs = 10_000 } = {}) {
  if (typeof home !== 'string' || !isAbsolute(home)) return fail('enroll_unsupported', 'no absolute HOME');
  const dir = ownerPolicyDir(home);
  const privateFile = join(dir, 'private-repos.json');
  const remoteFile = join(dir, 'remote.json');
  if (typeof remoteConfigPath !== 'string' || resolve(remoteConfigPath) !== remoteFile ||
      typeof privatePolicyPath !== 'string' || resolve(privatePolicyPath) !== privateFile) {
    return fail('enroll_unsupported', 'this runtime does not read the Mac owner-policy files');
  }
  if (typeof name !== 'string' || !NAME.test(name) || repo !== `memolabs-dev/${name}`) return fail('enroll_invalid');
  if (typeof ownerSub !== 'string' || ownerSub === '') return fail('enroll_policy_untrusted', 'no owner');

  try {
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return fail('enroll_policy_untrusted', 'the owner-policy folder is not a folder');
  } catch { return fail('enroll_policy_untrusted', 'no owner-policy folder'); }
  // The installer (deploy/mac/runtime-mac.mjs configure) takes the same lock while it rewrites both files.
  const lock = join(dir, ENROLL_LOCK);
  try {
    const held = await lstat(lock);
    if (held.isDirectory() && Date.now() - held.mtimeMs > STALE_LOCK_MS) await rmdir(lock);
  } catch { /* no lock, or another caller removed it first */ }
  if (!(await acquireLock(lock, { waitMs: lockWaitMs, stepMs: 50 }))) return fail('enroll_locked');
  try {
    const privateText = await trustedText(privateFile, uid);
    const remoteText = await trustedText(remoteFile, uid);
    if (privateText === null || remoteText === null) return fail('enroll_policy_untrusted', 'an owner-policy file is not trusted');
    let privateRaw, remoteRaw, remote;
    try {
      privateRaw = JSON.parse(privateText);
      remoteRaw = JSON.parse(remoteText);
      remote = parseRemotePolicy(remoteRaw);
    } catch { return fail('enroll_policy_untrusted', 'an owner-policy file does not parse'); }
    const parsed = parseOwnerPrivatePolicy(privateRaw, { expectedOwnerSub: ownerSub });
    if (!parsed.ok || remote.owner_sub !== ownerSub || !Array.isArray(remoteRaw.projects)) {
      return fail('enroll_policy_untrusted', 'the owner-policy files belong to another owner or are invalid');
    }
    const hasRepo = parsed.repos.some(r => r.toLowerCase() === repo.toLowerCase());
    const hasName = remote.projects.includes(name);
    if (hasRepo && hasName) return { ok: true, enrolled: false };
    if ((!hasRepo && parsed.repos.length + 1 > MAX_ENTRIES) || (!hasName && remoteRaw.projects.length + 1 > MAX_ENTRIES)) {
      return fail('enroll_limit', `at most ${MAX_ENTRIES} enrolled projects`);
    }
    try {
      if (!hasRepo) await writeAtomic(privateFile, `${JSON.stringify({ ...privateRaw, repos: [...privateRaw.repos, repo] })}\n`);
      if (!hasName) await writeAtomic(remoteFile, `${JSON.stringify({ ...remoteRaw, projects: [...remoteRaw.projects, name] }, null, 2)}\n`);
    } catch { return fail('enroll_write_failed'); }
    return { ok: true, enrolled: true };
  } finally {
    await rmdir(lock).catch(() => {});
  }
}
