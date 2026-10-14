// Agent entry point.
//
// MEMO_BRIDGE_AGENT_MODE=probe (default): host_status only. Mac launchd agent and the legacy
//   memo-bridge-vps-agent.service. Key: $MEMO_BRIDGE_AGENT_CONFIG/agent.key, or the
//   `agent-key` credential when $CREDENTIALS_DIRECTORY is set.
// MEMO_BRIDGE_AGENT_MODE=runtime: memo-bridge-runner.service (spec D1). Hosts
//   createRuntime({host:'vps'}) and serves the runtime tools to hub principals, each request
//   on runtime.as(principalFromHub(id)). Secrets are read only from $CREDENTIALS_DIRECTORY,
//   filled by LoadCredential= in the unit:
//     agent-key   Ed25519 private key of the vps agent identity     (required, read here)
//     ledger-gh   GitHub token for the lease ledger (spec D6)        (required; checked here, read
//                 per call by the ledger client, server/coordinator/issue-lease.mjs)
//     push-gh     GitHub token for pushes (spec D6, TODO-P4-11)       (optional here)
//   lab-infra (memo-bridge-runner.service) loads the agent key as `agent.key` and points
//   MEMO_BRIDGE_AGENT_CONFIG at the credentials directory (%d); both names are accepted.
//   With MEMO_BRIDGE_JOB_EXECUTOR=systemd the job supervisor (server/runners/supervisor.mjs)
//   starts in this process: FIFO queue, admission, lease renewal, disk budget, reconcile.
//   systemd.exec(5), systemd 257 (read on the VPS, section "Credentials" and the
//   $CREDENTIALS_DIRECTORY entry): the directory is an absolute per-unit path, read-only,
//   and only accessible to the unit's UID; LoadCredential=ID with no path searches
//   /etc/credstore/, /run/credstore/, /usr/lib/credstore/ (and the .encrypted variants).
//   Exercising it on the VPS is part of the TODO-P4-01 spike (to verify there).
// $MEMO_BRIDGE_AGENT_CONFIG holds the non-secret hub-ca.crt in both modes.
// No token is ever copied into process.env or logged.
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createAgent, createRuntimeOperations, probeOperations } from './agent.mjs';

const env = process.env;
const mode = env.MEMO_BRIDGE_AGENT_MODE || 'probe';
const host = env.MEMO_BRIDGE_HOST;
const dir = env.MEMO_BRIDGE_AGENT_CONFIG;
const credentialsDir = env.CREDENTIALS_DIRECTORY;
if (!['probe', 'runtime'].includes(mode)) throw new Error('MEMO_BRIDGE_AGENT_MODE must be probe or runtime');
if (!dir || !['mac', 'vps'].includes(host)) throw new Error('Missing agent configuration');
const log = (event, details = {}) => console.error(JSON.stringify({ at: new Date().toISOString(), event, host, ...details }));

// Read one small regular file (no symlink followed); the content is never logged.
function readSmall(path, maxBytes = 16 * 1024) {
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
const credentialFile = name => (credentialsDir && isAbsolute(credentialsDir) ? join(credentialsDir, name) : null);

const ca = readSmall(join(dir, 'hub-ca.crt'), 64 * 1024);
let privateKey;
let operations = probeOperations(host);
let runtimeOps = null;
let base = null;
let supervisor = null;

if (mode === 'runtime') {
  // Phase 4 hosts the runtime on the VPS only; the Mac keeps its local stdio runtime.
  if (host !== 'vps') throw new Error('runtime mode runs on host vps only');
  if (!credentialFile('agent-key')) throw new Error('CREDENTIALS_DIRECTORY required in runtime mode');
  const keyFile = ['agent-key', 'agent.key'].map(credentialFile).find(p => existsSync(p));
  if (!keyFile) throw new Error('agent-key credential missing');
  privateKey = readSmall(keyFile);
  const { createRuntime } = await import('../server/runtime.mjs');
  const { LEDGER_CREDENTIAL, PUSH_CREDENTIAL, credentialPath, readTokenFile } = await import('../server/coordinator/issue-lease.mjs');
  // Fail fast on a missing or malformed ledger token rather than on the first claim.
  const ledger = await readTokenFile(credentialPath(env, LEDGER_CREDENTIAL));
  if (ledger.error) throw new Error(`${LEDGER_CREDENTIAL} ${ledger.error}`);
  const pushPresent = existsSync(credentialPath(env, PUSH_CREDENTIAL));
  // The ledger client reads ledger-gh per call and hands it only to its python child, with a
  // private gh configuration under the state directory (server/runtime.mjs).
  base = createRuntime({ host: 'vps' });
  runtimeOps = await createRuntimeOperations({
    runtimeFor: principal => base.as(principal),
    principalFromWire: wire => base.principalFromHub({ id: wire?.id }),
    log: (event, details) => log(event, details)
  });
  operations = { ...operations, ...runtimeOps.handlers };
  // The job supervisor (VPS, MEMO_BRIDGE_JOB_EXECUTOR=systemd); null with the local executor.
  // A misconfigured runner tree or executor throws here: the unit fails visibly (Restart=).
  const { startSupervisorFromEnv } = await import('../server/runners/supervisor.mjs');
  supervisor = await startSupervisorFromEnv(base, env, { log: (event, details = {}) => log(event, details) });
  log('runtime_ready', { ops: Object.keys(operations).length, push_credential: pushPresent,
    executor: supervisor ? 'systemd' : 'local' });
} else {
  privateKey = credentialFile('agent-key') && existsSync(credentialFile('agent-key'))
    ? readSmall(credentialFile('agent-key')) : readSmall(join(dir, 'agent.key'));
}

const agent = createAgent({
  host,
  url: env.MEMO_BRIDGE_AGENT_URL || 'wss://localhost:9443/agent',
  privateKey,
  ca,
  operations,
  log: (event, h, details = {}) => log(event, details)
});
process.on('SIGTERM', async () => {
  agent.stop();
  // Jobs are systemd units: they keep running and the next start reconciles them (REQ-P4-08).
  try { await supervisor?.stop(); await runtimeOps?.close(); await base?.close(); } catch { /* exiting */ }
  process.exit(0);
});
