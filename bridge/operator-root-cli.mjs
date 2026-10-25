// Root helper entry point (Phase 6, TODO-P6-10): memo-operator-root.service on lab, as root.
// lab-infra (TODO-P6-12) provides the unit, RuntimeDirectory=memo-operator (root:memo-operator,
// 0750) for the socket, StateDirectory=memo-operator-root for scripts and root jobs, and
// /var/log/memo-operator (root, 0700) for the journal.
//
// Environment:
//   MEMO_OPERATOR_POLICY   policy file (default /etc/memo-operator/policy.json); host vps,
//                          max_tier root, root_helper.socket set
//   MEMO_OPERATOR_CONFIG   directory holding operator-hub.pub (the hub's operator public key)
//   MEMO_OPERATOR_ROOT_STATE  root-only state directory (default /var/lib/memo-operator-root)
// The policy and the key pass the same trust check as on the agent (owner root, not writable by
// group or other). Anything wrong stops the process before the socket exists.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DEFAULT_POLICY_PATHS, readTrustedFile } from './operator-policy.mjs';
import { loadPolicyAuthority } from './operator-authority.mjs';
import { createOperatorVerifier } from './operator-signing.mjs';
import { createOperatorGuard } from './operator-guard.mjs';
import { createAuditChain, fileAuditStore } from './operator-audit.mjs';
import { createJobStore } from './operator-jobs.mjs';
import { createRootHelper, createRootHelperServer } from './operator-root-helper.mjs';

const env = process.env;
if (process.getuid() !== 0) throw new Error('the root helper runs as root');
const log = (event, details = {}) => console.error(JSON.stringify({ at: new Date().toISOString(), event, host: 'operator-root', ...details }));
const authority = loadPolicyAuthority({ path: env.MEMO_OPERATOR_POLICY || DEFAULT_POLICY_PATHS.vps, expectedHost: 'vps', trustedUids: [0] });
const { policy } = authority;
if (policy.maxTierName !== 'root' || !policy.rootHelper) throw new Error('policy does not grant root (max_tier root and root_helper.socket required)');
const dir = env.MEMO_OPERATOR_CONFIG || '/etc/memo-operator';
const hubKeys = readTrustedFile(join(dir, 'operator-hub.pub'), { trustedUids: [0] })
  .split(/(?=-----BEGIN PUBLIC KEY-----)/).map(s => s.trim()).filter(Boolean);
const state = env.MEMO_OPERATOR_ROOT_STATE || '/var/lib/memo-operator-root';
mkdirSync(state, { recursive: true, mode: 0o700 });
const helper = createRootHelper({
  policy,
  verifier: createOperatorVerifier({ publicKeys: hubKeys, host: 'vps' }),
  guard: createOperatorGuard(policy, { autoFrozenFile: join(state, 'AUTO-FROZEN'), log }),
  chain: createAuditChain({ store: fileAuditStore(policy.auditFile) }),
  jobs: createJobStore({ dir: join(state, 'jobs'), prefix: 'rj' }),
  scriptDir: join(state, 'scripts'),
  authority,
  log
});
const server = createRootHelperServer({ helper, socketPath: policy.rootHelper.socket, log });
await server.start();
log('root_helper_ready', { socket: policy.rootHelper.socket });
process.on('SIGTERM', async () => { await server.stop(); process.exit(0); });
