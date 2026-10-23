// The local stdio process is not the launchd runtime, so it does not inherit the
// runtime's owner-policy environment. Reuse the installed Mac policy only after
// verifying that its files and LaunchAgent are owned by the current OS user.
// This never runs for remote/VPS, read-only or explicitly configured processes.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

const OWNER_KEYS = Object.freeze([
  'MEMO_BRIDGE_GOVERNANCE_ROOT',
  'MEMO_BRIDGE_REMOTE_CONFIG',
  'MEMO_BRIDGE_OWNER_SUB',
  'MEMO_BRIDGE_OWNER_PRIVATE_REPOS_FILE',
  'MEMO_BRIDGE_OWNER_EXTERNAL_PROJECTS_FILE',
  'MEMO_BRIDGE_OWNER_LEASE_KEY_FILE'
]);
const SHA = /^[0-9a-f]{40}$/;
function trustedFile(file, uid, { privateMode = true } = {}) {
  try {
    const st = lstatSync(file);
    return st.isFile() && !st.isSymbolicLink() && st.uid === uid &&
      (st.mode & (privateMode ? 0o077 : 0o022)) === 0 &&
      realpathSync(file) === file;
  } catch { return false; }
}
function trustedDirectory(dir, uid) {
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid &&
      (st.mode & 0o077) === 0 && realpathSync(dir) === dir;
  } catch { return false; }
}
function launchAgentEnv(plist) {
  return JSON.parse(execFileSync('/usr/bin/plutil',
    ['-extract', 'EnvironmentVariables', 'json', '-o', '-', plist],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 100_000 }));
}

/**
 * Fail closed and never set partial policy: a missing, stale or tampered
 * installation must behave like an unconfigured local stdio server.
 * Caller arguments cannot supply the owner identity or paths.
 */
export function bootstrapStdioMacOwnerPolicy({
  env = process.env, platformName = platform(), home = homedir(),
  uid = process.getuid?.(), readPlist = launchAgentEnv
} = {}) {
  if (platformName !== 'darwin' || typeof uid !== 'number' ||
      env.MEMO_BRIDGE_READ_ONLY === '1' || env.MEMO_BRIDGE_READ_ONLY === 'true' ||
      env.MEMO_BRIDGE_DISABLE_OWNER_AUTOLOAD === '1') return false;
  if (OWNER_KEYS.some(key => env[key] !== undefined)) return false;
  if (env.MEMOLABS_ROOT && resolve(env.MEMOLABS_ROOT) !== join(home, 'memolabs')) return false;
  const base = join(home, '.local', 'share', 'memo-bridge');
  const dir = join(base, 'owner-policy');
  const policyFile = join(dir, 'private-repos.json');
  const remoteFile = join(dir, 'remote.json');
  const externalFile = join(dir, 'external-projects.json');
  const leaseKey = join(dir, 'lease-key.json');
  const plist = join(home, 'Library', 'LaunchAgents', 'dev.memolabs.memo-bridge-agent.plist');
  if (!trustedDirectory(dir, uid) ||
      ![policyFile, remoteFile, externalFile, leaseKey].every(file => trustedFile(file, uid)) ||
      !trustedFile(plist, uid, { privateMode: false })) return false;
  try {
    const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
    const remote = JSON.parse(readFileSync(remoteFile, 'utf8'));
    const saved = readPlist(plist);
    if (policy.schema !== 'memolabs.owner-private-repos.v1' ||
        typeof policy.owner_sub !== 'string' ||
        policy.owner_sub !== remote?.oidc?.owner_sub ||
        saved?.MEMO_BRIDGE_OWNER_SUB !== policy.owner_sub ||
        saved?.MEMO_BRIDGE_AGENT_MODE !== 'runtime' ||
        saved?.MEMO_BRIDGE_MAC_RUNTIME_ENABLED !== 'enabled') return false;
    const expected = {
      MEMO_BRIDGE_REMOTE_CONFIG: remoteFile,
      MEMO_BRIDGE_OWNER_PRIVATE_REPOS_FILE: policyFile,
      MEMO_BRIDGE_OWNER_EXTERNAL_PROJECTS_FILE: externalFile,
      MEMO_BRIDGE_OWNER_LEASE_KEY_FILE: leaseKey
    };
    if (Object.entries(expected).some(([key,value]) => saved[key] !== value)) return false;
    const governance = saved.MEMO_BRIDGE_GOVERNANCE_ROOT;
    const prefix = join(base, 'governance') + sep;
    if (typeof governance !== 'string' || !isAbsolute(governance) ||
        !governance.startsWith(prefix) || !SHA.test(governance.slice(prefix.length)) ||
        !trustedFile(join(governance, 'scripts', 'issue_lease.py'), uid, {privateMode: false}) ||
        !trustedFile(join(governance, 'scripts', 'private_owner_allowlist.py'), uid, {privateMode: false}) ||
        !readFileSync(join(governance, 'scripts', 'private_owner_allowlist.py'), 'utf8').includes('getpwuid'))
      return false;
    // Commit the complete verified snapshot, never copy secrets from the plist.
    Object.assign(env, expected, {
      MEMO_BRIDGE_OWNER_SUB: policy.owner_sub,
      MEMO_BRIDGE_GOVERNANCE_ROOT: governance
    });
    return true;
  } catch { return false; }
}
