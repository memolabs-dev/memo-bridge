// End-to-end stdio contract using an independent temporary OS-user configuration.
// No GitHub, real GPU, VPS, OAuth, owner credential or network access.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { STANDALONE_TOOLS } from '../../standalone/server.mjs';

export async function smokeStandalone({ built = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'memo-standalone-smoke-'));
  const config = join(dir, 'config.json');
  const projectDir = join(dir, 'friend-project');
  let client;
  try {
    await mkdir(join(projectDir, '.git'), { recursive: true });
    await writeFile(config, JSON.stringify({
      schema_version: 1, projects: [{ name: 'friend-project', path: projectDir }]
    }));
    const entry = built ? 'dist/standalone/index.mjs' : 'standalone/index.mjs';
    const transport = new StdioClientTransport({
      command: process.execPath, args: [entry, '--config', config],
      env: {
        ...process.env,
        // Poison old owner-specific variables: this process may not consume them.
        MEMOLABS_ROOT: join(dir, 'forbidden-owner-root'),
        MEMO_BRIDGE_PROJECTS_ROOT: join(dir, 'forbidden-owner-projects'),
        MEMO_BRIDGE_STATE_DIR: join(dir, 'forbidden-owner-state'),
        MEMO_BRIDGE_REMOTE_CONFIG: join(dir, 'forbidden-owner-remote.json')
      }
    });
    client = new Client({ name: 'independent-smoke', version: '0.1.0' });
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    assert.deepEqual(names, [...STANDALONE_TOOLS].sort());
    const tool = async (name, args = {}) => {
      const data = await client.callTool({ name, arguments: args });
      assert.ok(!data.isError, JSON.stringify(data));
      return JSON.parse(data.content[0].text);
    };
    const info = await tool('bridge_info');
    assert.deepEqual([info.mode, info.local_only, info.writes_supported],
      ['standalone-readonly', true, false]);
    assert.ok(!JSON.stringify(info).includes('bridge.memolabs.dev'));
    const host = await tool('host_capabilities');
    assert.ok(host.cpu_count >= 1);
    assert.ok(!JSON.stringify(host).includes('hostname'));
    assert.deepEqual(await tool('projects_list'), { ok: true, projects: [{ name: 'friend-project' }] });
    assert.deepEqual(await tool('project_inspect', { project: 'friend-project' }),
      { ok: true, project: 'friend-project', available: true, git: true });
    assert.deepEqual(await tool('project_inspect', { project: 'other-project' }),
      { ok: false, error: 'project_not_registered' });
    const gpu = await tool('gpu_inventory');
    assert.ok(['detected', 'unknown'].includes(gpu.status));
    assert.ok(Array.isArray(gpu.gpus));
    // The client cannot use the old privileged tools or query arbitrary paths.
    for (const forbidden of ['operator_exec', 'host_status', 'jobs_submit', 'worktree_write_file',
      'github_create_pr', 'workspace_open', 'project_git_status']) {
      assert.ok(!names.includes(forbidden), forbidden);
    }
    for (const output of [info, host, gpu]) {
      assert.ok(!JSON.stringify(output).includes(dir), 'no machine paths exposed');
    }
    return { ok: true, tool_count: names.length, mode: info.mode };
  } finally {
    try { await client?.close(); } catch { /* cleanup */ }
    await rm(dir, { recursive: true, force: true });
  }
}
