// Implicit workspace (owner console REQ-Z1, .agent/project/owner-console/spec.md): a tool that
// needs a workspace and gets none runs in the conversation's own one. Driven through the very
// tool handlers the runtime agent serves (server/registry.mjs collectTools), with the in-memory
// ledger and the stub catalog of the coordinator fixture. Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { parseRemotePolicy } from '../bridge/write-gate.mjs';
import { clientSessionHash } from '../bridge/forward.mjs';
import { collectTools, collectToolDefinitions, registryProblems } from '../server/registry.mjs';
import { IMPLICIT_WORKSPACE_TOOLS, OPENING_TOOLS } from '../server/tools/implicit-workspace.mjs';
import { coordinatorOn, journal, tempStateDir } from './helpers/coordinator-fixture.mjs';
import { memoryLedger } from './helpers/memory-ledger.mjs';

const ALL = Object.values(CAPABILITIES);
const CHAT = makePrincipal('oidc:owner-sub', ALL, { client_type: 'chatgpt', via: 'hub' });
const session = name => clientSessionHash({ mcpReq: { _meta: { 'openai/session': name } } });
const meta = name => ({ meta: { client_session: session(name) } });

const issue = (repo, number, priority = 'p1') => ({ number, state: 'open', title: `Task ${repo}#${number}`,
  body: `## Scope\n\nChange ${number}.\n\n## Acceptance\n\n- test ${number}`,
  repository_url: `https://api.github.com/repos/memolabs-dev/${repo}`, labels: [{ name: 'agent:ready' }, { name: `priority:${priority}` }],
  created_at: '2026-10-10T10:00:00Z', updated_at: '2026-10-14T10:00:00Z' });

async function setup(t, { mode = 'warn', projects = ['memolabs-dev/drop', 'memolabs-dev/cuesheet'] } = {}) {
  const at = Date.parse('2026-10-18T08:00:00Z');
  const ledger = memoryLedger(() => at);
  const items = [issue('drop', 12, 'p1'), issue('cuesheet', 3, 'p0')];
  const searchIssues = async query => {
    const repos = [...query.matchAll(/repo:(\S+)/g)].map(m => m[1].toLowerCase());
    const hits = items.filter(i => repos.some(r => i.repository_url.toLowerCase().endsWith(r)));
    return { ok: true, total_count: hits.length, incomplete: false, items: hits };
  };
  const remotePolicy = parseRemotePolicy({ projects, session_binding: mode });
  const fx = coordinatorOn(await tempStateDir(t), { principal: CHAT, now: () => at, ledger, tasks: { remotePolicy, searchIssues } });
  t.after(() => fx.store.close());
  const tools = await collectTools(() => ({ coordinator: () => fx.coordinator }));
  const call = async (name, args, extra) => JSON.parse((await tools.get(name).handler(args, extra)).content[0].text);
  const active = () => fx.store.transaction(repo => repo.listWorkspaces({ principal: CHAT.id, status: 'active', limit: 50 }), { write: false });
  return { ...fx, ledger, call, active };
}

test('Z1: task_claim without workspace_id opens the conversation workspace, bound to it, and claims', async t => {
  const { call, active, store } = await setup(t);
  const out = await call('task_claim', { issue: 'memolabs-dev/drop#12' }, meta('chat-a'));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.implicit_workspace.opened, true);
  assert.equal(out.implicit_workspace.project, 'drop');
  const [ws] = await active();
  assert.equal(ws.id, out.implicit_workspace.workspace_id);
  assert.equal(ws.client_session, session('chat-a'));
  assert.equal(ws.client_type, 'chatgpt');
  const ops = (await journal(store)).map(e => e.op);
  for (const op of ['workspace_open', 'workspace_auto_open', 'task_claim']) assert.ok(ops.includes(op), op);

  // Later calls of the same conversation find it from the claim, never open another one.
  const renewed = await call('task_renew', { issue: out.issue, claim_id: out.claim_id, fence: out.fence }, meta('chat-a'));
  assert.equal(renewed.ok, true, JSON.stringify(renewed));
  assert.equal(renewed.implicit_workspace.opened, false);
  assert.equal(renewed.implicit_workspace.workspace_id, ws.id);
  const status = await call('workspace_status', {}, meta('chat-a'));
  assert.equal(status.workspace.workspace_id, ws.id);
  assert.equal((await active()).length, 1);
});

test('Z1: another conversation never gets this conversation\'s workspace, even with its claim id', async t => {
  const { call } = await setup(t);
  const out = await call('task_claim', { issue: 'memolabs-dev/drop#12' }, meta('chat-a'));
  const stolen = await call('task_renew', { issue: out.issue, claim_id: out.claim_id, fence: out.fence }, meta('chat-b'));
  assert.equal(stolen.ok, false);
  assert.equal(stolen.error, 'workspace_required');
  assert.match(stolen.next_step, /claim its task first|name the project/);
  const status = await call('workspace_status', {}, meta('chat-b'));
  assert.equal(status.error, 'workspace_required');
});

test('Z1: without a session hint nothing is chosen: workspace_required with the one next step', async t => {
  const { call, active } = await setup(t);
  const out = await call('task_claim', { issue: 'memolabs-dev/drop#12' }, { meta: null });
  assert.equal(out.error, 'workspace_required');
  assert.match(out.next_step, /workspace_open/);
  assert.equal((await active()).length, 0);
});

test('Z1: only task_claim and task_next open; any other tool asks for the task first', async t => {
  const { call, active } = await setup(t);
  for (const name of ['worktree_create', 'task_checkpoint', 'workspace_close', 'jobs_submit']) {
    const out = await call(name, { issue: 'memolabs-dev/drop#12', worktree_id: 'wt_aaaaaaaaaaaaaaaa', recipe: 'test',
      claim_id: '0'.repeat(32), fence: 'a'.repeat(40), title: 'x' }, meta('chat-c'));
    assert.equal(out.error, 'workspace_required', name);
  }
  assert.equal((await active()).length, 0);
  assert.deepEqual([...OPENING_TOOLS].sort(), ['task_claim', 'task_next']);
});

test('Z1: task_next without project opens on an allowed project and takes the highest priority task anywhere', async t => {
  const { call, active } = await setup(t);
  const out = await call('task_next', {}, meta('chat-d'));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.task.issue, 'memolabs-dev/cuesheet#3');
  assert.equal(out.implicit_workspace.opened, true);
  const [ws] = await active();
  assert.equal(ws.project_id, 'cuesheet', 'the workspace moved to the project of its task');
});

test('Z1: an Issue outside the allowed projects opens nothing', async t => {
  const { call, active } = await setup(t, { projects: ['memolabs-dev/drop'] });
  const out = await call('task_claim', { issue: 'memolabs-dev/cuesheet#3' }, meta('chat-e'));
  assert.equal(out.ok, false);
  assert.equal(out.error, 'workspace_required');
  assert.match(out.next_step, /no project you may work on/);
  const named = await call('task_claim', { issue: 'memolabs-dev/drop#12', workspace_id: undefined }, meta('chat-e'));
  assert.equal(named.ok, true, JSON.stringify(named));
  assert.equal((await active()).length, 1);
});

test('Z1: a second project in the same conversation gets its own workspace; the first is reused for its project', async t => {
  const { call, active } = await setup(t);
  const a = await call('task_claim', { issue: 'memolabs-dev/drop#12' }, meta('chat-f'));
  const b = await call('task_claim', { issue: 'memolabs-dev/cuesheet#3' }, meta('chat-f'));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.notEqual(a.implicit_workspace.workspace_id, b.implicit_workspace.workspace_id);
  assert.equal((await active()).length, 2);
  const again = await call('task_complete', { issue: a.issue, claim_id: a.claim_id, fence: a.fence }, meta('chat-f'));
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.implicit_workspace.workspace_id, a.implicit_workspace.workspace_id);
});

test('Z1: parallel first calls of one conversation share one opened workspace', async t => {
  const { call, active } = await setup(t);
  const [x, y] = await Promise.all([
    call('task_claim', { issue: 'memolabs-dev/drop#12' }, meta('chat-g')),
    call('task_status', { issue: 'memolabs-dev/drop#12' }, meta('chat-g')),
    call('task_next', { project: 'drop' }, meta('chat-g'))
  ]);
  assert.equal(x.ok, true, JSON.stringify(x));
  assert.ok(y);
  assert.equal((await active()).length, 1);
});

test('Z1: an explicit workspace_id is passed through untouched and still checked', async t => {
  const { call } = await setup(t);
  const out = await call('task_claim', { issue: 'memolabs-dev/drop#12', workspace_id: 'ws_doesnotexist0000' }, meta('chat-h'));
  assert.equal(out.error, 'unknown_workspace');
  assert.equal(out.implicit_workspace, undefined);
});

test('Z1: under session_binding enforce the opened workspace is bound and used by the same conversation only', async t => {
  const { call } = await setup(t, { mode: 'enforce' });
  const out = await call('task_claim', { issue: 'memolabs-dev/drop#12' }, meta('chat-i'));
  assert.equal(out.ok, true, JSON.stringify(out));
  const other = await call('workspace_status', { workspace_id: out.implicit_workspace.workspace_id }, meta('chat-j'));
  assert.equal(other.error, 'workspace_other_session');
});

test('Z1: every implicit tool lists workspace_id as optional, and the registry stays valid', async () => {
  const defs = await collectToolDefinitions();
  assert.deepEqual(registryProblems(defs), []);
  for (const name of IMPLICIT_WORKSPACE_TOOLS) {
    const schema = z.toJSONSchema(defs.get(name).inputSchema);
    assert.ok(schema.properties.workspace_id, name);
    assert.equal((schema.required ?? []).includes('workspace_id'), false, name);
  }
});
