// Adapter to the canonical STAR Issue lease ledger (memolabs-dev/.github, scripts/issue_lease.py).
// Memo Bridge never reimplements the protocol: it runs the governance script with fixed
// arguments and no shell, and maps its JSON receipts and denials to Coordinator results.
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LEDGER_CREDENTIAL, credentialsRequired, ghChildEnv, privateConfigDir } from './credentials.mjs';
import { LEDGER_REPO, createGitHubCredentials } from '../integrations/github-app.mjs';

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
// Credentials (Phase 4, D6; GitHub App tokens). The credential files and the gh child
// environment live in credentials.mjs; the token itself comes from the GitHub credentials
// provider (server/integrations/github-app.mjs): an installation token of the memo-labs-automation
// App narrowed to memolabs-dev/.github with contents:write when the `app-key` credential and
// the App settings are present, else the `ledger-gh` fine-grained PAT, read on each call. When
// $CREDENTIALS_DIRECTORY is set a token is required: there is no fallback to an ambient gh
// login. On the Mac it is unset, and the ledger keeps using the operator's own gh login.
export {
  APP_KEY_CREDENTIAL, LEDGER_CREDENTIAL, PUSH_CREDENTIAL, credentialPath, credentialsRequired, readTokenFile
} from './credentials.mjs';
export const ledgerChildEnv = ghChildEnv;

// `scratchDir`: parent of the per-call gh configuration directories in credential mode (the
// runtime passes <stateDir>/ledger-gh; /tmp may be read-only under ProtectSystem=strict).
// `credentials`: the GitHub credentials provider (the runtime shares one); built from `env`
// when absent.
export function createIssueLeaseClient({ root = defaultGovernanceRoot(), python = 'python3', timeoutMs = 120000,
  env = process.env, run = runLedger, scratchDir = null, credentials = null } = {}) {
  const provider = credentials ?? createGitHubCredentials({ env });
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
      const read = await provider.token('ledger', LEDGER_REPO);
      if (read.error) return { ok: false, error: 'ledger_unavailable', detail: `${read.credential ?? LEDGER_CREDENTIAL} ${read.error}` };
      if (!read.token) return { ok: false, error: 'ledger_unavailable', detail: `${LEDGER_CREDENTIAL} credential_missing` };
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
