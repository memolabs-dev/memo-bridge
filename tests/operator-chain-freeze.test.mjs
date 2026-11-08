// The chain check's blast radius (issue #326, spec D7): a host whose journal was rewritten stops
// that host above T0, not the fleet. On 2026-11-08 a log cleaner deleted the Mac journal, the hub
// reported the rewrite and froze operator access on the Mac *and* the VPS, which had nothing to do
// with it. Two real operator agents, one hub, one corrupt journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHub } from '../bridge/hub.mjs';
import { createAgent } from '../bridge/agent.mjs';
import { createOperatorOperations } from '../bridge/operator-agent.mjs';
import { createOperatorGuard } from '../bridge/operator-guard.mjs';
import { createAuditChain, fileAuditStore } from '../bridge/operator-audit.mjs';
import { createOperatorTools } from '../bridge/operator-tools.mjs';
import { createOperatorExecTools } from '../bridge/operator-exec.mjs';
import { createOperatorVerifier } from '../bridge/operator-signing.mjs';
import { createJobStore } from '../bridge/operator-jobs.mjs';
import { generateAgentIdentity } from '../bridge/crypto.mjs';
import { makePrincipal, CAPABILITIES } from '../server/coordinator/policy.mjs';
import { makeHost, operatorKeys } from './helpers/operator-fixture.mjs';

const OWNER = makePrincipal('oidc:owner', Object.values(CAPABILITIES));
const verifyWorkspace = async (principal, id) => ({ ok: true, workspace: { workspace_id: id, status: 'active', session_tag: null, project: 'drop' } });

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

function operatorAgent(t, { host, port, tlsCert, opKeys, id }) {
  const h = makeHost(t, { host, policy: { host, max_tier: 'exec', approval_mode: 'off' } });
  const guard = createOperatorGuard(h.policy, { autoFrozenFile: h.p('state/AUTO-FROZEN') });
  const chain = createAuditChain({ store: fileAuditStore(h.policy.auditFile) });
  const tools = { ...createOperatorTools(h.policy, { guard, chain, projects: async () => [], platform: 'linux' }),
    ...createOperatorExecTools(h.policy, { jobs: createJobStore({ dir: h.p('state/jobs') }), projects: async () => [], platform: 'linux' }) };
  const { handlers } = createOperatorOperations({ policy: h.policy, verifier: createOperatorVerifier({ publicKeys: [opKeys.publicKeyPem], host }),
    guard, chain, tools });
  const agent = createAgent({ host: `operator-${host}`, url: `wss://127.0.0.1:${port}/agent`, privateKey: id.privateKey, ca: tlsCert,
    reconnectMs: 100_000, operations: { host_status: async () => ({ host: `operator-${host}`, online: true }), ...handlers } });
  t.after(() => agent.stop());
  return { host: h, chain };
}

test('a rewritten journal freezes the host it belongs to, not the other one', async t => {
  const { tlsKey, tlsCert } = tls(t);
  const opKeys = operatorKeys();
  const ids = { vps: generateAgentIdentity(), mac: generateAgentIdentity() };
  const audit = [];
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: 'a'.repeat(64), port: 0, audit: ev => audit.push(ev),
    allowedAgentKeys: { 'operator-vps': ids.vps.publicKey, 'operator-mac': ids.mac.publicKey },
    operator: { signingKeyPem: opKeys.privateKeyPem, approvalModes: { mac: 'off', vps: 'off' }, anchorIntervalMs: 0, verifyWorkspace } });
  const { port } = await hub.start();
  t.after(() => hub.stop());

  const hosts = {};
  for (const name of ['vps', 'mac']) hosts[name] = operatorAgent(t, { host: name, port, tlsCert, opKeys, id: ids[name] });
  await until(() => hub.agentInfo('operator-vps')?.version === 2 && hub.agentInfo('operator-mac')?.version === 2);

  const lock = name => hub.requestOperator(name, 'operator_lock', { args: { host: name, workspace_id: (name === 'vps' ? 'ws_freezeTestVps001' : 'ws_freezeTestMac001'), kind: 'global', reason: 'freeze test' }, principal: OWNER });
  const call = (name, op, args) => hub.requestOperator(name, op, { args: { host: name, workspace_id: (name === 'vps' ? 'ws_freezeTestVps001' : 'ws_freezeTestMac001'), ...args }, principal: OWNER });
  const a = await lock('vps'); assert.equal(a.ok, true, JSON.stringify(a));
  const b = await lock('mac'); assert.equal(b.ok, true, JSON.stringify(b));
  const c = await call('mac', 'operator_run', { argv: ['true'] }); assert.equal(c.ok, true, JSON.stringify(c));

  assert.deepEqual(await hub.anchorChains(), { vps: 'anchored', mac: 'anchored' });
  // A journal line after the anchor, so the anchored sequence is above the first one.
  assert.equal((await call('vps', 'operator_run', { argv: ['true'] })).ok, true);
  assert.deepEqual(await hub.anchorChains(), { vps: 'anchored', mac: 'anchored' });

  // The VPS journal loses its tail the way the Mac's did: a valid chain, shorter than its anchor.
  const file = hosts.vps.host.policy.auditFile;
  const kept = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(0, 1).join('\n');
  writeFileSync(file, `${kept}\n`);

  assert.deepEqual(await hub.anchorChains(), { vps: 'tampered', mac: 'anchored' });
  assert.deepEqual((await call('vps', 'operator_run', { argv: ['true'] })).error, 'frozen', 'the host whose journal was rewritten is stopped');
  assert.equal((await call('mac', 'operator_run', { argv: ['true'] })).ok, true, 'the other host is untouched');
  assert.equal(hub.operatorFrozen(), false, 'the owner\'s fleet-wide switch is not thrown');
  // A read stays available everywhere: the freeze is above T0.
  assert.equal((await call('vps', 'operator_read', { path: hosts.vps.host.p('srv/app/config.txt') })).ok, true);
  assert.ok(audit.some(e => e.event === 'operator_frozen' && e.host === 'operator-vps'));
});
