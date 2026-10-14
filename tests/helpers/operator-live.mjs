// A real hub on loopback TLS with two real operator agents (operator-vps and operator-mac), each
// on its own temporary host tree, with every operator tool (read, write, exec, and the repatriated
// snapshot, media and transfer source). For the transfer, media and snapshot tests.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createOperatorOperations } from '../../bridge/operator-agent.mjs';
import { createOperatorGuard } from '../../bridge/operator-guard.mjs';
import { createAuditChain, fileAuditStore } from '../../bridge/operator-audit.mjs';
import { createOperatorTools } from '../../bridge/operator-tools.mjs';
import { createOperatorWriteTools } from '../../bridge/operator-write.mjs';
import { createSnapshotTool } from '../../bridge/operator-snapshot.mjs';
import { createMediaTool } from '../../bridge/operator-media.mjs';
import { createTransferSourceTools } from '../../bridge/operator-transfer-source.mjs';
import { createHub } from '../../bridge/hub.mjs';
import { createAgent } from '../../bridge/agent.mjs';
import { generateAgentIdentity } from '../../bridge/crypto.mjs';
import { createOperatorVerifier } from '../../bridge/operator-signing.mjs';
import { makeHost, operatorKeys } from './operator-fixture.mjs';

export function tls(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memo-op-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return { tlsKey: readFileSync(join(dir, 'k'), 'utf8'), tlsCert: readFileSync(join(dir, 'c'), 'utf8') };
}
export async function until(fn, ms = 10_000) {
  const expire = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > expire) throw new Error('wait expired'); await new Promise(r => setTimeout(r, 15)); }
}

// hostTools(host) -> the tool map of one agent.
export function agentTools(host, { platform = 'linux' } = {}) {
  const projects = async () => [];
  return {
    ...createOperatorTools(host.policy, { projects, platform }),
    ...createOperatorWriteTools(host.policy, { projects, stateDir: host.p('state') }),
    ...createSnapshotTool(host.policy, { projects }),
    ...createMediaTool(host.policy, { projects, platform }),
    ...createTransferSourceTools(host.policy, { projects })
  };
}

// operator: extra hub operator options (transferLimits, approvalModes...).
export async function twoHostStack(t, { operator = {}, platform = 'linux' } = {}) {
  const hosts = { vps: makeHost(t, { host: 'vps', policy: { max_tier: 'write' } }), mac: makeHost(t, { host: 'mac', policy: { max_tier: 'write' } }) };
  const { tlsKey, tlsCert } = tls(t);
  const opKeys = operatorKeys();
  const ids = { 'operator-vps': generateAgentIdentity(), 'operator-mac': generateAgentIdentity(), vps: generateAgentIdentity(), mac: generateAgentIdentity() };
  const audit = [];
  const verifyWorkspace = async (principal, ws) => ({ ok: true, workspace: { workspace_id: ws, status: 'active', session_tag: null, project: 'drop' } });
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: 'a'.repeat(64), port: 0, audit: ev => audit.push(ev),
    allowedAgentKeys: Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v.publicKey])),
    operator: { signingKeyPem: opKeys.privateKeyPem, freezeFile: hosts.vps.p('state/HUB-FROZEN'), anchorIntervalMs: 0, verifyWorkspace, ...operator } });
  const { port } = await hub.start();
  t.after(() => hub.stop());
  const url = `wss://127.0.0.1:${port}/agent`;
  for (const name of ['vps', 'mac']) {
    const host = hosts[name];
    const guard = createOperatorGuard(host.policy, { autoFrozenFile: host.p('state/AUTO-FROZEN') });
    const chain = createAuditChain({ store: fileAuditStore(host.policy.auditFile) });
    const verifier = createOperatorVerifier({ publicKeys: [opKeys.publicKeyPem], host: name });
    const { handlers } = createOperatorOperations({ policy: host.policy, verifier, guard, chain, tools: agentTools(host, { platform }) });
    const agent = createAgent({ host: `operator-${name}`, url, privateKey: ids[`operator-${name}`].privateKey, ca: tlsCert, reconnectMs: 100_000,
      operations: { host_status: async () => ({ host: `operator-${name}`, online: true }), ...handlers } });
    t.after(() => agent.stop());
  }
  await until(() => hub.agentInfo('operator-vps')?.version === 2 && hub.agentInfo('operator-mac')?.version === 2);
  return { hub, hosts, audit };
}

export const journalLines = host => readFileSync(host.policy.auditFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
