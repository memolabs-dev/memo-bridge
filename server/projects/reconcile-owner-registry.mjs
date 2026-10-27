// Explicit owner-installed Mac reconciliation (#312). Never invoked by a remote tool.
import { lstat, readFile, realpath, open, rename, rmdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { readProjectRegistry } from '../catalog.mjs';
import { parseRemotePolicy } from '../../bridge/write-gate.mjs';
import { parseOwnerPrivatePolicy } from '../coordinator/owner-private-repos.mjs';
import { acquireLock } from './registry-writer.mjs';
import { ENROLL_LOCK, ownerPolicyDir } from './mac-enroll.mjs';
import { enroll, gitOrigin, githubVisibility } from './owner-enrollment.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
async function trusted(path, uid) {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) ||
      st.size > 16384 || await realpath(path) !== path) throw new Error('untrusted_policy');
  return readFile(path, 'utf8');
}
async function atomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    const handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(tmp, path);
  } finally { await unlink(tmp).catch(() => {}); }
}

export async function reconcileOwnerRegistry({ host, home, ownerSub, remoteConfigPath, privatePolicyPath,
  uid = process.getuid?.(), readRegistry = readProjectRegistry, origin = gitOrigin, visibility = githubVisibility,
  lockWaitMs = 1000 } = {}) {
  if (host !== 'mac' || typeof home !== 'string' || !home.startsWith('/')) return { ok: false, error: 'reconcile_unsupported' };
  const dir = ownerPolicyDir(home), remoteFile = join(dir, 'remote.json'), privateFile = join(dir, 'private-repos.json');
  if (remoteConfigPath !== remoteFile || privatePolicyPath !== privateFile) return { ok: false, error: 'reconcile_unsupported' };
  let beforeRemote, beforePrivate, remote, privateRaw;
  try {
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) || await realpath(dir) !== dir) throw new Error();
    beforeRemote = await trusted(remoteFile, uid); beforePrivate = await trusted(privateFile, uid);
    remote = JSON.parse(beforeRemote); privateRaw = JSON.parse(beforePrivate);
    const policy = parseRemotePolicy(remote);
    if (!ownerSub || policy.owner_sub !== ownerSub || !parseOwnerPrivatePolicy(privateRaw, { expectedOwnerSub: ownerSub }).ok) throw new Error();
    if (remote.registry_enrollment !== 'all-owner-projects') return { ok: true, enabled: false };
  } catch { return { ok: false, error: 'reconcile_policy_untrusted' }; }
  let result;
  try {
    const root = join(home, 'memolabs');
    const registry = await readRegistry({ projectsRoot: root, layoutRoot: root,
      externalProjects: { file: join(dir, 'external-projects.json'), ownerSub, home, root } });
    result = await enroll({ projects: registry.projects, allOwnerProjects: true, origin, visibility });
  } catch { return { ok: false, error: 'reconcile_registry_unavailable' }; }
  if (!result.ok) return result;
  // A network, authentication or git failure proves nothing about the registry: write nothing
  // and retry later rather than compute a policy from an incomplete attestation (#312).
  if (result.skipped.some(p => p.reason === 'github_unverified')) return { ok: false, error: 'reconcile_github_unverified' };
  if (result.skipped.some(p => p.reason === 'origin_unverified')) return { ok: false, error: 'reconcile_registry_unverified' };
  // A conclusive skip (no owner origin, definitely absent, archived) is safe only when it cannot
  // revoke a grant this policy already carries. Removing an enrolled project stays an explicit
  // installer action; a periodic reconcile never drops one on evidence it did not complete.
  const skippedNames = new Set(result.skipped.map(p => p.name));
  const wouldRevoke = remote.projects.filter(name => skippedNames.has(name));
  if (wouldRevoke.length) return { ok: false, error: 'reconcile_would_revoke', detail: wouldRevoke.slice(0, 5).join(', ') };
  const names = [...result.projects, ...result.publicProjects].map(p => p.name).sort();
  const repos = result.projects.map(p => p.repo).sort();
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (same(remote.projects, names) && same(privateRaw.repos, repos)) return { ok: true, changed: false, projects: names.length };
  const lock = join(dir, ENROLL_LOCK);
  // The same stale lock recovery as project_create enrollment; this lock only covers
  // small policy writes, never GitHub/network calls.
  try {
    const held = await lstat(lock);
    if (held.isDirectory() && Date.now() - held.mtimeMs > 120_000) await rmdir(lock);
  } catch { /* absent, nonempty, or another reconciler already recovered it */ }
  if (!(await acquireLock(lock, { waitMs: lockWaitMs, stepMs: 50 }))) return { ok: false, error: 'reconcile_locked' };
  try {
    if (digest(await trusted(remoteFile, uid)) !== digest(beforeRemote) || digest(await trusted(privateFile, uid)) !== digest(beforePrivate))
      return { ok: false, error: 'reconcile_policy_changed' };
    // One bounded rollback pair; always retain both originals before replacing either file.
    await atomic(`${privateFile}.registry-backup`, beforePrivate);
    await atomic(`${remoteFile}.registry-backup`, beforeRemote);
    // The ledger changes first: a crash cannot grant a new private project at the remote gate.
    await atomic(privateFile, `${JSON.stringify({ ...privateRaw, repos })}\n`);
    await atomic(remoteFile, `${JSON.stringify({ ...remote, projects: names }, null, 2)}\n`);
    return { ok: true, changed: true, projects: names.length, skipped: result.skipped };
  } catch { return { ok: false, error: 'reconcile_write_failed' }; }
  finally { await rmdir(lock).catch(() => {}); }
}

export function startOwnerRegistryReconciler({ env = process.env, host, log = () => {}, reconcile = reconcileOwnerRegistry,
  intervalMs = 300_000 } = {}) {
  // Single flight; process lifetime owned by agent-cli. No remote caller supplies these inputs.
  let pending = null, stopped = false;
  const run = () => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    pending = Promise.resolve().then(() => reconcile({ host, home: env.HOME, ownerSub: env.MEMO_BRIDGE_OWNER_SUB,
      remoteConfigPath: env.MEMO_BRIDGE_REMOTE_CONFIG, privatePolicyPath: env.MEMO_BRIDGE_OWNER_PRIVATE_REPOS_FILE }))
      .then(result => { if (!result.ok || result.changed) log('registry_reconciled', result); return result; })
      .catch(() => { log('registry_reconciled', { ok: false, error: 'reconcile_failed' }); })
      .finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(run, intervalMs); timer.unref();
  return { run, async close() { stopped = true; clearInterval(timer); await pending; } };
}
