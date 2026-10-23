// Root helper on the Mac (owner decision 2026-10-14, spec §13 Mac root follow-up, DEV-P6-32 to 39).
//
// The LaunchDaemon dev.memolabs.memo-operator-root runs bridge/operator-root-mac-cli.mjs as root,
// from a root-owned copy installed by deploy/mac/install-operator-root.sh:
//   /Library/Application Support/MemoBridge/operator-root/     root:wheel 0755, never the owner's home
//     bin/node                       0555  a copy of an official node (system libraries only)
//     bridge/operator-root-mac-cli.mjs, bridge/operator-job-supervisor.mjs, package.json   0444
//     policy.json                    0444  host mac, max_tier root, approval_mode off (owner decision 2026-10-23)
//     operator-hub.pub               0444  the hub's operator signing key (copy)
//     FROZEN                               created by the owner (sudo touch) to freeze root calls
//   /var/run/memo-operator/root.sock       directory root:wheel 0755 made at each start (/var/run
//                                          is emptied at boot); socket owned by the agent user, 0600
//   /var/log/memo-operator/audit.jsonl     root 0600, the helper's hash-chained journal
//   /var/db/memo-operator-root/            root 0700: scripts, background root runs, AUTO-FROZEN
// It also refuses every call while the owner's ~/.memo-operator/FROZEN exists.
//
// startMacRootHelper does every check before the socket exists and throws on the first problem
// (launchd then retries, ThrottleInterval 30 s). uid, trusted uids and paths are injectable so the
// tests run it in a temporary directory without root.
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { loadOperatorPolicy, readTrustedFile } from './operator-policy.mjs';
import { createOperatorVerifier } from './operator-signing.mjs';
import { createOperatorGuard } from './operator-guard.mjs';
import { createAuditChain, fileAuditStore } from './operator-audit.mjs';
import { createJobStore } from './operator-jobs.mjs';
import { createRootHelper, createRootHelperServer } from './operator-root-helper.mjs';

export const MAC_ROOT_LABEL = 'dev.memolabs.memo-operator-root';
export const MAC_ROOT_DIR = '/Library/Application Support/MemoBridge/operator-root';

// Every path the Mac root helper uses. dir is injectable for the tests only.
export function macRootLayout(dir = MAC_ROOT_DIR) {
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Error('root_dir_not_absolute');
  return Object.freeze({
    label: MAC_ROOT_LABEL,
    parent: dirname(dir),
    dir,
    node: join(dir, 'bin', 'node'),
    script: join(dir, 'bridge', 'operator-root-mac-cli.mjs'),
    supervisor: join(dir, 'bridge', 'operator-job-supervisor.mjs'),
    packageJson: join(dir, 'package.json'),
    policy: join(dir, 'policy.json'),
    hubPub: join(dir, 'operator-hub.pub'),
    frozen: join(dir, 'FROZEN'),
    socketDir: '/var/run/memo-operator',
    socket: '/var/run/memo-operator/root.sock',
    logDir: '/var/log/memo-operator',
    audit: '/var/log/memo-operator/audit.jsonl',
    helperLog: '/var/log/memo-operator/helper.log',
    stateDir: '/var/db/memo-operator-root',
    plist: `/Library/LaunchDaemons/${MAC_ROOT_LABEL}.plist`
  });
}

// A path the root helper trusts: it and every directory above it (after symlinks are resolved,
// /var is /private/var) owned by a trusted uid and writable by neither group nor other. Otherwise
// someone else could rename a parent and swap the code or the policy under root. Returns null or
// a short code naming the first bad path.
export function untrustedAncestor(path, { trustedUids = [0], lstat = lstatSync, realpath = realpathSync.native } = {}) {
  let at;
  try { at = realpath(path); } catch { return `missing:${path}`; }
  for (;;) {
    let info;
    try { info = lstat(at); } catch { return `missing:${at}`; }
    if (info.isSymbolicLink()) return `symlink:${at}`;
    if (!trustedUids.includes(info.uid)) return `owner_untrusted:${at}`;
    if ((info.mode & 0o022) !== 0) return `writable_by_others:${at}`;
    if (at === sep) return null;
    at = dirname(at);
  }
}

// A directory the helper creates or keeps (state, journal, socket): a real directory, owned by a
// trusted uid, mode forced to `mode`.
function ownDir(path, mode, trustedUids) {
  mkdirSync(path, { recursive: true, mode });
  const info = lstatSync(path);
  if (!info.isDirectory()) throw new Error(`not_a_directory:${path}`);
  if (!trustedUids.includes(info.uid)) throw new Error(`owner_untrusted:${path}`);
  if ((info.mode & 0o7777) !== mode) chmodSync(path, mode);
}

const positiveId = value => /^[1-9][0-9]{0,9}$/.test(String(value ?? '')) ? Number(value) : null;

// env (the plist's EnvironmentVariables):
//   MEMO_OPERATOR_ROOT_DIR      the root-owned directory (default MAC_ROOT_DIR)
//   MEMO_OPERATOR_AGENT_UID     uid and gid the socket is handed to (the operator agent's user,
//   MEMO_OPERATOR_AGENT_GID     memo); never 0
//   MEMO_OPERATOR_USER_FROZEN   the owner's FROZEN switch, ~/.memo-operator/FROZEN, absolute
// Options (tests): getuid, trustedUids, execPath and scriptPath (must sit in the root directory),
// check (validate and return, no socket), log.
export async function startMacRootHelper({ env = process.env, getuid = () => process.getuid(), trustedUids = [0],
  execPath = process.execPath, scriptPath = process.argv[1], check = false, log = () => {}, executor } = {}) {
  if (getuid() !== 0) throw new Error('the Mac root helper runs as root');
  const L = macRootLayout(env.MEMO_OPERATOR_ROOT_DIR || MAC_ROOT_DIR);
  const bad = untrustedAncestor(L.dir, { trustedUids });
  if (bad) throw new Error(`root_dir_untrusted:${bad}`);
  // The program launchd runs and the code it loads must be the root-owned copies.
  const inside = path => { try { return realpathSync.native(path).startsWith(realpathSync.native(L.dir) + sep); } catch { return false; } };
  for (const [name, path] of [['node', execPath], ['script', scriptPath]]) {
    if (!inside(path)) throw new Error(`${name}_outside_root_dir`);
    const problem = untrustedAncestor(path, { trustedUids });
    if (problem) throw new Error(`${name}_untrusted:${problem}`);
  }
  const policy = loadOperatorPolicy({ path: L.policy, expectedHost: 'mac', agentUid: getuid(), trustedUids });
  if (policy.maxTierName !== 'root' || !policy.rootHelper) throw new Error('policy does not grant root (max_tier root and root_helper.socket required)');
  // The root FROZEN switch sits in the root-owned directory: only root creates or removes it.
  if (dirname(policy.frozenFile) !== L.dir) throw new Error('frozen_file_outside_root_dir');
  const hubKeys = readTrustedFile(L.hubPub, { agentUid: getuid(), trustedUids })
    .split(/(?=-----BEGIN PUBLIC KEY-----)/).map(s => s.trim()).filter(Boolean);
  const uid = positiveId(env.MEMO_OPERATOR_AGENT_UID);
  const gid = positiveId(env.MEMO_OPERATOR_AGENT_GID);
  if (uid === null || gid === null) throw new Error('MEMO_OPERATOR_AGENT_UID and MEMO_OPERATOR_AGENT_GID must name the agent user (not root)');
  const userFrozen = env.MEMO_OPERATOR_USER_FROZEN;
  if (typeof userFrozen !== 'string' || !isAbsolute(userFrozen)) throw new Error('MEMO_OPERATOR_USER_FROZEN must be absolute');

  const logDir = dirname(policy.auditFile);
  ownDir(policy.stateDir, 0o700, trustedUids);
  ownDir(logDir, 0o700, trustedUids);
  for (const path of [policy.stateDir, logDir]) {
    const problem = untrustedAncestor(path, { trustedUids });
    if (problem) throw new Error(`state_untrusted:${problem}`);
  }
  try {
    const info = lstatSync(policy.auditFile);
    if (!info.isFile()) throw new Error('audit_file_not_regular');
    if ((info.mode & 0o777) !== 0o600) chmodSync(policy.auditFile, 0o600);
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  // The socket directory: /var/run is root:daemon 0775 and emptied at boot, so it is made here.
  const socketDir = dirname(policy.rootHelper.socket);
  ownDir(socketDir, 0o755, trustedUids);

  const guard = createOperatorGuard(policy, { autoFrozenFile: join(policy.stateDir, 'AUTO-FROZEN'), extraFrozenFiles: [userFrozen], log });
  const helper = createRootHelper({
    policy,
    verifier: createOperatorVerifier({ publicKeys: hubKeys, host: 'mac' }),
    guard,
    chain: createAuditChain({ store: fileAuditStore(policy.auditFile) }),
    jobs: createJobStore({ dir: join(policy.stateDir, 'jobs'), prefix: 'rj' }),
    scriptDir: join(policy.stateDir, 'scripts'),
    ...(executor ? { executor } : {}),
    log
  });
  const summary = { ok: true, label: L.label, dir: L.dir, socket: policy.rootHelper.socket, socket_owner: { uid, gid }, audit: policy.auditFile,
    state: policy.stateDir, approval_mode: policy.approvalMode, frozen: guard.status(), hub_keys: hubKeys.length };
  if (check) return { summary, helper, guard, policy };
  const server = createRootHelperServer({ helper, socketPath: policy.rootHelper.socket, mode: 0o600, owner: { uid, gid }, log });
  await server.start();
  return { summary, helper, guard, policy, server };
}
