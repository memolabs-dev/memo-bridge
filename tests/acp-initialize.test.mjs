import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { initializeAcp } from '../server/runners/acp-initialize.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function endpoint(reply) {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const seen = [];
  let request = '';
  stdin.on('data', chunk => {
    request += String(chunk);
    if (!request.includes('\n')) return;
    const [line] = request.split('\n');
    const data = JSON.parse(line);
    seen.push(data);
    if (reply) void reply({ stdout, request: data });
  });
  return { stdin, stdout, seen };
}
const valid = id => ({ jsonrpc: '2.0', id, result: {
  protocolVersion: 1, agentInfo: { name: 'OpenCode' }, agentCapabilities: {}
} });
const line = data => JSON.stringify(data) + '\n';

test('sends precisely one bounded ACP initialize and confirms the matching receipt', async () => {
  const peer = endpoint(({ stdout, request }) => {
    stdout.write(line({ jsonrpc: '2.0', method: 'session/update', params: {} }));
    const response = line(valid(request.id));
    stdout.write(response.slice(0, 12));
    stdout.write(response.slice(12));
  });
  const ready = await initializeAcp(peer, { timeoutMs: 200 });
  assert.deepEqual(ready, { protocolVersion: 1 });
  assert.equal(peer.seen.length, 1);
  assert.equal(peer.seen[0].method, 'initialize');
  assert.equal(peer.seen[0].params.protocolVersion, 1);
  assert.deepEqual(peer.seen[0].params.clientCapabilities, {});
  assert.match(peer.seen[0].id, /^bridge-init-/);
  peer.stdout.end();
  peer.stdin.end();
});

test('refuses a spoofed response id before accepting any further status', async () => {
  const peer = endpoint(({ stdout }) => stdout.write(line(valid('different'))));
  await assert.rejects(initializeAcp(peer, { timeoutMs: 200 }), /acp_initialize_unexpected_response/);
});

test('refuses unsupported versions and ACP error receipts', async () => {
  for (const response of [
    id => ({ ...valid(id), result: { protocolVersion: 2 } }),
    id => ({ jsonrpc: '2.0', id, error: { code: -32600, message: 'No' } })
  ]) {
    const peer = endpoint(({ stdout, request }) => stdout.write(line(response(request.id))));
    await assert.rejects(initializeAcp(peer, { timeoutMs: 200 }), /acp_initialize_refused/);
  }
});

test('rejects truncated JSON, unframed bytes and oversized messages', async () => {
  for (const bad of ['{this-is-not-json}\n', '{"jsonrpc":"2.0"}\n',
    'x'.repeat(65537)]) {
    const peer = endpoint(({ stdout }) => stdout.write(bad));
    await assert.rejects(initializeAcp(peer, { timeoutMs: 200 }),
      /acp_initialize_(invalid_frame|oversized)/);
  }
});

test('requires real readiness within a strict handshake deadline', async () => {
  const peer = endpoint(() => {});
  const started = performance.now();
  await assert.rejects(initializeAcp(peer, { timeoutMs: 30 }), /acp_initialize_timeout/);
  assert.ok(performance.now() - started < 250);
});

test('fails immediately if process output closes before it can initialize', async () => {
  const peer = endpoint(({ stdout }) => stdout.end());
  await assert.rejects(initializeAcp(peer, { timeoutMs: 200 }), /acp_initialize_disconnected/);
});

test('does not retain data listeners after a completed or failed negotiation', async () => {
  const ready = endpoint(({ stdout, request }) => stdout.write(line(valid(request.id))));
  await initializeAcp(ready, { timeoutMs: 200 });
  assert.equal(ready.stdout.listenerCount('data'), 0);
  const fail = endpoint(({ stdout }) => stdout.write('bad-json\n'));
  await assert.rejects(initializeAcp(fail, { timeoutMs: 200 }));
  assert.equal(fail.stdout.listenerCount('data'), 0);
});

test('rejects non-stream and unreasonable time budgets without writing', async () => {
  await assert.rejects(initializeAcp({}, { timeoutMs: 200 }), /acp_initialize_invalid_transport/);
  const peer = endpoint();
  await assert.rejects(initializeAcp(peer, { timeoutMs: 10001 }), /acp_initialize_invalid_transport/);
  assert.equal(peer.seen.length, 0);
  await sleep(1);
});
