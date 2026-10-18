#!/usr/bin/env node
// Size of the remote tools/list (Phase 5, TODO-P5-11, U-P5-04, R-P5-13): what ChatGPT receives
// when it lists the Memo Bridge tools, for the read stage (remote_writes disabled) and the
// write stage (enabled). Served exactly as the public listener serves it (createMcpHandler over
// createRemoteServerFactory); nothing is forwarded, nothing touches the network.
//
//   node scripts/remote-toolsize.mjs          a table (read stage, write stage, write stage with operator tools)
//   node scripts/remote-toolsize.mjs --json   one JSON object
//
// Tokens are an estimate (bytes / 4); no ChatGPT limit is documented, so the numbers are to be
// compared with what ChatGPT shows after "Refresh" in the TODO-P5-33 window.
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createRemoteServerFactory } from '../bridge/remote-surface.mjs';
import { CAPABILITIES } from '../server/coordinator/policy.mjs';
import { LEARNING_REASONS, LEARNING_REVIEW_MAX_BYTES, learningReview } from '../server/coordinator/learning.mjs';

const SUB = '00000000-0000-4000-8000-000000000000';
const CLIENT = 'https://chatgpt.com/oauth/client.json';
const SCOPES = Object.values(CAPABILITIES);

// operator: the ceiling the live remote.json grants since Phase 6 (every capability, operator tiers
// included), so the operator_* tools are listed too: what ChatGPT really receives today.
async function listTools(remoteWrites, { operator = false } = {}) {
  const factory = createRemoteServerFactory({
    config: { owner_sub: SUB, allowed_client_ids: [CLIENT], remote_writes: remoteWrites ? 'enabled' : 'disabled',
      ...(operator ? { ceiling: SCOPES } : {}) },
    dispatch: async () => ({ ok: false, error: 'not_forwarded' })
  });
  const handler = createMcpHandler(factory, { legacy: 'stateless', responseMode: 'json' });
  const response = await handler.fetch(new Request('http://localhost/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  }), { authInfo: { token: 'size-script', clientId: CLIENT, scopes: SCOPES, extra: { sub: SUB } } });
  const raw = await response.text();
  await handler.close?.();
  // The stateless leg may answer as one SSE event: the JSON-RPC message is its data line.
  const text = /^(event|data):/m.test(raw) ? raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('') : raw;
  const body = JSON.parse(text);
  if (!body.result?.tools) throw new Error(`tools/list failed: ${text.slice(0, 200)}`);
  return { text, tools: body.result.tools };
}

function measure({ text, tools }) {
  const perTool = tools.map(tool => ({ name: tool.name, bytes: Buffer.byteLength(JSON.stringify(tool)) })).sort((a, b) => b.bytes - a.bytes);
  const bytes = Buffer.byteLength(text);
  return { tools: tools.length, bytes, approx_tokens: Math.ceil(bytes / 4), largest: perTool.slice(0, 5) };
}

// The learning_review block (#38) a tool result may carry: its largest form, against its bound.
const reviewBytes = Math.max(...LEARNING_REASONS.map(r => Buffer.byteLength(JSON.stringify(learningReview(r, { calls: 1_000_000, turns: 1_000_000 })))));
const report = { read: measure(await listTools(false)), write: measure(await listTools(true)),
  operator: measure(await listTools(true, { operator: true })),
  learning_review: { bytes: reviewBytes, max_bytes: LEARNING_REVIEW_MAX_BYTES } };
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report));
} else {
  for (const [stage, r] of Object.entries(report)) {
    if (stage === 'learning_review') { console.log(`learning_review block  ${r.bytes} bytes (bound ${r.max_bytes})`); continue; }
    console.log(`${stage.padEnd(6)} ${String(r.tools).padStart(3)} tools  ${String(r.bytes).padStart(7)} bytes  ~${r.approx_tokens} tokens`);
    for (const t of r.largest) console.log(`         ${t.name.padEnd(24)} ${t.bytes} bytes`);
  }
}
