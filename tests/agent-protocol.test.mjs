// Protocol v2, op registry and agent dispatcher (Phase 4: TODO-P4-03, TODO-P4-05; AC-P4-02,
// AC-P4-10 runtime side). The agent is driven by a minimal in-test hub over real TLS; the
// runtime dispatcher runs against a temporary store with a stub ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import WebSocket, { WebSocketServer } from 'ws';
import {
  MAX_FRAME_BYTES, MAX_IN_FLIGHT, MAX_RESULT_BYTES, OperationError, PROTOCOL_VERSION, SUBPROTOCOL, backoffDelay,
  createReassembler, encodeFrames, idempotencyKey, makeRequest, parseFrame, validateHello, validateRequest
} from '../bridge/protocol.mjs';
import {
  HUB_PRINCIPALS, MUTATING_OPS, OPS, PRINCIPAL_IDS, RUNTIME_OPS, TIMEOUTS, collectToolDefinitions, denialReason, principalFromWire
} from '../bridge/ops.mjs';
import { createAgent, createRuntimeOperations, unwrapToolResult } from '../bridge/agent.mjs';
import { generateAgentIdentity, nonce, verifyChallenge } from '../bridge/crypto.mjs';
import { CAPABILITIES, OPERATION_CAPABILITY } from '../server/coordinator/policy.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { PROJECT_ORIGINS, stubLedger, stubProjects, tempStateDir } from './helpers/coordinator-fixture.mjs';

const OWNER = HUB_PRINCIPALS[PRINCIPAL_IDS.owner];
const READER = HUB_PRINCIPALS[PRINCIPAL_IDS.readonly];

async function until(fn, ms = 5000) {
  const expire = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > expire) throw new Error('wait expired'); await new Promise(r => setTimeout(r, 20)); }
}
function tls(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memo-agent-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return { key: readFileSync(join(dir, 'k'), 'utf8'), cert: readFileSync(join(dir, 'c'), 'utf8') };
}

// A minimal hub: v1 challenge, then records every frame and lets the test send frames.
async function fakeHub(t, { host = 'vps', identity, maxPayload = MAX_FRAME_BYTES, ping = false } = {}) {
  const { key, cert } = tls(t);
  const server = createServer({ key, cert });
  const wss = new WebSocketServer({ server, maxPayload, perMessageDeflate: false });
  const hub = { cert, frames: [], hello: null, socket: null, connections: 0, closes: [] };
  wss.on('connection', ws => {
    hub.connections++;
    const value = nonce();
    ws.send(JSON.stringify({ type: 'challenge', nonce: value }));
    ws.on('message', raw => {
      const msg = parseFrame(raw);
      hub.frames.push(msg);
      if (msg?.type === 'authenticate') {
        assert.equal(verifyChallenge(host, value, msg.signature, identity.publicKey), true);
        hub.socket = ws;
        ws.send(JSON.stringify({ type: 'authenticated' }));
      } else if (msg?.type === 'hello') hub.hello = msg;
    });
    ws.on('close', code => hub.closes.push(code));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  hub.port = server.address().port;
  hub.url = `wss://127.0.0.1:${hub.port}/agent`;
  hub.send = msg => hub.socket.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  hub.request = (op, args = {}, principal = OWNER, extra = {}) => {
    const req = makeRequest({ op, args, principal, timeoutMs: 1000, ...extra });
    for (const f of encodeFrames(req)) hub.socket.send(f);
    return req.id;
  };
  hub.answer = id => hub.frames.find(f => f?.id === id && (f.type === 'result' || f.type === 'error'));
  hub.reassembled = id => {
    const parts = createReassembler({ maxMessageBytes: MAX_RESULT_BYTES });
    let out = null;
    for (const f of hub.frames) if (f?.type === 'part' && f.id === id) out = parts.accept(f) ?? out;
    return out?.message ?? null;
  };
  t.after(async () => { for (const c of wss.clients) c.terminate(); await new Promise(r => server.close(r)); });
  return hub;
}

test('frames: large messages are split into <=16 KiB parts and reassembled; caps and gaps are refused', () => {
  const big = { v: 2, type: 'result', id: 'abcdefgh-1234', data: { text: 'é'.repeat(100_000) } };
  const frames = encodeFrames(big);
  assert.ok(frames.length > 1);
  for (const f of frames) assert.ok(Buffer.byteLength(f) <= MAX_FRAME_BYTES, `frame ${Buffer.byteLength(f)} bytes`);
  const parts = createReassembler({ maxMessageBytes: MAX_RESULT_BYTES });
  let out = null;
  for (const f of frames) out = parts.accept(parseFrame(f)) ?? out;
  assert.deepEqual(out.message, big);
  assert.equal(parts.size, 0);
  // Whole message above the cap: the sender gets null and answers *_too_large instead.
  assert.equal(encodeFrames(big, { maxMessageBytes: 1024 }), null);
  // Receiver cap.
  const small = createReassembler({ maxMessageBytes: 20_000, tooLarge: 'request_too_large' });
  const results = frames.map(f => small.accept(parseFrame(f))).filter(Boolean);
  assert.equal(results[0].error, 'request_too_large');
  // A gap (missing seq) and a part that does not start at 0 are refused.
  const gap = createReassembler({ maxMessageBytes: MAX_RESULT_BYTES });
  assert.equal(gap.accept(parseFrame(frames[0])), null);
  assert.equal(gap.accept(parseFrame(frames[2])).error, 'invalid_request');
  assert.equal(createReassembler({ maxMessageBytes: MAX_RESULT_BYTES }).accept(parseFrame(frames[1])).error, 'invalid_request');
  // Too many partial messages at once.
  const many = createReassembler({ maxMessageBytes: MAX_RESULT_BYTES, maxPartial: 1 });
  assert.equal(many.accept({ id: 'aaaaaaaa', seq: 0, last: false, data: 'eA==' }), null);
  assert.equal(many.accept({ id: 'bbbbbbbb', seq: 0, last: false, data: 'eA==' }).error, 'agent_busy');
  // A part may not reassemble into another part.
  const nested = encodeFrames({ v: 2, type: 'part', id: 'cccccccc', pad: 'x'.repeat(20_000) });
  const r = createReassembler({ maxMessageBytes: MAX_RESULT_BYTES });
  let last = null;
  for (const f of nested) last = r.accept(parseFrame(f)) ?? last;
  assert.equal(last.error, 'invalid_request');
});

test('hello and request envelopes are validated; capabilities never come from the wire', () => {
  assert.equal(validateHello({ type: 'hello', v: 2, host: 'vps', ops: ['host_status'] }, 'vps').ok, true);
  assert.equal(validateHello({ type: 'hello', v: 1, host: 'vps', ops: [] }, 'vps').code, 'unsupported_version');
  assert.equal(validateHello({ type: 'hello', v: 3, host: 'vps', ops: [] }, 'vps').code, 'unsupported_version');
  assert.equal(validateHello({ type: 'hello', v: 2, host: 'mac', ops: [] }, 'vps').ok, false);
  assert.equal(validateHello({ type: 'hello', v: 2, host: 'vps', ops: ['rm -rf'] }, 'vps').ok, false);
  assert.equal(validateHello({ type: 'hello', v: 2, host: 'vps', ops: Array(129).fill('a') }, 'vps').ok, false);
  assert.equal(validateHello({ type: 'hello', v: 2, host: 'vps', ops: [], max_inflight: 999 }, 'vps').maxInFlight, MAX_IN_FLIGHT);

  const req = makeRequest({ op: 'job_status', args: { job_id: 'job_x' }, principal: OWNER, timeoutMs: 1000 });
  assert.deepEqual(req.principal, { id: 'hub:owner' });
  assert.equal(validateRequest(req).ok, true);
  assert.equal(validateRequest({ ...req, id: 'x' }).ok, false);
  assert.equal(validateRequest({ ...req, op: '../exec' }).code, 'invalid_request');
  assert.equal(validateRequest({ ...req, args: [] }).code, 'invalid_arguments');
  assert.equal(validateRequest({ ...req, principal: { id: 'root' } }).code, 'unknown_principal');
  // The wire may claim any capabilities; the receiver maps the id with its own table.
  const forged = principalFromWire({ id: 'hub:readonly', capabilities: Object.values(CAPABILITIES) });
  assert.deepEqual([...forged.capabilities], [CAPABILITIES.READ]);
  assert.equal(principalFromWire({ id: 'hub:root' }), null);
  assert.equal(principalFromWire(null), null);

  const k = idempotencyKey('hub:owner', 'jobs_submit', 'r1');
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.notEqual(k, idempotencyKey('hub:readonly', 'jobs_submit', 'r1'));
  assert.equal(idempotencyKey('hub:owner', 'jobs_submit', ''), null);
});

test('op registry: every runtime tool is registered with its policy capability and timeout', async () => {
  const defs = await collectToolDefinitions();
  assert.deepEqual([...defs.keys()].sort(), [...RUNTIME_OPS].sort());
  assert.deepEqual([...RUNTIME_OPS].sort(), Object.keys(OPERATION_CAPABILITY).sort());
  for (const op of RUNTIME_OPS) {
    assert.equal(OPS[op].capability, OPERATION_CAPABILITY[op]);
    assert.equal(OPS[op].mutating, OPERATION_CAPABILITY[op] !== CAPABILITIES.READ, op);
    assert.equal(typeof defs.get(op).inputSchema.safeParse, 'function', op);
  }
  for (const op of ['jobs_submit', 'job_cancel', 'task_claim', 'worktree_push', 'workspace_open']) assert.ok(MUTATING_OPS.includes(op), op);
  for (const op of ['job_status', 'job_events', 'job_results', 'jobs_list']) assert.ok(!MUTATING_OPS.includes(op), op);
  // Ledger ops wait at least 130 s at the hub (ledger child timeout is 120 s).
  for (const op of ['task_claim', 'task_renew', 'task_release', 'task_checkpoint', 'jobs_submit', 'worktree_push']) {
    assert.ok(OPS[op].timeoutMs >= 130_000, op);
  }
  assert.equal(OPS.host_status.kind, 'probe');
  assert.equal(OPS.host_status.timeoutMs, TIMEOUTS.probe);
  assert.equal(OPS.exec, undefined);
});

test('denialReason: principal map and the mutating-ops gate (D9, TODO-P4-40)', () => {
  const on = { runtimeEnabled: true, mutatingOps: false };
  const owner = { runtimeEnabled: true, mutatingOps: 'owner' };
  assert.equal(denialReason(READER, 'job_status', on), null);
  assert.equal(denialReason(READER, 'jobs_submit', owner), 'forbidden');
  for (const op of ['job_cancel', 'task_claim', 'worktree_push']) assert.equal(denialReason(READER, op, owner), 'forbidden');
  assert.equal(denialReason(OWNER, 'jobs_submit', on), 'mutating_disabled');
  assert.equal(denialReason(OWNER, 'jobs_submit', owner), null);
  assert.equal(denialReason(OWNER, 'exec', owner), 'unsupported_op');
  assert.equal(denialReason(OWNER, 'job_status', { runtimeEnabled: false }), 'runtime_disabled');
  assert.equal(denialReason(OWNER, 'host_status', {}), null);
});

test('backoff grows from 1 s to 60 s with jitter', () => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const ceiling = Math.min(60_000, 1000 * 2 ** attempt);
    assert.equal(backoffDelay(attempt, { random: () => 0 }), ceiling / 2);
    assert.equal(backoffDelay(attempt, { random: () => 0.999999 }), Math.round(ceiling / 2 + 0.999999 * ceiling / 2));
  }
  assert.ok(backoffDelay(50) <= 60_000);
});

test('agent: hello advertises its ops; dispatch, unsupported_op, v1 compatibility, large results', async t => {
  const id = generateAgentIdentity();
  const hub = await fakeHub(t, { identity: id });
  const agent = createAgent({ host: 'vps', url: hub.url, privateKey: id.privateKey, ca: hub.cert, reconnectMs: 100_000,
    operations: {
      host_status: async () => ({ host: 'vps', online: true }),
      echo_op: async (args, ctx) => ({ ok: true, args, principal: ctx.principal.id, key: ctx.requestKey }),
      big_op: async () => ({ ok: true, text: 'x'.repeat(200_000) }),
      huge_op: async () => ({ ok: true, text: 'x'.repeat(MAX_RESULT_BYTES + 10) }),
      boom_op: async () => { throw new Error('/secret/path leaked?'); },
      coded_op: async () => { throw new OperationError('invalid_arguments'); }
    } });
  t.after(() => agent.stop());
  await until(() => hub.hello);
  assert.equal(hub.hello.v, PROTOCOL_VERSION);
  assert.equal(hub.hello.host, 'vps');
  assert.deepEqual(hub.hello.ops.sort(), ['big_op', 'boom_op', 'coded_op', 'echo_op', 'host_status', 'huge_op']);
  assert.equal(hub.hello.max_inflight, MAX_IN_FLIGHT);

  const key = 'a'.repeat(64);
  const echo = hub.request('echo_op', { n: 1 }, OWNER, { requestKey: key });
  await until(() => hub.answer(echo));
  assert.deepEqual(hub.answer(echo).data, { ok: true, args: { n: 1 }, principal: 'hub:owner', key });

  const unknown = hub.request('not_served');
  await until(() => hub.answer(unknown));
  assert.deepEqual(hub.answer(unknown), { v: 2, type: 'error', id: unknown, code: 'unsupported_op' });

  const boom = hub.request('boom_op');
  await until(() => hub.answer(boom));
  assert.equal(hub.answer(boom).code, 'internal_error');
  assert.doesNotMatch(JSON.stringify(hub.answer(boom)), /secret/);
  const coded = hub.request('coded_op');
  await until(() => hub.answer(coded));
  assert.equal(hub.answer(coded).code, 'invalid_arguments');

  const big = hub.request('big_op');
  await until(() => hub.reassembled(big));
  assert.equal(hub.reassembled(big).data.text.length, 200_000);
  const huge = hub.request('huge_op');
  await until(() => hub.answer(huge));
  assert.equal(hub.answer(huge).code, 'result_too_large');

  // A large request arrives in parts and is reassembled by the agent.
  const large = hub.request('echo_op', { blob: 'y'.repeat(60_000) });
  await until(() => hub.reassembled(large));
  assert.equal(hub.reassembled(large).data.args.blob.length, 60_000);
  assert.ok(hub.frames.filter(f => f?.type === 'part' && f.id === large).length > 1);

  // v1 hub request (no "v"): answered in v1 with host_status.
  hub.send({ type: 'request', id: 'legacy-0001', op: 'host_status' });
  await until(() => hub.frames.find(f => f?.id === 'legacy-0001'));
  assert.deepEqual(hub.frames.find(f => f?.id === 'legacy-0001'), { type: 'result', id: 'legacy-0001', data: { host: 'vps', online: true } });

  // Malformed request with a valid id: invalid_request, not silence.
  hub.send({ v: 2, type: 'request', id: 'bad-req-0001', op: 'echo_op', args: {}, principal: { id: 'nobody' } });
  await until(() => hub.answer('bad-req-0001'));
  assert.equal(hub.answer('bad-req-0001').code, 'unknown_principal');
});

test('agent: the in-flight cap holds at 8', async t => {
  const id = generateAgentIdentity();
  const hub = await fakeHub(t, { identity: id });
  let active = 0; let peak = 0; let release;
  const gate = new Promise(r => { release = r; });
  const agent = createAgent({ host: 'vps', url: hub.url, privateKey: id.privateKey, ca: hub.cert, reconnectMs: 100_000,
    operations: { host_status: async () => ({ host: 'vps', online: true }),
      slow_op: async () => { active++; peak = Math.max(peak, active); await gate; active--; return { ok: true }; } } });
  t.after(() => agent.stop());
  await until(() => hub.hello);
  const ids = Array.from({ length: 11 }, () => hub.request('slow_op'));
  await until(() => ids.filter(i => hub.answer(i)).length === 3);
  assert.deepEqual(ids.map(i => hub.answer(i)?.code).filter(Boolean), ['agent_busy', 'agent_busy', 'agent_busy']);
  assert.equal(agent.inFlight, 8);
  release();
  await until(() => ids.every(i => hub.answer(i)));
  assert.equal(peak, 8);
  assert.equal(agent.inFlight, 0);
});

test('agent: an oversize frame from the hub is rejected, and the agent reconnects with backoff', async t => {
  const id = generateAgentIdentity();
  const hub = await fakeHub(t, { identity: id, maxPayload: 1024 * 1024 });
  const events = [];
  const agent = createAgent({ host: 'vps', url: hub.url, privateKey: id.privateKey, ca: hub.cert, backoff: { minMs: 50, maxMs: 200 },
    log: (event, h, details) => events.push({ event, ...details }) });
  t.after(() => agent.stop());
  await until(() => hub.hello);
  hub.send('{"pad":"' + 'z'.repeat(MAX_FRAME_BYTES + 10) + '"}');
  await until(() => hub.closes.length === 1);
  assert.equal(hub.closes[0], 1009);
  await until(() => hub.connections === 2 && agent.connected);
  const scheduled = events.find(e => e.event === 'reconnect_scheduled');
  assert.ok(scheduled.delay_ms >= 25 && scheduled.delay_ms <= 50, JSON.stringify(scheduled));
});

test('agent: a hub that stops pinging is dropped by the liveness timer', async t => {
  const id = generateAgentIdentity();
  const hub = await fakeHub(t, { identity: id });
  const agent = createAgent({ host: 'vps', url: hub.url, privateKey: id.privateKey, ca: hub.cert, livenessMs: 150,
    backoff: { minMs: 100_000 } });
  t.after(() => agent.stop());
  await until(() => hub.hello);
  // Pings keep it alive past the liveness window.
  for (let i = 0; i < 4; i++) { hub.socket.ping(); await new Promise(r => setTimeout(r, 80)); }
  assert.equal(hub.closes.length, 0);
  await until(() => hub.closes.length === 1, 2000);
  assert.equal(agent.connected, false);
});

test('runtime dispatcher re-authorizes forwarded requests and journals refusals (AC-P4-10 runtime side)', async t => {
  // Same wiring as bridge/agent-cli.mjs runtime mode: one base runtime, a view per principal.
  // Owner writes enabled on the runner side (TODO-P4-40); the default is read-only (runtime-principal tests).
  const base = createRuntime({ stateDir: await tempStateDir(t), ledger: stubLedger(), host: 'vps', resolveProject: stubProjects(),
    projectRemote: project => Promise.resolve(PROJECT_ORIGINS[project.name] ?? null),
    hubGrants: { 'hub:owner': 'owner', 'hub:readonly': 'read' } });
  t.after(() => base.close());
  const logged = [];
  const ops = await createRuntimeOperations({ runtimeFor: principal => base.as(principal),
    principalFromWire: wire => base.principalFromHub({ id: wire?.id }), log: (event, details) => logged.push({ event, ...details }) });
  t.after(() => ops.close());
  assert.deepEqual(Object.keys(ops.handlers).sort(), [...RUNTIME_OPS].sort());
  const call = (op, args, principal) => ops.handlers[op](args, { op, principal: { id: principal } });

  const opened = await call('workspace_open', { project: 'drop', client_label: 'vps test' }, 'hub:owner');
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.workspace.host, 'vps');

  // A forged request straight to the runtime with the read-only principal: refused here too.
  for (const op of ['workspace_open', 'jobs_submit', 'job_cancel', 'task_claim', 'worktree_push']) {
    assert.deepEqual(await call(op, {}, 'hub:readonly'), { ok: false, error: 'forbidden' }, op);
  }
  const listed = await call('workspace_list', {}, 'hub:readonly');
  assert.equal(listed.ok, true);
  assert.equal(listed.workspaces.length, 0, 'the read-only principal does not see the owner workspace');

  // Refusals are in the service journal and in the runtime audit journal, with principal and reason.
  assert.deepEqual(logged.filter(e => e.op === 'jobs_submit'), [{ event: 'op_denied', principal: 'hub:readonly', op: 'jobs_submit', reason: 'forbidden' }]);
  const events = await base.store().transaction(repo => repo.listEvents({ limit: 100 }), { write: false });
  const denied = events.filter(e => e.principal === 'hub:readonly' && e.outcome === 'denied');
  assert.ok(denied.some(e => e.op === 'jobs_submit' && e.code === 'forbidden'), JSON.stringify(denied));
  assert.ok(denied.some(e => e.op === 'task_claim'));

  await assert.rejects(call('workspace_list', {}, 'hub:root'), e => e instanceof OperationError && e.code === 'unknown_principal');
  await assert.rejects(call('workspace_list', { limit: 'x' }, 'hub:owner'), e => e.code === 'invalid_arguments');
  assert.throws(() => unwrapToolResult({ content: [{ type: 'text', text: '[1]' }] }), e => e.code === 'internal_error');
});
