// T1 operator tools: file writes inside the write roots (Phase 6, TODO-P6-08, spec D9, D11).
//
// Every path goes through resolveOperatorPath with access "rw": canonical path inside a write
// root, secret denylist, nothing inside a .git directory, and no file of a registered project
// checkout on its default branch (use_dev_flow). On top of that:
//  - edits are computed in memory, optionally checked by a named validator preset (a fixed
//    argv run on a temporary copy, never a caller string), then written to a temporary file in
//    the same directory with the original mode and owner, fsynced and renamed over the file:
//    a reader sees the old or the new content, never a mix;
//  - whatever is replaced or deleted is backed up first, next to it (<name>.memo-bak.<ts>-<hex>, a
//    directory as <name>.memo-bak.<ts>-<hex>.tar.gz); when the backup fails, nothing changes;
//  - a write that would change the file's owner (the agent cannot chown as another user) is
//    refused rather than done silently;
//  - chmod never sets setuid, setgid or sticky bits, and never follows a symlink.
// Root-owned files outside the write roots are changed through operator_run as_root or
// operator_script (T3, root helper), not here (DEV-P6-18).
import { randomBytes, createHash } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createDenylist, catalogProjects, resolveOperatorPath, contained } from './operator-paths.mjs';
import { runArgv, searchMatcher } from './operator-tools.mjs';
import { UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES } from '../server/tools/operator-tools.mjs';

export const EDIT_MAX_BYTES = 8 * 1024 * 1024;
const DIFF_MAX_LINES = 400;
const UPLOAD_TTL_MS = 60 * 60_000;
const MAX_UPLOADS = 4;
const COPY_MAX_ENTRIES = 10_000;

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const stamp = now => new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// Validator presets (spec D9): name -> how to check a candidate file. `argv(file)` is fixed
// except for the temporary file path the agent created itself. json is checked in process.
export const VALIDATORS = Object.freeze({
  json: { inProcess: text => { JSON.parse(text); } },
  yaml: { argv: f => ['python3', '-I', '-c', 'import sys, yaml; yaml.safe_load(open(sys.argv[1], encoding="utf-8"))', f] },
  traefik: { argv: f => ['python3', '-I', '-c', 'import sys, yaml; yaml.safe_load(open(sys.argv[1], encoding="utf-8"))', f] },
  toml: { argv: f => ['python3', '-I', '-c', 'import sys, tomllib; tomllib.load(open(sys.argv[1], "rb"))', f] },
  python: { argv: f => ['python3', '-I', '-m', 'py_compile', f] },
  sh: { argv: f => ['sh', '-n', f] },
  systemd: { argv: f => ['systemd-analyze', 'verify', f], suffix: '.service' },
  nginx: { argv: f => ['nginx', '-t', '-q', '-c', f] },
  caddy: { argv: f => ['caddy', 'validate', '--adapter', 'caddyfile', '--config', f] }
});

// A compact line diff: the changed region between the common prefix and suffix, as - and +
// lines, bounded. Enough to review an edit; not a minimal diff.
export function lineDiff(before, after) {
  const a = before.split('\n'); const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1; let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const lines = [`@@ line ${start + 1} @@`, ...a.slice(start, endA + 1).map(l => `-${l}`), ...b.slice(start, endB + 1).map(l => `+${l}`)];
  return lines.length > DIFF_MAX_LINES ? [...lines.slice(0, DIFF_MAX_LINES), `... ${lines.length - DIFF_MAX_LINES} more diff lines`].join('\n')
    : lines.join('\n');
}

const occurrences = (text, needle) => { let n = 0; for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++; return n; };

// The new content of an edit, or {error}. Pure.
export function applyEdit(current, args) {
  const { mode, old, new_text: newText = '', pattern, flags = '', start_marker: start, end_marker: end, count = 1 } = args;
  switch (mode) {
    case 'write': return { text: newText };
    case 'append': return { text: current + newText };
    case 'prepend': return { text: newText + current };
    case 'replace': {
      if (typeof old !== 'string') return { error: 'old_required' };
      const n = occurrences(current, old);
      if (n === 0) return { error: 'old_not_found' };
      if (n !== count) return { error: 'old_count_mismatch', found: n };
      return { text: current.split(old).join(newText) };
    }
    case 'regex': {
      if (typeof pattern !== 'string') return { error: 'pattern_required' };
      const m = searchMatcher(pattern, { regex: true });
      if (!m.ok) return { error: m.error };
      let re;
      try { re = new RegExp(pattern, `${[...new Set(flags.replace(/g/g, ''))].join('')}g`); } catch { return { error: 'invalid_pattern' }; }
      let n = 0;
      // A function replacement: new_text is literal ($1 and $& are not expanded).
      const text = current.replace(re, match => (n < count ? (n++, newText) : match));
      if (n === 0) return { error: 'regex_no_match' };
      return { text, replaced: n };
    }
    case 'block': {
      if (typeof start !== 'string' || typeof end !== 'string') return { error: 'markers_required' };
      if (occurrences(current, start) !== 1 || occurrences(current, end) !== 1) return { error: 'markers_not_unique' };
      const i = current.indexOf(start) + start.length;
      const j = current.indexOf(end);
      if (j < i) return { error: 'markers_out_of_order' };
      return { text: current.slice(0, i) + newText + current.slice(j) };
    }
    default: return { error: 'invalid_arguments' };
  }
}

// deps: run (argv runner, validators and tar), projects (D11 source), now, uid (process uid),
// random (ids), stateDir (uploads).
export function createOperatorWriteTools(policy, { run = runArgv, projects = catalogProjects(policy.repositories), now = Date.now,
  uid = process.getuid?.() ?? -1, random = randomBytes, stateDir = policy.stateDir } = {}) {
  const denylist = createDenylist(policy);
  const resolve = (raw, mustExist = true) => resolveOperatorPath(policy, raw, { access: 'rw', mustExist, denylist, projects });
  const tmpName = dir => join(dir, `.memo-tmp-${random(8).toString('hex')}`);
  const isRoot = path => policy.writeRoots.includes(path);

  // Write `data` to `path` atomically, keeping mode and owner of `like` (an fs.Stats) when given.
  async function atomicWrite(path, data, like) {
    const tmp = tmpName(dirname(path));
    const fh = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, like ? like.mode & 0o7777 : 0o644);
    try {
      await fh.writeFile(data);
      if (like) {
        await fh.chmod(like.mode & 0o7777);
        if (like.uid !== uid || like.gid !== (await fh.stat()).gid) {
          try { await fh.chown(like.uid, like.gid); } catch { throw Object.assign(new Error('owner_would_change'), { code: 'OWNER' }); }
        }
      }
      await fh.sync();
    } catch (error) {
      await fh.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw error;
    }
    await fh.close();
    await rename(tmp, path);
  }

  // Backup next to the target. A file is copied (mode kept), a directory archived with tar.
  async function backup(path, info) {
    // Timestamp plus 6 random hex: two backups of one path in the same second never collide.
    const target = `${path}.memo-bak.${stamp(now)}-${random(3).toString('hex')}`;
    if (info.isDirectory()) {
      const archive = `${target}.tar.gz`;
      const r = await run(['tar', '-czf', archive, '-C', dirname(path), basename(path)], { timeoutMs: 240_000 });
      if (r.code !== 0) { await unlink(archive).catch(() => {}); throw new Error('backup_failed'); }
      return archive;
    }
    await copyFile(path, target, fsConstants.COPYFILE_EXCL);
    await chmod(target, info.mode & 0o777 & ~0o022).catch(() => {});
    return target;
  }

  async function validate(name, text, dir) {
    const preset = VALIDATORS[name];
    if (!preset) return fail('invalid_arguments');
    if (preset.inProcess) {
      try { preset.inProcess(text); return null; } catch (error) { return fail('validation_failed', { validator: name, detail: String(error.message).slice(0, 500) }); }
    }
    const file = `${tmpName(dir)}${preset.suffix ?? ''}`;
    await writeFile(file, text, { mode: 0o600, flag: 'wx' });
    try {
      const r = await run(preset.argv(file), { timeoutMs: 20_000, maxBytes: 64 * 1024 });
      if (r.code === null) return fail('validator_unavailable', { validator: name });
      if (r.code !== 0) return fail('validation_failed', { validator: name, exit_code: r.code, detail: `${r.stdout}${r.stderr}`.slice(-2000) });
      return null;
    } finally { await unlink(file).catch(() => {}); }
  }

  const uploads = new Map(); // id -> {path, size, overwrite, file, received:Set, created}
  const uploadDir = () => join(stateDir, 'uploads');
  const sweepUploads = async () => {
    for (const [id, u] of uploads) if (now() - u.created > UPLOAD_TTL_MS) { uploads.delete(id); await unlink(u.file).catch(() => {}); }
  };

  // Staged content for operator_edit: {ok, args, used} or a refusal. A stage belongs to the path it
  // was started for, must be complete, at most EDIT_MAX_BYTES and valid UTF-8.
  async function stagedEditArgs(args, path) {
    const used = [];
    const out = { ...args };
    for (const [key, field] of [['old_upload_id', 'old'], ['new_upload_id', 'new_text']]) {
      if (args[key] === undefined) continue;
      if (args[field] !== undefined) return fail('invalid_arguments', { detail: `${field} or ${key}, not both` });
      const u = uploads.get(args[key]);
      if (!u || !u.stage) return fail('unknown_upload', { detail: key });
      if (!u.staged) return fail('upload_incomplete', { detail: key });
      if (u.path !== path) return fail('stage_path_mismatch', { detail: `${key} was staged for another path` });
      if (u.size > EDIT_MAX_BYTES) return fail('file_too_large');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(u.file)); } catch { return fail('not_text', { detail: key }); }
      if (field === 'old' && !text) return fail('invalid_arguments', { detail: 'old_upload_id is empty' });
      out[field] = text;
      used.push(args[key]);
    }
    delete out.old_upload_id; delete out.new_upload_id;
    return { ok: true, args: out, used };
  }
  async function dropStages(ids) {
    for (const id of ids) { const u = uploads.get(id); uploads.delete(id); if (u) await unlink(u.file).catch(() => {}); }
  }

  return {
    async operator_edit(raw) {
      const at = await resolve(raw.path, raw.create !== true);
      if (!at.ok) return at;
      // Staged content (operator_upload_init stage:true) in place of old / new_text.
      const staged = await stagedEditArgs(raw, at.path);
      if (!staged.ok) return staged;
      const args = staged.args;
      let info = null;
      try { info = await lstat(at.path); } catch { info = null; }
      if (info && !info.isFile()) return fail('not_a_file');
      if (info && info.size > EDIT_MAX_BYTES) return fail('file_too_large');
      if (!info && !['write', 'append', 'prepend'].includes(args.mode)) return fail('not_found');
      let current = '';
      if (info) {
        const buf = await readFile(at.path);
        if (buf.subarray(0, 8192).includes(0)) return fail('not_text');
        current = buf.toString('utf8');
      }
      const edited = applyEdit(current, args);
      if (edited.error) return fail(edited.error, edited.found !== undefined ? { found: edited.found } : {});
      if (Buffer.byteLength(edited.text) > EDIT_MAX_BYTES) return fail('file_too_large');
      const changed = edited.text !== current || !info;
      const base = { ok: true, host: policy.host, path: at.path, changed, created: !info, bytes_before: info ? Buffer.byteLength(current) : 0,
        bytes_after: Buffer.byteLength(edited.text), ...(edited.replaced ? { replaced: edited.replaced } : {}) };
      const diff = args.diff || args.dry_run ? { untrusted_content: { diff: lineDiff(current, edited.text) } } : {};
      if (!changed) return { ...base, ...diff };
      if (args.validator) {
        const bad = await validate(args.validator, edited.text, dirname(at.path));
        if (bad) return bad;
      }
      if (args.dry_run) return { ...base, dry_run: true, ...(args.validator ? { validator: 'passed' } : {}), ...diff };
      let backupPath = null;
      try { if (info) backupPath = await backup(at.path, info); } catch { return fail('backup_failed'); }
      try { await atomicWrite(at.path, edited.text, info); } catch (error) {
        return fail(error?.code === 'OWNER' ? 'owner_would_change' : 'write_failed', backupPath ? { backup: backupPath } : {});
      }
      await dropStages(staged.used);
      return { ...base, backup: backupPath, ...(args.validator ? { validator: 'passed' } : {}), ...diff };
    },

    async operator_upload_init({ path, size, overwrite = false, stage = false }) {
      await sweepUploads();
      if (uploads.size >= MAX_UPLOADS) return fail('too_many_uploads');
      if (stage && size > EDIT_MAX_BYTES) return fail('file_too_large', { max_bytes: EDIT_MAX_BYTES });
      const at = await resolve(path, false);
      if (!at.ok) return at;
      const exists = await lstat(at.path).then(s => s, () => null);
      if (exists && !exists.isFile()) return fail('not_a_file');
      // A stage writes nothing at the path: the edit that uses it decides (and keeps a backup).
      if (exists && !overwrite && !stage) return fail('exists', { detail: 'set overwrite to replace it (a backup is kept)' });
      const id = `up_${random(16).toString('base64url')}`;
      await mkdir(uploadDir(), { recursive: true, mode: 0o700 });
      const file = join(uploadDir(), id);
      await writeFile(file, '', { mode: 0o600, flag: 'wx' });
      uploads.set(id, { path: at.path, size, overwrite, stage, file, received: new Set(), created: now() });
      return { ok: true, host: policy.host, upload_id: id, path: at.path, size, ...(stage ? { stage: true } : {}), chunk_bytes: UPLOAD_CHUNK_BYTES,
        chunks: Math.ceil(size / UPLOAD_CHUNK_BYTES), expires_in_s: UPLOAD_TTL_MS / 1000 };
    },

    async operator_upload_chunk({ upload_id: id, index, content_base64: content }) {
      const u = uploads.get(id);
      if (!u) return fail('unknown_upload');
      if (u.staged) return fail('upload_complete');
      const data = Buffer.from(content, 'base64');
      const expected = Math.min(UPLOAD_CHUNK_BYTES, u.size - index * UPLOAD_CHUNK_BYTES);
      if (expected <= 0 || data.length !== expected) return fail('chunk_size_mismatch', { expected_bytes: Math.max(0, expected) });
      const fh = await open(u.file, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
      try { await fh.write(data, 0, data.length, index * UPLOAD_CHUNK_BYTES); } finally { await fh.close(); }
      u.received.add(index);
      return { ok: true, host: policy.host, upload_id: id, index, received: u.received.size, chunks: Math.ceil(u.size / UPLOAD_CHUNK_BYTES) };
    },

    async operator_upload_complete({ upload_id: id, sha256 }) {
      const u = uploads.get(id);
      if (!u) return fail('unknown_upload');
      const chunks = Math.ceil(u.size / UPLOAD_CHUNK_BYTES);
      if (u.received.size !== chunks) return fail('upload_incomplete', { received: u.received.size, chunks });
      const hash = createHash('sha256');
      await new Promise((ok, ko) => createReadStream(u.file).on('data', c => hash.update(c)).on('end', ok).on('error', ko));
      if (hash.digest('hex') !== sha256) return fail('sha256_mismatch');
      if (u.stage) {
        u.staged = true;
        return { ok: true, host: policy.host, upload_id: id, path: u.path, size: u.size, sha256, staged: true,
          next: 'operator_edit on this path with new_upload_id (or old_upload_id) set to this upload_id', expires_in_s: Math.max(0, Math.round((UPLOAD_TTL_MS - (now() - u.created)) / 1000)) };
      }
      // The destination is checked again: the tree may have changed since init.
      const at = await resolve(u.path, false);
      if (!at.ok) return at;
      const exists = await lstat(at.path).then(s => s, () => null);
      if (exists && (!exists.isFile() || !u.overwrite)) return fail('exists');
      let backupPath = null;
      try { if (exists) backupPath = await backup(at.path, exists); } catch { return fail('backup_failed'); }
      try { await atomicWrite(at.path, await readFile(u.file), exists); } catch (error) {
        return fail(error?.code === 'OWNER' ? 'owner_would_change' : 'write_failed');
      }
      uploads.delete(id);
      await unlink(u.file).catch(() => {});
      return { ok: true, host: policy.host, path: at.path, size: u.size, sha256, backup: backupPath };
    },

    async operator_move({ src, dst, overwrite = false }) {
      const from = await resolve(src);
      if (!from.ok) return from;
      if (isRoot(from.path)) return fail('root_protected');
      const to = await resolve(dst, false);
      if (!to.ok) return to;
      if (contained(from.path, to.path)) return fail('invalid_arguments', { detail: 'destination inside source' });
      const exists = await lstat(to.path).then(s => s, () => null);
      let backupPath = null;
      if (exists) {
        if (!overwrite) return fail('exists');
        try { backupPath = await backup(to.path, exists); } catch { return fail('backup_failed'); }
        if (exists.isDirectory()) await rm(to.path, { recursive: true });
      }
      try { await rename(from.path, to.path); } catch (error) {
        return fail(error?.code === 'EXDEV' ? 'cross_device' : 'move_failed', backupPath ? { backup: backupPath } : {});
      }
      return { ok: true, host: policy.host, src: from.path, dst: to.path, backup: backupPath };
    },

    async operator_copy({ src, dst, overwrite = false, recursive = false }) {
      const from = await resolve(src);
      if (!from.ok) return from;
      const to = await resolve(dst, false);
      if (!to.ok) return to;
      const info = await lstat(from.path);
      if (info.isDirectory() && !recursive) return fail('recursive_required');
      if (contained(from.path, to.path)) return fail('invalid_arguments', { detail: 'destination inside source' });
      const exists = await lstat(to.path).then(s => s, () => null);
      let backupPath = null;
      if (exists) {
        if (!overwrite) return fail('exists');
        try { backupPath = await backup(to.path, exists); } catch { return fail('backup_failed'); }
        await rm(to.path, { recursive: true });
      }
      let entries = 0; let skipped = 0;
      try {
        // Symlinks are copied as links (never followed); secret files are left behind.
        await cp(from.path, to.path, { recursive: true, dereference: false, errorOnExist: true, force: false, preserveTimestamps: true,
          filter: source => {
            if (source !== from.path && denylist.denied(source)) { skipped++; return false; }
            if (source !== from.path && basename(source) === '.git') { skipped++; return false; }
            if (++entries > COPY_MAX_ENTRIES) throw new Error('too_many_entries');
            return true;
          } });
      } catch (error) {
        return fail(error?.message === 'too_many_entries' ? 'too_many_entries' : 'copy_failed', backupPath ? { backup: backupPath } : {});
      }
      return { ok: true, host: policy.host, src: from.path, dst: to.path, entries, secret_entries_skipped: skipped, backup: backupPath };
    },

    async operator_delete({ path, recursive = false }) {
      const at = await resolve(path);
      if (!at.ok) return at;
      if (isRoot(at.path)) return fail('root_protected');
      const info = await lstat(at.path);
      if (info.isDirectory() && !recursive) return fail('recursive_required');
      let backupPath;
      try { backupPath = await backup(at.path, info); } catch { return fail('backup_failed'); }
      await rm(at.path, { recursive: info.isDirectory(), force: false });
      return { ok: true, host: policy.host, path: at.path, deleted: info.isDirectory() ? 'directory' : 'file', backup: backupPath };
    },

    async operator_chmod({ path, mode }) {
      const at = await resolve(path);
      if (!at.ok) return at;
      const bits = parseInt(mode, 8);
      if (!Number.isInteger(bits) || bits > 0o777) return fail('invalid_mode');
      const info = await lstat(at.path);
      if (info.isSymbolicLink()) return fail('symlink_refused');
      await chmod(at.path, bits);
      return { ok: true, host: policy.host, path: at.path, mode: bits.toString(8).padStart(3, '0'), previous: (info.mode & 0o7777).toString(8).padStart(3, '0') };
    }
  };
}
