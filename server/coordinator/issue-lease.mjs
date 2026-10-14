// Adapter to the canonical STAR Issue lease ledger (memolabs-dev/.github, scripts/issue_lease.py).
// Memo Bridge never reimplements the protocol: it runs the governance script with fixed
// arguments and no shell, and maps its JSON receipts and denials to Coordinator results.
import { spawn } from 'node:child_process';
import { constants as fsConstants, existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const ISSUE_REF_RE = /^([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,7})$/;
export const OUTCOMES = Object.freeze(['completed', 'blocked', 'failed', 'cancelled']);
export const LEASE_TTL = Object.freeze({ min: 60, max: 1800, default: 300 });
const SHA_RE = /^[0-9a-f]{40}$/;
const CLAIM_RE = /^[0-9a-f]{32}$/;
const WORKER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

// Denial messages are fixed strings written by the governance script; map the meaningful ones.
const DENIALS = [
  [/^Active lease exists/, 'lease_held'],
  [/^(Missing or superseded lease|Lease expired)/, 'stale_lease'],
  [/^(Issue changed|Post-claim preflight failed)/, 'issue_changed'],
  [/allowlist/, 'repo_not_allowed'],
  [/^Concurrent lease change/, 'lease_race_lost'],
  [/^Issue (is not open|is not explicitly agent:ready|has blocking labels|must have exactly one explicit priority)/, 'issue_not_ready'],
  [/^(GitHub API|Cannot verify GitHub)/, 'ledger_unavailable']
];

export function parseIssueRef(value) {
  const match = typeof value === 'string' ? ISSUE_REF_RE.exec(value) : null;
  return match ? { ref: value, repo: `${match[1]}/${match[2]}`, number: match[3] } : null;
}

export function defaultGovernanceRoot(env = process.env) {
  return env.MEMO_BRIDGE_GOVERNANCE_ROOT || join(homedir(), 'projects', 'memolabs-org-gh');
}

function cleanDetail(text) {
  return String(text).replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 160);
}

// Run the ledger in its own process group so a timeout kills python *and* its gh children:
// a surviving gh could otherwise complete a write after we reported failure.
function runLedger(command, args, { timeoutMs, env }) {
  return new Promise(resolve => {
    let stdout = ''; let stderr = ''; let timedOut = false; let overflow = false;
    const child = spawn(command, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const cap = 64 * 1024;
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > cap) { overflow = true; kill(); } });
    child.stderr.on('data', chunk => { if (stderr.length < cap) stderr += chunk; });
    function kill() { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: '', timedOut: false, spawnFailed: true }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut, overflow }); });
  });
}

const MUTATING = new Set(['claim', 'heartbeat', 'release']);

// ---------------------------------------------------------------------------------------------
// Credentials (Phase 4, D6). On the VPS the runner runs as memo-runner with
// LoadCredential=ledger-gh and LoadCredential=push-gh. systemd.exec(5) (systemd 257,
// LoadCredential= and $CREDENTIALS_DIRECTORY): the data is copied into a read-only per-unit
// directory exported as $CREDENTIALS_DIRECTORY, readable only by the unit's User= and root; a
// credential searched in /etc/credstore by name "is not considered fatal" when missing, so a
// missing file must be refused here. When $CREDENTIALS_DIRECTORY is set, the token is
// required: there is no fallback to an ambient gh login. On the Mac it is unset, and the
// ledger keeps using the operator's own gh login as in Phase 3.
export const LEDGER_CREDENTIAL = 'ledger-gh';
export const PUSH_CREDENTIAL = 'push-gh';
const CREDENTIAL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
// Fine-grained PATs (github_pat_...), classic (ghp_...) and installation tokens (ghs_...).
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const CREDENTIAL_MAX_BYTES = 4096;
// Variables that carry or redirect a GitHub credential; never inherited by the ledger child.
const CREDENTIAL_VARS = ['CREDENTIALS_DIRECTORY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'GIT_ASKPASS', 'SSH_ASKPASS'];

// The absolute path of credential `name` when this process runs with systemd credentials,
// else null. `name` is one of ours, never caller input.
export function credentialPath(env, name) {
  const dir = env?.CREDENTIALS_DIRECTORY;
  if (typeof dir !== 'string' || dir === '' || !CREDENTIAL_NAME_RE.test(name)) return null;
  return isAbsolute(dir) ? join(dir, name) : null;
}
export const credentialsRequired = env => typeof env?.CREDENTIALS_DIRECTORY === 'string' && env.CREDENTIALS_DIRECTORY !== '';

// Read a token file: a regular file (no symlink, no FIFO), at most 4 KiB, one token. Returns
// {token} or {error}; the error never contains the file content.
export async function readTokenFile(path) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > CREDENTIAL_MAX_BYTES) return { error: 'credential_invalid' };
    const token = (await handle.readFile('utf8')).trim();
    return TOKEN_RE.test(token) ? { token } : { error: 'credential_invalid' };
  } catch (error) {
    return { error: error?.code === 'ENOENT' ? 'credential_missing' : 'credential_unreadable' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

// A private directory for gh's configuration, created for one call and removed after it. The
// parent must be ours and closed to others (0700): it holds nothing secret, since the token
// stays in the environment, but gh must not read or write a shared configuration.
async function privateConfigDir(parent) {
  if (parent) {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const info = await lstat(parent);
    const uid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) throw new Error('scratch_not_private');
  }
  return mkdtemp(join(parent ?? tmpdir(), 'gh-'));
}

// The ledger child's environment with a token: inherited variables minus every credential
// carrier, then GH_TOKEN, a private GH_CONFIG_DIR (and HOME/XDG dirs inside it, so gh writes
// nothing elsewhere), prompts and update checks disabled. Built per call and passed only to
// the python child (and the gh it runs); the runner's own process.env is never modified.
// gh help environment (gh 2.102): GH_TOKEN takes precedence over stored credentials for
// github.com; GH_CONFIG_DIR is where gh stores configuration.
export function ledgerChildEnv(env, token, configDir) {
  const child = { ...env };
  for (const name of CREDENTIAL_VARS) delete child[name];
  return {
    ...child,
    GH_TOKEN: token,
    GH_CONFIG_DIR: configDir,
    HOME: configDir,
    XDG_CONFIG_HOME: join(configDir, 'config'),
    XDG_STATE_HOME: join(configDir, 'state'),
    XDG_DATA_HOME: join(configDir, 'data'),
    XDG_CACHE_HOME: join(configDir, 'cache'),
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1'
  };
}

// `scratchDir`: parent of the per-call gh configuration directories in credential mode (the
// runtime passes <stateDir>/ledger-gh; /tmp may be read-only under ProtectSystem=strict).
export function createIssueLeaseClient({ root = defaultGovernanceRoot(), python = 'python3', timeoutMs = 120000,
  env = process.env, run = runLedger, scratchDir = null } = {}) {
  let script = null;
  function locate() {
    if (script) return script;
    const candidate = join(root, 'scripts', 'issue_lease.py');
    if (!existsSync(candidate)) throw new Error('ledger_script_missing');
    script = realpathSync(candidate);
    return script;
  }

  async function call(action, args) {
    let path;
    try { path = locate(); } catch { return { ok: false, error: 'ledger_unavailable', detail: 'issue_lease.py not found' }; }
    // -E -s: ignore PYTHON* variables and user site-packages; the script directory stays on
    // sys.path because the ledger imports its sibling issue_preflight module.
    let childEnv = { ...env, GH_PROMPT_DISABLED: '1' };
    let configDir = null;
    if (credentialsRequired(env)) {
      const file = credentialPath(env, LEDGER_CREDENTIAL);
      const read = file ? await readTokenFile(file) : { error: 'credential_missing' };
      if (read.error) return { ok: false, error: 'ledger_unavailable', detail: `${LEDGER_CREDENTIAL} ${read.error}` };
      try { configDir = await privateConfigDir(scratchDir); } catch {
        return { ok: false, error: 'ledger_unavailable', detail: 'gh config dir unavailable' };
      }
      childEnv = ledgerChildEnv(env, read.token, configDir);
    }
    let out;
    try {
      out = await run(python, ['-E', '-s', path, action, ...args], { timeoutMs, env: childEnv });
    } finally {
      if (configDir) await rm(configDir, { recursive: true, force: true }).catch(() => {});
    }
    if (out.code === 0 && !out.overflow) {
      try { return { ok: true, receipt: JSON.parse(out.stdout) }; } catch { /* fall through */ }
    }
    const line = String(out.stderr ?? '').split('\n').find(l => l.startsWith('LEASE_DENIED: '));
    if (out.code === 2 && line) {
      const message = line.slice('LEASE_DENIED: '.length);
      const code = DENIALS.find(([rx]) => rx.test(message))?.[1] ?? 'lease_denied';
      return { ok: false, error: code, detail: cleanDetail(message) };
    }
    // A mutating call that did not finish cleanly may or may not have reached GitHub.
    const unknown = MUTATING.has(action) && !out.spawnFailed;
    return { ok: false, error: unknown ? 'ledger_outcome_unknown' : 'ledger_unavailable',
      detail: out.timedOut ? 'timeout' : out.spawnFailed ? 'cannot start python3' : `exit ${out.code}` };
  }

  const issueArgs = issue => ['--repo', issue.repo, '--issue', issue.number];
  const owner = (worker, claimId, fence) =>
    WORKER_RE.test(worker) && CLAIM_RE.test(claimId) && SHA_RE.test(fence) ? ['--worker', worker, '--claim-id', claimId, '--fence', fence] : null;
  const invalid = { ok: false, error: 'invalid_input', detail: 'ownership' };

  return {
    status: issue => call('status', issueArgs(issue)),
    claim: (issue, worker, ttl) => WORKER_RE.test(worker)
      ? call('claim', [...issueArgs(issue), '--worker', worker, '--ttl', String(ttl)]) : Promise.resolve(invalid),
    verify: (issue, worker, claimId, fence) => {
      const o = owner(worker, claimId, fence);
      return o ? call('verify', [...issueArgs(issue), ...o]) : Promise.resolve(invalid);
    },
    heartbeat: (issue, worker, claimId, fence, ttl) => {
      const o = owner(worker, claimId, fence);
      return o ? call('heartbeat', [...issueArgs(issue), ...o, '--ttl', String(ttl)]) : Promise.resolve(invalid);
    },
    release: (issue, worker, claimId, fence, outcome) => {
      const o = owner(worker, claimId, fence);
      return o ? call('release', [...issueArgs(issue), ...o, '--outcome', outcome]) : Promise.resolve(invalid);
    }
  };
}
