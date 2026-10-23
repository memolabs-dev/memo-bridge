import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateCatalogRefresh, installCatalogSnapshot, REFRESH_LIMITS } from '../server/catalog-refresh.mjs';
import { makeCatalogSnapshot, parseCatalogSnapshot } from '../server/catalog-snapshot.mjs';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const at = offset => new Date(NOW + offset).toISOString();
const document = (names, generatedAt) => JSON.stringify(makeCatalogSnapshot(
  names.map(name => ({ name, kind: 'repo', status: 'active', nature: 'app', stack: 'TypeScript' })),
  generatedAt));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'memo-catalog-refresh-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  return { root, path: join(root, 'catalog-snapshot.json') };
}
const install = (path, content, extra = {}) => installCatalogSnapshot({
  path, content, now: NOW, random: () => Buffer.from('aabbccddeeff0011', 'hex'), ...extra });

test('a strictly newer snapshot replaces the current one, backed up and mode-limited', async t => {
  const { path } = await fixture(t);
  const current = document(['memo-bridge', 'cuesheet'], at(-3600_000));
  const incoming = document(['memo-bridge', 'cuesheet', 'drop'], at(0));
  await writeFile(path, current);

  const decision = evaluateCatalogRefresh({ incoming, current, now: NOW });
  assert.equal(decision.ok, true);
  assert.equal(decision.reason, 'newer');
  assert.equal(decision.current_generated_at, at(-3600_000));
  assert.equal(decision.projects, 3);

  const result = await install(path, incoming);
  assert.equal(result.ok, true);
  assert.equal(result.bytes, Buffer.byteLength(incoming));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), JSON.parse(incoming));
  assert.equal((await stat(path)).mode & 0o777, REFRESH_LIMITS.mode);
  assert.ok(result.backup, 'the replaced document is kept');
  assert.equal(await readFile(result.backup, 'utf8'), current);
  assert.equal((await readdir(path.slice(0, path.lastIndexOf('/'))))
    .filter(name => name.startsWith('catalog-snapshot.json.tmp-')).length, 0, 'no temporary file is left');
  assert.deepEqual((await readdir(path.slice(0, path.lastIndexOf('/'))))
    .filter(name => name.endsWith('.lock')), [], 'the lock is released');
});

test('a replayed, older or identical snapshot is refused and nothing changes', async t => {
  const { path } = await fixture(t);
  const current = document(['memo-bridge'], at(-3600_000));
  await writeFile(path, current);

  for (const replay of [document(['memo-bridge', 'drop'], at(-7200_000)), document(['memo-bridge'], at(-3600_000))]) {
    const decision = evaluateCatalogRefresh({ incoming: replay, current, now: NOW });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'not_newer');
    const result = await install(path, replay);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_newer');
  }
  assert.equal(await readFile(path, 'utf8'), current, 'the installed document is untouched');
});

test('a stale, future, malformed or duplicated snapshot is refused before any write', async t => {
  const { path } = await fixture(t);
  const current = document(['memo-bridge'], at(-60_000));
  await writeFile(path, current);

  const refused = [
    [document(['memo-bridge'], at(-25 * 3600_000)), 'stale_snapshot'],
    [JSON.stringify({ ...JSON.parse(document(['memo-bridge'], at(0))), generated_at: at(3600_000) }), 'invalid_snapshot'],
    ['{"schema":"memolabs.project-catalog.v1", not json', 'invalid_snapshot'],
    [JSON.stringify({ ...JSON.parse(document(['memo-bridge', 'cuesheet'], at(0))), projects: [{ name: 'memo-bridge', kind: 'repo', status: 'active', nature: 'app', stack: 'TypeScript' }, { name: 'memo-bridge', kind: 'repo', status: 'active', nature: 'app', stack: 'TypeScript' }] }), 'duplicate_catalog_project'],
  ];
  for (const [incoming, reason] of refused) {
    const decision = evaluateCatalogRefresh({ incoming, current, now: NOW });
    assert.equal(decision.ok, false, reason);
    assert.equal(decision.reason, reason);
    const result = await install(path, incoming);
    assert.equal(result.ok, false);
  }
  assert.equal(await readFile(path, 'utf8'), current);
});

test('a digest that does not match the content is refused without opening the destination', async t => {
  const { path } = await fixture(t);
  const current = document(['memo-bridge'], at(-60_000));
  await writeFile(path, current);
  const incoming = document(['memo-bridge', 'drop'], at(0));

  const result = await install(path, incoming, { expectedSha256: 'f'.repeat(64) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'digest_mismatch');
  assert.equal(await readFile(path, 'utf8'), current);
  assert.deepEqual((await readdir(path.slice(0, path.lastIndexOf('/'))))
    .filter(name => name.includes('memo-bak')), [], 'nothing was backed up, nothing was staged');
});

test('two installers never interleave: the second is refused while the lock lives', async t => {
  const { path } = await fixture(t);
  const current = document(['memo-bridge'], at(-60_000));
  await writeFile(path, current);
  await writeFile(`${path}.lock`, '');

  const result = await install(path, document(['memo-bridge', 'drop'], at(0)));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'locked');
  assert.equal(await readFile(path, 'utf8'), current);

  // A lock left behind by a crashed installer expires, and the refresh then proceeds.
  const old = new Date(NOW - REFRESH_LIMITS.lockTtlMs - 60_000);
  await utimes(`${path}.lock`, old, old);
  const after = await install(path, document(['memo-bridge', 'drop'], at(0)));
  assert.equal(after.ok, true, 'an expired lock is taken over exactly once');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).projects.length, 3);
});

test('a failed backup or a failed verification changes nothing and leaves no debris', async t => {
  const { path } = await fixture(t);
  const current = document(['memo-bridge'], at(-60_000));
  await writeFile(path, current);
  const incoming = document(['memo-bridge', 'drop'], at(0));

  const failingCopy = await install(path, incoming, { copy: async () => { throw new Error('no space'); } });
  assert.equal(failingCopy.ok, false);
  assert.equal(failingCopy.reason, 'backup_failed');
  assert.equal(await readFile(path, 'utf8'), current);

  // The verification reads the staged bytes back: a staging file that does not match the
  // digest never becomes the destination, and the lock is released either way.
  const failingVerify = await install(path, incoming, { read: async () => Buffer.from('tampered') });
  assert.equal(failingVerify.ok, false);
  assert.equal(failingVerify.reason, 'verify_failed');
  assert.equal(await readFile(path, 'utf8'), current);
  assert.ok(failingVerify.backup, 'the current document was already backed up');
  const dir = path.slice(0, path.lastIndexOf('/'));
  assert.deepEqual((await readdir(dir)).filter(name => name.includes('.tmp-')), [], 'no temporary file is left');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.lock')), [], 'the lock is released');
});

test('a corrupt current document never blocks a good refresh, and backups stay bounded', async t => {
  const { path } = await fixture(t);
  await writeFile(path, '{ truncated');
  const decision = evaluateCatalogRefresh({ incoming: document(['memo-bridge'], at(0)), current: await readFile(path, 'utf8'), now: NOW });
  assert.equal(decision.ok, true, 'a corrupt current file is not a version to beat');
  assert.equal(decision.current_generated_at, null);

  for (let i = 1; i <= 5; i += 1) {
    const result = await install(path, document(['memo-bridge'], at(i * 1000)));
    assert.equal(result.ok, true);
  }
  const left = (await readdir(path.slice(0, path.lastIndexOf('/'))))
    .filter(name => name.includes('memo-bak'));
  assert.equal(left.length, REFRESH_LIMITS.keepBackups, 'old backups are pruned, the newest are kept');
});

test('the destination is never readable by anyone but the owner group', async t => {
  const { path } = await fixture(t);
  await install(path, document(['memo-bridge'], at(0)));
  const info = await stat(path);
  assert.equal(info.mode & 0o007, 0, 'no world bits');
  assert.equal(info.mode & 0o070, REFRESH_LIMITS.mode & 0o070);
  assert.equal(info.mode & fsConstants.S_IFMT, fsConstants.S_IFREG);
  assert.equal(parseCatalogSnapshot(JSON.parse(await readFile(path, 'utf8'))).projects.length, 1);
});
