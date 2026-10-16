// Authenticated GitHub -> Source Engine observation import.
// This does not merge, approve, or promote any PR. Only already tracked changes are reconciled.
import { recordSourceChange } from './changes.mjs';
import { parseRepo } from '../integrations/github.mjs';

const SHA = /^[0-9a-f]{40}$/;
const MAX = 30;
const fields = ['pr_number', 'head_sha', 'base_sha', 'ci_state', 'landing_state'];
const allowedConclusions = new Set(['success', 'neutral', 'skipped']);

export function observedCi(checks) {
  if (!checks?.ok || !checks.summary || !Array.isArray(checks.check_runs) || !Array.isArray(checks.statuses)) return 'unknown';
  // The GitHub adapter returns at most 100 checks/statuses, so a full page is inconclusive.
  if (checks.check_runs.length >= 100 || checks.statuses.length >= 100) return 'unknown';
  const runs = checks.check_runs;
  const statuses = checks.statuses;
  if (!runs.length && !statuses.length) return 'unknown';
  if (runs.some(r => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(r.conclusion)) ||
      statuses.some(s => ['failure', 'error'].includes(s.state))) return 'failed';
  if (runs.some(r => r.status !== 'completed') || statuses.some(s => s.state === 'pending')) return 'pending';
  if (runs.some(r => !allowedConclusions.has(r.conclusion)) ||
      statuses.some(s => s.state !== 'success')) return 'unknown';
  if (runs.length && checks.summary.check_runs !== runs.length) return 'unknown';
  return 'success';
}

function verifiedPull(p, origin, row) {
  if (!p || !Number.isSafeInteger(p.number) || p.number < 1 ||
      p.head_repo_full_name?.toLowerCase() !== origin.toLowerCase() ||
      typeof p.head !== 'string' || p.head !== row.branch ||
      !SHA.test(p.head_sha ?? '')) return false;
  return row.pr_number == null || row.pr_number === p.number;
}

const equalsPatch = (row, patch) => fields.every(k => patch[k] === row[k]);

// A bounded, scoped reconciliation pass. All GitHub reads finish before the first local write.
// Missing/partial GitHub pages never imply PR closure, a green CI, or permission to merge.
export async function reconcileSourceProject({ store, github, project, origin, now = Date.now, limit = MAX }) {
  if (typeof project !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(project) ||
      !parseRepo(origin) || !Number.isInteger(limit) || limit < 1 || limit > MAX) {
    return { ok: false, error: 'invalid_input' };
  }
  const resolved = await github.resolveRepo(origin);
  if (!resolved?.ok || resolved.repo?.full?.toLowerCase() !== origin.toLowerCase()) {
    return { ok: false, error: 'repo_not_registered' };
  }
  const rows = await store.transaction(repo => repo.listSourceChanges({ project_id: project, limit, offset: 0 }),
    { write: false });
  const safe = rows.filter(r => r.issue_ref?.split('#')[0]?.toLowerCase() === origin.toLowerCase());
  const prs = await github.pullRequests(resolved.repo, { state: 'all', limit: 100 });
  if (!prs?.ok || !Array.isArray(prs.pull_requests)) {
    return { ok: false, error: 'github_unavailable', observed: 0, committed: 0 };
  }
  const pulls = prs.pull_requests;
  const decisions = [];
  const candidates = [];
  for (const row of safe) {
    const matches = pulls.filter(p => verifiedPull(p, origin, row));
    if (matches.length !== 1) {
      decisions.push({ id: row.id, result: matches.length ? 'ambiguous_pr' : 'pr_not_verified' });
      continue;
    }
    const pr = matches[0];
    if (row.landing_state === 'landed') {
      decisions.push({ id: row.id, result: 'terminal_observation' });
      continue;
    }
    // Check status must correspond to the *exact* reviewed head SHA.
    let ci = 'unknown';
    let reason = 'ci_unavailable';
    const checks = await github.checks(resolved.repo, pr.head_sha);
    if (checks?.ok && checks.sha === pr.head_sha) {
      ci = observedCi(checks);
      reason = 'observed';
    } else if (checks?.ok) {
      reason = 'stale_checks_sha';
    }
    const moved = row.head_sha !== null && row.head_sha !== pr.head_sha;
    // A merged PR is a terminal, verified remote fact. A closed PR is not a merge.
    const landing = pr.state === 'merged' ? 'landed'
      : pr.state === 'closed' ? 'closed'
      : moved ? 'blocked'
      : row.landing_state === 'blocked' ? 'blocked'
      : 'open';
    // Existing base is kept, unless trusted upstream explicitly exposes a different target SHA.
    const patch = {
      pr_number: pr.number,
      head_sha: pr.head_sha,
      base_sha: SHA.test(pr.base_sha ?? '') ? pr.base_sha : row.base_sha,
      ci_state: ci,
      landing_state: landing
    };
    if (equalsPatch(row, patch)) {
      decisions.push({ id: row.id, result: 'unchanged', pr_number: pr.number });
      continue;
    }
    candidates.push({ row, patch, pr, moved, reason });
  }
  for (const item of candidates) {
    const { row, patch, pr, moved, reason } = item;
    const updated = await recordSourceChange(store, {
      id: row.id, patch, expected_revision: row.revision, observed_at: Math.max(now(), (row.source_at ?? 0) + 1)
    });
    decisions.push({ id: row.id, result: updated.ok ? 'recorded' : updated.error,
      pr_number: pr.number, head_moved: moved, ci_evidence: reason });
  }
  return { ok: true, project, origin, fetched_prs: pulls.length,
    records_examined: rows.length, matched: candidates.length,
    committed: decisions.filter(d => d.result === 'recorded').length,
    decisions, truncated: rows.length === limit || pulls.length === 100,
    merge_performed: false,
    limitations: ['Only previously registered Source Engine changes with same-repo PR evidence are imported.',
      'No missing PR is assumed closed or merged; partial GitHub pages are inconclusive.',
      'This observation is never a substitute for required checks, review or branch-protection verification.'] };
}
