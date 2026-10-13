// Adapter to the canonical STAR Issue lease ledger (memolabs-dev/.github, scripts/issue_lease.py).
// Memo Bridge never reimplements the protocol: it runs the governance script with fixed
// arguments and no shell, and maps its JSON receipts and denials to Coordinator results.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ISSUE_REF_RE = /^([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,8})$/;
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

export function createIssueLeaseClient({ root = defaultGovernanceRoot(), python = 'python3', timeoutMs = 90000, run = execFile,
  env = process.env } = {}) {
  let script = null;
  function locate() {
    if (script) return script;
    const candidate = join(root, 'scripts', 'issue_lease.py');
    if (!existsSync(candidate)) throw new Error('ledger_script_missing');
    script = realpathSync(candidate);
    return script;
  }

  function call(action, args) {
    let path;
    try { path = locate(); } catch { return Promise.resolve({ ok: false, error: 'ledger_unavailable', detail: 'issue_lease.py not found' }); }
    // -E -s: ignore PYTHON* variables and user site-packages; the script directory stays on
    // sys.path because the ledger imports its sibling issue_preflight module.
    return new Promise(resolve => {
      run(python, ['-E', '-s', path, action, ...args], {
        timeout: timeoutMs, maxBuffer: 64 * 1024, env: { ...env, GH_PROMPT_DISABLED: '1' }
      }, (error, stdout, stderr) => {
        if (!error) {
          try { return resolve({ ok: true, receipt: JSON.parse(stdout) }); } catch {
            return resolve({ ok: false, error: 'ledger_unavailable', detail: 'malformed ledger output' });
          }
        }
        const line = String(stderr ?? '').split('\n').find(l => l.startsWith('LEASE_DENIED: '));
        if (error.code === 2 && line) {
          const message = line.slice('LEASE_DENIED: '.length);
          const code = DENIALS.find(([rx]) => rx.test(message))?.[1] ?? 'lease_denied';
          return resolve({ ok: false, error: code, detail: cleanDetail(message) });
        }
        resolve({ ok: false, error: 'ledger_unavailable', detail: error.killed ? 'timeout' : `exit ${error.code ?? 'unknown'}` });
      });
    });
  }

  const issueArgs = issue => ['--repo', issue.repo, '--issue', issue.number];
  const ownerArgs = (worker, claimId, fence) => {
    if (!WORKER_RE.test(worker) || !CLAIM_RE.test(claimId) || !SHA_RE.test(fence)) throw new Error('invalid_ownership');
    return ['--worker', worker, '--claim-id', claimId, '--fence', fence];
  };

  return {
    status: issue => call('status', issueArgs(issue)),
    claim: (issue, worker, ttl) => call('claim', [...issueArgs(issue), '--worker', worker, '--ttl', String(ttl)]),
    verify: (issue, worker, claimId, fence) => call('verify', [...issueArgs(issue), ...ownerArgs(worker, claimId, fence)]),
    heartbeat: (issue, worker, claimId, fence, ttl) =>
      call('heartbeat', [...issueArgs(issue), ...ownerArgs(worker, claimId, fence), '--ttl', String(ttl)]),
    release: (issue, worker, claimId, fence, outcome) =>
      call('release', [...issueArgs(issue), ...ownerArgs(worker, claimId, fence), '--outcome', outcome])
  };
}
