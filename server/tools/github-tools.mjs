// GitHub MCP tools: bounded reads of Issues, pull requests, workflow runs and checks for
// registered repositories, and pull request creation from a claimed worktree.
// Authorization comes first in every handler; the principal comes from the runtime, never
// from tool arguments. Pull requests are opened, never merged: the landing contract of
// memolabs-dev/.github lands them.
//
// Phase 5 (D9), enforced here whatever the caller sends:
// - a remote principal (oidc:) reads and opens pull requests only on the GitHub origins of the
//   allowlisted projects (remote.json);
// - the head of a pull request is always the worktree's own branch (there is no head argument),
//   never main, master or the default branch (compared without case), and for a remote
//   principal the branch head on GitHub must be a commit worktree_push sent from this worktree;
// - writes check the D8 session binding; github_create_pr takes client_request_id.
import { z } from 'zod/v4';
import { workerFor } from '../coordinator/index.mjs';
import { ownsWorkspace } from '../coordinator/policy.mjs';
import { validBranch } from '../coordinator/checkpoints.mjs';
import { parseIssueRef } from '../coordinator/issue-lease.mjs';
import { LIMITS, createGitHub, validInputText } from '../integrations/github.mjs';
import { AI_ATTRIBUTION, isProtectedBranch, pushedCommits } from '../runners/worktrees.mjs';
import { CLIENT_REQUEST_ID_RE, runOnce } from '../coordinator/store.mjs';
import { isRemotePrincipal, metaFromExtra, remotePolicyFromEnv, remoteProjectRefusal, sessionBindingDecision }
  from '../../bridge/write-gate.mjs';

export const GITHUB_TOOLS = Object.freeze(['github_issues', 'github_pull_requests', 'github_workflows', 'github_checks',
  'github_create_pr']);

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail } : {}) });

const WS_RE = /^ws_[A-Za-z0-9_-]{16}$/;
// Worktree ids are minted by the worktree module (prefix_random); accept that shape only.
const WORKTREE_RE = /^[a-z]{1,8}_[A-Za-z0-9_-]{8,48}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const LABEL_RE = /^[^,\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]{1,50}$/;
// Refusals of github_create_pr are journaled as 'denied'; anything else that fails is 'error'.
const DENIED = new Set(['forbidden', 'workspace_closed', 'worktree_not_active', 'wrong_host', 'claim_required',
  'stale_lease', 'lease_held', 'issue_changed', 'lease_denied', 'repo_not_allowed', 'repo_not_registered',
  'default_branch_refused', 'branch_not_pushed', 'unknown_workspace', 'unknown_worktree', 'project_not_allowed',
  'head_not_pushed_by_workspace', 'session_mismatch']);

const repoArg = z.string().max(140).describe('owner/repo of a registered project (its GitHub origin), or memolabs-dev/.github.');
const limitArg = z.number().int().min(LIMITS.list.min).max(LIMITS.list.max).optional()
  .describe(`Maximum items returned (default ${LIMITS.list.default}, first page only).`);

// The body already references the Issue with a GitHub closing keyword?
function closesIssue(body, issue) {
  const ref = `(?:${issue.repo.replace(/[.]/g, '\\.')})?#${issue.number}(?![0-9])`;
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+${ref}`, 'i').test(body);
}

// options.github injects a ready integration (tests); otherwise one is built per runtime.
// options.remotePolicy injects the remote policy (tests); otherwise MEMO_BRIDGE_REMOTE_CONFIG.
export function registerGithubTools(server, getRuntime, options = {}) {
  const built = new WeakMap();
  const remotePolicy = options.remotePolicy ?? remotePolicyFromEnv();
  const githubOf = rt => {
    if (options.github) return options.github;
    let github = built.get(rt);
    if (!github) {
      github = createGitHub({ catalogOptions: rt.catalogOptions, now: rt.now, ...options });
      built.set(rt, github);
    }
    return github;
  };

  // Reads: authorization, then repository scope; only refusals are journaled.
  const readTool = (op, run) => async (args = {}) => {
    const rt = getRuntime();
    if (!rt.authorize(op)) {
      await rt.audit(op, 'denied', 'forbidden');
      return result(fail('forbidden'));
    }
    try {
      const github = githubOf(rt);
      const resolved = await github.resolveRepo(args.repo);
      if (!resolved.ok) {
        if (resolved.error === 'repo_not_registered') await rt.audit(op, 'denied', 'repo_not_registered');
        return result(resolved);
      }
      if (isRemotePrincipal(rt.principal) && !(await remoteRepoAllowed(github, resolved.repo))) {
        await rt.audit(op, 'denied', 'project_not_allowed');
        return result(fail('project_not_allowed'));
      }
      return result(await run(github, resolved.repo, args));
    } catch {
      return result(fail('internal_error'));
    }
  };

  // A remote principal reads only the GitHub origins of the allowlisted projects.
  async function remoteRepoAllowed(github, repo) {
    if (!remotePolicy.configured) return false;
    for (const name of remotePolicy.projects) {
      const origin = await github.projectRepo(name);
      if (origin && origin.toLowerCase() === repo.full.toLowerCase()) return true;
    }
    return false;
  }

  const limitOf = value => (value === undefined ? LIMITS.list.default
    : Number.isInteger(value) && value >= LIMITS.list.min && value <= LIMITS.list.max ? value : undefined);

  server.registerTool('github_issues', {
    description: 'List Issues (pull requests excluded) of a registered repository, most recently updated first: number, title, state, labels, author, updated_at, url. Read-only.',
    inputSchema: z.object({
      repo: repoArg,
      state: z.enum(['open', 'closed', 'all']).optional().describe('Default open.'),
      labels: z.array(z.string().max(LIMITS.label)).max(LIMITS.labels).optional().describe('Only Issues carrying all these labels.'),
      limit: limitArg
    }),
    annotations: read
  }, readTool('github_issues', (github, repo, args) => {
    const limit = limitOf(args.limit);
    if (limit === undefined) return fail('invalid_input', 'limit');
    const state = args.state ?? 'open';
    if (!['open', 'closed', 'all'].includes(state)) return fail('invalid_input', 'state');
    if (args.labels !== undefined && (!Array.isArray(args.labels) || args.labels.length > LIMITS.labels ||
      !args.labels.every(l => typeof l === 'string' && LABEL_RE.test(l)))) return fail('invalid_input', 'labels');
    return github.issues(repo, { state, labels: args.labels, limit });
  }));

  server.registerTool('github_pull_requests', {
    description: 'List pull requests of a registered repository, most recently updated first: number, title, state, draft, author, head, base, labels, updated_at, url, and mergeable for the first open ones. Read-only.',
    inputSchema: z.object({
      repo: repoArg,
      state: z.enum(['open', 'closed', 'all']).optional().describe('Default open.'),
      limit: limitArg
    }),
    annotations: read
  }, readTool('github_pull_requests', (github, repo, args) => {
    const limit = limitOf(args.limit);
    if (limit === undefined) return fail('invalid_input', 'limit');
    const state = args.state ?? 'open';
    if (!['open', 'closed', 'all'].includes(state)) return fail('invalid_input', 'state');
    return github.pullRequests(repo, { state, limit });
  }));

  server.registerTool('github_workflows', {
    description: 'Recent GitHub Actions workflow runs of a registered repository, newest first, optionally for one branch: name, status, conclusion, branch, head_sha, url. Read-only.',
    inputSchema: z.object({
      repo: repoArg,
      branch: z.string().max(200).optional(),
      limit: limitArg
    }),
    annotations: read
  }, readTool('github_workflows', (github, repo, args) => {
    const limit = limitOf(args.limit);
    if (limit === undefined) return fail('invalid_input', 'limit');
    if (args.branch !== undefined && !validBranch(args.branch)) return fail('invalid_input', 'branch');
    return github.workflowRuns(repo, { branch: args.branch, limit });
  }));

  server.registerTool('github_checks', {
    description: 'Check runs and the combined commit status of a commit SHA or branch of a registered repository, with a pending/failing summary. Read-only.',
    inputSchema: z.object({
      repo: repoArg,
      ref: z.string().max(200).describe('Full 40-character commit SHA or branch name.')
    }),
    annotations: read
  }, readTool('github_checks', (github, repo, args) => {
    const ref = typeof args.ref === 'string' ? args.ref : '';
    if (!SHA_RE.test(ref) && !validBranch(ref)) return fail('invalid_input', 'ref');
    return github.checks(repo, ref);
  }));

  server.registerTool('github_create_pr', {
    description: 'Open a pull request from the branch of an active worktree of your workspace into the repository default branch. The branch must already be pushed, the workspace must hold a live claim on the worktree Issue (verified by the lease ledger), and "Closes #<n>" is appended when the Issue is in the same repository. Returns the existing pull request when one is already open for the branch. Never merges and never enables auto-merge: the memolabs-dev/.github landing contract lands pull requests.',
    inputSchema: z.object({
      workspace_id: z.string().max(40).describe('Workspace id returned by workspace_open (ws_…).'),
      worktree_id: z.string().max(60).describe('Worktree id returned by worktree_create.'),
      title: z.string().min(1).max(LIMITS.title),
      body: z.string().max(LIMITS.body).optional(),
      draft: z.boolean().optional(),
      client_request_id: z.string().regex(CLIENT_REQUEST_ID_RE).optional()
        .describe('Your own id for this call (8 to 128 letters, digits, _ or -). A retry with the same id returns the first result.')
    }),
    annotations: write
  }, async (args = {}, extra = null) => {
    const op = 'github_create_pr';
    const rt = getRuntime();
    const meta = metaFromExtra(extra);
    const ids = { workspace_id: WS_RE.test(args.workspace_id ?? '') ? args.workspace_id : undefined,
      ...(meta.request_id ? { request_id: meta.request_id } : {}) };
    if (!rt.authorize(op)) {
      await rt.audit(op, 'denied', 'forbidden', ids);
      return result(fail('forbidden'));
    }
    let outcome;
    try {
      const guard = { remotePolicy, meta };
      outcome = await runOnce(rt.store(), { principal: rt.principal.id, op, clientRequestId: args.client_request_id, now: rt.now() },
        () => createPr(rt, githubOf(rt), args, ids, guard));
    } catch {
      outcome = fail('internal_error');
    }
    const failed = outcome.ok === false;
    await rt.audit(op, failed ? (DENIED.has(outcome.error) ? 'denied' : 'error') : 'ok', failed ? outcome.error : null, ids);
    return result(outcome);
  });
}

// ids is filled as facts are established so the audit row names the workspace and Issue.
async function createPr(rt, github, args, ids, { remotePolicy, meta } = {}) {
  const remote = isRemotePrincipal(rt.principal);
  if (!WS_RE.test(args.workspace_id ?? '')) return fail('invalid_input', 'workspace_id');
  if (!WORKTREE_RE.test(args.worktree_id ?? '')) return fail('invalid_input', 'worktree_id');
  if (!validInputText(args.title, LIMITS.title) || !args.title.trim()) return fail('invalid_input', 'title');
  if (args.body !== undefined && !validInputText(args.body, LIMITS.body, { multiline: true })) return fail('invalid_input', 'body');
  // Pull requests go out under the owner's name: no AI attribution, as for commit messages.
  if (AI_ATTRIBUTION.some(rx => rx.test(`${args.title}\n${args.body ?? ''}`))) return fail('invalid_input', 'AI attribution');
  if (args.draft !== undefined && typeof args.draft !== 'boolean') return fail('invalid_input', 'draft');

  // Local preconditions in one consistent read: owned active workspace, its active worktree on
  // this host, and a live local claim on the worktree's Issue.
  const now = rt.now();
  let local;
  try {
    local = await rt.store().transaction(repo => {
      const workspace = repo.getWorkspace(args.workspace_id);
      if (!workspace) return { error: fail('unknown_workspace') };
      if (!ownsWorkspace(rt.principal, workspace)) return { error: fail('forbidden') };
      if (workspace.status !== 'active') return { error: fail('workspace_closed') };
      const worktree = repo.getWorktree(args.worktree_id);
      if (!worktree || worktree.workspace_id !== workspace.id) return { error: fail('unknown_worktree') };
      if (worktree.status !== 'active') return { error: fail('worktree_not_active') };
      if (worktree.host !== rt.host) return { error: fail('wrong_host', worktree.host) };
      if (!worktree.issue_ref) return { error: fail('claim_required', 'worktree has no Issue') };
      const claim = repo.claimsOf(workspace.id, 'claimed')
        .find(c => c.issue_ref === worktree.issue_ref && Date.parse(c.expires_at) > now);
      if (!claim) return { error: fail('claim_required') };
      return { workspace, worktree, claim };
    }, { write: false });
  } catch {
    local = { error: fail('store_unavailable') };
  }
  if (local.error) return local.error;
  const { workspace, worktree, claim } = local;
  const notAllowed = remoteProjectRefusal(rt.principal, worktree.project_id, remotePolicy);
  if (notAllowed) return notAllowed;
  const binding = sessionBindingDecision(workspace.client_session, meta?.client_session, remotePolicy?.session_binding);
  if (!binding.ok) return binding;
  const issue = parseIssueRef(worktree.issue_ref);
  if (!issue) return fail('claim_required', 'invalid Issue reference');
  ids.issue = issue.ref;

  // Repository: the GitHub origin of the worktree's registered project.
  const origin = await github.projectRepo(worktree.project_id);
  if (!origin) return fail('repo_not_registered');
  const resolved = await github.resolveRepo(origin);
  if (!resolved.ok) return resolved;
  const repo = resolved.repo;

  const branch = worktree.branch;
  if (!validBranch(branch)) return fail('invalid_input', 'branch');
  const base = await github.defaultBranch(repo);
  if (!base.ok) return base;
  if (isProtectedBranch(branch, [base.branch])) return fail('default_branch_refused');
  const head = await github.remoteBranchHead(worktree.path, branch);
  if (!head.ok) return head;
  // Remotely the pull request carries only what this workspace pushed: a branch someone moved
  // since (another session, a terminal) is refused rather than proposed under the owner's name.
  if (remote && !(await pushedCommits(rt, worktree.id)).includes(head.sha)) return fail('head_not_pushed_by_workspace');

  // Idempotent: an already open pull request for this branch is returned as is.
  const existing = await github.openPullFor(repo, branch);
  if (!existing.ok) return existing;
  if (existing.pull) return { ok: true, existing: true, repo: repo.full, number: existing.pull.number, url: existing.pull.url,
    head: branch, base: existing.pull.base };

  let body = (args.body ?? '').trim();
  if (issue.repo.toLowerCase() === repo.full.toLowerCase() && !closesIssue(body, issue)) {
    body = body ? `${body}\n\nCloses #${issue.number}` : `Closes #${issue.number}`;
  }

  // Write boundary: the ledger re-verifies the claim immediately before the pull request.
  const verified = await rt.ledger.verify(issue, workerFor(workspace), claim.claim_id, claim.fence_sha);
  if (!verified?.ok) return verified?.error ? fail(verified.error, verified.detail) : fail('ledger_unavailable');

  const created = await github.createPull(repo, { title: args.title.trim(), head: branch, base: base.branch, body,
    draft: args.draft ?? false });
  const warned = value => (binding.warning && value.ok ? { ...value, session_warning: binding.warning } : value);
  if (created.ok) {
    return warned({ ok: true, existing: false, repo: repo.full, number: created.pull.number, url: created.pull.url,
      head: branch, base: base.branch, head_sha: head.sha, draft: created.pull.draft });
  }
  // A lost response or a concurrent creation: adopt the pull request if it now exists.
  if (created.uncertain || created.error === 'github_validation_failed' || created.error === 'github_outcome_unknown') {
    const after = await github.openPullFor(repo, branch);
    if (after.ok && after.pull) {
      return { ok: true, existing: true, recovered: true, repo: repo.full, number: after.pull.number, url: after.pull.url,
        head: branch, base: after.pull.base };
    }
    if (created.uncertain && after.ok) return fail('github_unavailable', 'no pull request was created');
  }
  const { uncertain, ...failure } = created;
  return failure;
}

