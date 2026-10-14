// Phase 6, TODO-P6-05 to 07 (R-P6-02, R-P6-05, R-P6-06, R-P6-07, R-P6-11; AC-P6-03 end to
// end, AC-P6-04, AC-P6-07, AC-P6-11): the operator agent's pipeline (signature, tier, kill
// switch, rate limits, schema, tool, redaction, journal) on a temporary host tree, then the
// whole path over a real hub on loopback TLS with a real operator agent (bridge/agent.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { createOperatorOperations } from '../bridge/operator-agent.mjs';
import { createOperatorGuard, AUTO_FREEZE } from '../bridge/operator-guard.mjs';
import { createAuditChain, fileAuditStore, memoryAuditStore, verifyChain, GENESIS } from '../bridge/operator-audit.mjs';
import { createOperatorTools } from '../bridge/operator-tools.mjs';
import { OPERATOR_SCHEMAS } from '../server/tools/operator-tools.mjs';
import { operatorTier } from '../server/coordinator/policy.mjs';
import { createHub, hubFreezeDenial } from '../bridge/hub.mjs';
import { createAgent } from '../bridge/agent.mjs';
import { generateAgentIdentity } from '../bridge/crypto.mjs';
import { createOperatorVerifier } from '../bridge/operator-signing.mjs';
import { HUB_PRINCIPALS, PRINCIPAL_IDS } from '../bridge/ops.mjs';
import { CANARY, GITHUB_TOKEN, makeHost, operatorKeys, signingPair } from './helpers/operator-fixture.mjs';

const PRINCIPAL = 'oidc:owner';
let seq = 0;
const nextId = () => `req_${String(++seq).padStart(16, '0')}`;

// The agent's pipeline with an extra T1 test op (Lot 1 has no real T1 tool) to exercise the
// kill switch and the rate limit above T0.
function pipeline(t, { policyOverrides = {}, clock = { t: 1_800_000_000_000 } } = {}) {
  const host = makeHost(t, { policy: { max_tier: 'write', ...policyOverrides } });
  const { signer, verifier } = signingPair({ clock });
  const now = () => clock.t;
  const markers = [];
  const guard = createOperatorGuard(host.policy, { autoFrozenFile: host.p('state/AUTO-FROZEN'), now,
    writeMarker: (path, text) => { markers.push(path); writeFileSync(path, text); } });
  const store = memoryAuditStore();
  const chain = createAuditChain({ store, now });
  const tools = createOperatorTools(host.policy, { guard, chain, projects: async () => [], platform: 'linux', now });
  let writes = 0;
  tools.operator_test_write = async () => { writes++; return { ok: true, wrote: true }; };
  const tierOf = op => (op === 'operator_test_write' ? 1 : operatorTier(op));
  const schemas = { ...OPERATOR_SCHEMAS, operator_test_write: z.object({ host: z.enum(['mac', 'vps']), ref: z.string().optional() }) };
  const { handlers } = createOperatorOperations({ policy: host.policy, verifier, guard, chain, tools, tierOf, schemas, now,
    ops: [...Object.keys(OPERATOR_SCHEMAS), 'operator_test_write'] });
  const call = async (op, args, { tamper = null, sign = true, tier = tierOf(op) } = {}) => {
    const id = nextId();
    let operator = sign ? signer.sign({ id, op, host: 'vps', tier, principal: PRINCIPAL, args }) : null;
    if (tamper) operator = tamper(operator);
    return handlers[op](args, { id, op, principal: { id: PRINCIPAL }, operator, meta: null });
  };
  return { host, call, handlers, signer, guard, chain, store, clock, markers, writes: () => writes };
}

test('pipeline: a signed T0 call runs, is redacted, bounded and journaled; an unsigned one never runs', async t => {
  const { host, call, store } = pipeline(t);
  const out = await call('operator_read', { host: 'vps', path: host.p('srv/app/config.txt'), ref: 'trace-1' });
  assert.equal(out.ok, true);
  assert.equal(out.ref, 'trace-1');
  assert.equal(JSON.stringify(out).includes(GITHUB_TOKEN), false);
  const unsigned = await call('operator_read', { host: 'vps', path: host.p('srv/app/config.txt') }, { sign: false });
  assert.deepEqual(unsigned, { ok: false, error: 'signature_missing' });
  const lines = store.read().trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => [l.op, l.outcome, l.code]), [['operator_read', 'ok', null], ['operator_read', 'denied', 'signature_missing']]);
  assert.equal(lines[0].ref, 'trace-1');
  assert.equal(lines[0].principal, PRINCIPAL);
  assert.match(lines[0].output_sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(lines).includes(GITHUB_TOKEN), false, 'the journal never holds the content');
  // The schema and the host still apply after a good signature.
  assert.equal((await call('operator_read', { host: 'vps', path: 7 })).error, 'invalid_arguments');
  assert.equal((await call('operator_read', { host: 'mac', path: '/x' })).error, 'host_mismatch');
});

test('AC-P6-03 end to end: replay, changed args, expired, unknown key are refused and nothing runs', async t => {
  const { host, handlers, signer, clock, writes } = pipeline(t);
  const args = { host: 'vps' };
  const id = nextId();
  const operator = signer.sign({ id, op: 'operator_test_write', host: 'vps', tier: 1, principal: PRINCIPAL, args });
  const ctx = { id, op: 'operator_test_write', principal: { id: PRINCIPAL }, operator };
  assert.equal((await handlers.operator_test_write(args, ctx)).ok, true);
  assert.deepEqual(await handlers.operator_test_write(args, ctx), { ok: false, error: 'replayed' });
  const id2 = nextId();
  const op2 = signer.sign({ id: id2, op: 'operator_test_write', host: 'vps', tier: 1, principal: PRINCIPAL, args });
  assert.deepEqual(await handlers.operator_test_write({ ...args, ref: 'added' }, { ...ctx, id: id2, operator: op2 }), { ok: false, error: 'args_mismatch' });
  const id3 = nextId();
  const op3 = signer.sign({ id: id3, op: 'operator_test_write', host: 'vps', tier: 1, principal: PRINCIPAL, args });
  clock.t += 61_000;
  assert.deepEqual(await handlers.operator_test_write(args, { ...ctx, id: id3, operator: op3 }), { ok: false, error: 'expired' });
  const stranger = signingPair({ clock });
  const id4 = nextId();
  const op4 = stranger.signer.sign({ id: id4, op: 'operator_test_write', host: 'vps', tier: 1, principal: PRINCIPAL, args });
  assert.deepEqual(await handlers.operator_test_write(args, { ...ctx, id: id4, operator: op4 }), { ok: false, error: 'unknown_key' });
  assert.equal(writes(), 1, 'only the first, valid call ran');
  assert.equal(host.policy.host, 'vps');
});

test('tier: the signed tier must match this side\'s table and stay within the local max_tier', async t => {
  const { call, writes } = pipeline(t, { policyOverrides: { max_tier: 'read' } });
  assert.deepEqual(await call('operator_test_write', { host: 'vps' }), { ok: false, error: 'tier_not_allowed' });
  // A hub that signs a T1 op as T0 is caught by the agent's own table.
  assert.deepEqual(await call('operator_test_write', { host: 'vps' }, { tier: 0 }), { ok: false, error: 'tier_mismatch' });
  assert.equal(writes(), 0);
});

test('AC-P6-04: with the FROZEN file present every op above T0 answers frozen; T0 still reads', async t => {
  const { host, call, writes } = pipeline(t);
  assert.equal((await call('operator_test_write', { host: 'vps' })).ok, true);
  writeFileSync(host.p('state/FROZEN'), '');
  assert.deepEqual(await call('operator_test_write', { host: 'vps' }), { ok: false, error: 'frozen' });
  assert.equal((await call('operator_read', { host: 'vps', path: host.p('srv/app/notes.md') })).ok, true, 'T0 stays available');
  const status = await call('operator_freeze_status', { host: 'vps' });
  assert.deepEqual([status.host_frozen_file, status.frozen_above_t0], [true, true]);
  rmSync(host.p('state/FROZEN'));
  assert.equal((await call('operator_test_write', { host: 'vps' })).ok, true, 'checked on every call, no cache');
  assert.equal(writes(), 2);
});

test('AC-P6-11: 5 signature or policy refusals in 5 min freeze the host; the marker survives a restart; only the owner clears it', async t => {
  const { host, call, guard, clock, markers } = pipeline(t);
  const bad = env => ({ ...env, sig: env.sig.slice(0, -2) + (env.sig.endsWith('AA') ? 'BA' : 'AA') });
  for (let i = 0; i < AUTO_FREEZE.refusals - 1; i++) {
    assert.equal((await call('operator_read', { host: 'vps', path: '/x' }, { tamper: bad })).error, 'signature_invalid');
  }
  assert.equal((await call('operator_test_write', { host: 'vps' })).ok, true, 'four refusals: not frozen yet');
  // Refusals older than the window do not count.
  clock.t += AUTO_FREEZE.windowMs + 1;
  assert.equal((await call('operator_read', { host: 'vps', path: '/x' }, { tamper: bad })).error, 'signature_invalid');
  assert.equal((await call('operator_test_write', { host: 'vps' })).ok, true);
  // A secret path request counts like a policy refusal.
  for (let i = 0; i < AUTO_FREEZE.refusals - 2; i++) await call('operator_read', { host: 'vps', path: '/x' }, { tamper: bad });
  assert.equal((await call('operator_read', { host: 'vps', path: host.p('srv/app/.env') })).error, 'path_secret');
  assert.equal(guard.status().auto, true);
  assert.deepEqual(markers, [host.p('state/AUTO-FROZEN')]);
  assert.deepEqual(await call('operator_test_write', { host: 'vps' }), { ok: false, error: 'frozen' });
  // A sixth refusal changes nothing; a restarted agent reads the marker and stays frozen.
  await call('operator_read', { host: 'vps', path: '/x' }, { tamper: bad });
  const restarted = createOperatorGuard(host.policy, { autoFrozenFile: host.p('state/AUTO-FROZEN') });
  assert.equal(restarted.admit(1), 'frozen');
  // No wire path clears it; the owner removes the marker on the host.
  rmSync(host.p('state/AUTO-FROZEN'));
  assert.equal(restarted.admit(1), null);
  assert.equal((await call('operator_test_write', { host: 'vps' })).ok, true);
  // Ordinary errors (not found, not allowed) never count.
  const g = createOperatorGuard(host.policy);
  for (let i = 0; i < 10; i++) g.refused('not_found');
  for (let i = 0; i < 10; i++) g.refused('path_not_allowed');
  assert.equal(g.status().auto, false);
});

test('rate limits per tier: T1 over its per-minute budget answers rate_limited, T0 is not limited here', async t => {
  const { call, clock } = pipeline(t, { policyOverrides: { rate_limits: { write: 3 } } });
  for (let i = 0; i < 3; i++) assert.equal((await call('operator_test_write', { host: 'vps' })).ok, true);
  assert.deepEqual(await call('operator_test_write', { host: 'vps' }), { ok: false, error: 'rate_limited' });
  for (let i = 0; i < 10; i++) assert.equal((await call('operator_policy', { host: 'vps' })).ok, true);
  clock.t += 60_001;
  assert.equal((await call('operator_test_write', { host: 'vps' })).ok, true, 'the window slides');
});

test('AC-P6-07: every call lands in the chain; altering one line makes operator_audit_verify report that line', async t => {
  const { call, store, chain } = pipeline(t);
  for (let i = 0; i < 4; i++) await call('operator_policy', { host: 'vps', ref: `r${i}` });
  const verified = await call('operator_audit_verify', { host: 'vps' });
  assert.deepEqual([verified.chain_ok, verified.lines], [true, 4], 'the verify call itself is journaled after it answers');
  assert.equal(chain.seq, 5);
  const lines = store.read().trim().split('\n');
  assert.equal(JSON.parse(lines[0]).prev, GENESIS);
  for (let i = 1; i < lines.length; i++) assert.equal(JSON.parse(lines[i]).prev, JSON.parse(lines[i - 1]).hash);
  // Tamper with line 3: change the outcome, keep its hash.
  const edited = lines.map((l, i) => (i === 2 ? l.replace('"outcome":"ok"', '"outcome":"denied"') : l));
  store.set(`${edited.join('\n')}\n`);
  const broken = await call('operator_audit_verify', { host: 'vps' });
  assert.deepEqual([broken.chain_ok, broken.first_broken_line, broken.reason], [false, 3, 'hash_mismatch']);
  // Recompute that line's hash too: the next line's prev no longer matches.
  const fixed = JSON.parse(edited[2]);
  const { lineHash } = await import('../bridge/operator-audit.mjs');
  fixed.hash = lineHash(fixed);
  store.set(`${[...edited.slice(0, 2), JSON.stringify(fixed), ...edited.slice(3)].join('\n')}\n`);
  assert.deepEqual([verifyChain(store.read()).first_broken_line, verifyChain(store.read()).reason], [4, 'prev_mismatch']);
  // A removed line and a torn last line are reported too.
  assert.equal(verifyChain(`${[lines[0], lines[2]].join('\n')}\n`).first_broken_line, 2);
  assert.deepEqual(verifyChain(`${lines[0]}\n{"seq":2`), { ok: false, lines: 2, head: JSON.parse(lines[0]).hash, first_broken_line: 2, reason: 'unparsable' });
  // A chain reopened from a file continues from its head.
  const dir = mkdtempSync(join(tmpdir(), 'memo-op-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'audit.jsonl');
  const a = createAuditChain({ store: fileAuditStore(file) });
  a.append({ op: 'operator_policy', outcome: 'ok', args: { host: 'vps', secret: GITHUB_TOKEN, long: 'x'.repeat(1000) } });
  const b = createAuditChain({ store: fileAuditStore(file) });
  assert.equal(b.head, a.head);
  b.append({ op: 'operator_state', outcome: 'ok', args: {} });
  assert.deepEqual([b.verify().ok, b.verify().lines], [true, 2]);
  const text = readFileSync(file, 'utf8');
  assert.equal(text.includes(GITHUB_TOKEN), false, 'arguments are redacted in the journal');
  assert.ok(text.includes('...[1000 chars]'), 'long arguments are cut');
  assert.equal((await import('node:fs')).statSync(file).mode & 0o777, 0o600);
});

// ------------------------------------------------------------------------------------------
// Over a real hub and a real operator agent.

function tls(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memo-op-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return { tlsKey: readFileSync(join(dir, 'k'), 'utf8'), tlsCert: readFileSync(join(dir, 'c'), 'utf8') };
}
async function until(fn, ms = 5000) {
  const expire = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > expire) throw new Error('wait expired'); await new Promise(r => setTimeout(r, 15)); }
}

async function liveStack(t) {
  const host = makeHost(t);
  const { tlsKey, tlsCert } = tls(t);
  const opKeys = operatorKeys();
  const ids = { 'operator-vps': generateAgentIdentity(), vps: generateAgentIdentity(), mac: generateAgentIdentity() };
  const audit = [];
  const freezeFile = host.p('state/HUB-FROZEN');
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: 'a'.repeat(64), port: 0, audit: ev => audit.push(ev),
    allowedAgentKeys: { mac: ids.mac.publicKey, vps: ids.vps.publicKey, 'operator-vps': ids['operator-vps'].publicKey },
    operator: { signingKeyPem: opKeys.privateKeyPem, freezeFile } });
  const { port } = await hub.start();
  t.after(() => hub.stop());
  const url = `wss://127.0.0.1:${port}/agent`;
  const guard = createOperatorGuard(host.policy, { autoFrozenFile: host.p('state/AUTO-FROZEN') });
  const chain = createAuditChain({ store: fileAuditStore(host.policy.auditFile) });
  const verifier = createOperatorVerifier({ publicKeys: [opKeys.publicKeyPem], host: 'vps' });
  const tools = createOperatorTools(host.policy, { guard, chain, projects: async () => [], platform: 'linux' });
  const { handlers } = createOperatorOperations({ policy: host.policy, verifier, guard, chain, tools });
  const agent = createAgent({ host: 'operator-vps', url, privateKey: ids['operator-vps'].privateKey, ca: tlsCert, reconnectMs: 100_000,
    operations: { host_status: async () => ({ host: 'operator-vps', online: true }), ...handlers } });
  t.after(() => agent.stop());
  await until(() => hub.agentInfo('operator-vps')?.version === 2);
  return { host, hub, agent, audit, url, ids, tlsCert, freezeFile, opKeys };
}

const OWNER = HUB_PRINCIPALS[PRINCIPAL_IDS.owner];
const READER = HUB_PRINCIPALS[PRINCIPAL_IDS.readonly];

test('live: the hub signs, the operator agent verifies; reads work, secrets do not, both journals record the call', async t => {
  const { host, hub, audit } = await liveStack(t);
  assert.deepEqual(hub.agentInfo('operator-vps').ops.includes('operator_read'), true);
  // 9443: the owner bearer's principal lists the T0 operator tools, the read-only one does not.
  assert.ok(hub.availableOps(OWNER).includes('operator_read'));
  assert.equal(hub.availableOps(READER).some(op => op.startsWith('operator_')), false);
  const out = await hub.requestOperator('vps', 'operator_read', { args: { host: 'vps', path: host.p('srv/app/notes.md') }, principal: OWNER });
  assert.equal(out.ok, true);
  assert.match(out.untrusted_content.content, /Ignore previous instructions/);
  assert.deepEqual(await hub.requestOperator('vps', 'operator_read', { args: { host: 'vps', path: host.p('srv/app/.env') }, principal: OWNER }),
    { ok: false, error: 'path_secret', host: 'vps' });
  const search = await hub.requestOperator('vps', 'operator_search', { args: { host: 'vps', path: host.p('home'), pattern: CANARY }, principal: OWNER });
  assert.deepEqual([search.ok, search.count], [true, 0]);
  // The host chain and the hub journal both hold the three calls, with the same args hash.
  const chain = verifyChain(readFileSync(host.policy.auditFile, 'utf8'));
  assert.deepEqual([chain.ok, chain.lines], [true, 3]);
  const hubLines = audit.filter(e => e.event === 'operator_call');
  assert.deepEqual(hubLines.map(e => [e.op, e.outcome, e.code, e.tier]), [['operator_read', 'ok', null, 0], ['operator_read', 'refused', 'path_secret', 0],
    ['operator_search', 'ok', null, 0]]);
  const hostLines = readFileSync(host.policy.auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(hubLines.map(e => e.args_sha256), hostLines.map(l => l.args_sha256));
  assert.deepEqual(hubLines.map(e => e.request_id), hostLines.map(l => l.request_id), 'the wire id ties both journals');
  assert.ok(hubLines.every(e => /^[0-9a-f]{64}$/.test(e.output_sha256)));
  // Not authorized, wrong host argument, unknown op, a non-operator op through requestOperator.
  assert.deepEqual(await hub.requestOperator('vps', 'operator_policy', { args: { host: 'vps' }, principal: READER }), { ok: false, error: 'forbidden', host: 'vps' });
  assert.deepEqual(await hub.requestOperator('vps', 'operator_policy', { args: { host: 'mac' }, principal: OWNER }), { ok: false, error: 'invalid_arguments' });
  assert.deepEqual(await hub.requestOperator('mac', 'operator_policy', { args: { host: 'mac' }, principal: OWNER }), { ok: false, error: 'host_offline', host: 'mac' });
  assert.deepEqual(await hub.requestOperator('vps', 'tasks_list', { args: { host: 'vps' }, principal: OWNER }), { ok: false, error: 'unsupported_op' });
});

test('live: an operator op never leaves the hub unsigned, and an operator identity serves nothing else', async t => {
  const { hub } = await liveStack(t);
  // requestAgent is the path every other surface uses: it refuses operator ops outright.
  assert.deepEqual(await hub.requestAgent('operator-vps', 'operator_policy', { args: { host: 'vps' }, principal: OWNER }), { ok: false, error: 'unsupported_op' });
  assert.deepEqual(await hub.requestAgent('vps', 'operator_policy', { args: { host: 'vps' }, principal: OWNER }), { ok: false, error: 'unsupported_op' });
  assert.deepEqual(await hub.requestAgent('operator-vps', 'tasks_list', { principal: OWNER }), { ok: false, error: 'unsupported_op' });
});

test('live AC-P6-04: the hub freeze flag and the hub freeze file refuse above T0 at the hub; T0 still answers; no tool unfreezes', async t => {
  const { hub, audit, freezeFile } = await liveStack(t);
  assert.equal(hub.operatorFrozen(), false);
  hub.setOperatorFrozen(true, 'owner-test');
  assert.equal(hub.operatorFrozen(), true);
  const status = await hub.requestOperator('vps', 'operator_freeze_status', { args: { host: 'vps' }, principal: OWNER });
  assert.deepEqual([status.hub_frozen, status.frozen_above_t0], [true, true]);
  assert.equal((await hub.requestOperator('vps', 'operator_policy', { args: { host: 'vps' }, principal: OWNER })).ok, true, 'T0 answers while frozen');
  hub.setOperatorFrozen(false, 'owner-test');
  writeFileSync(freezeFile, '');
  assert.equal(hub.operatorFrozen(), true, 'the file freezes without any call');
  rmSync(freezeFile);
  assert.equal(hub.operatorFrozen(), false);
  assert.ok(audit.some(e => e.event === 'operator_frozen' && e.by === 'owner-test'));
  // The hub's decision for every tier (Lot 2 brings the T1 to T3 ops that exercise it live).
  assert.deepEqual([0, 1, 2, 3].map(tier => hubFreezeDenial(tier, true)), [null, 'frozen', 'frozen', 'frozen']);
  assert.deepEqual([0, 1, 2, 3].map(tier => hubFreezeDenial(tier, false)), [null, null, null, null]);
  assert.equal(existsSync(freezeFile), false);
});
