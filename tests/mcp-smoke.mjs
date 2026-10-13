import { strict as assert } from 'node:assert';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({ name: 'memo-bridge-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['plugin/server/dist/index.mjs'], cwd: process.cwd() });
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
    if (name === 'projects_list') {
      assert.ok(payload.projects.some(p => p.name === 'memo-bridge'));
    }
    if (name === 'projects_audit') assert.ok(payload.registered_count > 0);

  }
  const macAndVps = await client.callTool({ name: 'list_hosts', arguments: {} });
  assert.equal(JSON.parse(macAndVps.content[0].text).length, 2);
  console.log(JSON.stringify({ok:true, tools:names, multiHost:true}));
} finally {
  await client.close();
}
