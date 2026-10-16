import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultStandaloneConfig, parseStandaloneConfig, standalonePaths,
  loadStandaloneConfig, createLocalProjectService
} from '../standalone/config.mjs';
import { installStandalone } from '../standalone/install.mjs';

async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), 'mb-standalone-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('Windows paths belong to the current user, never the owner hub or project root', () => {
  const paths = standalonePaths({
    os: 'win32', home: 'C:\\Users\\Friend',
    env: { APPDATA: 'C:\\Users\\Friend\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Friend\\AppData\\Local',
      MEMO_BRIDGE_PROJECTS_ROOT: 'C:\\Owner\\memolabs' }
  });
  assert.equal(paths.config, 'C:\\Users\\Friend\\AppData\\Roaming\\MemoBridge\\config.json');
  assert.equal(paths.executable, 'C:\\Users\\Friend\\AppData\\Local\\MemoBridge\\standalone\\index.mjs');
  assert.ok(!JSON.stringify(paths).includes('Owner'));
  assert.throws(() => standalonePaths({ os: 'win32', home: 'C:\\Users\\Friend',
    env: { APPDATA: 'relative\\dir', LOCALAPPDATA: 'C:\\Real' } }), /invalid_windows_profile/);
});

test('Linux paths honor XDG with no owner env fallback', () => {
  const p = standalonePaths({ os: 'linux', home: '/home/bob', env: {
    XDG_CONFIG_HOME: '/tmp/bob-conf', XDG_DATA_HOME: '/tmp/bob-data',
    MEMOLABS_ROOT: '/private/memolabs' } });
  assert.equal(p.config, '/tmp/bob-conf/memo-bridge/config.json');
  assert.equal(p.executable, '/tmp/bob-data/memo-bridge/standalone/index.mjs');
});

test('config is deny-by-default; only explicit, valid paths; no owner secrets or defaults', () => {
  assert.deepEqual(defaultStandaloneConfig(), { schema_version: 1, projects: [] });
  const project = { name: 'videoAI', path: 'C:\\Users\\Friend\\projects\\videoAI' };
  assert.deepEqual(parseStandaloneConfig(JSON.stringify({ schema_version: 1, projects: [project] }),
    { os: 'win32' }).projects[0], project);
  const wrong = [
    { schema_version: 1, projects: [], owner_hub: 'https://bridge.memolabs.dev/mcp' },
    { schema_version: 1, projects: [{ ...project, token: 'secret' }] },
    { schema_version: 1, projects: [project, { name: 'VIDEOAI', path: 'C:\\Other' }] },
    { schema_version: 1, projects: [{ name: 'evil', path: 'relative\\foo' }] },
    { schema_version: 1, projects: [{ name: '..', path: 'C:\\Windows' }] },
    { schema_version: 2, projects: [] },
    { schema_version: 1, projects: 'all' },
    { schema_version: 1, projects: new Array(65).fill(project) }
  ];
  for (const spec of wrong) assert.throws(() => parseStandaloneConfig(JSON.stringify(spec),
    { os: 'win32' }), /config_invalid_/);
  assert.throws(() => parseStandaloneConfig('{'), /config_invalid_json/);
});

test('project inspection never enumerates unconfigured paths or reveals configured root', async t => {
  const root = await temp(t);
  const projectPath = join(root, 'hidden-user', 'videoAI');
  await mkdir(join(projectPath, '.git'), { recursive: true });
  const cfg = parseStandaloneConfig(JSON.stringify({
    schema_version: 1, projects: [{ name: 'videoAI', path: projectPath }] }));
  const projects = createLocalProjectService(cfg);
  assert.deepEqual(projects.list(), { ok: true, projects: [{ name: 'videoAI' }] });
  assert.deepEqual(await projects.inspect('videoAI'),
    { ok: true, project: 'videoAI', available: true, git: true });
  assert.deepEqual(await projects.inspect('etc'), { ok: false, error: 'project_not_registered' });
  assert.ok(!JSON.stringify(await projects.inspect('videoAI')).includes(root));
  await rm(join(projectPath, '.git'), { recursive: true, force: true });
  assert.equal((await projects.inspect('videoAI')).git, false);
  await rm(projectPath, { recursive: true, force: true });
  assert.equal((await projects.inspect('videoAI')).available, false);
});

test('installer initializes private per-user config once without replacing edits', async t => {
  const root = await temp(t);
  const binary = join(root, 'src.mjs');
  const config = join(root, 'user', 'config.json');
  const executable = join(root, 'user', 'bin', 'index.mjs');
  await writeFile(binary, 'console.log("standalone");');
  const paths = { config, executable };
  const first = await installStandalone({ builtFile: binary, paths });
  assert.equal(first.ok, true);
  assert.equal(first.config_created, true);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), defaultStandaloneConfig());
  const modified = JSON.stringify({ schema_version: 1, projects: [{ name: 'keep', path: root }] });
  await writeFile(config, modified);
  const again = await installStandalone({ builtFile: binary, paths });
  assert.equal(again.config_created, false);
  assert.equal(await readFile(config, 'utf8'), modified);
  assert.equal(await readFile(executable, 'utf8'), 'console.log("standalone");');
});

test('installer refuses replacing a symlinked config or executable', async t => {
  const root = await temp(t);
  const binary = join(root, 'binary.mjs');
  const real = join(root, 'real.mjs');
  await writeFile(binary, 'good');
  await writeFile(real, 'keep');
  const paths = { config: join(root, 'settings', 'config.json'),
    executable: join(root, 'bin', 'index.mjs') };
  await mkdir(join(root, 'bin'));
  await symlink(real, paths.executable);
  await assert.rejects(installStandalone({ builtFile: binary, paths }), /unsafe_install_target/);
  assert.equal(await readFile(real, 'utf8'), 'keep');
  await rm(paths.executable);
  // The install attempt already created the settings directory; don't recreate it.
  await symlink(real, paths.config);
  await assert.rejects(installStandalone({ builtFile: binary, paths }), /unsafe_config_target/);
});

test('startup refuses uninitialized, malformed, symlink or oversized user config', async t => {
  const root = await temp(t);
  const config = join(root, 'config.json');
  await assert.rejects(loadStandaloneConfig(config), /config_not_initialized/);
  await writeFile(config, '{no');
  await assert.rejects(loadStandaloneConfig(config), /config_invalid_json/);
  await writeFile(config, 'x'.repeat(65537));
  await assert.rejects(loadStandaloneConfig(config), /config_unsafe_file/);
  await rm(config);
  const outside = join(root, 'outside.json');
  await writeFile(outside, JSON.stringify(defaultStandaloneConfig()));
  await symlink(outside, config);
  await assert.rejects(loadStandaloneConfig(config), /config_unsafe_file/);
});
