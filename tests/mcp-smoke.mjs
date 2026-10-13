import { strict as assert } from 'node:assert';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Portable fixture: CI machines do not contain the owner's canonical project registry.
const root = await mkdtemp(join(tmpdir(), 'memo-bridge-smoke-'));
const repository = join(root, 'memo-bridge');
await mkdir(repository);
await writeFile(join(root, 'PROJECTS.md'), [
  '# Local test registry',
  '## Projets appartenant à Memo Labs',
  '| Name | Path | Kind | Status | Nature | Stack | Vault note |',
  '|---|---|---|---|---|---|---|',
  '| memo-bridge | memo-bridge | repo | active | infrastructure | Node.js | - |',
  '## Dépôts de référence'
].join('\n'));
execFileSync('git', ['init', '-q', '-b', 'main', repository]);

const client = new Client({ name: 'memo-bridge-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['plugin/server/dist/index.mjs'],
  cwd: process.cwd(),
  env: { ...process.env, MEMO_BRIDGE_PROJECTS_ROOT: root }
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map(x => x.name).sort();
  assert.deepEqual(names, ['bridge_info','host_status','list_hosts','project_git_status','project_info','projects_audit','projects_list']);
  for (const name of names) {
    const args = name === 'host_status' ? { host: 'mac' } :
      ['project_info','project_git_status'].includes(name) ? { project: 'memo-bridge' } : {};
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    assert.ok(response.content[0].text.length > 10);
    const payload = JSON.parse(response.content[0].text);
    if (name === 'project_info' || name === 'project_git_status') {
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.project === 'memo-bridge' || payload.project?.name === 'memo-bridge', true);
    }
    if (name === 'projects_list') assert.ok(payload.projects.some(p => p.name === 'memo-bridge'));
    if (name === 'projects_audit') assert.equal(payload.registered_count, 1);
  }
  const macAndVps = await client.callTool({ name: 'list_hosts', arguments: {} });
  assert.equal(JSON.parse(macAndVps.content[0].text).length, 2);
  console.log(JSON.stringify({ok:true, tools:names, multiHost:true, fixture:true}));
} finally {
  await client.close();
  await rm(root, {recursive:true, force:true});
}
