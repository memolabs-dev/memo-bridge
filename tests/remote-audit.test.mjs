// Phase 5, TODO-P5-07 (AC-P5-16, REQ-P5-17): one hub journal line per remote call or refusal,
// {at, request_id, principal, client_ref, op, outcome, code, ms, bytes}; runtime events carry
// via, client_type and request_id; neither ever holds arguments, tokens or session values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { parseRemotePolicy } from '../bridge/write-gate.mjs';
import { DENIED_CODES, clientRef, createForwarder, hubAuditLine, outcomeOf } from '../bridge/forward.mjs';
import { coordinatorOn, journal, stubLedger, tempStateDir } from './helpers/coordinator-fixture.mjs';

const CHAT = makePrincipal('oidc:owner-sub', Object.values(CAPABILITIES), { client_type: 'chatgpt', via: 'hub' });
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJl';
const SESSION = 'conversation-secret-value-1234';
const LINE_KEYS = ['at', 'bytes', 'client_ref', 'code', 'event', 'ms', 'op', 'outcome', 'principal', 'request_id'];

test('hubAuditLine keeps only its own fields, whatever it is given', () => {
  const line = hubAuditLine({ at: 0, request_id: 'req-0000-0001', principal: 'oidc:x', client_ref: clientRef('https://chatgpt.com/client.json'),
    op: 'task_claim', outcome: 'ok', code: null, ms: 12.4, bytes: 99, args: { content: 'file body' }, token: TOKEN });
  assert.deepEqual(Object.keys(line).sort(), LINE_KEYS);
  assert.equal(line.ms, 12);
  assert.match(line.client_ref, /^[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(line).includes('file body'));
  assert.ok(!JSON.stringify(line).includes('eyJ'));
  // Malformed values are dropped, never copied.
  const bad = hubAuditLine({ at: 0, request_id: 'x y', op: 'Task Claim!', outcome: 'maybe', code: 'Not A Code', client_ref: TOKEN });
  assert.deepEqual([bad.request_id, bad.op, bad.outcome, bad.code, bad.client_ref], [null, 'invalid', 'error', null, null]);
});

test('outcomes: ok, accepted, denied for policy refusals (gate included), error otherwise', () => {
  assert.deepEqual(outcomeOf({ ok: true }), { outcome: 'ok', code: null });
  assert.deepEqual(outcomeOf({ ok: true, status: 'accepted' }), { outcome: 'accepted', code: null });
  for (const code of ['write_gate_closed', 'forbidden', 'project_not_allowed', 'path_protected', 'session_mismatch', 'rate_limited']) {
    assert.ok(DENIED_CODES.has(code), code);
    assert.deepEqual(outcomeOf({ ok: false, error: code }), { outcome: 'denied', code });
  }
  assert.deepEqual(outcomeOf({ ok: false, error: 'ledger_unavailable' }), { outcome: 'error', code: 'ledger_unavailable' });
  assert.deepEqual(outcomeOf({ ok: false, error: 'Not a code' }), { outcome: 'error', code: 'internal_error' });
});

test('AC-P5-16: the hub line and the runtime event share request_id; no token, argument or session value in either', async t => {
  const fx = coordinatorOn(await tempStateDir(t), { principal: CHAT, ledger: stubLedger(),
    tasks: { remotePolicy: parseRemotePolicy({ projects: ['drop'] }) } });
  t.after(() => fx.store.close());
  const methods = { workspace_open: 'workspaceOpen', task_claim: 'taskClaim', write_probe: null };
  const lines = [];
  let n = 0;
  const forwarder = createForwarder({ audit: l => lines.push(l), newRequestId: () => `req-audit-${String(++n).padStart(4, '0')}`,
    requestAgent: (host, op, { args, requestId, clientSession }) => (methods[op]
      ? fx.coordinator[methods[op]](args, { request_id: requestId, client_session: clientSession })
      : { ok: false, error: 'write_gate_closed' }) });
  const ctx = { mcpReq: { _meta: { 'openai/session': SESSION } }, http: { authInfo: { token: TOKEN } } };
  const clientId = 'https://chatgpt.com/oauth/client.json';

  const opened = await forwarder.call({ op: 'workspace_open', args: { project: 'drop', client_label: 'LABEL-NOT-IN-LOGS' }, principal: CHAT, ctx, clientId });
  assert.equal(opened.ok, true);
  const ws = opened.workspace.workspace_id;
  const claimed = await forwarder.call({ op: 'task_claim', args: { workspace_id: ws, issue: 'memolabs-dev/drop#7' }, principal: CHAT, ctx, clientId });
  assert.equal(claimed.ok, true);
  // A forged write the hub gate refuses is journaled as a denial.
  const gated = await forwarder.call({ op: 'write_probe', args: { secret: 'ARG-NOT-IN-LOGS' }, principal: CHAT, ctx, clientId });
  assert.equal(gated.error, 'write_gate_closed');

  assert.equal(lines.length, 3);
  for (const line of lines) assert.deepEqual(Object.keys(line).sort(), LINE_KEYS);
  assert.deepEqual(lines.map(l => [l.op, l.outcome, l.code]),
    [['workspace_open', 'ok', null], ['task_claim', 'ok', null], ['write_probe', 'denied', 'write_gate_closed']]);
  assert.ok(lines.every(l => l.client_ref === clientRef(clientId) && l.principal === CHAT.id && Number.isInteger(l.bytes)));

  const events = await journal(fx.store);
  for (const op of ['workspace_open', 'task_claim']) {
    const hub = lines.find(l => l.op === op);
    const runtime = events.find(e => e.op === op);
    assert.equal(runtime.request_id, hub.request_id, op);
    assert.equal(runtime.via, 'hub');
    assert.equal(runtime.client_type, 'chatgpt');
  }
  // Nothing secret anywhere: token prefix, argument values, label, raw session value.
  const everything = JSON.stringify(lines) + JSON.stringify(events);
  for (const needle of ['eyJ', 'ARG-NOT-IN-LOGS', 'LABEL-NOT-IN-LOGS', SESSION, clientId]) {
    assert.ok(!everything.includes(needle), needle);
  }
});

test('runtime events of a local principal keep via and client_type null; request ids are filterable', async t => {
  const local = makePrincipal('local:owner', Object.values(CAPABILITIES));
  const fx = coordinatorOn(await tempStateDir(t), { principal: local, ledger: stubLedger() });
  t.after(() => fx.store.close());
  const opened = await fx.coordinator.workspaceOpen({ project: 'drop' }, { request_id: 'req-local-0001' });
  await fx.coordinator.workspaceOpen({ project: 'drop' });
  const [first] = await fx.store.transaction(repo => repo.listEvents({ request_id: 'req-local-0001', limit: 5 }), { write: false });
  assert.equal(first.workspace_id, opened.workspace.workspace_id);
  assert.equal(first.via, null);
  assert.equal(first.client_type, null);
  const tagged = await fx.store.transaction(repo => repo.listEvents({ with_request_id: true, limit: 50 }), { write: false });
  assert.equal(tagged.length, 1);
});
