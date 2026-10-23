// What may replace the VPS copy of the Mac project catalog, and how (#79).
//
// A refresh is metadata travelling between two hosts the owner already trusts, so it carries
// the smallest possible authority: this module decides whether an incoming snapshot may
// replace the current one, and installs it so the destination is never missing, half written
// or silently older. It never resolves a path, never reads PROJECTS.md and never widens an
// allowlist: a snapshot only adds visibility metadata (server/catalog-snapshot.mjs,
// .agent/project/project-registry-v2/spec.md).
//
// Three properties, each with a refusal code:
//  - freshness and schema: the incoming document must parse and must not be stale;
//  - replay: it must carry a strictly newer `generated_at` than the document already there,
//    so a captured old snapshot can never be pushed back over a newer one;
//  - atomicity: the content is verified against its SHA-256 *before* the rename, and the
//    rename is the only write the destination ever sees.
//
// Concurrency has its own guard: an exclusive lock file next to the destination. Two
// installers can never interleave, and a lock left behind by a crashed one expires.
import { constants as fsConstants } from 'node:fs';
import { copyFile, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { parseCatalogSnapshot } from './catalog-snapshot.mjs';

export const REFRESH_LIMITS = Object.freeze({
  keepBackups: 3,          // the destination's own copies, newest first
  lockTtlMs: 10 * 60_000,  // a lock older than this belongs to a crashed installer
  mode: 0o640,             // the hub writes it, the runner reads it, nobody else
});

const stamp = ms => new Date(ms).toISOString().replace(/[:.]/g, '-');
const sha256 = data => createHash('sha256').update(data).digest('hex');

// evaluateCatalogRefresh({incoming, current, now, maxAgeMs})
//   incoming  the JSON text the Mac produced (what the transfer verified)
//   current   the JSON text already on this host, or null when there is none or it is unusable
// A corrupt *current* file never blocks a good refresh: it is what a refresh is for.
// Returns {ok, reason, ...} and never throws on bad input.
export function evaluateCatalogRefresh({ incoming, current = null, now = Date.now(), maxAgeMs }) {
  let parsed;
  try {
    parsed = parseCatalogSnapshot(JSON.parse(incoming), { now, ...(maxAgeMs === undefined ? {} : { maxAgeMs }) });
  } catch (error) {
    const message = String(error?.message ?? error);
    return { ok: false, reason: message.startsWith('duplicate_') ? 'duplicate_catalog_project' : 'invalid_snapshot',
      detail: message.slice(0, 200) };
  }
  if (parsed.stale) return { ok: false, reason: 'stale_snapshot', generated_at: parsed.generated_at };

  let previous = null;
  if (current) {
    try {
      // The document already installed keeps its own age: only its version matters here.
      previous = parseCatalogSnapshot(JSON.parse(current),
        { now, maxAgeMs: Number.MAX_SAFE_INTEGER });
    } catch { previous = null; }
  }
  if (previous && Date.parse(parsed.generated_at) <= Date.parse(previous.generated_at)) {
    return { ok: false, reason: 'not_newer', current_generated_at: previous.generated_at,
      incoming_generated_at: parsed.generated_at };
  }
  return { ok: true, reason: 'newer', incoming_generated_at: parsed.generated_at,
    current_generated_at: previous?.generated_at ?? null, projects: parsed.projects.length };
}

// installCatalogSnapshot({path, content, expectedSha256, ...})
//   The single entry point: it takes the lock, reads what is there, applies
//   evaluateCatalogRefresh *under the lock* (so a replay can never slip between the decision
//   and the write), verifies the content against its digest, backs the current document up,
//   writes the new one and renames. Options are injectable so the tests drive time,
//   randomness, the copy and the failures.
export async function installCatalogSnapshot({
  path, content, expectedSha256 = null, now = Date.now(), random = randomBytes,
  mode = REFRESH_LIMITS.mode, lockTtlMs = REFRESH_LIMITS.lockTtlMs,
  copy = copyFile, read = readFile, keepBackups = REFRESH_LIMITS.keepBackups, maxAgeMs = undefined,
}) {
  const digest = sha256(content);
  // A digest the transfer computed and that the content does not have: the transfer lied or
  // was truncated on the way. Nothing is opened, nothing is backed up, nothing changes.
  if (expectedSha256 && expectedSha256 !== digest) {
    return { ok: false, reason: 'digest_mismatch', expected: expectedSha256, computed: digest };
  }

  const lockPath = `${path}.lock`;
  const takeLock = async () => {
    try {
      const handle = await open(lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      await handle.close();
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      // A lock older than the TTL belongs to a crashed installer: take it over once.
      try {
        const info = await stat(lockPath);
        if (now - info.mtimeMs <= lockTtlMs) return false;
        await unlink(lockPath);
        const handle = await open(lockPath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
        await handle.close();
        return true;
      } catch { return false; }
    }
  };
  if (!(await takeLock())) return { ok: false, reason: 'locked', lock: lockPath };

  const tmp = `${path}.tmp-${random(4).toString('hex')}`;
  try {
    // The decision is taken under the lock, on the bytes that are really there: two
    // refreshes can never both believe they are replacing an older document.
    let current = null;
    try { current = await readFile(path, 'utf8'); } catch { current = null; }
    const decision = evaluateCatalogRefresh({ incoming: content, current, now,
      ...(maxAgeMs === undefined ? {} : { maxAgeMs }) });
    if (!decision.ok) return decision;

    let backupPath = null;
    let existing = null;
    try { existing = await stat(path); } catch { existing = null; }
    if (existing) {
      // The previous copy stays on disk even if the write below fails: nothing is ever lost.
      backupPath = `${path}.memo-bak.${stamp(now)}-${random(3).toString('hex')}`;
      try { await copy(path, backupPath, fsConstants.COPYFILE_EXCL); }
      catch { await unlink(tmp).catch(() => {}); return { ok: false, reason: 'backup_failed' }; }
    }

    let handle;
    try {
      handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW, mode);
    } catch { await unlink(tmp).catch(() => {}); return { ok: false, reason: 'write_failed' }; }
    try {
      await handle.writeFile(content);
      await handle.chmod(mode);
      await handle.sync();
    } catch { await handle.close().catch(() => {}); await unlink(tmp).catch(() => {});
      return { ok: false, reason: 'write_failed', backup: backupPath }; }
    await handle.close();

    // Verify the bytes that are about to become the destination, before the only write it
    // ever sees. A half written or truncated file can never land.
    const written = await read(tmp);
    if (sha256(written) !== digest) {
      await unlink(tmp).catch(() => {});
      return { ok: false, reason: 'verify_failed', backup: backupPath };
    }
    await rename(tmp, path);
    await pruneBackups(path, keepBackups).catch(() => {});
    return { ok: true, reason: decision.reason, sha256: digest, bytes: written.length,
      backup: backupPath, mode, replaced: decision.current_generated_at,
      generated_at: decision.incoming_generated_at };
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

async function pruneBackups(path, keep) {
  const dir = path.slice(0, path.lastIndexOf('/')) || '.';
  const base = path.slice(path.lastIndexOf('/') + 1);
  const entries = await readdir(dir);
  const backups = entries.filter(name => name.startsWith(`${base}.memo-bak.`)).sort().reverse();
  for (const name of backups.slice(keep)) await unlink(`${dir}/${name}`).catch(() => {});
}
