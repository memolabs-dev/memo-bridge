// Source Engine periodic observation: opt-in, origin-scoped, no GitHub mutations.
// A new PR is discovered ONLY when independent Coordinator checkpoints attest the
// exact issue, branch and pushed SHA. Untrusted PR text never supplies identity.
import { createHash } from 'node:crypto';
import { recordSourceChange } from './changes.mjs';
import { reconcileSourceProject } from './reconcile.mjs';
import { parseRepo } from '../integrations/github.mjs';

const SHA = /^[a-f0-9]{40}$/;
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const ISSUE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]{0,8}$/;
const MAX_PROJECTS = 8;
const MAX_PRS = 40;
const MAX_WORKTREES = 100;
const MAX_CHANGES = 500;
const activeStores = new WeakSet();

export function validatePollPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
      !Array.isArray(policy.projects) || policy.projects.length < 1 ||
      policy.projects.length > MAX_PROJECTS ||
      !policy.projects.every(p => typeof p === 'string' && PROJECT.test(p)) ||
      new Set(policy.projects).size !== policy.projects.length ||
      !Array.isArray(policy.trustedAuthors) || policy.trustedAuthors.length < 1 ||
      policy.trustedAuthors.length > 8 || !policy.trustedAuthors.every(a =>
        typeof a === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\[bot\])?$/.test(a) && a.length <= 80) ||
      new Set(policy.trustedAuthors).size !== policy.trustedAuthors.length ||
      (policy.enabled !== true && policy.enabled !== false) ||
      (policy.apply !== true && policy.apply !== false)) {
    return { ok: false, error: 'invalid_policy' };
  }
  return { ok: true, policy: {
    enabled: policy.enabled, apply: policy.apply,
    projects: [...policy.projects], trustedAuthors: [...policy.trustedAuthors]
  } };
}

function sameIssueOrigin(issue, origin) {
  return typeof issue === 'string' && ISSUE.test(issue) &&
    issue.split('#')[0].toLowerCase() === origin.toLowerCase();
}

export function sourceIdForPull(origin, number) {
  // Small stable id, never derived from PR text. Repeated discovery yields the same id.
  return 'gh.' + createHash('sha256').update(origin.toLowerCase() + '#' + number).digest('hex').slice(0, 32);
}

function trustedCheckpoint(worktree, pull, repo, checkpoints, defaultBranch, authors) {
  if (!worktree || !sameIssueOrigin(worktree.issue_ref, repo) ||
      !Number.isInteger(pull?.number) || pull.number < 1 ||
      pull.head_repo_full_name?.toLowerCase() !== repo.toLowerCase() ||
      pull.head !== worktree.branch || pull.base !== defaultBranch ||
      !SHA.test(pull.head_sha ?? '') || !authors.has(pull.author) ||
      !['open', 'merged', 'closed'].includes(pull.state)) return false;
  // Durable remote proof from *our* Coordinator. A PR closing keyword is insufficient.
  return checkpoints.some(c => c.issue_ref === worktree.issue_ref &&
    c.workspace_id === worktree.workspace_id &&
    c.branch === worktree.branch && c.durability === 'remote' &&
    c.commit_sha === pull.head_sha);
}

async function trackedChanges(store, project, max = MAX_CHANGES) {
  const changes = [];
  for (let offset = 0; offset < max; offset += 100) {
    const page = await store.transaction(repo =>
      repo.listSourceChanges({ project_id: project, limit: 100, offset }), { write: false });
    changes.push(...page);
    if (page.length < 100) return { changes, truncated: false };
  }
  return { changes, truncated: true };
}

export async function discoverSourceChanges({ store, github, project, origin,
  trustedAuthors, dryRun = true, now = Date.now } = {}) {
  if (!PROJECT.test(project ?? '') || !parseRepo(origin) ||
      !Array.isArray(trustedAuthors) || !trustedAuthors.length) {
    return { ok: false, error: 'invalid_input' };
  }
  const repo = await github.resolveRepo(origin);
  if (!repo?.ok || repo.repo?.full?.toLowerCase() !== origin.toLowerCase()) {
    return { ok: false, error: 'repo_not_registered' };
  }
  // All required network reads complete before writing ANY changes; failure is atomic for
  // this project's discovery pass. Insufficient data never means "no PRs".
  const [pulls, base] = await Promise.all([
    github.pullRequests(repo.repo, { state: 'all', limit: MAX_PRS }),
    github.defaultBranch(repo.repo)
  ]);
  if (!pulls?.ok || !Array.isArray(pulls.pull_requests) || !base?.ok ||
      typeof base.branch !== 'string') return { ok: false, error: 'github_unavailable' };
  const { changes, truncated } = await trackedChanges(store, project);
  if (truncated) return { ok: false, error: 'source_page_limit' };
  const worktrees = await store.transaction(db =>
    db.listWorktrees({ project_id: project, limit: MAX_WORKTREES }), { write: false });
  if (!Array.isArray(worktrees) || worktrees.length === MAX_WORKTREES) {
    // Cannot prove exhaustivity when our local Coordinator workspace history is truncated.
    return { ok: false, error: 'worktree_page_limit' };
  }
  const authors = new Set(trustedAuthors);
  const planned = [], decisions = [];
  for (const pull of pulls.pull_requests) {
    if (changes.some(c => c.pr_number === pull.number && sameIssueOrigin(c.issue_ref, origin))) {
      decisions.push({ pr_number: pull.number, status: 'already_tracked' });
      continue;
    }
    const candidates = [];
    for (const wt of worktrees) {
      if (!sameIssueOrigin(wt.issue_ref, origin) || pull.head !== wt.branch) continue;
      const checkpoints = await store.transaction(db => db.listCheckpoints(wt.issue_ref, 10), { write: false });
      if (trustedCheckpoint(wt, pull, origin, checkpoints, base.branch, authors)) candidates.push(wt);
    }
    if (candidates.length !== 1) {
      decisions.push({ pr_number: pull.number, status: candidates.length ? 'ambiguous_identity' : 'identity_unverified' });
      continue;
    }
    const wt = candidates[0], id = sourceIdForPull(origin, pull.number);
    // A collision with a separately tracked change is never overwritten.
    if (changes.some(c => c.id === id)) {
      decisions.push({ pr_number: pull.number, status: 'existing_change_id' });
      continue;
    }
    planned.push({ id, issue_ref: wt.issue_ref, branch: wt.branch, worktree_id: wt.id,
      pr_number: pull.number, head_sha: pull.head_sha,
      base_sha: SHA.test(pull.base_sha ?? '') ? pull.base_sha : null });
  }
  if (dryRun) return { ok: true, project, dry_run: true, candidates: planned.length,
    recorded: 0, decisions: decisions.concat(planned.map(p => ({ pr_number: p.pr_number, status: 'would_record' }))),
    truncated: pulls.pull_requests.length === MAX_PRS };
  for (const item of planned) {
    const { id, ...patch } = item;
    const outcome = await recordSourceChange(store, {
      id, patch: { project_id: project, ...patch, ci_state: 'unknown', landing_state: 'open' },
      // A repeat creates an unchanged snapshot and does not increment the revision.
      at: now()
    });
    decisions.push({ pr_number: item.pr_number, status: outcome.ok
      ? outcome.unchanged ? 'already_recorded' : 'recorded' : outcome.error });
  }
  return { ok: true, project, dry_run: false, candidates: planned.length,
    recorded: decisions.filter(d => d.status === 'recorded').length, decisions,
    truncated: pulls.pull_requests.length === MAX_PRS };
}

// A single iteration only: a host-owned systemd timer calls it, not an API model session.
// Concurrency is also prohibited across OS processes by the unit's flock invocation.
export async function runSourcePollOnce({ store, github, catalog, policy, now = Date.now } = {}) {
  const validated = validatePollPolicy(policy);
  if (!validated.ok) return validated;
  if (!policy.enabled) return { ok: false, error: 'disabled' };
  if (activeStores.has(store)) return { ok: false, error: 'already_running' };
  activeStores.add(store);
  try {
    const result = { ok: true, dry_run: !policy.apply, projects: [], observed_at: now() };
    for (const project of policy.projects) {
      let entry;
      try {
        const found = await catalog({ search: project });
        const row = found?.projects?.find(p =>
          p.name === project && p.kind === 'repo' && p.available !== false && p.metadata_only !== true);
        if (!row) { result.projects.push({ project, ok: false, error: 'unknown_project' }); result.ok = false; continue; }
        const origin = await github.projectRepo(project);
        if (!parseRepo(origin)) { result.projects.push({ project, ok: false, error: 'repo_unavailable' }); result.ok = false; continue; }
        const discovery = await discoverSourceChanges({ store, github, project, origin,
          trustedAuthors: policy.trustedAuthors, dryRun: !policy.apply, now });
        if (!discovery.ok || !policy.apply) entry = { project, ...discovery };
        else {
          const reconciliation = await reconcileSourceProject({ store, github, project, origin,
            limit: 30, now });
          entry = { project, discovery, reconciliation,
            ok: reconciliation.ok, recorded: discovery.recorded };
        }
      } catch { entry = { project, ok: false, error: 'source_unavailable' }; }
      result.projects.push(entry);
      if (!entry.ok) result.ok = false;
    }
    // Do not expose raw filesystem paths, tokens, env or arbitrary PR/Issue bodies.
    return result;
  } finally {
    activeStores.delete(store);
  }
}
