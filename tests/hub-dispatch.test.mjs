// Hub dispatch over protocol v2 (Phase 4: TODO-P4-04; AC-P4-02, AC-P4-10 hub side, AC-14 gate).
// A real hub on loopback TLS, real agents (bridge/agent.mjs) with test operations, and raw
// WebSocket clients for the misbehaving cases. No runtime state is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import https from 'node:https';
import WebSocket from 'ws';
import { createHub } from '../bridge/hub.mjs';
import { createAgent } from '../bridge/agent.mjs';
import { generateAgentIdentity, signChallenge } from '../bridge/crypto.mjs';
import { MAX_FRAME_BYTES, SUBPROTOCOL, idempotencyKey, makeHello } from '../bridge/protocol.mjs';
import { HUB_PRINCIPALS, PRINCIPAL_IDS, RUNTIME_OPS, collectToolDefinitions } from '../bridge/ops.mjs';

const OWNER = HUB_PRINCIPALS[PRINCIPAL_IDS.owner];
const READER = HUB_PRINCIPALS[PRINCIPAL_IDS.readonly];
const OWNER_TOKEN = 'test-owner-token-'.repeat(4);
const READER_TOKEN = 'test-reader-token-'.repeat(4);
const sha = v => createHash('sha256').update(v).digest('hex');
let DEFINITIONS;

async function until(fn, ms = 5000) {
  const expire = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > expire) throw new Error('wait expired'); await new Promise(r => setTimeout(r, 15)); }
}
function tls(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memo-hub-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return { tlsKey: readFileSync(join(dir, 'k'), 'utf8'), tlsCert: readFileSync(join(dir, 'c'), 'utf8') };
}

async function startHub(t, options = {}) {
  DEFINITIONS ??= await collectToolDefinitions();
  const keys = { mac: generateAgentIdentity(), vps: generateAgentIdentity() };
  const { tlsKey, tlsCert } = tls(t);
  const audit = [];
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: sha(OWNER_TOKEN), readOnlyTokenSha256: sha(READER_TOKEN),
    allowedAgentKeys: { mac: keys.mac.publicKey, vps: keys.vps.publicKey }, runtimeHost: 'vps', toolDefinitions: DEFINITIONS,
    port: 0, audit: ev => audit.push(ev), ...options });
  const { port } = await hub.start();
  t.after(() => hub.stop());
  const url = `wss://127.0.0.1:${port}/agent`;
  const agent = (host, operations, extra = {}) => {
    const a = createAgent({ host, url, privateKey: keys[host].privateKey, ca: tlsCert, reconnectMs: 100_000, operations, ...extra });
    t.after(() => a.stop());
    return a;
  };
  // A raw agent: authenticates, optionally says hello, and exposes its socket.
  const raw = (host, { hello, wsOptions = {} } = {}) => new Promise((resolve, reject) => {
    const ws = new WebSocket(url, SUBPROTOCOL, { ca: tlsCert, maxPayload: 1024 * 1024, ...wsOptions });
    const frames = [];
    t.after(() => ws.terminate());
    ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      frames.push(msg);
      if (msg.type === 'challenge') ws.send(JSON.stringify({ type: 'authenticate', host, signature: signChallenge(host, msg.nonce, keys[host].privateKey) }));
      if (msg.type === 'authenticated') {
        if (hello) ws.send(JSON.stringify(makeHello({ host, ops: hello })));
        resolve({ ws, frames });
      }
    });
    ws.on('error', reject);
  });
  const mcp = (token, body) => new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', ca: tlsCert, headers: {
      ...(token && { authorization: 'Bearer ' + token }), 'content-type': 'application/json', accept: 'application/json, text/event-stream' } },
    res => { let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null })); });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  const tools = async token => (await mcp(token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).body.result.tools.map(x => x.name).sort();
  const callTool = async (token, name, args = {}) => {
    const out = await mcp(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
    const text = out.body?.result?.content?.[0]?.text;
    return { ...out, data: text && out.body.result.isError !== true ? JSON.parse(text) : null };
  };
  return { hub, audit, agent, raw, mcp, tools, callTool, url, tlsCert };
}

const hostStatus = host => async () => ({ host, online: true });

test('registry: an op outside the registry is denied even if advertised; unknown ops get unsupported_op', async t => {
  const { hub, agent, audit } = await startHub(t);
  const seen = [];
  agent('vps', { host_status: hostStatus('vps'), exec: async () => { seen.push('exec'); return { ok: true }; },
    job_status: async () => ({ ok: true, job: { status: 'running' } }) });
  await until(() => hub.agentInfo('vps')?.version === 2);
  assert.deepEqual(hub.agentInfo('vps').ops, ['host_status', 'job_status']);
  assert.ok(audit.some(e => e.event === 'agent_hello' && e.ignored === 1));
  assert.deepEqual(await hub.requestAgent('vps', 'exec', { principal: OWNER }), { ok: false, error: 'unsupported_op' });
  // In the registry but not served by this agent: refused without a round trip.
  assert.deepEqual(await hub.requestAgent('vps', 'jobs_list', { principal: OWNER }), { ok: false, error: 'unsupported_op' });
  assert.deepEqual(await hub.requestAgent('vps', 'job_status', { args: { job_id: 'job_1' }, principal: OWNER }), { ok: true, job: { status: 'running' } });
  assert.deepEqual(await hub.requestAgent('mac', 'host_status', { principal: OWNER }), { ok: false, error: 'host_offline' });
  assert.deepEqual(seen, []);
});

test('#61 host tools for the Mac answered by a VPS runtime: the hub fills in the Mac agent connection', async t => {
  const { hub, agent } = await startHub(t);
  const noRoute = { source: 'unknown', online: null, detail: 'no route from this host; the Mac accepts no incoming connection' };
  agent('vps', {
    host_status: hostStatus('vps'),
    host_capabilities: async ({ host }) => ({ ok: true, host, local: false, roles: { source: 'declared', roles: [], limitations: [] },
      reachability: { ...noRoute }, tools: null, recipes: null, note: 'remote' }),
    host_resources: async ({ host }) => ({ ok: true, host, local: false, ...noRoute, job_concurrency_limit: null, notes: [] })
  });
  await until(() => hub.agentInfo('vps')?.version === 2);
  const offline = await hub.requestAgent('vps', 'host_capabilities', { args: { host: 'mac' }, principal: OWNER });
  assert.equal(offline.reachability.source, 'hub');
  assert.equal(offline.reachability.online, false, JSON.stringify(offline));
  const resources = await hub.requestAgent('vps', 'host_resources', { args: { host: 'mac' }, principal: OWNER });
  assert.equal(resources.online, false, JSON.stringify(resources));
  assert.equal(resources.source, 'hub');

  agent('mac', { host_status: hostStatus('mac') });
  await until(() => hub.agentInfo('mac'));
  const online = await hub.requestAgent('vps', 'host_capabilities', { args: { host: 'mac' }, principal: OWNER });
  assert.equal(online.reachability.online, true, JSON.stringify(online));
  assert.match(online.reachability.since, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await hub.requestAgent('vps', 'host_resources', { args: { host: 'mac' }, principal: OWNER })).online, true);
  // The VPS itself, or a runtime that observed the host: unchanged.
  const vps = await hub.requestAgent('vps', 'host_capabilities', { args: { host: 'vps' }, principal: OWNER });
  assert.deepEqual(vps.reachability, noRoute);
});

test('a disconnect flushes pending requests with agent_disconnected in under 100 ms', async t => {
  const { hub, agent } = await startHub(t);
  let started = 0;
  const a = agent('vps', { host_status: hostStatus('vps'), job_status: () => { started++; return new Promise(() => {}); } });
  await until(() => hub.agentInfo('vps')?.version === 2);
  const calls = [1, 2, 3].map(() => hub.requestAgent('vps', 'job_status', { args: {}, principal: OWNER }));
  await until(() => started === 3);
  const t0 = performance.now();
  a.stop();
  const results = await Promise.all(calls);
  const elapsed = performance.now() - t0;
  assert.deepEqual(results, Array(3).fill({ ok: false, error: 'agent_disconnected' }));
  assert.ok(elapsed < 100, `flush took ${elapsed} ms`);
  assert.equal(hub.inventory().find(h => h.host === 'vps').online, false);
});

test('a 120 s ledger op completes under its per-op timeout; a silent op times out', async t => {
  const { hub, agent } = await startHub(t);
  let finish;
  agent('vps', { host_status: hostStatus('vps'),
    task_claim: () => new Promise(resolve => { finish = resolve; setTimeout(() => resolve({ ok: true, claim_id: 'c1' }), 120_000); }),
    task_renew: () => new Promise(() => {}) }, { livenessMs: 3_600_000 });
  await until(() => hub.agentInfo('vps')?.version === 2);
  // Mocked setTimeout drives both the agent's 120 s handler and the hub's per-op deadlines;
  // socket I/O stays real. Poll with setImmediate, which the mock leaves alone.
  const settle = async fn => { for (let i = 0; i < 20000 && !(await fn()); i++) await new Promise(r => setImmediate(r)); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  const claim = hub.requestAgent('vps', 'task_claim', { args: {}, principal: OWNER });
  const renew = hub.requestAgent('vps', 'task_renew', { args: {}, principal: OWNER });
  let renewDone = false; renew.then(() => { renewDone = true; });
  await settle(() => finish);
  assert.ok(finish, 'the agent started the ledger op');
  t.mock.timers.tick(120_000);
  assert.deepEqual(await claim, { ok: true, claim_id: 'c1' });
  assert.equal(renewDone, false, 'task_renew is still within its deadline at 120 s');
  // task_renew never answers: it fails at its own deadline (>= 130 s), not before.
  t.mock.timers.tick(9_000);
  await settle(() => renewDone);
  assert.equal(renewDone, false);
  t.mock.timers.tick(2_000);
  assert.deepEqual(await renew, { ok: false, error: 'timeout' });
});

test('an oversize frame from an agent is rejected and its pending requests flushed', async t => {
  const { hub, raw } = await startHub(t);
  const { ws, frames } = await raw('vps', { hello: ['host_status', 'job_status'] });
  await until(() => hub.agentInfo('vps')?.version === 2);
  const pending = hub.requestAgent('vps', 'job_status', { args: {}, principal: OWNER });
  await until(() => frames.some(f => f.type === 'request'));
  const closed = new Promise(r => ws.on('close', code => r(code)));
  ws.send(JSON.stringify({ v: 2, type: 'result', id: frames.find(f => f.type === 'request').id, data: { pad: 'x'.repeat(MAX_FRAME_BYTES) } }));
  assert.equal(await closed, 1009);
  assert.deepEqual(await pending, { ok: false, error: 'agent_disconnected' });
});

test('results: parts are reassembled, schemas are checked, the hub in-flight cap holds', async t => {
  const { hub, agent, audit } = await startHub(t);
  let release; const gate = new Promise(r => { release = r; });
  agent('vps', {
    host_status: async () => ({ host: 'mac', online: true }),          // lies about its host
    job_results: async () => ({ ok: true, log: { lines: Array(3000).fill('line of output') } }),
    job_events: async () => [1, 2, 3],                                // not an object
    jobs_list: async () => ({ ok: false, error: 'Not A Code!' }),       // malformed error
    job_status: async () => { await gate; return { ok: true }; }
  });
  await until(() => hub.agentInfo('vps')?.version === 2);
  const big = await hub.requestAgent('vps', 'job_results', { args: {}, principal: OWNER });
  assert.equal(big.log.lines.length, 3000);
  assert.deepEqual(await hub.requestAgent('vps', 'host_status', { principal: OWNER }), { ok: false, error: 'invalid_agent_response' });
  assert.deepEqual(await hub.requestAgent('vps', 'job_events', { principal: OWNER }), { ok: false, error: 'invalid_agent_response' });
  assert.deepEqual(await hub.requestAgent('vps', 'jobs_list', { principal: OWNER }), { ok: false, error: 'invalid_agent_response' });
  assert.ok(audit.some(e => e.event === 'invalid_agent_response' && e.op === 'job_events'));
  const slow = Array.from({ length: 8 }, () => hub.requestAgent('vps', 'job_status', { principal: OWNER }));
  assert.deepEqual(await hub.requestAgent('vps', 'job_status', { principal: OWNER }), { ok: false, error: 'agent_busy' });
  assert.equal(hub.agentInfo('vps').pending, 8);
  release();
  assert.deepEqual(await Promise.all(slow), Array(8).fill({ ok: true }));
});

test('compatibility: a v1 agent (no hello) still answers host_status; mutating requests carry the derived request key', async t => {
  const { hub, raw, agent } = await startHub(t);
  const { ws, frames } = await raw('mac');
  ws.on('message', data => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'request') ws.send(JSON.stringify({ type: 'result', id: msg.id, data: { host: 'mac', online: true, cpu_count: 4 } }));
  });
  assert.deepEqual(await hub.requestAgent('mac', 'host_status'), { host: 'mac', online: true, cpu_count: 4 });
  const request = frames.find(f => f.type === 'request');
  assert.deepEqual(Object.keys(request).sort(), ['id', 'op', 'type']);
  assert.equal(hub.agentInfo('mac').version, 1);
  assert.deepEqual(await hub.requestAgent('mac', 'job_status', { principal: OWNER }), { ok: false, error: 'unsupported_op' });

  let ctxSeen;
  agent('vps', { host_status: hostStatus('vps'), jobs_submit: async (args, ctx) => { ctxSeen = { args, ctx }; return { ok: true, job_id: 'job_1' }; } });
  await until(() => hub.agentInfo('vps')?.version === 2);
  await hub.requestAgent('vps', 'jobs_submit', { args: { client_request_id: 'retry-1' }, principal: OWNER });
  assert.equal(ctxSeen.ctx.requestKey, idempotencyKey('hub:owner', 'jobs_submit', 'retry-1'));
  assert.deepEqual(ctxSeen.ctx.principal, { id: 'hub:owner' });
});

test('the hub drops an agent that misses a pong', async t => {
  const { hub, raw, audit } = await startHub(t, { pingIntervalMs: 40 });
  await raw('vps', { hello: ['host_status'], wsOptions: { autoPong: false } });
  await until(() => hub.inventory().find(h => h.host === 'vps').online);
  await until(() => !hub.inventory().find(h => h.host === 'vps').online, 2000);
  assert.ok(audit.some(e => e.event === 'agent_ping_timeout' && e.host === 'vps'));
});

test('principal map over MCP: owner and read-only bearers, mutating gate off by default (AC-P4-10, AC-14 gate)', async t => {
  const { agent, tools, callTool, mcp, audit, hub } = await startHub(t);
  const calls = [];
  const ops = Object.fromEntries(RUNTIME_OPS.map(op => [op, async (args, ctx) => { calls.push({ op, principal: ctx.principal.id, args }); return { ok: true, op }; }]));
  agent('vps', { host_status: hostStatus('vps'), ...ops });
  await until(() => hub.agentInfo('vps')?.version === 2);

  assert.equal((await mcp(null, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).status, 401);
  assert.equal((await mcp('wrong-token', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).status, 401);

  const readerTools = await tools(READER_TOKEN);
  const ownerTools = await tools(OWNER_TOKEN);
  for (const list of [readerTools, ownerTools]) {
    assert.ok(list.includes('job_status') && list.includes('job_events') && list.includes('host_status'));
    for (const op of ['jobs_submit', 'job_cancel', 'task_claim', 'worktree_push']) assert.ok(!list.includes(op), op);
  }
  assert.deepEqual(readerTools, ownerTools, 'with mutating ops disabled both principals see the read ops only');

  const status = await callTool(READER_TOKEN, 'job_status', { job_id: 'job_abc' });
  assert.deepEqual(status.data, { ok: true, op: 'job_status' });
  assert.deepEqual(calls.at(-1), { op: 'job_status', principal: 'hub:readonly', args: { job_id: 'job_abc' } });

  for (const [token, principal, reason] of [[READER_TOKEN, 'hub:readonly', 'forbidden'], [OWNER_TOKEN, 'hub:owner', 'mutating_disabled']]) {
    const before = calls.length;
    const refused = await callTool(token, 'jobs_submit', { workspace_id: 'ws_x', worktree_id: 'wt_x', recipe: 'test' });
    assert.ok(refused.body.error || refused.body.result?.isError, JSON.stringify(refused.body));
    assert.equal(calls.length, before, 'nothing reached the agent');
    const entry = audit.findLast(e => e.event === 'op_denied');
    assert.deepEqual({ principal: entry.principal, op: entry.op, reason: entry.reason }, { principal, op: 'jobs_submit', reason });
    assert.doesNotMatch(JSON.stringify(entry), /ws_x|wt_x|recipe/, 'arguments are never journaled');
  }
  const info = (await callTool(READER_TOKEN, 'bridge_info')).data;
  assert.equal(info.mutating_ops, 'disabled');
  assert.equal(info.principal.id, 'hub:readonly');
  assert.deepEqual(info.tools, readerTools);
  assert.ok(audit.every(e => !JSON.stringify(e).includes(OWNER_TOKEN) && !JSON.stringify(e).includes(READER_TOKEN)));
});

test('with mutatingOps "owner", only the owner principal gets mutating ops', async t => {
  const { agent, tools, callTool, audit, hub } = await startHub(t, { mutatingOps: 'owner' });
  const calls = [];
  const ops = Object.fromEntries(RUNTIME_OPS.map(op => [op, async (args, ctx) => { calls.push({ op, principal: ctx.principal.id }); return { ok: true, op }; }]));
  agent('vps', { host_status: hostStatus('vps'), ...ops });
  await until(() => hub.agentInfo('vps')?.version === 2);
  const ownerTools = await tools(OWNER_TOKEN);
  const readerTools = await tools(READER_TOKEN);
  for (const op of ['jobs_submit', 'job_cancel', 'task_claim', 'worktree_push']) {
    assert.ok(ownerTools.includes(op), op);
    assert.ok(!readerTools.includes(op), op);
  }
  assert.deepEqual(ownerTools.filter(op => RUNTIME_OPS.includes(op)).sort(), [...RUNTIME_OPS].sort());
  const ok = await callTool(OWNER_TOKEN, 'job_cancel', { job_id: 'job_abc' });
  assert.deepEqual(ok.data, { ok: true, op: 'job_cancel' });
  assert.deepEqual(calls.at(-1), { op: 'job_cancel', principal: 'hub:owner' });
  for (const op of ['jobs_submit', 'job_cancel', 'task_claim', 'worktree_push']) {
    await callTool(READER_TOKEN, op, {});
    const entry = audit.findLast(e => e.event === 'op_denied');
    assert.deepEqual({ principal: entry.principal, op: entry.op, reason: entry.reason }, { principal: 'hub:readonly', op, reason: 'forbidden' });
  }
  assert.equal(calls.filter(c => c.principal === 'hub:readonly').length, 0);
});

test('hub configuration is validated; without a runtime host only the hub tools are listed', async t => {
  const { tlsKey, tlsCert } = tls(t);
  const base = { tlsKey, tlsCert, tokenSha256: sha(OWNER_TOKEN), allowedAgentKeys: {}, port: 0 };
  assert.throws(() => createHub({ ...base, mutatingOps: 'all', runtimeHost: 'vps' }), /mutatingOps/);
  assert.throws(() => createHub({ ...base, mutatingOps: 'owner' }), /runtime host/);
  assert.throws(() => createHub({ ...base, readOnlyTokenSha256: sha(OWNER_TOKEN) }), /read-only/);
  assert.throws(() => createHub({ ...base, runtimeHost: 'cloud' }), /runtime host/);
  const { tools, callTool, audit } = await startHub(t, { runtimeHost: null, toolDefinitions: null });
  assert.deepEqual(await tools(OWNER_TOKEN), ['bridge_info', 'host_status', 'list_hosts']);
  await callTool(OWNER_TOKEN, 'job_status', { job_id: 'job_x' });
  assert.equal(audit.findLast(e => e.event === 'op_denied').reason, 'runtime_disabled');
  await callTool(OWNER_TOKEN, 'exec', { command: 'id' });
  assert.equal(audit.findLast(e => e.event === 'op_denied').reason, 'unsupported_op');
});

// agent-cli runtime mode end to end: the real entry point, credentials from a temporary
// $CREDENTIALS_DIRECTORY (fake, non-secret values), a temporary state directory, the real hub.
test('agent-cli runtime mode serves the runtime tools through the hub, credentials from CREDENTIALS_DIRECTORY', async t => {
  const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs');
  const { spawn } = await import('node:child_process');
  DEFINITIONS ??= await collectToolDefinitions();
  const work = mkdtempSync(join(tmpdir(), 'memo-runner-cli-'));
  const config = join(work, 'config'); const creds = join(work, 'creds'); const state = join(work, 'state');
  t.after(() => { try { chmodSync(creds, 0o700); } catch { /* not created */ } rmSync(work, { recursive: true, force: true }); });
  mkdirSync(config); mkdirSync(creds, { mode: 0o700 });
  const id = generateAgentIdentity();
  const { tlsKey, tlsCert } = tls(t);
  const audit = [];
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: sha(OWNER_TOKEN), readOnlyTokenSha256: sha(READER_TOKEN),
    allowedAgentKeys: { vps: id.publicKey }, runtimeHost: 'vps', toolDefinitions: DEFINITIONS, port: 0, audit: ev => audit.push(ev) });
  const { port } = await hub.start();
  t.after(() => hub.stop());
  writeFileSync(join(config, 'hub-ca.crt'), tlsCert);
  writeFileSync(join(creds, 'agent-key'), id.privateKey, { mode: 0o600 });
  const fakeToken = 'test_ledger_token_' + 'x'.repeat(24);
  const spawnCli = extraEnv => {
    const child = spawn(process.execPath, ['bridge/agent-cli.mjs'], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH, HOME: work, MEMO_BRIDGE_AGENT_MODE: 'runtime', MEMO_BRIDGE_HOST: 'vps', MEMO_BRIDGE_AGENT_CONFIG: config,
        CREDENTIALS_DIRECTORY: creds, MEMO_BRIDGE_STATE_DIR: state, MEMO_BRIDGE_AGENT_URL: `wss://127.0.0.1:${port}/agent`, ...extraEnv } });
    let stderr = '';
    child.stderr.on('data', c => { stderr += c; });
    const exited = new Promise(r => child.on('exit', code => r(code)));
    t.after(() => child.kill('SIGKILL'));
    return { child, exited, stderr: () => stderr };
  };

  // Without the ledger credential the runner refuses to start, and says which one.
  const missing = spawnCli({});
  assert.notEqual(await missing.exited, 0);
  assert.match(missing.stderr(), /ledger-gh credential_missing/);

  writeFileSync(join(creds, 'ledger-gh'), fakeToken + '\n', { mode: 0o600 });
  chmodSync(creds, 0o500);
  const runner = spawnCli({});
  await until(() => hub.agentInfo('vps')?.version === 2, 15_000);
  assert.ok(hub.agentInfo('vps').ops.includes('jobs_submit') && hub.agentInfo('vps').ops.includes('workspace_list'));
  const call = (token, name, args = {}) => new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', ca: tlsCert, headers: {
      authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } },
    res => { let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve(JSON.parse(JSON.parse(text).result.content[0].text))); });
    req.on('error', reject); req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
  });
  const listed = await call(OWNER_TOKEN, 'workspace_list', {});
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(listed.workspaces, []);
  const jobs = await call(READER_TOKEN, 'jobs_list', {});
  assert.equal(jobs.ok, true, JSON.stringify(jobs));
  // A forged read-only request straight to the runtime (bypassing the hub's gate) is refused there.
  assert.deepEqual(await hub.requestAgent('vps', 'jobs_submit', { args: { workspace_id: 'ws_x', worktree_id: 'wt_x', recipe: 'test' },
    principal: READER }), { ok: false, error: 'forbidden' });
  await until(() => /"event":"op_denied".*"principal":"hub:readonly".*"op":"jobs_submit"/.test(runner.stderr()));
  assert.ok(!runner.stderr().includes(fakeToken), 'the token never reaches the logs');
  assert.match(runner.stderr(), /"event":"runtime_ready".*"executor":"local"/);
  runner.child.kill('SIGTERM');
  assert.equal(await runner.exited, 0);
  await until(() => !hub.agentInfo('vps'), 15_000);

  // lab-infra layout (memo-bridge-runner.service): the key loaded as `agent.key`, and
  // MEMO_BRIDGE_AGENT_CONFIG=%d, the credentials directory, which also holds hub-ca.crt.
  chmodSync(creds, 0o700);
  rmSync(join(creds, 'agent-key'));
  writeFileSync(join(creds, 'agent.key'), id.privateKey, { mode: 0o600 });
  writeFileSync(join(creds, 'hub-ca.crt'), tlsCert, { mode: 0o600 });
  chmodSync(creds, 0o500);
  // A runner tree that disagrees with the dispatcher's fixed layout (or, off Linux, the systemd
  // executor itself) stops the start: the unit fails visibly instead of serving a broken runner.
  const bad = spawnCli({ MEMO_BRIDGE_AGENT_CONFIG: creds, MEMO_BRIDGE_JOB_EXECUTOR: 'systemd',
    MEMO_BRIDGE_RUNNER_ROOT: join(work, 'runner'), MEMO_BRIDGE_SPOOL_DIR: join(work, 'elsewhere') });
  assert.notEqual(await bad.exited, 0);
  assert.match(bad.stderr(), /invalid_configuration/);
  const lab = spawnCli({ MEMO_BRIDGE_AGENT_CONFIG: creds });
  await until(() => hub.agentInfo('vps')?.version === 2, 15_000);
  assert.equal((await call(OWNER_TOKEN, 'workspace_list', {})).ok, true);
  lab.child.kill('SIGTERM');
  assert.equal(await lab.exited, 0);
});
