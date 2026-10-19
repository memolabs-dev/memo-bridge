import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const guard = join(root, 'deploy/mac/guard-coordinator-state.py');
const installer = readFileSync(join(root, 'deploy/mac/install-runtime-agent.sh'), 'utf8');
const python = process.env.PYTHON || 'python3';

function run(...argv) {
  const child = spawnSync(python, ['-I', '-B', ...argv], {encoding: 'utf8'});
  if (child.error?.code === 'ENOENT') return null;
  return child;
}
function initDb(path, version = 9) {
  const py = [
    'import sqlite3,sys',
    'con=sqlite3.connect(sys.argv[1])',
    'con.execute("PRAGMA journal_mode=WAL")',
    'con.execute(f"PRAGMA user_version={int(sys.argv[2])}")',
    'con.execute("CREATE TABLE evidence (n TEXT)")',
    'con.execute("INSERT INTO evidence VALUES (?)",("persisted",))',
    'con.commit();con.close()',
  ].join(';');
  const result = run('-c', py, path, String(version));
  assert.equal(result?.status, 0, result?.stderr ?? 'python3 unavailable');
}

test('Mac release guard refuses v8 against a v9 SQLite without modifying live state', t => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-schema-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const db = join(dir, 'coordinator.sqlite'), source = join(dir, 'store.mjs');
  initDb(db, 9);
  writeFileSync(source, 'export const SCHEMA_VERSION = 8;\n');
  const bad = run(guard, source, db);
  assert.equal(bad?.status, 1, bad?.stderr ?? 'python unavailable');
  assert.match(bad.stderr, /state_schema_newer_than_code/);
  assert.equal(existsSync(join(dir, 'pre-release-backups')), false);
  const state = run('-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("PRAGMA user_version").fetchone()[0]); print(c.execute("SELECT n FROM evidence").fetchone()[0])', db);
  assert.equal(state?.stdout.trim(), '9\npersisted');
});

test('Mac release guard backs up v9 including committed data and refuses bad sources', t => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-schema-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const db = join(dir, 'coordinator.sqlite'), source = join(dir, 'store.mjs');
  initDb(db, 9);
  writeFileSync(source, 'export const SCHEMA_VERSION = 9;\n');
  const good = run(guard, source, db);
  assert.equal(good?.status, 0, good?.stderr ?? 'python unavailable');
  assert.match(good.stdout, /coordinator_schema_db=9 runtime_schema=9/);
  const files = readdirSync(join(dir, 'pre-release-backups')).filter(f => f.endsWith('.sqlite'));
  assert.equal(files.length, 1);
  const backup = join(dir, 'pre-release-backups', files[0]);
  const restored = run('-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("PRAGMA user_version").fetchone()[0]); print(c.execute("SELECT n FROM evidence").fetchone()[0]); print(c.execute("PRAGMA integrity_check").fetchone()[0])', backup);
  assert.equal(restored?.stdout.trim(), '9\npersisted\nok');
  writeFileSync(source, 'this release has no schema');
  const invalid = run(guard, source, db);
  assert.equal(invalid?.status, 1);
  assert.match(invalid.stderr, /runtime_release_missing_coordinator_schema/);
});

test('Mac installer checks schema before changing credentials or launchd', () => {
  const guardCall = installer.indexOf('guard-coordinator-state.py');
  assert.ok(guardCall > 0);
  assert.ok(guardCall < installer.indexOf('# 3. Credentials:'));
  assert.ok(guardCall < installer.lastIndexOf('reload_agent\n'));
});

test('Mac guard accepts a fresh database but refuses symlinked state', t => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-schema-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const db = join(dir, 'coordinator.sqlite'), source = join(dir, 'store.mjs');
  writeFileSync(source, 'export const SCHEMA_VERSION = 9;\n');
  assert.equal(run(guard, source, db)?.status, 0);
  const real = join(dir, 'real.sqlite');
  initDb(real, 9);
  symlinkSync(real, db);
  const bad = run(guard, source, db);
  assert.equal(bad?.status, 1);
  assert.match(bad.stderr, /coordinator_db_not_regular_file/);
});
