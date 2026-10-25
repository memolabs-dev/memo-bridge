// Operator agent entry point (Phase 6, TODO-P6-05). One process per host:
//   lab   memo-operator.service, user memo-operator (no sudo, no docker group), lab-infra role
//         memo-operator (Lot 2, TODO-P6-12)
//   Mac   a launchd user agent, user memo, over an SSH local forward to the hub (Lot 3)
//
// Environment:
//   MEMO_OPERATOR_HOST     mac | vps                                               (required)
//   MEMO_OPERATOR_CONFIG   directory holding hub-ca.crt (hub TLS CA) and           (required)
//                          operator-hub.pub (the hub's operator signing public key, one or more
//                          PEM blocks); operator-hub.pub must pass the same trust check as the
//                          policy (owner root, or the owner on the Mac; not writable by others)
//   MEMO_OPERATOR_POLICY   policy file (default /etc/memo-operator/policy.json on lab,
//                          ~/.memo-operator/policy.json on the Mac)
//   MEMO_OPERATOR_STATE    writable directory for background runs, uploads and the auto-freeze
//                          marker (default: the policy's state_dir)
// With a root_helper section in the policy, T3 calls go through the helper's socket
// (bridge/operator-root-helper.mjs); on lab the host journal does too, so the agent cannot
// rewrite it. On the Mac the section is written only once the root helper is installed.
// lab-infra must run this unit with KillMode=process so background runs outlive a restart.
//   MEMO_BRIDGE_AGENT_URL  hub agent endpoint (default wss://localhost:9443/agent)
//   CREDENTIALS_DIRECTORY  systemd credentials: `agent-key`, this agent's Ed25519 identity
//                          (lab). Otherwise MEMO_OPERATOR_CONFIG/agent.key (Mac).
// The policy and the hub key are read at start; a change needs a restart. Any problem with them
// stops the process before it connects (fail closed). After start, a policy file that no longer
// passes or differs refuses every call above T0 (policy_unavailable, policy_changed; #290).
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createAgent, localStatus } from './agent.mjs';
import { OPERATOR_AGENT_IDS } from './ops.mjs';
import { DEFAULT_POLICY_PATHS, readTrustedFile } from './operator-policy.mjs';
import { loadPolicyAuthority } from './operator-authority.mjs';
import { createOperatorVerifier } from './operator-signing.mjs';
import { createOperatorGuard } from './operator-guard.mjs';
import { createAuditChain, fileAuditStore, helperAuditChain } from './operator-audit.mjs';
import { createOperatorTools } from './operator-tools.mjs';
import { createOperatorWriteTools } from './operator-write.mjs';
import { createOperatorExecTools } from './operator-exec.mjs';
import { createSnapshotTool } from './operator-snapshot.mjs';
import { createMediaTool } from './operator-media.mjs';
import { createTransferSourceTools } from './operator-transfer-source.mjs';
import { createJobStore } from './operator-jobs.mjs';
import { createRootHelperClient } from './operator-root-helper.mjs';
import { createOperatorOperations } from './operator-agent.mjs';
import { createMacCheckoutAuthority } from './mac-checkout-authority.mjs';

const env = process.env;
const host = env.MEMO_OPERATOR_HOST;
const dir = env.MEMO_OPERATOR_CONFIG;
if (!['mac', 'vps'].includes(host)) throw new Error('MEMO_OPERATOR_HOST must be mac or vps');
if (!dir || !isAbsolute(dir)) throw new Error('MEMO_OPERATOR_CONFIG must be an absolute directory');
const identity = OPERATOR_AGENT_IDS[host];
const log = (event, details = {}) => console.error(JSON.stringify({ at: new Date().toISOString(), event, host: identity, ...details }));

function readSmall(path, maxBytes = 64 * 1024) {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) throw new Error('file_invalid');
    const buf = Buffer.alloc(info.size);
    let at = 0;
    while (at < info.size) { const n = readSync(fd, buf, at, info.size - at, at); if (n === 0) break; at += n; }
    return buf.subarray(0, at).toString('utf8');
  } finally { closeSync(fd); }
}

// Owner uids trusted for the policy and the hub key: root, plus the owner on the Mac, where the
// agent runs as the owner (root there goes through the separate root helper).
const trustedUids = host === 'mac' ? [0, process.getuid()] : [0];
const home = homedir();
const policyPath = env.MEMO_OPERATOR_POLICY || DEFAULT_POLICY_PATHS[host].replace(/^~/, home);
// The policy is read again before every call above T0 (issue #290): gone or changed, those refuse.
const authority = loadPolicyAuthority({ path: policyPath, expectedHost: host, trustedUids, home });
const { policy } = authority;
const hubKeys = readTrustedFile(join(dir, 'operator-hub.pub'), { trustedUids })
  .split(/(?=-----BEGIN PUBLIC KEY-----)/).map(s => s.trim()).filter(Boolean);
const verifier = createOperatorVerifier({ publicKeys: hubKeys, host });
const stateDir = env.MEMO_OPERATOR_STATE || policy.stateDir;
const guard = createOperatorGuard(policy, { autoFrozenFile: join(stateDir, 'AUTO-FROZEN'), log });
// On lab the root helper owns the journal (spec D7). On the Mac the agent appends to its own and
// the root helper (LaunchDaemon dev.memolabs.memo-operator-root, optional) keeps a second,
// root-owned chain for root calls (DEV-P6-36); T3 is forwarded only while its socket exists.
const rootHelper = policy.rootHelper ? createRootHelperClient({ socketPath: policy.rootHelper.socket, checkSocket: host === 'mac' }) : null;
const chain = rootHelper && host === 'vps' ? helperAuditChain(rootHelper) : createAuditChain({ store: fileAuditStore(policy.auditFile) });
const jobs = createJobStore({ dir: join(stateDir, 'jobs') });
const tools = { ...createOperatorTools(policy, { guard, chain }), ...createOperatorWriteTools(policy, { stateDir }),
  ...createOperatorExecTools(policy, { jobs }),
  // Repatriated from SentinelX (part 2): orientation, media, the source side of operator_transfer.
  ...createSnapshotTool(policy), ...createMediaTool(policy), ...createTransferSourceTools(policy) };
if (env.MEMO_OPERATOR_CHECKOUT_AUTHORITY && env.MEMO_OPERATOR_CHECKOUT_AUTHORITY !== 'enabled') {
  throw new Error('MEMO_OPERATOR_CHECKOUT_AUTHORITY must be enabled or unset');
}
if (env.MEMO_OPERATOR_CHECKOUT_AUTHORITY === 'enabled' && host !== 'mac') {
  throw new Error('checkout authority can only run on Mac');
}
const checkoutAuthority = env.MEMO_OPERATOR_CHECKOUT_AUTHORITY === 'enabled'
  ? createMacCheckoutAuthority({ stateDir }) : null;
const { handlers } = createOperatorOperations({ policy, verifier, guard, chain, tools, rootHelper, log, checkoutAuthority, authority });

const ca = readSmall(join(dir, 'hub-ca.crt'));
const credentialsDir = env.CREDENTIALS_DIRECTORY;
const keyFile = credentialsDir && isAbsolute(credentialsDir) && existsSync(join(credentialsDir, 'agent-key'))
  ? join(credentialsDir, 'agent-key') : join(dir, 'agent.key');
const privateKey = readSmall(keyFile, 16 * 1024);

const agent = createAgent({
  host: identity,
  url: env.MEMO_BRIDGE_AGENT_URL || 'wss://localhost:9443/agent',
  privateKey,
  ca,
  operations: {
    // The hub's liveness probe: the same fixed facts as the probe agent, under this identity.
    host_status: async () => ({ ...(await localStatus(host)), host: identity }),
    ...handlers
  },
  log: (event, h, details = {}) => log(event, details)
});
log('operator_ready', { max_tier: policy.maxTierName, ops: Object.keys(handlers).length, root_helper: Boolean(rootHelper),
  missing_roots: policy.missingRoots.length });
process.on('SIGTERM', () => { agent.stop(); process.exit(0); });
