// Durable state of the hub (issue: hub state lost on every restart; inventory 2026-10-14 §4.9).
//
// The hub keeps a few small tables that must outlive a restart or a deploy: the Telegram /freeze
// flag, the /grant standing approvals, the operator locks, the job notification inbox and the
// watches of running notify jobs. Each one is a JSON document in its own file under one
// directory (systemd StateDirectory= on lab, mode 0700, owner memo-bridge):
//
//   freeze.json, grants.json, locks.json, notifications.json
//
// Writes are atomic (temporary file in the same directory, fsync, rename) and the files are
// 0600. A document that cannot be read or parsed is set aside as <name>.corrupt-<ms> and the
// table starts empty, journaled, never crashing the hub. The one exception is the operator locks:
// they are read with read() (fail closed), the file stays in place, and the hub refuses every
// lock with locks_state_unavailable until the document reads again (fixed, or removed to reset). Without a directory (tests, a hub
// started by hand) every load answers the fallback and every save is a no-op: the behaviour of
// the hub before this module.
//
// What is deliberately NOT kept: approvals waiting for the owner (the call that waits for them
// is gone with the process), implicit per-call locks, upload ids and transfers in progress
// (they belong to a call or an HTTP exchange that the restart ended).
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const HUB_STATE_DOCUMENTS = Object.freeze(['freeze', 'grants', 'locks', 'notifications', 'workspace_routes', 'checkout_leases']);
export const HUB_STATE_VERSION = 1;
// A document larger than this is refused on load and on save (the tables are bounded far below).
export const HUB_STATE_MAX_BYTES = 4 * 1024 * 1024;

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

export function createHubState({ dir = null, record = () => {}, now = Date.now } = {}) {
  if (dir !== null && (typeof dir !== 'string' || !isAbsolute(dir))) throw new Error('hub state directory must be an absolute path');
  if (dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('hub state directory is not a directory');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('hub state directory is not owned by the hub user');
    if ((st.mode & 0o077) !== 0) throw new Error('hub state directory must not be readable by others (0700)');
  }
  const pathOf = name => {
    if (!HUB_STATE_DOCUMENTS.includes(name)) throw new Error(`unknown hub state document ${name}`);
    return join(dir, `${name}.json`);
  };

  function load(name, fallback) {
    if (!dir) return fallback;
    const file = pathOf(name);
    let text;
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.size > HUB_STATE_MAX_BYTES) throw new Error('not a regular file or too large');
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return fallback;
      setAside(name, file, 'unreadable');
      return fallback;
    }
    try {
      const doc = JSON.parse(text);
      if (doc?.version !== HUB_STATE_VERSION || !Object.hasOwn(doc, 'data')) throw new Error('version');
      record('hub_state_loaded', { document: name });
      return doc.data;
    } catch {
      setAside(name, file, 'unparsable');
      return fallback;
    }
  }

  // Fail-closed read for a table whose silent loss is unsafe (the operator locks): {ok:true, data}
  // (data null when the document does not exist yet) or {ok:false, error}. An unreadable or
  // unparsable document is journaled but left in place, so a later read can succeed once it is
  // fixed; nothing here starts an empty table on its behalf. Without a directory: {ok:true, data:null}.
  function read(name) {
    if (!dir) return { ok: true, data: null };
    const file = pathOf(name);
    let text;
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.size > HUB_STATE_MAX_BYTES) throw new Error('not a regular file or too large');
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, data: null };
      record('hub_state_corrupt', { document: name, reason: 'unreadable', kept: true });
      return fail('unreadable');
    }
    try {
      const doc = JSON.parse(text);
      if (doc?.version !== HUB_STATE_VERSION || !Object.hasOwn(doc, 'data')) throw new Error('version');
      return { ok: true, data: doc.data };
    } catch {
      record('hub_state_corrupt', { document: name, reason: 'unparsable', kept: true });
      return fail('unparsable');
    }
  }

  function setAside(name, file, reason) {
    try { renameSync(file, `${file}.corrupt-${now()}`); } catch { /* left in place: the next save replaces it */ }
    record('hub_state_corrupt', { document: name, reason });
  }

  // Atomic replace. Answers {ok:true} or {ok:false, error}; never throws (a save that fails is
  // journaled and the hub keeps working on its memory, as before this module).
  function save(name, data) {
    if (!dir) return { ok: true, skipped: true };
    const file = pathOf(name);
    const tmp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
    let fd = null;
    try {
      const body = JSON.stringify({ version: HUB_STATE_VERSION, saved_at: new Date(now()).toISOString(), data });
      if (Buffer.byteLength(body) > HUB_STATE_MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'too_large' });
      fd = openSync(tmp, 'wx', 0o600);
      writeSync(fd, body);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, file);
      return { ok: true };
    } catch (error) {
      if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
      try { unlinkSync(tmp); } catch { /* not created */ }
      const code = error?.code === 'too_large' ? 'too_large' : 'write_failed';
      record('hub_state_save_failed', { document: name, reason: code });
      return fail(code);
    }
  }

  return Object.freeze({ dir, load, read, save, get durable() { return Boolean(dir); } });
}
