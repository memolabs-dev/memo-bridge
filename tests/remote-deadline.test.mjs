// Phase 5, TODO-P5-09 (AC-P5-14, REQ-P5-15, D10): a mutating op still running at the soft
// deadline answers {status:'accepted', request_id}; the runtime finishes it; the outcome is read
// through workspace_status (requests, in_flight) or task_status; a retry with the same
// client_request_id creates nothing new (Phase 4 FU-5 extended to task_claim).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { parseRemotePolicy } from '../bridge/write-gate.mjs';
import { RETRY_SAFE_OPS, createForwarder } from '../bridge/forward.mjs';
import { coordinatorOn, journal, stubLedger, tempStateDir } from './helpers/coordinator-fixture.mjs';

const CHAT = makePrincipal('oidc:owner-sub', Object.values(CAPABILITIES), { client_type: 'chatgpt', via: 'hub' });
const ISSUE = 'memolabs-dev/drop#7';
const METHODS = { workspace_open: 'workspaceOpen', workspace_status: 'workspaceStatus', task_claim: 'taskClaim',
  task_status: 'taskStatus' };

// A ledger whose claim waits until the test lets it go (the 130 s ledger, made controllable).
function slowLedger() {
  const base = stubLedger();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  return {
    ...base, calls, release: base.release, open: () => release(),
    claim: async (issue, worker, ttl) => { calls.push(issue.ref); await gate; return base.claim(issue, worker, ttl); }
  };
}

function setup(t, stateDir, ledger, { softDeadlineMs = 40 } = {}) {
  const remotePolicy = parseRemotePolicy({ projects: ['drop'] });
  const fx = coordinatorOn(stateDir, { principal: CHAT, ledger, tasks: { remotePolicy } });
  t.after(() => fx.store.close());
  const lines = [];
  // The runtime side of the hub channel: the envelope's request id and session reach the
  // coordinator as metadata, next to the principal, never inside the arguments.
  const requestAgent = (host, op, { args, requestId, clientSession }) =>
    fx.coordinator[METHODS[op]](args, { request_id: requestId, client_session: clientSession });
  let n = 0;
  const forwarder = createForwarder({ requestAgent, softDeadlineMs, audit: line => lines.push(line),
    newRequestId: () => `req-test-${String(++n).padStart(4, '0')}` });
  const call = (op, args) => forwarder.call({ op, args, principal: CHAT });
  return { ...fx, call, lines };
}

test('AC-P5-14: a slow task_claim answers accepted within the soft deadline, finishes, and a retry claims nothing new', async t => {
  const ledger = slowLedger();
  const { call, coordinator, store, lines } = setup(t, await tempStateDir(t), ledger);
  const ws = (await call('workspace_open', { project: 'drop' })).workspace.workspace_id;

  const started = Date.now();
  const first = await call('task_claim', { workspace_id: ws, issue: ISSUE, client_request_id: 'claim-retry-0001' });
  assert.ok(Date.now() - started < 1000, 'answered at the soft deadline, not at the ledger');
  assert.equal(first.ok, true);
  assert.equal(first.status, 'accepted');
  assert.equal(first.request_id, 'req-test-0002');
  assert.equal(first.client_request_id, 'claim-retry-0001');

  // Still running: workspace_status says so, by request id.
  const running = await coordinator.workspaceStatus({ workspace_id: ws });
  assert.deepEqual(running.in_flight.map(r => [r.request_id, r.op]), [['req-test-0002', 'task_claim']]);

  // A retry while the first call runs joins it instead of claiming again.
  const retryWhileRunning = call('task_claim', { workspace_id: ws, issue: ISSUE, client_request_id: 'claim-retry-0001' });
  ledger.open();
  const joined = await retryWhileRunning;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(joined.ok, true);

  // The outcome is now readable through workspace_status, by the request id given to the model.
  const status = await coordinator.workspaceStatus({ workspace_id: ws });
  assert.equal(status.in_flight, undefined);
  assert.equal(status.claims.length, 1);
  assert.ok(status.requests.some(r => r.request_id === 'req-test-0002' && r.op === 'task_claim' && r.outcome === 'ok'),
    JSON.stringify(status.requests));
  assert.equal((await coordinator.taskStatus({ issue: ISSUE })).ok, true);

  // A later retry with the same client_request_id returns the first result and claims nothing.
  const replay = await call('task_claim', { workspace_id: ws, issue: ISSUE, client_request_id: 'claim-retry-0001' });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.claim_id, status.claims[0].claim_id);
  assert.deepEqual(ledger.calls, [ISSUE], 'the ledger saw exactly one claim');
  assert.equal((await store.transaction(repo => repo.claimsOf(ws), { write: false })).length, 1);

  // Hub journal: the accepted answer, then the completion, under the same request id.
  const claimLines = lines.filter(l => l.request_id === 'req-test-0002');
  assert.deepEqual(claimLines.map(l => [l.event, l.outcome]), [['remote_call', 'accepted'], ['remote_call_completed', 'ok']]);
  // And the runtime journal row carries the same request id.
  assert.ok((await journal(store)).some(e => e.op === 'task_claim' && e.outcome === 'ok' && e.request_id === 'req-test-0002'));
});

test('a mutating call without client_request_id gets one from the hub, returned with accepted, and the retry is safe', async t => {
  const ledger = slowLedger();
  const { call } = setup(t, await tempStateDir(t), ledger);
  const ws = (await call('workspace_open', { project: 'drop' })).workspace.workspace_id;
  const accepted = await call('task_claim', { workspace_id: ws, issue: ISSUE });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.client_request_id, `rq_${accepted.request_id}`);
  ledger.open();
  await new Promise(resolve => setTimeout(resolve, 20));
  const replay = await call('task_claim', { workspace_id: ws, issue: ISSUE, client_request_id: accepted.client_request_id });
  assert.equal(replay.replayed, true);
  assert.deepEqual(ledger.calls, [ISSUE]);
});

test('fast calls answer directly; reads are never cut by the soft deadline; a refusal is not stored for replay', async t => {
  const ledger = slowLedger();
  ledger.open();
  const { call, coordinator } = setup(t, await tempStateDir(t), ledger, { softDeadlineMs: 5_000 });
  const ws = (await call('workspace_open', { project: 'drop' })).workspace.workspace_id;
  // An invalid client_request_id is refused before anything runs.
  assert.deepEqual(await coordinator.taskClaim({ workspace_id: ws, issue: ISSUE, client_request_id: 'bad id' }),
    { ok: false, error: 'invalid_input', detail: 'client_request_id' });
  // A refusal is not stored: after it, the same id can still succeed for real.
  const refused = await call('task_claim', { workspace_id: 'ws_AAAAAAAAAAAAAAAA', issue: ISSUE, client_request_id: 'claim-fast-0001' });
  assert.equal(refused.error, 'unknown_workspace');
  const claim = await call('task_claim', { workspace_id: ws, issue: ISSUE, client_request_id: 'claim-fast-0001' });
  assert.equal(claim.status, undefined);
  assert.equal(claim.ok, true);
  assert.equal(claim.replayed, undefined);
  assert.equal(claim.request_id, 'req-test-0003');
  assert.deepEqual(ledger.calls, [ISSUE]);

  // A slow read waits for its result (the hub's own timeout bounds it, not the soft deadline).
  const slowRead = createForwarder({ softDeadlineMs: 1, newRequestId: () => 'req-read-0001',
    requestAgent: () => new Promise(resolve => setTimeout(() => resolve({ ok: true, value: 1 }), 30)) });
  assert.deepEqual(await slowRead.call({ op: 'task_status', args: {}, principal: CHAT }),
    { ok: true, value: 1, request_id: 'req-read-0001' });
});

test('fix F6: only retry-safe ops answer accepted; a slow workspace_open waits for its outcome and gets no injected id', async () => {
  const seen = [];
  const requestAgent = (host, op, { args }) => {
    seen.push({ op, args });
    return new Promise(resolve => setTimeout(() => resolve({ ok: true, op }), 60));
  };
  const forwarder = createForwarder({ requestAgent, softDeadlineMs: 5, audit: () => {} });
  for (const op of ['workspace_open', 'worktree_commit', 'task_release', 'job_cancel']) {
    const res = await forwarder.call({ op, args: {}, principal: CHAT });
    assert.equal(res.status, undefined, `${op} never answers accepted`);
    assert.equal(res.ok, true);
    assert.equal(res.op, op);
  }
  assert.deepEqual(seen.map(s => s.args.client_request_id), [undefined, undefined, undefined, undefined]);
  for (const op of RETRY_SAFE_OPS) {
    const res = await forwarder.call({ op, args: {}, principal: CHAT });
    assert.equal(res.status, 'accepted', op);
  }
});
