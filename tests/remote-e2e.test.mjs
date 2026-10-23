// TODO-P5-11 end to end, offline: an MCP client (@modelcontextprotocol/client) with a locally
// minted owner token talks to the public listener over HTTPS, and every call travels the real
// path to the runtime: remote surface, forwarder, hub v2 envelope, agent, runtime, store, Git.
// remote.json has the exact shape lab-infra renders. Stage R (writes disabled), stage W (writes
// enabled in a test config, the write gate probe on a systemctl fixture), and the journal.
// Run alone with `pnpm run smoke:remote`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REMOTE_TOOLS, REMOTE_TOOLS_READ } from '../server/registry.mjs';
import { CHATGPT, ISSUE, SUB, SYSTEMCTL_NO_RUNNER, remoteStack } from './helpers/remote-stack.mjs';

const sorted = list => [...list].sort();
const S1 = 'conversation-one';
const S2 = 'conversation-two';

test('stage R (remote_writes disabled): tools/list is the read set, a read works, a forged write is refused and journaled', async t => {
  const s = await remoteStack(t, { remote: { surface: 'full' } });
  const chat = await s.client(await s.mint());
  const tools = await chat.tools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), sorted(REMOTE_TOOLS_READ), 'no write tool while the gate is closed');
  for (const tool of tools) {
    for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) assert.equal(typeof tool.annotations?.[hint], 'boolean', `${tool.name} ${hint}`);
  }

  const projects = await chat.call('projects_list');
  assert.deepEqual(projects.data.projects.map(p => p.name), ['demo'], 'the lab-infra owner/repo entry allows the catalog project');
  const list = await chat.call('workspace_list');
  assert.deepEqual([list.data.ok, list.data.count], [true, 0]);
  assert.match(list.data.request_id, /^[0-9a-f-]{36}$/, 'every forwarded call carries the hub request id');

  // A write tool is not listed, so the SDK answers "unknown tool"; the listener journals it first.
  const forged = await chat.raw.callTool({ name: 'task_claim', arguments: { workspace_id: 'ws_AAAAAAAAAAAAAAAA', issue: ISSUE } })
    .catch(error => ({ isError: true, error }));
  assert.equal(forged.isError, true, JSON.stringify(forged));
  assert.ok(s.journal.some(e => e.event === 'remote_denied' && e.op === 'task_claim' && e.reason === 'write_gate_closed'), 'gate refusal journaled');
  // The runtime grants the owner read only (remote.json, gate layer 3): a forged envelope with
  // a full principal straight to the runtime is refused there too, and journaled there.
  const { makePrincipal, CAPABILITIES } = await import('../server/coordinator/policy.mjs');
  const direct = await s.hub.requestAgent('vps', 'workspace_open', { args: { project: 'demo' },
    principal: makePrincipal(`oidc:${SUB}`, Object.values(CAPABILITIES), { client_type: 'chatgpt', via: 'hub' }) });
  assert.deepEqual(direct, { ok: false, error: 'forbidden' });
  assert.ok((await s.events()).some(e => e.principal === `oidc:${SUB}` && e.op === 'workspace_open' && e.outcome === 'denied'));
  assert.ok(s.wire.every(w => w.id === `oidc:${SUB}` && w.client_type === 'chatgpt'), 'client_type travels on the wire, server-derived');
});

test('stage W (remote_writes enabled, no root runner): a conversation claims, writes, commits and pushes; invariants hold', async t => {
  const s = await remoteStack(t, { remote: { remote_writes: 'enabled', surface: 'full' }, systemctl: SYSTEMCTL_NO_RUNNER });
  const chat = await s.client(await s.mint());
  assert.deepEqual((await chat.tools()).map(tool => tool.name).sort(), sorted(REMOTE_TOOLS));

  // workspace_open: client_type and host come from the server; a requested mac is kept as a label (repatriation D-R14).
  const macOpened = await chat.call('workspace_open', { project: 'demo', host: 'mac' });
  assert.deepEqual([macOpened.data.ok, macOpened.data.workspace.host, macOpened.data.note.host_requested], [true, 'vps', 'mac']);
  const opened = await chat.call('workspace_open', { project: 'demo', client_type: 'codex' }, S1);
  assert.equal(opened.data.ok, true, JSON.stringify(opened.data));
  assert.deepEqual([opened.data.workspace.client_type, opened.data.workspace.host], ['chatgpt', 'vps']);
  const ws = opened.data.workspace.workspace_id;
  assert.equal((await chat.call('workspace_open', { project: 'other' })).data.error, 'project_not_allowed');

  const claim = await chat.call('task_claim', { workspace_id: ws, issue: ISSUE, client_request_id: 'smoke-claim-0001' }, S1);
  assert.equal(claim.data.ok, true, JSON.stringify(claim.data));
  const claimRetry = await chat.call('task_claim', { workspace_id: ws, issue: ISSUE, client_request_id: 'smoke-claim-0001' }, S1);
  assert.equal(claimRetry.data.replayed, true, 'client_request_id reaches the coordinator: a retry replays the first claim');
  // Another conversation writing into this workspace: warned (session_binding warn), journaled.
  const renewOther = await chat.call('task_renew', { workspace_id: ws, issue: ISSUE, claim_id: claim.data.claim_id,
    fence: claim.data.fence }, S2);
  assert.equal(renewOther.data?.session_warning, 'session_mismatch', JSON.stringify(renewOther));

  // The default branch is never a worktree branch, so it is never pushed.
  assert.equal((await chat.call('worktree_create', { workspace_id: ws, issue: ISSUE, branch: 'main' }, S1)).data.error, 'protected_branch');
  const created = await chat.call('worktree_create', { workspace_id: ws, issue: ISSUE }, S1);
  assert.equal(created.data.ok, true, JSON.stringify(created.data));
  const wt = created.data.worktree.worktree_id;

  const write = await chat.call('worktree_write_file', { worktree_id: wt, path: 'notes/remote.md', content: 'written from ChatGPT\n' }, S1);
  assert.equal(write.data.ok, true, JSON.stringify(write.data));
  const crossTalk = await chat.call('worktree_write_file', { worktree_id: wt, path: 'notes/other.md', content: 'other\n' }, S2);
  assert.equal(crossTalk.data.session_warning, 'session_mismatch', 'the session hash reaches the worktree runner');
  const workflow = await chat.call('worktree_write_file', { worktree_id: wt, path: '.github/workflows/evil.yml', content: 'on: push\n' }, S1);
  assert.equal(workflow.data.error, 'path_protected');
  const big = await chat.call('worktree_write_file', { worktree_id: wt, path: 'big.txt', content: 'x'.repeat(100 * 1024) }, S1);
  assert.equal(big.data.error, 'content_too_large', 'the 96 KiB remote write cap (REQ-P5-14)');

  const commit = await chat.call('worktree_commit', { worktree_id: wt, message: 'docs: note from a remote conversation' }, S1);
  assert.equal(commit.data.ok, true, JSON.stringify(commit.data));
  const push = await chat.call('worktree_push', { worktree_id: wt, client_request_id: 'smoke-push-0001' }, S1);
  assert.equal(push.data.ok, true, JSON.stringify(push.data));
  const branch = created.data.worktree.branch;
  assert.equal(s.git(s.origin, 'rev-parse', `refs/heads/${branch}`), commit.data.commit, 'the workspace branch reached origin');
  assert.equal(s.git(s.origin, 'log', '-1', '--format=%s', 'main'), 'initial', 'main on origin is untouched');
  const replay = await chat.call('worktree_push', { worktree_id: wt, client_request_id: 'smoke-push-0001' }, S1);
  assert.equal(replay.data.replayed, true, 'client_request_id reaches the runtime: a retry replays the first push');

  // Journal (REQ-P5-17): the hub line and the runtime event share the request id; via and
  // client_type are server-set; no token, argument or file content anywhere.
  const events = await s.events();
  const pushed = events.find(e => e.op === 'worktree_push' && e.outcome === 'ok');
  assert.ok(pushed, JSON.stringify(events));
  assert.deepEqual([pushed.via, pushed.client_type], ['hub', 'chatgpt']);
  const hubLine = s.journal.find(e => e.event === 'remote_call' && e.op === 'worktree_push' && e.request_id === pushed.request_id);
  assert.ok(hubLine, 'the hub journal line and the runtime event share request_id');
  assert.equal(hubLine.outcome, 'ok');
  const claimEvent = events.find(e => e.op === 'task_claim' && e.outcome === 'ok');
  assert.ok(s.journal.some(e => e.op === 'task_claim' && e.request_id === claimEvent.request_id));
  assert.ok(events.some(e => e.op === 'session_check' && e.code === 'session_mismatch'), 'the cross-conversation write is journaled');
  const everything = JSON.stringify(s.journal) + JSON.stringify(events);
  for (const secret of ['eyJ', 'written from ChatGPT', S1, S2, CHATGPT]) {
    assert.ok(!everything.includes(secret), `journal leaks ${secret}`);
  }
  assert.equal(await readFile(join(s.repo, 'README.md'), 'utf8'), '# demo\n', 'the source checkout is never written');
});

test('stage W refused at start: a root runner keeps the listener from being built', async t => {
  const { SYSTEMCTL_ROOT_RUNNER } = await import('./helpers/remote-stack.mjs');
  await assert.rejects(remoteStack(t, { remote: { remote_writes: 'enabled' }, systemctl: SYSTEMCTL_ROOT_RUNNER }),
    /remote writes refused: root_runner/);
});
