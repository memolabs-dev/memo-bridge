import { strict as assert } from 'node:assert';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FAKE_GH_DIR, GOVERNANCE_ROOT, HAS_GOVERNANCE } from './helpers/coordinator-fixture.mjs';

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
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
  GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 'smoke@example.invalid' };
execFileSync('git', ['-C', repository, 'commit', '-q', '--allow-empty', '-m', 'smoke'], { env: gitEnv });
const head = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
// Offline GitHub for the canonical lease ledger.
const githubState = join(root, 'github.json');
const ledgerRoot = 'f'.repeat(40);
await writeFile(githubState, JSON.stringify({ refs: { 'refs/heads/main': ledgerRoot },
  commits: { [ledgerRoot]: { message: 'root', tree: { sha: 'e'.repeat(40) }, parents: [] } },
  issues: { 'memolabs-dev/cuesheet#3': {} } }));

const client = new Client({ name: 'memo-bridge-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['plugin/server/dist/index.mjs'],
  cwd: process.cwd(),
  env: { ...process.env, MEMO_BRIDGE_PROJECTS_ROOT: root, MEMO_BRIDGE_STATE_DIR: join(root, 'state'),
    MEMO_BRIDGE_GOVERNANCE_ROOT: GOVERNANCE_ROOT, PATH: `${FAKE_GH_DIR}:${process.env.PATH}`, FAKE_GH_STATE: githubState }
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map(x => x.name).sort();
  const coordinatorTools = ['coordinator_events','issue_checkpoint','issue_claim','issue_heartbeat','issue_release',
    'issue_status','workspace_close','workspace_list','workspace_open','workspace_status'];
  assert.deepEqual(names, ['bridge_info','host_status','list_hosts','project_git_status','project_info','projects_audit',
    'projects_list', ...coordinatorTools].sort());
  for (const name of names.filter(n => !coordinatorTools.includes(n))) {
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
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  const ws = await call('workspace_open', { project: 'memo-bridge', client_type: 'cli', client_label: 'smoke' });
  assert.equal(ws.ok, true, JSON.stringify(ws));
  const workspace_id = ws.workspace.workspace_id;
  assert.equal((await call('bridge_info', {})).allowed_tools.length, 17);
  let coordinated = false;
  if (HAS_GOVERNANCE) {
    const issue = 'memolabs-dev/cuesheet#3';
    const claim = await call('issue_claim', { workspace_id, issue, ttl_seconds: 120 });
    assert.equal(claim.ok, true, JSON.stringify(claim));
    const other = await call('workspace_open', { project: 'memo-bridge', client_type: 'cli' });
    assert.equal((await call('issue_claim', { workspace_id: other.workspace.workspace_id, issue })).error, 'lease_held');
    const held = { workspace_id, issue, claim_id: claim.claim_id, fence: claim.fence };
    const checkpoint = await call('issue_checkpoint', { ...held, branch: 'main', commit: head });
    assert.equal(checkpoint.durability, 'local_only', JSON.stringify(checkpoint));
    assert.equal((await call('issue_release', { ...held, outcome: 'completed' })).ok, true);
    assert.equal((await call('issue_status', { issue })).lease.state, 'released');
    assert.ok((await call('coordinator_events', { issue })).count >= 4);
    coordinated = true;
  }
  assert.equal((await call('workspace_close', { workspace_id })).workspace.status, 'closed');
  const rejected = await client.callTool({ name: 'issue_claim', arguments: { workspace_id, issue: 'x', ttl_seconds: 5 } });
  assert.equal(rejected.isError, true, 'schema bounds are enforced at the MCP boundary');
  const macAndVps = await client.callTool({ name: 'list_hosts', arguments: {} });
  assert.equal(JSON.parse(macAndVps.content[0].text).length, 2);
  console.log(JSON.stringify({ok:true, tools:names.length, coordinated, multiHost:true, fixture:true}));
} finally {
  await client.close();
  await rm(root, {recursive:true, force:true});
}
