// Phase 5, TODO-P5-06 (REQ-P5-14, AC-P5-13): bounds of the remote path. Compact JSON, a 24 KiB
// default budget answered with result_too_large (never a cut), list and page clamps, and the
// 96 KiB remote write cap. The runtime is replaced by a dispatch that follows the runner's
// contracts (worktree_read_file offset/limit/next_offset, server/runners/worktrees.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { REMOTE_LIMITS, boundedResult, createRemoteServerFactory, parseRemoteConfig, remoteArgs } from '../bridge/remote-surface.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';

const ALL = Object.values(CAPABILITIES);
const SUB = 'owner-sub';
const CLIENT = 'https://chatgpt.com/c.json';
const CONFIG = { owner_sub: SUB, allowed_client_ids: [CLIENT] };
const jsonRpcBody = text => JSON.parse(/^(event|data):/m.test(text)
  ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('') : text);

function surface(dispatch, { config = CONFIG, scopes = ['coordinator:read'] } = {}) {
  const calls = [];
  const factory = createRemoteServerFactory({ config, dispatch: async (host, op, o) => { calls.push({ op, args: o.args }); return dispatch(op, o.args); } });
  const handler = createMcpHandler(factory, { legacy: 'stateless' });
  const authInfo = { token: 't', clientId: CLIENT, scopes, extra: { sub: SUB } };
  return {
    calls,
    async call(name, args = {}) {
      const response = await handler.fetch(new Request('http://localhost/mcp', { method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), { authInfo });
      const result = jsonRpcBody(await response.text()).result;
      const text = result.content[0].text;
      return { text, bytes: Buffer.byteLength(text), data: JSON.parse(text) };
    }
  };
}

// The runner's worktree_read_file window (LIMITS.readBytes 256 KiB, next_offset to continue).
function fakeReader(file) {
  const buf = Buffer.from(file, 'utf8');
  return (op, args) => {
    assert.equal(op, 'worktree_read_file');
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 256 * 1024;
    const end = Math.min(offset + limit, buf.length);
    return { ok: true, path: args.path, offset, bytes: end - offset, size: buf.length, truncated: end < buf.length,
      ...(end < buf.length ? { next_offset: end } : {}), content: buf.subarray(offset, end).toString('utf8') };
  };
}

test('AC-P5-13: a 300 KiB file is read completely through 16 KiB pages, each answer within the budget', async () => {
  const line = 'export const value = "memo bridge";\n';
  const file = line.repeat(Math.ceil(300 * 1024 / line.length));
  const s = surface(fakeReader(file));
  let offset; let content = ''; let pages = 0;
  do {
    const out = await s.call('worktree_read_file', { worktree_id: 'wt_x', path: 'big.ts', ...(offset !== undefined ? { offset } : {}) });
    assert.equal(out.data.ok, true, out.text.slice(0, 200));
    assert.ok(out.bytes <= REMOTE_LIMITS.resultBudgetBytes, `page of ${out.bytes} bytes`);
    content += out.data.content;
    offset = out.data.next_offset;
    pages++;
  } while (offset !== undefined && pages < 100);
  assert.equal(content, file);
  assert.equal(pages, Math.ceil(Buffer.byteLength(file) / (16 * 1024)));
  // Every forwarded call carried the remote page clamp, whatever the model asked for.
  assert.ok(s.calls.every(c => c.args.limit === 16 * 1024));
  await s.call('worktree_read_file', { worktree_id: 'wt_x', path: 'big.ts', limit: 256 * 1024 });
  await s.call('worktree_read_file', { worktree_id: 'wt_x', path: 'big.ts', limit: 100 });
  assert.deepEqual(s.calls.slice(-2).map(c => c.args.limit), [16 * 1024, 100]);
});

test('AC-P5-13: a 40 KiB result is refused with result_too_large, never cut, and JSON stays compact', async () => {
  const big = { ok: true, issues: Array.from({ length: 400 }, (_, i) => ({ number: i, title: 'x'.repeat(90) })) };
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > 40 * 1024);
  const s = surface(() => big);
  const out = await s.call('github_issues', { repo: 'memolabs-dev/drop' });
  assert.equal(out.data.ok, false);
  assert.equal(out.data.error, 'result_too_large');
  assert.equal(out.data.bytes, Buffer.byteLength(JSON.stringify(big)));
  assert.equal(out.data.budget_bytes, 24 * 1024);
  assert.match(out.data.hint, /limit/);
  assert.equal(out.text.includes('xxxxxxxx'), false, 'no partial content');
  assert.equal(out.text.includes('\n'), false);
  // A result exactly at the budget passes untouched.
  const fit = { ok: true, pad: '' };
  fit.pad = 'y'.repeat(24 * 1024 - Buffer.byteLength(JSON.stringify(fit)));
  assert.equal(Buffer.byteLength(JSON.stringify(fit)), 24 * 1024);
  const exact = await surface(() => fit).call('github_issues', { repo: 'memolabs-dev/drop' });
  assert.deepEqual(exact.data, fit);
  assert.equal(exact.bytes, 24 * 1024);
});

test('the budget is configurable, and a mutating op that ran keeps that fact when over budget', async () => {
  const s = surface(() => ({ ok: true, rows: 'z'.repeat(3000) }), { config: { ...CONFIG, result_budget_bytes: 2048 } });
  const out = await s.call('workspace_list', {});
  assert.deepEqual([out.data.error, out.data.budget_bytes], ['result_too_large', 2048]);
  const ran = boundedResult('workspace_close', { ok: true, released: 'r'.repeat(30 * 1024) }, 24 * 1024);
  assert.equal(JSON.parse(ran.text).op_completed, true);
  const refused = boundedResult('workspace_close', { ok: false, error: 'x', detail: 'd'.repeat(30 * 1024) }, 24 * 1024);
  assert.equal(JSON.parse(refused.text).op_completed, undefined);
  assert.equal(JSON.parse(boundedResult('worktree_read_file', { ok: true, content: 'c'.repeat(30 * 1024) }, 24 * 1024).text).hint,
    'read a smaller page: lower limit, then continue from next_offset');
});

test('list clamps: limits above 50 are lowered, unset defaults stay unless the tool default is above the clamp', () => {
  const cfg = parseRemoteConfig(CONFIG);
  const p = makePrincipal(`oidc:${SUB}`, ALL, { client_type: 'chatgpt' });
  const args = (op, a) => remoteArgs(op, a, p, cfg).args;
  for (const op of ['workspace_list', 'tasks_list', 'jobs_list', 'audit_events', 'github_issues', 'github_pull_requests', 'github_workflows',
    'worktree_list_files']) {
    assert.equal(args(op, { limit: 200 }).limit, 50, op);
    assert.equal(args(op, { limit: 7 }).limit, 7, op);
  }
  assert.equal(args('tasks_list', {}).limit, undefined, 'tasks_list keeps its own default (30)');
  assert.equal(args('worktree_list_files', { worktree_id: 'wt_x' }).limit, 50, 'its own default is 500');
  assert.equal(args('job_results', { job_id: 'job_1', tail_lines: 400 }).tail_lines, 200);
  assert.equal(args('job_results', { job_id: 'job_1' }).tail_lines, undefined);
  assert.equal(args('worktree_read_file', { worktree_id: 'wt_x', path: 'a' }).limit, 16 * 1024);
  // The caller's object is never changed.
  const original = { limit: 500 };
  remoteArgs('workspace_list', original, p, cfg);
  assert.deepEqual(original, { limit: 500 });
  // Tighter configured bounds apply.
  const tight = parseRemoteConfig({ ...CONFIG, list_limit: 10, read_page_bytes: 4096, job_tail_lines: 20 });
  assert.equal(remoteArgs('jobs_list', { limit: 50 }, p, tight).args.limit, 10);
  assert.equal(remoteArgs('worktree_read_file', {}, p, tight).args.limit, 4096);
  assert.equal(remoteArgs('job_results', { tail_lines: 50 }, p, tight).args.tail_lines, 20);
});

test('AC-P5-13: a 100 KiB remote write is refused before forwarding; 90 KiB passes', async () => {
  const s = surface(() => ({ ok: true }), { config: { ...CONFIG, remote_writes: 'enabled' }, scopes: ALL });
  const refused = await s.call('worktree_write_file', { worktree_id: 'wt_x', path: 'a.txt', content: 'a'.repeat(100 * 1024) });
  assert.deepEqual(refused.data, { ok: false, error: 'content_too_large' });
  assert.equal(s.calls.length, 0);
  // Bytes, not characters: 40 Ki three-byte characters are 120 KiB.
  const wide = await s.call('worktree_write_file', { worktree_id: 'wt_x', path: 'a.txt', content: '€'.repeat(40 * 1024) });
  assert.deepEqual(wide.data, { ok: false, error: 'content_too_large' });
  const ok = await s.call('worktree_write_file', { worktree_id: 'wt_x', path: 'a.txt', content: 'a'.repeat(90 * 1024) });
  assert.deepEqual(ok.data, { ok: true });
  assert.equal(s.calls.length, 1);
});
