// #257: the owner's checkouts outside MEMOLABS_ROOT, enrolled in his Mac owner-policy file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTERNAL_SCHEMA, checkExternalPath, parseExternalProjects, readExternalProjects } from '../server/projects/external-projects.mjs';
import { readProjectRegistry, projectInfo } from '../server/catalog.mjs';

const SUB = 'owner-sub-123';
const REPO = 'guillaume-flambard/private-example';

async function fixture(t, { mode = 0o600, data } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mb-ext-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const root = join(home, 'memolabs');
  const checkout = join(home, 'example');
  await mkdir(join(checkout, '.git'), { recursive: true });
  await mkdir(join(root, 'products', 'listed', '.git'), { recursive: true });
  await writeFile(join(root, 'PROJECTS.md'), [
    '# Registry', '', '## Projets appartenant à Memo Labs', '',
    '| Name | Path | Kind | Status | Nature | Stack | Vault |', '|---|---|---|---|---|---|---|',
    '| listed | products/listed | repo | active | listed project | node | - |', '', '## Other', ''
  ].join('\n'));
  const dir = join(home, '.local', 'share', 'memo-bridge', 'owner-policy');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'external-projects.json');
  await writeFile(file, JSON.stringify(data ?? { schema: EXTERNAL_SCHEMA, owner_sub: SUB,
    projects: [{ name: 'example', path: checkout, repo: REPO }] }));
  await chmod(file, mode);
  const options = { file, ownerSub: SUB, home, root, platform: 'darwin', origin: async () => REPO };
  return { base, home, root, checkout, file, options };
}

test('an enrolled external checkout becomes a catalog project after the registry rows', async t => {
  const f = await fixture(t);
  const rows = await readExternalProjects(f.options);
  assert.deepEqual(rows.map(r => [r.name, r.available, r.path, r.external]), [['example', true, f.checkout, true]]);
  const catalog = await readProjectRegistry({ projectsRoot: f.root, layoutRoot: f.root, externalProjects: f.options });
  assert.deepEqual(catalog.projects.map(p => p.name), ['listed', 'example']);
  const info = await projectInfo('example', { projectsRoot: f.root, layoutRoot: f.root, externalProjects: f.options });
  assert.equal(info.project.local_path, f.checkout);
  assert.equal(info.project.kind, 'repo');
  // Left out on request (catalog snapshot export, operator policy).
  const without = await readProjectRegistry({ projectsRoot: f.root, layoutRoot: f.root, externalProjects: false });
  assert.deepEqual(without.projects.map(p => p.name), ['listed']);
});

test('nothing is read off the Mac, without the variable, with another owner or an untrusted file', async t => {
  const f = await fixture(t);
  assert.deepEqual(await readExternalProjects({ ...f.options, platform: 'linux' }), []);
  assert.deepEqual(await readExternalProjects({ ...f.options, file: undefined }), []);
  assert.deepEqual(await readExternalProjects({ ...f.options, ownerSub: 'someone-else' }), []);
  assert.deepEqual(await readExternalProjects({ ...f.options, ownerSub: undefined }), []);
  const other = join(f.home, 'external-projects.json');
  await writeFile(other, '{}'); await chmod(other, 0o600);
  assert.deepEqual(await readExternalProjects({ ...f.options, file: other }), [], 'only the fixed path');
  await chmod(f.file, 0o644);
  assert.deepEqual(await readExternalProjects(f.options), [], 'group or world readable');
  await chmod(f.file, 0o600);
  await rm(f.file); await symlink(other, f.file);
  assert.deepEqual(await readExternalProjects(f.options), [], 'a symlink');
});

test('a row whose origin is not the declared repository is unavailable', async t => {
  const f = await fixture(t);
  const rows = await readExternalProjects({ ...f.options, origin: async () => 'guillaume-flambard/another' });
  assert.deepEqual(rows.map(r => [r.name, r.available, r.path]), [['example', false, null]]);
  const none = await readExternalProjects({ ...f.options, origin: async () => null });
  assert.equal(none[0].available, false);
});

test('a registry row of the same name wins over an external row', async t => {
  const f = await fixture(t, { data: null });
  await writeFile(f.file, JSON.stringify({ schema: EXTERNAL_SCHEMA, owner_sub: SUB,
    projects: [{ name: 'listed', path: f.checkout, repo: REPO }] }));
  await chmod(f.file, 0o600);
  const catalog = await readProjectRegistry({ projectsRoot: f.root, layoutRoot: f.root, externalProjects: f.options });
  assert.deepEqual(catalog.projects.map(p => [p.name, p.path]), [['listed', join(f.root, 'products', 'listed')]]);
});

test('paths: inside the home, outside private folders and the registry root, a real repository', async t => {
  const f = await fixture(t);
  const opts = { home: f.home, root: f.root };
  assert.equal((await checkExternalPath(f.checkout, opts)).ok, true);
  for (const [path, error] of [
    [f.home, 'external_path_outside_home'],
    [f.base, 'external_path_outside_home'],
    [join(f.home, 'missing'), 'external_path_missing'],
    [join(f.root, 'products', 'listed'), 'external_path_in_registry_root']
  ]) assert.equal((await checkExternalPath(path, opts)).error, error, path);
  for (const dir of ['Documents', 'Downloads', '.ssh', '.aws', '.gnupg', 'Library']) {
    const target = join(f.home, dir, 'repo');
    await mkdir(join(target, '.git'), { recursive: true });
    assert.equal((await checkExternalPath(target, opts)).error, 'external_path_denied', dir);
  }
  const plainDir = join(f.home, 'plain');
  await mkdir(plainDir);
  assert.equal((await checkExternalPath(plainDir, opts)).error, 'external_path_not_repository');
  const link = join(f.home, 'link');
  await symlink(f.checkout, link);
  assert.equal((await checkExternalPath(link, opts)).error, 'external_path_not_canonical');
  const worktreeLike = join(f.home, 'wt');
  await mkdir(worktreeLike);
  await writeFile(join(worktreeLike, '.git'), 'gitdir: /elsewhere\n');
  assert.equal((await checkExternalPath(worktreeLike, opts)).error, 'external_path_not_repository');
});

test('file schema: exact keys, owner namespaces, unique names and repositories, absolute paths', () => {
  const item = { name: 'example', path: '/Users/test/example', repo: REPO };
  const good = { schema: EXTERNAL_SCHEMA, owner_sub: SUB, projects: [item] };
  assert.equal(parseExternalProjects(good, { ownerSub: SUB }).ok, true);
  for (const data of [
    { ...good, extra: 1 },
    { ...good, schema: 'memolabs.owner-private-repos.v1' },
    { ...good, projects: [{ ...item, extra: 1 }] },
    { ...good, projects: [{ ...item, repo: 'someone-else/private-example' }] },
    { ...good, projects: [{ ...item, path: 'relative/example' }] },
    { ...good, projects: [{ ...item, path: '/Users/test/../etc' }] },
    { ...good, projects: [{ ...item, name: 'Bad Name' }] },
    { ...good, projects: [item, { ...item, repo: 'guillaume-flambard/other' }] },
    { ...good, projects: [item, { ...item, name: 'other' }] },
    { ...good, projects: Array.from({ length: 21 }, (_, i) => ({ ...item, name: `p${i}`, repo: `memolabs-dev/p${i}` })) }
  ]) assert.equal(parseExternalProjects(data, { ownerSub: SUB }).ok, false, JSON.stringify(data).slice(0, 120));
  assert.equal(parseExternalProjects(good, { ownerSub: 'other' }).ok, false);
});
