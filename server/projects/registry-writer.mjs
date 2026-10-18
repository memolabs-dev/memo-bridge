// The one writer of the project registry, $MEMOLABS_ROOT/PROJECTS.md, for project_create (owner
// console D-A2-5, .agent/project/owner-console/spec.md section 09). Several sessions write that
// file; a read-modify-write without a lock loses rows in silence, so everything here happens
// under the lock the `proj` CLI already takes (~/bin/proj: mkdir /tmp/proj-registry.lock), and
// `proj heal` and project_create serialize.
//
// It only ever ADDS one row to the main table ("## Projets appartenant à Memo Labs"), in
// alphabetical order, after a backup copy in ~/.home/proj-backups/ (where `proj` keeps its own),
// and replaces the file with an atomic rename. It never edits or removes a row, and never breaks
// a lock it did not take: after `waitMs` it answers registry_locked and writes nothing.
import { copyFile, mkdir, open, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const REGISTRY_LOCK = '/tmp/proj-registry.lock';
const SECTION = '## Projets appartenant';
const MAX_BYTES = 1024 * 1024;
const CELL_RE = /^[^|\n\r]{1,120}$/;
const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail } : {}) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cells = line => (line.startsWith('|') && line.endsWith('|') ? line.slice(1, -1).split('|').map(c => c.trim()) : null);

// The rows of the main table, by name, from the registry text; null when the section is missing.
export function registryRows(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => l.startsWith(SECTION));
  if (start < 0) return null;
  const rows = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i++) {
    const c = cells(lines[i].replace(/\r$/, ''));
    if (!c || c.length < 7 || c[0] === 'Name' || /^-+$/.test(c[0])) continue;
    rows.push({ index: i, name: c[0], path: c[1] });
  }
  return { lines, start, rows };
}

// The text with `row` inserted in alphabetical order, or {error}. row: {name, path, kind, status,
// nature, stack, note}, every cell one line without '|'.
export function insertRow(text, row) {
  const parsed = registryRows(text);
  if (!parsed) return { error: 'projects_section_missing' };
  const values = [row.name, row.path, row.kind, row.status, row.nature, row.stack, row.note];
  if (values.some(v => typeof v !== 'string' || !CELL_RE.test(v))) return { error: 'invalid_row' };
  const existing = parsed.rows.find(r => r.name === row.name);
  if (existing) return { exists: true, row: existing };
  if (!parsed.rows.length) return { error: 'projects_table_missing' };
  const after = parsed.rows.find(r => r.name.localeCompare(row.name, 'en') > 0);
  const at = after ? after.index : parsed.rows[parsed.rows.length - 1].index + 1;
  const lines = [...parsed.lines];
  lines.splice(at, 0, `| ${values.join(' | ')} |`);
  return { text: lines.join('\n') };
}

// Take the lock, or false after waitMs. mkdir is atomic: whoever creates the folder holds it.
export async function acquireLock(lock = REGISTRY_LOCK, { waitMs = 20_000, stepMs = 200 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { await mkdir(lock); return true; } catch (error) { if (error?.code !== 'EEXIST') return false; }
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

// Add one row to <root>/PROJECTS.md under the lock. Returns {ok, added: true|false, row} or a
// refusal. added false: a row with that name was already there (the caller checks its path).
export async function addRegistryRow(root, row, { lock = REGISTRY_LOCK, backupDir = join(homedir(), '.home', 'proj-backups'),
  waitMs = 20_000, now = () => new Date() } = {}) {
  const file = join(root, 'PROJECTS.md');
  if (!(await acquireLock(lock, { waitMs }))) return fail('registry_locked', 'another session holds the registry lock');
  try {
    let text;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_BYTES) return fail('registry_unavailable');
      text = await readFile(file, 'utf8');
    } catch { return fail('registry_unavailable'); }
    const next = insertRow(text, row);
    if (next.error) return fail(next.error);
    if (next.exists) return { ok: true, added: false, row: { name: next.row.name, path: next.row.path } };
    try {
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
      await copyFile(file, join(backupDir, `PROJECTS.md.${stamp}.project-create`));
    } catch { return fail('registry_backup_failed'); }
    const tmp = join(root, `.PROJECTS.md.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, next.text, { flag: 'wx', mode: (await stat(file)).mode & 0o777 });
      const handle = await open(tmp, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(tmp, file);
    } catch {
      await unlink(tmp).catch(() => {});
      return fail('registry_write_failed');
    }
    return { ok: true, added: true, row: { name: row.name, path: row.path } };
  } finally {
    await rmdir(lock).catch(() => {});
  }
}
