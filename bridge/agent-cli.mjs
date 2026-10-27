// Agent entry point.
//
// MEMO_BRIDGE_AGENT_MODE=probe (default): host_status only. Mac launchd agent and the legacy
//   memo-bridge-vps-agent.service. Key: $MEMO_BRIDGE_AGENT_CONFIG/agent.key, or the
//   `agent-key` credential when $CREDENTIALS_DIRECTORY is set.
// MEMO_BRIDGE_AGENT_MODE=runtime: memo-bridge-runner.service (spec D1). Hosts
//   createRuntime({host}) and serves the runtime tools to hub principals, each request
//   on runtime.as(principalFromHub(id)). Secrets are read only from $CREDENTIALS_DIRECTORY,
//   filled by LoadCredential= in the unit:
//     agent-key   Ed25519 private key of the vps agent identity     (required, read here)
//     app-key     PEM private key of the GitHub App memo-labs-automation (optional). With the
//                 App settings MEMO_BRIDGE_GITHUB_APP_ID and MEMO_BRIDGE_GITHUB_APP_INSTALLATION_ID
//                 (environment, not secret) it replaces both PATs: the runtime mints installation
//                 tokens narrowed to one repository and the minimal permissions, on demand
//                 (server/integrations/github-app.mjs)
//     ledger-gh   GitHub token for the lease ledger (spec D6)        (fallback PAT; required when
//                 the App is not configured, read per call by server/coordinator/issue-lease.mjs)
//     push-gh     GitHub token for pushes (spec D6, TODO-P4-11)       (fallback PAT, optional)
//   Startup requires either a usable app-key with valid App settings, or a valid ledger-gh.
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
import { createAgent, createRuntimeOperations, probeOperations, wireClaim } from './agent.mjs';
import { executableRuntimeHost } from './runtime-placement.mjs';
import { closeRuntimeAgent } from './runtime-agent-shutdown.mjs';

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
  // Mac runtime is an explicit opt-in and uses the same credential, policy and lease gates.
  // Merely seeing a Mac project in the discovery snapshot NEVER turns this on.
  executableRuntimeHost(host, env);
  if (!credentialFile('agent-key')) throw new Error('CREDENTIALS_DIRECTORY required in runtime mode');
  const keyFile = ['agent-key', 'agent.key'].map(credentialFile).find(p => existsSync(p));
  if (!keyFile) throw new Error('agent-key credential missing');
  privateKey = readSmall(keyFile);
  const { createRuntime } = await import('../server/runtime.mjs');
  const { LEDGER_CREDENTIAL, readTokenFile, credentialPath } = await import('../server/coordinator/credentials.mjs');
  const { createGitHubCredentials } = await import('../server/integrations/github-app.mjs');
  // GitHub credentials: the App when app-key and its settings are present, else the PATs.
  // Checked offline here (no network): fail fast rather than on the first claim.
  const githubCredentials = createGitHubCredentials({ env, log: (event, details) => log(event, details) });
  const github = await githubCredentials.startupCheck();
  if (github.ledger === 'missing') {
    if (!['absent', 'configured'].includes(github.app)) throw new Error(`app-key ${github.app}`);
    const ledger = await readTokenFile(credentialPath(env, LEDGER_CREDENTIAL));
    throw new Error(`${LEDGER_CREDENTIAL} ${ledger.error ?? 'credential_missing'}`);
  }
  if (!['absent', 'configured'].includes(github.app)) log('github_app_unusable', { code: github.app, fallback: 'pat' });
  const pushPresent = github.push !== 'missing';
  // The ledger client gets its token per call and hands it only to its python child, with a
  // private gh configuration under the state directory (server/runtime.mjs).
  base = createRuntime({ host, githubCredentials });
  if (host === 'mac') {
    const { startOwnerRegistryReconciler } = await import('../server/projects/reconcile-owner-registry.mjs');
    const reconciler = startOwnerRegistryReconciler({ env, host, log });
    base.onShutdown(() => reconciler.close());
    void reconciler.run();
  }
  runtimeOps = await createRuntimeOperations({
    runtimeFor: principal => base.as(principal),
    principalFromWire: wire => base.principalFromHub(wireClaim(wire)),
    log: (event, details) => log(event, details)
  });
  operations = { ...operations, ...runtimeOps.handlers };
  // The job supervisor (VPS, MEMO_BRIDGE_JOB_EXECUTOR=systemd); null with the local executor.
  // A misconfigured runner tree or executor throws here: the unit fails visibly (Restart=).
  const { startSupervisorFromEnv } = await import('../server/runners/supervisor.mjs');
  supervisor = await startSupervisorFromEnv(base, env, { log: (event, details = {}) => log(event, details) });
  log('runtime_ready', { ops: Object.keys(operations).length, push_credential: pushPresent,
    github_auth: { app: github.app, ledger: github.ledger, push: github.push },
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
let shuttingDown=false;
process.on('SIGTERM', () => {
  if(shuttingDown)return;
  shuttingDown=true;
  // Jobs are systemd units: they keep running and the next start reconciles them (REQ-P4-08).
  // The runtime's onShutdown hooks own local ACP children: always run them
  // even if stopping the unrelated job supervisor fails.
  void closeRuntimeAgent({agent,supervisor,runtimeOps,base}).then(
    outcome => process.exit(outcome.ok ? 0 : 1), () => process.exit(1)
  );
});
