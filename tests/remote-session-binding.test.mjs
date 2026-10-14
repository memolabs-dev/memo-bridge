// Phase 5, TODO-P5-10 (AC-P5-10, D8): the conversation hint `_meta["openai/session"]`, hashed by
// the hub, binds a workspace to the conversation that opened it. A write from another present
// session warns (default) or is refused (block); workspace_recover rebinds, journaled. The
// binding is a cross-talk guard, never an authorization: an absent session is never refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { parseRemotePolicy, sessionBindingDecision, requestMeta } from '../bridge/write-gate.mjs';
import { clientSessionHash } from '../bridge/forward.mjs';
import { coordinatorOn, journal, stubLedger, tempStateDir } from './helpers/coordinator-fixture.mjs';

const ALL = Object.values(CAPABILITIES);
const CHAT = makePrincipal('oidc:owner-sub', ALL, { client_type: 'chatgpt', via: 'hub' });
const READER = makePrincipal('oidc:owner-sub', [CAPABILITIES.READ], { client_type: 'chatgpt', via: 'hub' });
const S1 = clientSessionHash({ mcpReq: { _meta: { 'openai/session': 'conversation-one' } } });
const S2 = clientSessionHash({ mcpReq: { _meta: { 'openai/session': 'conversation-two' } } });
const ISSUE = 'memolabs-dev/drop#7';

function chat(t, stateDir, { mode = 'warn', principal = CHAT } = {}) {
  const remotePolicy = parseRemotePolicy({ projects: ['drop'], session_binding: mode });
  const fx = coordinatorOn(stateDir, { principal, ledger: stubLedger(), tasks: { remotePolicy } });
  t.after(() => fx.store.close());
  return fx;
}
const meta = (client_session, request_id = undefined) => ({ client_session, ...(request_id ? { request_id } : {}) });
const rows = async store => (await journal(store)).reverse().map(e => `${e.op}:${e.outcome}${e.code ? `:${e.code}` : ''}`);

test('the session hash is derived by the hub from _meta only, and malformed metadata is dropped', () => {
  assert.match(S1, /^[0-9a-f]{32}$/);
  assert.notEqual(S1, S2);
  assert.equal(clientSessionHash({ mcpReq: { _meta: {} } }), null);
  assert.equal(clientSessionHash({ mcpReq: { _meta: { 'openai/session': 'x'.repeat(600) } } }), null);
  assert.equal(clientSessionHash(null), null);
  assert.deepEqual({ ...requestMeta({ client_session: 'not-a-hash', request_id: 'bad id!' }) }, { client_session: null, request_id: null });
  assert.deepEqual(sessionBindingDecision(S1, S1, 'block'), { ok: true });
  assert.deepEqual(sessionBindingDecision(null, S2, 'block'), { ok: true }, 'an unbound workspace is never refused');
  assert.deepEqual(sessionBindingDecision(S1, null, 'block'), { ok: true }, 'an absent session is never refused');
  assert.deepEqual(sessionBindingDecision(S1, S2, 'warn'), { ok: true, warning: 'session_mismatch' });
  assert.deepEqual(sessionBindingDecision(S1, S2, 'block'), { ok: false, error: 'session_mismatch' });
});

test('AC-P5-10 warn: workspace_open records S1; a write from S2 succeeds with a warning and a journal row', async t => {
  const { coordinator, store } = chat(t, await tempStateDir(t));
  const opened = await coordinator.workspaceOpen({ project: 'drop' }, meta(S1));
  assert.equal(opened.ok, true);
  const id = opened.workspace.workspace_id;
  const row = await store.transaction(repo => repo.getWorkspace(id), { write: false });
  assert.equal(row.client_session, S1);

  const same = await coordinator.taskClaim({ workspace_id: id, issue: ISSUE }, meta(S1));
  assert.equal(same.ok, true);
  assert.equal(same.session_warning, undefined);

  const other = await coordinator.taskRenew({ workspace_id: id, issue: ISSUE, claim_id: same.claim_id, fence: same.fence }, meta(S2));
  assert.equal(other.ok, true);
  assert.equal(other.session_warning, 'session_mismatch');
  assert.ok((await rows(store)).includes('session_check:ok:session_mismatch'));

  // No session presented (stdio, or ChatGPT left it out): no check at all.
  const none = await coordinator.taskRenew({ workspace_id: id, issue: ISSUE, claim_id: same.claim_id, fence: same.fence });
  assert.equal(none.ok, true);
  assert.equal(none.session_warning, undefined);
});

test('AC-P5-10 block: a write from S2 is refused with session_mismatch and journaled; S1 still works', async t => {
  const stateDir = await tempStateDir(t);
  const { coordinator, store } = chat(t, stateDir, { mode: 'block' });
  const id = (await coordinator.workspaceOpen({ project: 'drop' }, meta(S1))).workspace.workspace_id;
  assert.deepEqual(await coordinator.taskClaim({ workspace_id: id, issue: ISSUE }, meta(S2)), { ok: false, error: 'session_mismatch' });
  const log = await rows(store);
  assert.ok(log.includes('task_claim:denied:session_mismatch'), log.join(' '));
  assert.ok(log.includes('session_check:denied:session_mismatch'), log.join(' '));
  // Nothing was claimed by the refused call.
  assert.deepEqual(await store.transaction(repo => repo.claimsOf(id), { write: false }), []);
  assert.equal((await coordinator.taskClaim({ workspace_id: id, issue: ISSUE }, meta(S1))).ok, true);
  // Closing (giving work back) from another conversation is a write too.
  assert.equal((await coordinator.workspaceClose({ workspace_id: id }, meta(S2))).error, 'session_mismatch');
});

test('AC-P5-10 recover: workspace_recover from S2 rebinds explicitly and is journaled; S2 can then write in block mode', async t => {
  const stateDir = await tempStateDir(t);
  const { coordinator, store } = chat(t, stateDir, { mode: 'block' });
  const id = (await coordinator.workspaceOpen({ project: 'drop' }, meta(S1))).workspace.workspace_id;
  const recovered = await coordinator.workspaceRecover({ workspace_id: id }, meta(S2, 'req-recover-0001'));
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.session, { bound: true, rebound: true });
  assert.equal((await store.transaction(repo => repo.getWorkspace(id), { write: false })).client_session, S2);
  const rebind = (await journal(store)).find(e => e.op === 'workspace_rebind');
  assert.equal(rebind.outcome, 'ok');
  assert.equal(rebind.code, 'session_changed');
  assert.equal(rebind.workspace_id, id);
  assert.equal(rebind.request_id, 'req-recover-0001');
  // The old conversation is now the foreign one.
  assert.equal((await coordinator.taskClaim({ workspace_id: id, issue: ISSUE }, meta(S1))).error, 'session_mismatch');
  assert.equal((await coordinator.taskClaim({ workspace_id: id, issue: ISSUE }, meta(S2))).ok, true);
  // Recovering again from the bound session changes nothing.
  assert.deepEqual((await coordinator.workspaceRecover({ workspace_id: id }, meta(S2))).session, { bound: true, rebound: false });
});

test('recover by a read-only principal never rebinds (no write capability), nor on a closed workspace', async t => {
  const stateDir = await tempStateDir(t);
  const writer = chat(t, stateDir);
  const id = (await writer.coordinator.workspaceOpen({ project: 'drop' }, meta(S1))).workspace.workspace_id;
  const reader = chat(t, stateDir, { principal: READER });
  const seen = await reader.coordinator.workspaceRecover({ workspace_id: id }, meta(S2));
  assert.deepEqual(seen.session, { bound: false, rebound: false, reason: 'read_only' });
  assert.equal((await writer.store.transaction(repo => repo.getWorkspace(id), { write: false })).client_session, S1);
  await writer.coordinator.workspaceClose({ workspace_id: id }, meta(S1));
  const closed = await writer.coordinator.workspaceRecover({ workspace_id: id }, meta(S2));
  assert.deepEqual(closed.session, { bound: false, rebound: false, reason: 'workspace_closed' });
});

test('a forged client_session in the tool arguments is ignored: only the metadata channel counts', async t => {
  const { coordinator, store } = chat(t, await tempStateDir(t), { mode: 'block' });
  const opened = await coordinator.workspaceOpen({ project: 'drop', client_session: S2 }, meta(S1));
  const id = opened.workspace.workspace_id;
  assert.equal((await store.transaction(repo => repo.getWorkspace(id), { write: false })).client_session, S1);
  // A write whose arguments claim S1 but whose metadata says S2 is still S2.
  assert.equal((await coordinator.taskClaim({ workspace_id: id, issue: ISSUE, client_session: S1 }, meta(S2))).error, 'session_mismatch');
});
