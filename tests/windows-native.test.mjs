// Native Windows proof. Deliberately skipped on Linux/macOS; a Linux mock is NOT a Windows proof.
// Uses temporary per-user directories and an actual stdio MCP client, no owner Mac/VPS secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { standalonePaths } from '../standalone/config.mjs';
import { installStandalone } from '../standalone/install.mjs';

const isWindows = process.platform === 'win32';
const BUNDLE = fileURLToPath(new URL('../dist/standalone/index.mjs', import.meta.url));
const ONLY_TOOLS = ['bridge_info', 'gpu_inventory', 'host_capabilities', 'project_inspect', 'projects_list'].sort();
const FORBIDDEN = ['host_status', 'operator_exec', 'operator_write', 'jobs_submit',
  'github_create_pr', 'worktree_write_file', 'workspace_open'];

test('native Windows: installed, isolated read-only stdio MCP and profile paths', { skip: !isWindows }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'memo-standalone-windows-'));
  const testHome = win32.join(root, 'Friend');
  const roaming = win32.join(testHome, 'AppData', 'Roaming');
  const local = win32.join(testHome, 'AppData', 'Local');
  const paths = standalonePaths({ os: 'win32', home: testHome, env: {
    APPDATA: roaming, LOCALAPPDATA: local, MEMOLABS_ROOT: win32.join(root, 'forbidden-owner')
  } });
  t.after(async () => rm(root, { recursive: true, force: true }));
  assert.equal(paths.config, win32.join(roaming, 'MemoBridge', 'config.json'));
  assert.equal(paths.executable, win32.join(local, 'MemoBridge', 'standalone', 'index.mjs'));
  assert.equal(win32.isAbsolute(paths.config), true);

  const init = await installStandalone({ builtFile: BUNDLE, paths });
  assert.equal(init.ok, true);
  assert.equal(init.config_created, true);
  assert.deepEqual(JSON.parse(await readFile(paths.config, 'utf8')),
    { schema_version: 1, projects: [] });

  const repo = win32.join(root, 'project explicitly allowed');
  await mkdir(win32.join(repo, '.git'), { recursive: true });
  await writeFile(paths.config, JSON.stringify({
    schema_version: 1, projects: [{ name: 'friend-project', path: repo }]
  }));
  const second = await installStandalone({ builtFile: BUNDLE, paths });
  assert.equal(second.config_created, false, 'upgrade preserves per-user config');
  assert.equal(JSON.parse(await readFile(paths.config, 'utf8')).projects[0].path, repo);

  // Spawns precisely the installed, bundled executable, not the owner's bundled MCP.
  const client = new Client({ name: 'windows-native-probe', version: '0.1.0' });
  const env = { ...process.env,
    MEMOLABS_ROOT: win32.join(root, 'owner-not-present'),
    MEMO_BRIDGE_STATE_DIR: win32.join(root, 'owner-state-forbidden'),
    MEMO_BRIDGE_REMOTE_CONFIG: win32.join(root, 'owner-remote-forbidden') };
  const transport = new StdioClientTransport({
    command: process.execPath, args: [paths.executable, '--config', paths.config], env
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(x => x.name).sort();
    assert.deepEqual(tools, ONLY_TOOLS);
    assert.ok(FORBIDDEN.every(x => !tools.includes(x)), 'no privileged tool ever registered');
    async function call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined);
      return JSON.parse(result.content[0].text);
    }
    const info = await call('bridge_info');
    assert.equal(info.mode, 'standalone-readonly');
    assert.equal(info.writes_supported, false);
    assert.equal(info.remote_control_supported, false);
    const hardware = await call('host_capabilities');
    assert.equal(hardware.os, 'win32');
    assert.ok(hardware.cpu_count >= 1);
    assert.deepEqual(await call('projects_list'), { ok: true, projects: [{ name: 'friend-project' }] });
    assert.deepEqual(await call('project_inspect', { project: 'friend-project' }),
      { ok: true, project: 'friend-project', available: true, git: true });
    assert.deepEqual(await call('project_inspect', { project: 'owner-private' }),
      { ok: false, error: 'project_not_registered' });
    const inventory = await call('gpu_inventory');
    assert.ok(['detected', 'unknown'].includes(inventory.status));
    assert.ok(Array.isArray(inventory.gpus));
    assert.ok(inventory.gpus.every(x => ['nvidia', 'amd', 'intel', 'unknown'].includes(x.vendor)));
    // No actual GPU vendor is assumed, and no local absolute project path is exposed.
    assert.ok(!JSON.stringify({ tools, info, hardware, inventory }).includes(root));
    assert.ok(!JSON.stringify(inventory).includes('MEMOLABS_ROOT'));
  } finally {
    await client.close();
  }
});
