// Memo Coordinator: the Memo Bridge face of Memo Labs work coordination.
//
// Ownership, decided on 2026-10-13 (Vault 1-Projects/memo-labs-os.md):
// - a task is a GitHub Issue (the tool contract says "task", the argument stays `issue`,
//   written owner/repo#n);
// - a reservation is the Git-ref lease of memolabs-dev/.github (scripts/issue_lease.py), which
//   works across the Mac and the VPS without a central database;
// - this module adds what the ledger does not own: per-session workspaces, the identity of the
//   worker (derived by the server, never by the model), Git-verified checkpoints and an audit
//   journal, all in the private local store.
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';
import { projectInfo, readProjectRegistry } from '../catalog.mjs';
import { CLIENT_TYPES, authorize, isRemotePrincipal, ownsWorkspace, workerFor } from './policy.mjs';
import { CAPABILITIES } from './policy.mjs';
import { runOnce } from './store.mjs';
import { remotePolicyFromEnv, remoteProjectRefusal, requestMeta, sessionBindingDecision } from '../../bridge/write-gate.mjs';
import { ACTIVE_JOB_STATUSES } from '../runners/executor.mjs';
import { cancelActiveJobs, stopCancelledJobs } from '../runners/jobs.mjs';
import { COMMIT_RE, validBranch, verifyCheckpoint } from './checkpoints.mjs';
import { LEASE_TTL, OUTCOMES, defaultGovernanceRoot, parseIssueRef } from './issue-lease.mjs';
import { BATCH_ID_RE, BATCH_LABEL_COLOR, BATCH_MAX, BATCH_SCAN, NEXT_ON, TASK_STATES, batchLabel, batchLabelText, claimOrder,
  isClaimable, issueBody, newBatchId, parseTaskBody, pasteSentence, priorityOf, taskState, validateBatchTasks, workerInstructions }
  from './batches.mjs';

// The list lives in policy.mjs, so a principal can carry a server-derived client kind (Phase 5).
export { CLIENT_TYPES };
export const HOSTS = Object.freeze(['mac', 'vps']);
export const SUMMARY_MAX = 2000;
export const TASKS_LIMIT = Object.freeze({ max: 100, default: 30 });
// Claimability, as the ledger's preflight defines it (memolabs-dev/.github scripts/issue_preflight.py).
export const READY_LABEL = 'agent:ready';
export const PRIORITIES = Object.freeze(['priority:p0', 'priority:p1', 'priority:p2']);
export const BLOCKING_LABELS = Object.freeze(['status:blocked', 'needs:human', 'type:epic', 'agent:working']);

const WS_RE = /^ws_[A-Za-z0-9_-]{16}$/;
const CLAIM_RE = /^[0-9a-f]{32}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/;
const DENIED = new Set(['forbidden', 'stale_lease', 'lease_held', 'workspace_closed', 'project_mismatch',
  'repo_not_allowed', 'issue_not_ready', 'issue_changed', 'lease_race_lost', 'lease_denied', 'host_not_remote_enabled',
  'project_not_allowed', 'session_mismatch']);
// Phase 5: the only host a remote (OIDC) principal's workspace may live on. Mac-hosted
// workspaces driven remotely are deferred to Phase 5b (spec non-goals, REQ-P5-08).
const REMOTE_HOST = 'vps';
const UNCERTAIN = new Set(['ledger_unavailable', 'ledger_outcome_unknown']);
const MAX_LIST = 200;
const WRITES = new Set(['workspace_open', 'workspace_close', 'task_claim', 'task_renew', 'task_release', 'task_complete',
  'task_checkpoint', 'batch_create', 'task_next']);
// Phase 5 remote guards (D8, D9, REQ-P5-15), applied around the operations whatever the caller:
// - the project allowlist binds remote principals when they open or extend work; giving work
//   back (release, complete, close) stays possible after a project leaves the allowlist;
// - the session binding is checked on every write that names a workspace;
// - task_claim takes client_request_id (Phase 4 FU-5): a retry returns the first result.
// Batches (TODO-P5-50 to 52): batch_create and batch_status name their project, task_next works
// in the project of its workspace; task_next and batch_create replay their first result.
const REMOTE_PROJECT_OPS = new Set(['workspace_open', 'task_claim', 'task_renew', 'task_checkpoint', 'batch_create',
  'batch_status', 'task_next']);
const BOUND_OPS = new Set(['workspace_close', 'task_claim', 'task_renew', 'task_release', 'task_complete', 'task_checkpoint',
  'task_next']);
const IDEMPOTENT_OPS = new Set(['task_claim', 'task_next', 'batch_create']);
// Issues a task_next of this process is claiming right now: concurrent task_next calls try
// them last, so parallel conversations on one batch rarely race for the same Issue. Only an
// optimisation: the ledger alone decides who holds a task.
const CLAIMING = new Map();
const claiming = ref => (CLAIMING.get(ref) ?? 0) > 0;
const holdClaiming = ref => CLAIMING.set(ref, (CLAIMING.get(ref) ?? 0) + 1);
const dropClaiming = ref => { const n = (CLAIMING.get(ref) ?? 1) - 1; if (n > 0) CLAIMING.set(ref, n); else CLAIMING.delete(ref); };
// Calls running now in this process, by hub request id, so workspace_status can say that an
// operation answered 'accepted' is still running.
const IN_FLIGHT = new Map();
const IN_FLIGHT_MAX = 1000;
const REQUESTS_SHOWN = 10;
// workspace_recover bounds: ledger status calls are slow (python + gh), so only the most
// recent held claims are reconciled.
const RECOVER = Object.freeze({ claims: 10, checkpoints: 10, jobs: 10, worktrees: 50, actions: 20 });
// tasks_list bounds: projects scanned, repositories per search query, search calls per listing.
const TASKS_SCAN = Object.freeze({ projects: 200, reposPerQuery: 10, queries: 5, perPage: 100 });

const newId = prefix => `${prefix}_${randomBytes(12).toString('base64url')}`;
const iso = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail } : {}) });

// Text written by one session is read back by other sessions' models: no control characters,
// no bidirectional overrides, and line breaks only where the field is meant to be multi-line.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g;
const LINE_BREAKS = /[\t\n\r]/;
function cleanText(value, max, { multiline = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length > max || CONTROL.test(text) || (!multiline && LINE_BREAKS.test(text))) return undefined;
  return text || null;
}
// For text that comes from elsewhere (GitHub titles, job summaries): never refuse it, but strip
// every control, zero-width and bidi character and bound its length before a model reads it.
export function sanitizeExternal(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(CONTROL_ALL, ' ').replace(/ {2,}/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}
function limitOf(value, fallback = 50, max = MAX_LIST) {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && value >= 1 && value <= max ? value : undefined;
}
function ttlOf(value) {
  if (value === undefined) return LEASE_TTL.default;
  return Number.isInteger(value) && value >= LEASE_TTL.min && value <= LEASE_TTL.max ? value : undefined;
}

// The claims table has a single free `outcome` column. A completion summary is stored in it
// after the outcome keyword ("completed: <summary>"); outcome keywords never contain ':', so
// the split is unambiguous. Readers always go through decodeOutcome.
const encodeOutcome = (outcome, summary) => (summary ? `${outcome}: ${summary}` : outcome);
export function decodeOutcome(stored) {
  if (typeof stored !== 'string') return { outcome: null, summary: null };
  const i = stored.indexOf(': ');
  return i < 0 ? { outcome: stored, summary: null } : { outcome: stored.slice(0, i), summary: stored.slice(i + 2) };
}

function publicWorkspace(w) {
  return {
    workspace_id: w.id, project: w.project_id, principal: w.principal, client_type: w.client_type,
    client_label: w.client_label, host: w.host, branch: w.branch, status: w.status,
    created_at: iso(w.created_at), closed_at: iso(w.closed_at)
  };
}
function publicClaim(c) {
  const { outcome, summary } = decodeOutcome(c.outcome);
  return { issue: c.issue_ref, claim_id: c.claim_id, fence: c.fence_sha, epoch: c.epoch, expires_at: c.expires_at,
    state: c.state, outcome, ...(summary ? { summary } : {}) };
}
function publicCheckpoint(c) {
  return { issue: c.issue_ref, workspace_id: c.workspace_id, claim_id: c.claim_id, fence: c.fence_sha,
    branch: c.branch, commit: c.commit_sha, durability: c.durability, note: c.note, at: iso(c.at) };
}
// Local filesystem paths (worktree path, job log path) never leave the server.
function publicWorktree(w) {
  return { worktree_id: w.id, project: w.project_id, host: w.host, branch: w.branch, base_ref: w.base_ref,
    base_commit: w.base_commit, issue: w.issue_ref, status: w.status, created_at: iso(w.created_at) };
}
function publicJob(j) {
  return { job_id: j.id, worktree_id: j.worktree_id, project: j.project_id, host: j.host, recipe: j.recipe,
    status: j.status, exit_code: j.exit_code, created_at: iso(j.created_at), started_at: iso(j.started_at),
    ended_at: iso(j.ended_at), summary: sanitizeExternal(j.summary, 500) };
}

async function catalogResolver(name, options) {
  const info = await projectInfo(name, options);
  if (!info.ok) return info;
  const p = info.project;
  return { ok: true, project: { name: p.name, repoPath: p.kind === 'repo' && p.available ? p.local_path : null } };
}

// Every registered project that is a Git repository available on this host.
async function catalogRepos(options) {
  const catalog = await readProjectRegistry(options);
  return catalog.projects.filter(p => p.kind === 'repo' && p.available).map(p => ({ name: p.name, repoPath: p.path }));
}

// owner/repo of the project's GitHub origin, read-only; null when it cannot be established.
export function gitHubRemote({ repoPath } = {}) {
  if (!repoPath) return Promise.resolve(null);
  return new Promise(resolve => {
    execFile('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      timeout: 6000, maxBuffer: 4096, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    }, (error, stdout) => {
      if (error) return resolve(null);
      // Any host spelling (github.com, an SSH alias…): only the owner/repo tail is compared.
      const match = /[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?\s*$/.exec(stdout.trim());
      resolve(match ? `${match[1]}/${match[2]}` : null);
    });
  });
}

// The ledger's public allowlist, read as text from issue_preflight.py and never executed.
// Only the `PUBLIC_ALLOWLIST = frozenset({ "owner/repo", ... })` literal is accepted; anything
// else in the block makes the whole parse fail closed.
export function parsePublicAllowlist(text) {
  if (typeof text !== 'string') return null;
  const block = /^PUBLIC_ALLOWLIST\s*=\s*frozenset\(\{([^}]{0,8000})\}\)/m.exec(text);
  if (!block) return null;
  const body = block[1].replace(/#[^\n]*/g, '');
  const entries = body.split(',').map(s => s.trim()).filter(Boolean);
  const repos = [];
  for (const entry of entries) {
    const m = /^"([^"\\]{1,140})"$/.exec(entry) ?? /^'([^'\\]{1,140})'$/.exec(entry);
    if (!m || !REPO_RE.test(m[1])) return null;
    repos.push(m[1]);
  }
  return repos.length ? repos : null;
}

export async function readPublicAllowlist(root = defaultGovernanceRoot()) {
  try {
    const text = await readFile(join(root, 'scripts', 'issue_preflight.py'), 'utf8');
    const repos = text.length <= 256 * 1024 ? parsePublicAllowlist(text) : null;
    return repos ? { ok: true, repos } : fail('ledger_unavailable', 'allowlist unreadable');
  } catch {
    return fail('ledger_unavailable', 'issue_preflight.py not found');
  }
}

// One GitHub issue search through the gh CLI: fixed argv, no shell, bounded output.
export function ghSearchIssues(query, { perPage = TASKS_SCAN.perPage, timeoutMs = 20000, env = process.env } = {}) {
  return new Promise(resolve => {
    execFile('gh', ['api', '-X', 'GET', 'search/issues', '-f', `q=${query}`, '-f', 'sort=created', '-f', 'order=asc',
      '-f', `per_page=${perPage}`], {
      timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      env: { ...env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_NO_UPDATE_NOTIFIER: '1' }
    }, (error, stdout) => {
      if (error) return resolve(fail('github_unavailable', error.killed ? 'timeout' : 'gh api failed'));
      try {
        const data = JSON.parse(stdout);
        if (!Array.isArray(data?.items)) return resolve(fail('github_unavailable', 'unexpected response'));
        resolve({ ok: true, total_count: Number(data.total_count) || 0, incomplete: Boolean(data.incomplete_results),
          items: data.items });
      } catch {
        resolve(fail('github_unavailable', 'unexpected response'));
      }
    });
  });
}

// The search query is fixed except for the repository qualifiers, which come only from the
// allowlist ∩ registered origins and are validated by REPO_RE.
export function tasksQuery(repos) {
  return ['is:issue', 'is:open', `label:"${READY_LABEL}"`, ...repos.map(r => `repo:${r}`)].join(' ');
}

// Keep the claimable Issues of one search page, in rank order: p0 > p1 > p2, then oldest first.
export function rankTasks(items, repoProjects) {
  const tasks = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.pull_request || item.state !== 'open') continue;
    const repoMatch = /\/repos\/([^/]+\/[^/]+)$/.exec(String(item.repository_url ?? ''));
    if (!repoMatch || !REPO_RE.test(repoMatch[1])) continue;
    const project = repoProjects.get(repoMatch[1].toLowerCase());
    if (!project) continue;
    if (!Number.isInteger(item.number) || item.number < 1 || item.number > 99999999) continue;
    const labels = (Array.isArray(item.labels) ? item.labels : []).map(l => (typeof l === 'string' ? l : l?.name))
      .filter(l => typeof l === 'string');
    if (!labels.includes(READY_LABEL)) continue;
    if (labels.some(l => BLOCKING_LABELS.includes(l))) continue;
    const priorities = PRIORITIES.filter(p => labels.includes(p));
    if (priorities.length !== 1) continue;
    const created = Date.parse(item.created_at);
    tasks.push({
      issue: `${project.repo}#${item.number}`, project: project.name, priority: priorities[0].slice('priority:'.length),
      title: sanitizeExternal(item.title, 200),
      labels: labels.slice(0, 20).map(l => sanitizeExternal(l, 50)).filter(Boolean),
      created_at: Number.isFinite(created) ? new Date(created).toISOString() : null,
      updated_at: Number.isFinite(Date.parse(item.updated_at)) ? new Date(Date.parse(item.updated_at)).toISOString() : null,
      url: `https://github.com/${project.repo}/issues/${item.number}`,
      _created: Number.isFinite(created) ? created : Number.MAX_SAFE_INTEGER
    });
  }
  tasks.sort((a, b) => a.priority.localeCompare(b.priority) || a._created - b._created || a.issue.localeCompare(b.issue));
  return tasks.map(({ _created, ...task }) => task);
}

export function defaultHost() {
  return platform() === 'darwin' ? 'mac' : 'vps';
}

// The worker identity recorded in the ledger (defined in policy.mjs, re-exported here).
export { workerFor };

export function createCoordinator({ store, principal, ledger, now = Date.now, catalogOptions = {},
  resolveProject = name => catalogResolver(name, catalogOptions), projectRemote = gitHubRemote, host = defaultHost(),
  listProjectRepos = () => catalogRepos(catalogOptions), governanceRoot = defaultGovernanceRoot(),
  readAllowlist = () => readPublicAllowlist(governanceRoot), searchIssues = query => ghSearchIssues(query),
  remotePolicy = remotePolicyFromEnv(), github = null, projectSync = null }) {
  if (!store || !principal || !ledger) throw new Error('coordinator_requires_store_principal_and_ledger');
  const remote = isRemotePrincipal(principal);
  // Where the call came from and which client made it, as the server set them on the principal
  // (D6); never read from arguments. Absent attributes stay null in the journal.
  const principalVia = ['stdio', 'hub'].includes(principal.via) ? principal.via : (remote ? 'hub' : null);
  const principalClientType = CLIENT_TYPES.includes(principal.client_type) ? principal.client_type : null;

  const audit = (repo, op, outcome, code, ids = {}, meta = {}) => repo.appendEvent({
    at: now(), principal: principal.id,
    // Only well-formed identifiers reach the journal; arbitrary caller text never does.
    workspace_id: WS_RE.test(ids.workspace_id ?? '') ? ids.workspace_id : null,
    issue_ref: parseIssueRef(ids.issue) ? ids.issue : null,
    op, outcome, code: code ?? null,
    via: principalVia, client_type: principalClientType, request_id: meta.request_id ?? null
  });
  // Writes always journal their outcome; reads journal only refusals.
  const journal = (op, result, ids, meta = {}) => {
    const failed = result?.ok === false;
    if (!WRITES.has(op) && !(failed && DENIED.has(result.error))) return Promise.resolve();
    const outcome = failed ? (DENIED.has(result.error) ? 'denied' : 'error') : 'ok';
    return store.transaction(repo => audit(repo, op, outcome, failed ? result.error : null, ids, meta)).catch(() => {});
  };
  // One extra journal row (session checks, rebinds); never throws.
  const note = (op, outcome, code, ids, meta) => store.transaction(repo => audit(repo, op, outcome, code, ids, meta)).catch(() => {});
  // GitHub Projects view (server/integrations/project-sync.mjs): fire and forget, never
  // awaited, so it can neither fail nor slow an operation. A failure is one journal row,
  // project_sync_failed with a short code.
  const sync = projectSync?.enabled ? projectSync : null;
  const syncing = (ids, meta) => ({ onFailure: code => note('project_sync_failed', 'error', code, ids, meta) });
  const read = fn => store.transaction(repo => fn(repo, now()), { write: false });
  const write = fn => store.transaction(repo => fn(repo, now()));

  // Shared precondition for every operation that names a workspace.
  async function ownedWorkspace(workspaceId, { requireActive = true } = {}) {
    if (!WS_RE.test(workspaceId ?? '')) return { error: fail('invalid_input', 'workspace_id') };
    const workspace = await read(repo => repo.getWorkspace(workspaceId));
    if (!workspace) return { error: fail('unknown_workspace') };
    if (!ownsWorkspace(principal, workspace)) return { error: fail('forbidden') };
    if (requireActive && workspace.status !== 'active') return { error: fail('workspace_closed') };
    return { workspace };
  }

  // Precondition for operations on a held claim: owned active workspace, and a claim this
  // workspace recorded. The ledger then checks worker, claim id and fence itself.
  async function heldClaim(args, { requireActive = true } = {}) {
    const issue = parseIssueRef(args.issue);
    if (!issue) return { error: fail('invalid_input', 'issue') };
    if (!CLAIM_RE.test(args.claim_id ?? '')) return { error: fail('invalid_input', 'claim_id') };
    if (!SHA_RE.test(args.fence ?? '')) return { error: fail('invalid_input', 'fence') };
    const ws = await ownedWorkspace(args.workspace_id, { requireActive });
    if (ws.error) return ws;
    const claim = await read(repo => repo.getClaim(args.claim_id));
    if (!claim || claim.workspace_id !== ws.workspace.id || claim.issue_ref !== issue.ref) return { error: fail('unknown_claim') };
    return { issue, workspace: ws.workspace, claim };
  }

  // Ask the ledger who holds the Issue. Used whenever the outcome of a write is uncertain:
  // { mine } is our live lease (possibly with a fence we never saw), { other } is someone
  // else's live lease, null means nobody holds it, { error } means we cannot tell.
  async function whoHolds(issue, worker) {
    const status = await ledger.status(issue);
    if (!status.ok) return { error: status };
    const r = status.receipt;
    if (r.state !== 'claimed' || r.expired) return null;
    return r.worker === worker ? { mine: r } : { other: r };
  }

  // Release one locally recorded claim, reconciling a stale local fence with the ledger.
  // Returns released (ours, now released), lost (no longer ours) or unreleased (try again).
  async function releaseRecorded(workspace, claim, outcome) {
    const issue = parseIssueRef(claim.issue_ref);
    const worker = workerFor(workspace);
    let result = await ledger.release(issue, worker, claim.claim_id, claim.fence_sha, outcome);
    if (result.ok) return { state: 'released', fence: result.receipt.fence_sha };
    if (result.error === 'stale_lease' || UNCERTAIN.has(result.error)) {
      const holder = await whoHolds(issue, worker);
      if (holder?.error) return { state: 'unreleased', error: holder.error.error };
      if (holder?.mine && holder.mine.claim_id === claim.claim_id) {
        result = await ledger.release(issue, worker, claim.claim_id, holder.mine.fence_sha, outcome);
        return result.ok ? { state: 'released', fence: result.receipt.fence_sha } : { state: 'unreleased', error: result.error };
      }
      return { state: 'lost' };
    }
    return { state: 'unreleased', error: result.error };
  }

  // task_release and task_complete: release a held claim with an outcome. Allowed on a closed
  // workspace too, so a claim left behind can always be given back.
  // Jobs never outlive the claim they were submitted under: releasing or completing a task
  // cancels the workspace's active jobs on that Issue's worktrees, closing a workspace cancels
  // all of its jobs. The runner also stops a job by itself once its claim is gone.
  async function cancelJobs(workspaceId, issueRef = null) {
    const stopped = await write((repo, at) => cancelActiveJobs(repo, { workspaceId, issueRef }, at, principal.id));
    stopCancelledJobs(stopped);
    return stopped.map(j => j.job_id);
  }

  async function releaseHeld(args, outcome, summary, meta = null) {
    const held = await heldClaim(args, { requireActive: false });
    if (held.error) return held.error;
    if (held.claim.state === 'released') {
      const cancelled = await cancelJobs(held.workspace.id, held.issue.ref);
      return { ok: true, issue: held.issue.ref, released: true, ...publicOutcome(held.claim.outcome),
        ...(cancelled.length ? { cancelled_jobs: cancelled } : {}) };
    }
    const result = await ledger.release(held.issue, workerFor(held.workspace), args.claim_id, args.fence, outcome);
    let fence;
    if (result.ok) fence = result.receipt.fence_sha;
    else if (result.error === 'ledger_outcome_unknown') {
      const holder = await whoHolds(held.issue, workerFor(held.workspace));
      if (holder?.error || holder?.mine) return result;
    } else return result;
    await write((repo, at) => repo.updateClaim(args.claim_id, { state: 'released', outcome: encodeOutcome(outcome, summary),
      fence_sha: fence ?? held.claim.fence_sha, updated_at: at }, held.claim.fence_sha));
    const cancelled = await cancelJobs(held.workspace.id, held.issue.ref);
    void sync?.taskReleased({ issue: held.issue.ref, outcome }, syncing({ workspace_id: held.workspace.id, issue: held.issue.ref }, meta));
    return { ok: true, issue: held.issue.ref, released: true, outcome, ...(summary ? { summary } : {}),
      ...(cancelled.length ? { cancelled_jobs: cancelled } : {}) };
  }
  const publicOutcome = stored => {
    const { outcome, summary } = decodeOutcome(stored);
    return { outcome, ...(summary ? { summary } : {}) };
  };

  async function resolve(name) {
    if (typeof name !== 'string' || !name) return fail('invalid_input', 'project');
    const resolved = await resolveProject(name);
    if (!resolved.ok) {
      const invalid = resolved.error === 'invalid_project_name';
      return fail(invalid ? 'invalid_input' : 'unknown_project', invalid ? 'project' : undefined);
    }
    return resolved;
  }

  // Ledger view of one locally recorded claim, for workspace_recover.
  async function reconcile(workspace, claim) {
    const issue = parseIssueRef(claim.issue_ref);
    const base = { issue: claim.issue_ref, claim_id: claim.claim_id, local_fence: claim.fence_sha, local_expires_at: claim.expires_at };
    if (!issue) return { ...base, state: 'unknown', reason: 'invalid_issue' };
    let status;
    try { status = await ledger.status(issue); } catch { status = fail('ledger_unavailable'); }
    if (!status.ok) return { ...base, state: 'unknown', reason: status.error };
    const r = status.receipt ?? {};
    const ours = r.worker === workerFor(workspace) && r.claim_id === claim.claim_id;
    if (ours && r.state === 'claimed' && !r.expired) {
      return { ...base, state: 'still_held', fence: r.fence_sha, epoch: r.epoch, expires_at: r.expires_at };
    }
    if (ours && r.state === 'claimed' && r.expired) return { ...base, state: 'expired', expires_at: r.expires_at };
    return { ...base, state: 'lost', ledger_state: r.state ?? null };
  }

  // Short, deterministic hints for a session that lost its context.
  function nextActions(workspace, claims, checkpoints, jobs, worktrees) {
    const actions = [];
    const active = workspace.status === 'active';
    if (!active) actions.push('Workspace is closed: open a new one with workspace_open to keep working.');
    for (const c of claims) {
      if (c.state === 'still_held') {
        if (active) {
          actions.push(`Renew ${c.issue} with task_renew (claim_id ${c.claim_id}, fence ${c.fence}) before ${c.expires_at}.`);
          const last = checkpoints.find(cp => cp.issue === c.issue);
          if (last && last.durability !== 'remote') {
            actions.push(`Push branch ${last.branch} and record a new task_checkpoint on ${c.issue}: the last one is ${last.durability}.`);
          }
        } else {
          actions.push(`Release ${c.issue} with task_release (claim_id ${c.claim_id}, fence ${c.fence}): this closed workspace still holds it.`);
        }
      } else if (c.state === 'expired') {
        actions.push(`Lease on ${c.issue} expired: stop writing; check task_status, then task_claim again if it is still ready.`);
      } else if (c.state === 'lost') {
        actions.push(`${c.issue} is no longer held by this workspace: do not write; pick another task with tasks_list.`);
      } else {
        actions.push(`Ledger unreachable for ${c.issue}: do not write until task_status confirms the lease.`);
      }
    }
    for (const j of jobs.filter(j => ACTIVE_JOB_STATUSES.includes(j.status))) {
      actions.push(`Job ${j.job_id} is ${j.status}: follow it with job_status or job_events.`);
    }
    if (active && worktrees.length && !claims.some(c => c.state === 'still_held')) {
      actions.push('Active worktrees remain without a held task: claim their task again or remove them with worktree_remove.');
    }
    if (active && !claims.length) actions.push('No task held: pick one with tasks_list, then task_claim.');
    return actions.slice(0, RECOVER.actions).map(a => a.slice(0, 300));
  }

  // GitHub for batches: injected in tests, else the shared integration (server/integrations/
  // github.mjs, loaded lazily: it imports this module).
  let gitHubClient = github;
  async function gitHub() {
    if (!gitHubClient) {
      const { createGitHub } = await import('../integrations/github.mjs');
      gitHubClient = createGitHub({ catalogOptions });
    }
    return gitHubClient;
  }

  // The batch repository of a project: its GitHub origin, which must be in the ledger
  // allowlist (else no task of the batch could ever be claimed).
  async function batchRepo(projectName) {
    const project = await resolve(projectName);
    if (!project.ok) return project;
    const origin = await projectRemote(project.project);
    if (!origin) return fail('project_origin_unknown');
    const allowlist = await readAllowlist();
    if (!allowlist.ok) return allowlist;
    const repo = allowlist.repos.find(r => r.toLowerCase() === origin.toLowerCase());
    if (!repo) return fail('repo_not_allowed');
    const [owner, name] = repo.split('/');
    return { ok: true, project: project.project.name, repo: { full: repo, owner, name } };
  }

  // The Issues of a batch, newest data from GitHub, with their owner/repo#n reference.
  async function batchIssues(repo, batch) {
    const listed = await (await gitHub()).labelledIssues(repo, batchLabel(batch), { limit: BATCH_SCAN });
    if (!listed.ok) return listed;
    return { ok: true, issues: listed.issues.map(i => ({ ...i, ref: `${repo.full}#${i.number}` })) };
  }

  const claimRules = { ready: READY_LABEL, priorities: PRIORITIES, blocking: BLOCKING_LABELS };
  const liveLocal = (claim, at) => claim?.state === 'claimed' && Date.parse(claim.expires_at) > at;

  // What task_next hands a worker conversation: the task, its claim and the fixed steps.
  function nextTask(issue, claim, workspaceId) {
    const parsed = parseTaskBody(issue.body);
    return { issue: issue.ref, title: issue.title, url: issue.url,
      priority: (priorityOf(issue, PRIORITIES) ?? '').slice('priority:'.length) || null,
      scope: parsed.scope, acceptance: parsed.acceptance, ...(parsed.scope || parsed.acceptance ? {} : { body: issue.body }),
      workspace_id: workspaceId, claim_id: claim.claim_id, fence: claim.fence, expires_at: claim.expires_at,
      instructions: workerInstructions({ workspaceId, issue: issue.ref, expiresAt: claim.expires_at }) };
  }

  const operations = {
    async workspaceOpen(args) {
      // A client kind the server derived (principal.client_type, Phase 5 D6) wins over the
      // argument a model wrote; otherwise the argument, as before.
      const clientType = principal.client_type ?? args.client_type ?? 'other';
      if (!CLIENT_TYPES.includes(clientType)) return fail('invalid_input', 'client_type');
      const label = cleanText(args.client_label, 80);
      if (label === undefined) return fail('invalid_input', 'client_label');
      const remote = isRemotePrincipal(principal);
      const hostId = args.host ?? (remote ? REMOTE_HOST : host);
      if (!HOSTS.includes(hostId)) return fail('invalid_input', 'host');
      if (remote && hostId !== REMOTE_HOST) return fail('host_not_remote_enabled');
      if (args.branch !== undefined && args.branch !== null && !validBranch(args.branch)) return fail('invalid_input', 'branch');
      const project = await resolve(args.project);
      if (!project.ok) return project;
      const id = newId('ws');
      return write((repo, at) => {
        const row = { id, principal: principal.id, client_type: clientType, client_label: label,
          project_id: project.project.name, host: hostId, branch: args.branch ?? null, status: 'active',
          created_at: at, updated_at: at };
        repo.insertWorkspace(row);
        return { ok: true, workspace: publicWorkspace({ ...row, closed_at: null }), worker: workerFor(row) };
      });
    },

    async workspaceStatus(args) {
      const ws = await ownedWorkspace(args.workspace_id, { requireActive: false });
      if (ws.error) return ws.error;
      const { claims, requests } = await read(repo => ({ claims: repo.claimsOf(ws.workspace.id, 'claimed'),
        requests: repo.listEvents({ workspace_id: ws.workspace.id, with_request_id: true, limit: REQUESTS_SHOWN }) }));
      // Outcomes of the last calls that carried a hub request id (how an 'accepted' answer is
      // resolved, REQ-P5-15), and the ones still running in this process.
      const running = [...IN_FLIGHT.entries()].filter(([, r]) => r.workspace_id === ws.workspace.id && r.principal === principal.id)
        .slice(0, REQUESTS_SHOWN).map(([id, r]) => ({ request_id: id, op: r.op, started_at: iso(r.started) }));
      return { ok: true, workspace: publicWorkspace(ws.workspace), worker: workerFor(ws.workspace),
        claims: claims.map(publicClaim),
        ...(requests.length ? { requests: requests.map(e => ({ request_id: e.request_id, op: e.op, outcome: e.outcome,
          code: e.code, at: iso(e.at) })) } : {}),
        ...(running.length ? { in_flight: running } : {}) };
    },

    async workspaceList(args) {
      if (args.status !== undefined && !['active', 'closed'].includes(args.status)) return fail('invalid_input', 'status');
      const max = limitOf(args.limit);
      if (max === undefined) return fail('invalid_input', 'limit');
      const rows = await read(repo => repo.listWorkspaces({ principal: principal.id, status: args.status, limit: max }));
      return { ok: true, count: rows.length, workspaces: rows.map(publicWorkspace) };
    },

    // Closing releases this workspace's claims in the ledger (outcome cancelled). It is safe
    // to call again: a closed workspace still releases any claim left recorded as held, for
    // example when the ledger was unreachable the first time.
    async workspaceClose(args, meta) {
      const ws = await ownedWorkspace(args.workspace_id, { requireActive: false });
      if (ws.error) return ws.error;
      // Close first, so no new claim can be recorded for this workspace from now on, and cancel
      // its jobs in the same transaction: no job runs on for a closed workspace.
      const stopped = await write((repo, at) => {
        if (ws.workspace.status !== 'closed') repo.updateWorkspace(ws.workspace.id, { status: 'closed', closed_at: at, updated_at: at });
        return cancelActiveJobs(repo, { workspaceId: ws.workspace.id }, at, principal.id);
      });
      stopCancelledJobs(stopped);
      const claims = await read(repo => repo.claimsOf(ws.workspace.id, 'claimed'));
      const released = []; const lost = []; const unreleased = [];
      for (const claim of claims) {
        const outcome = await releaseRecorded(ws.workspace, claim, 'cancelled');
        if (outcome.state === 'unreleased') { unreleased.push({ issue: claim.issue_ref, error: outcome.error }); continue; }
        await write((repo, at) => repo.updateClaim(claim.claim_id, { state: 'released',
          outcome: outcome.state === 'released' ? 'cancelled' : 'lost', fence_sha: outcome.fence ?? claim.fence_sha, updated_at: at },
        claim.fence_sha));
        (outcome.state === 'released' ? released : lost).push(claim.issue_ref);
        if (outcome.state === 'released') {
          void sync?.taskReleased({ issue: claim.issue_ref, outcome: 'cancelled' },
            syncing({ workspace_id: ws.workspace.id, issue: claim.issue_ref }, meta));
        }
      }
      const workspace = await read(repo => repo.getWorkspace(ws.workspace.id));
      return { ok: true, workspace: publicWorkspace(workspace), released, lost, unreleased,
        ...(stopped.length ? { cancelled_jobs: stopped.map(j => j.job_id) } : {}) };
    },

    // Read-only snapshot for a session that lost its context: what it holds according to the
    // ledger (not only the local mirror), where its work is, and what to do next. Never writes,
    // not even to reconcile the mirror: workspace_close and task_release do that.
    async workspaceRecover(args) {
      const ws = await ownedWorkspace(args.workspace_id, { requireActive: false });
      if (ws.error) return ws.error;
      const workspace = ws.workspace;
      const local = await read(repo => ({
        held: repo.claimsOf(workspace.id, 'claimed'),
        all: repo.claimsOf(workspace.id),
        worktrees: repo.listWorktrees({ workspace_id: workspace.id, status: 'active', limit: RECOVER.worktrees }),
        jobs: repo.listJobs({ workspace_id: workspace.id, limit: RECOVER.jobs })
      }));
      // claimsOf orders by updated_at ascending: reconcile the most recent ones.
      const held = local.held.slice(-RECOVER.claims).reverse();
      const claims = await Promise.all(held.map(c => reconcile(workspace, c)));
      // Checkpoints of every Issue this workspace ever claimed, from any workspace: another
      // machine's pushed commit is exactly what a resuming session needs.
      const issues = [...new Set(local.all.slice(-20).map(c => c.issue_ref))];
      const checkpoints = (await read(repo => issues.flatMap(ref => repo.listCheckpoints(ref, RECOVER.checkpoints))))
        .sort((a, b) => b.at - a.at || b.id - a.id).slice(0, RECOVER.checkpoints).map(publicCheckpoint);
      const worktrees = local.worktrees.map(publicWorktree);
      const jobs = local.jobs.map(publicJob);
      return { ok: true, workspace: publicWorkspace(workspace), worker: workerFor(workspace), claims,
        claims_truncated: local.held.length > held.length, worktrees, checkpoints, jobs,
        next_actions: nextActions(workspace, claims, checkpoints, jobs, worktrees) };
    },

    // Claimable Issues of the repositories that are both a registered project's GitHub origin
    // and in the ledger allowlist. The ledger stays the authority: task_claim re-checks it all.
    async tasksList(args) {
      const max = limitOf(args.limit, TASKS_LIMIT.default, TASKS_LIMIT.max);
      if (max === undefined) return fail('invalid_input', 'limit');
      let projects;
      if (args.project !== undefined) {
        const refusal = remoteProjectRefusal(principal, args.project, remotePolicy);
        if (refusal) return refusal;
        const project = await resolve(args.project);
        if (!project.ok) return project;
        projects = [project.project];
      } else {
        if (remote && !remotePolicy.configured) return remoteProjectRefusal(principal, null, remotePolicy);
        try { projects = (await listProjectRepos()).slice(0, TASKS_SCAN.projects); } catch { return fail('catalog_unavailable'); }
        // A remote principal only ever sees the allowlisted projects (D9, REQ-P5-09).
        if (remote) projects = projects.filter(p => remotePolicy.projects.includes(p.name));
      }
      const allowlist = await readAllowlist();
      if (!allowlist.ok) return allowlist;
      const allowed = new Map(allowlist.repos.map(r => [r.toLowerCase(), r]));
      const origins = await Promise.all(projects.map(async p => ({ name: p.name, origin: await projectRemote(p) })));
      const repoProjects = new Map();
      const notAllowed = [];
      for (const { name, origin } of origins) {
        if (!origin) continue;
        const repo = allowed.get(origin.toLowerCase());
        if (!repo) { notAllowed.push(name); continue; }
        // Two registered projects on one origin: the first registered name wins.
        if (!repoProjects.has(repo.toLowerCase())) repoProjects.set(repo.toLowerCase(), { name, repo });
      }
      if (args.project !== undefined) {
        if (!origins[0].origin) return fail('project_origin_unknown');
        if (notAllowed.length) return fail('repo_not_allowed');
      }
      const repos = [...repoProjects.values()].map(p => p.repo).sort();
      const chunks = [];
      for (let i = 0; i < repos.length && chunks.length < TASKS_SCAN.queries; i += TASKS_SCAN.reposPerQuery) {
        chunks.push(repos.slice(i, i + TASKS_SCAN.reposPerQuery));
      }
      let truncated = repos.length > TASKS_SCAN.queries * TASKS_SCAN.reposPerQuery;
      const items = [];
      for (const chunk of chunks) {
        const page = await searchIssues(tasksQuery(chunk));
        if (!page.ok) return fail('github_unavailable', page.detail);
        if (page.incomplete || page.total_count > page.items.length) truncated = true;
        items.push(...page.items.slice(0, TASKS_SCAN.perPage));
      }
      const tasks = rankTasks(items, repoProjects);
      return { ok: true, count: Math.min(tasks.length, max), tasks: tasks.slice(0, max),
        repositories: repos, not_allowed: notAllowed.sort().slice(0, 50), truncated: truncated || tasks.length > max,
        lease: 'not included; call task_status for the shared lease of one task' };
    },

    async taskStatus(args) {
      const issue = parseIssueRef(args.issue);
      if (!issue) return fail('invalid_input', 'issue');
      if (remote && !(await remoteOrigins()).has(issue.repo.toLowerCase())) return fail('project_not_allowed');
      const lease = await ledger.status(issue);
      const checkpoints = await read(repo => repo.listCheckpoints(issue.ref, 20));
      if (!lease.ok) return { ...lease, checkpoints: checkpoints.map(publicCheckpoint) };
      return { ok: true, issue: issue.ref, lease: lease.receipt, checkpoints: checkpoints.map(publicCheckpoint) };
    },

    async taskClaim(args, meta) {
      const issue = parseIssueRef(args.issue);
      if (!issue) return fail('invalid_input', 'issue');
      const ttl = ttlOf(args.ttl_seconds);
      if (ttl === undefined) return fail('invalid_input', 'ttl_seconds');
      const ws = await ownedWorkspace(args.workspace_id);
      if (ws.error) return ws.error;
      // The issue must belong to the workspace's project when its origin is known.
      const project = await resolveProject(ws.workspace.project_id);
      const origin = project.ok ? await projectRemote(project.project) : null;
      if (origin && origin.toLowerCase() !== issue.repo.toLowerCase()) return fail('project_mismatch');
      // Remotely the Issue must be proven to belong to the allowlisted project (D9).
      if (remote && !origin) return fail('project_origin_unknown');
      const worker = workerFor(ws.workspace);
      let receipt; let recovered = false;
      const result = await ledger.claim(issue, worker, ttl);
      if (result.ok) {
        receipt = result.receipt;
      } else if (UNCERTAIN.has(result.error)) {
        // The write may have landed (timeout) or lost a ref race reported as an API failure.
        const holder = await whoHolds(issue, worker);
        if (holder?.mine) { receipt = holder.mine; recovered = true; }
        else if (holder?.other) return fail('lease_held');
        else if (holder === null) return fail('ledger_unavailable', 'nothing was claimed');
        else return result;
      } else {
        return result;
      }
      let recorded;
      try {
        recorded = await write((repo, at) => {
          // Re-read inside the transaction: a concurrent workspace_close must win.
          if (repo.getWorkspace(ws.workspace.id)?.status !== 'active') return false;
          repo.insertClaim({ claim_id: receipt.claim_id, workspace_id: ws.workspace.id, issue_ref: issue.ref,
            fence_sha: receipt.fence_sha, epoch: receipt.epoch, expires_at: receipt.expires_at, updated_at: at });
          return true;
        });
      } catch {
        recorded = null;
      }
      if (!recorded) {
        // Never leave a lease nobody can release: give it back before reporting the failure.
        const back = await ledger.release(issue, worker, receipt.claim_id, receipt.fence_sha, 'cancelled');
        return fail(recorded === false ? 'workspace_closed' : 'store_unavailable',
          back.ok ? 'claim released' : `claim may remain until ${receipt.expires_at}`);
      }
      // Also covers task_next and the takeover of an expired lease: the new holder is Réservé.
      void sync?.taskClaimed({ issue: issue.ref, clientType: ws.workspace.client_type },
        syncing({ workspace_id: ws.workspace.id, issue: issue.ref }, meta));
      return { ok: true, issue: issue.ref, worker, claim_id: receipt.claim_id, fence: receipt.fence_sha, epoch: receipt.epoch,
        expires_at: receipt.expires_at, project_origin_verified: Boolean(origin), ...(recovered ? { recovered: true } : {}) };
    },

    async taskRenew(args) {
      const ttl = ttlOf(args.ttl_seconds);
      if (ttl === undefined) return fail('invalid_input', 'ttl_seconds');
      const held = await heldClaim(args);
      if (held.error) return held.error;
      const worker = workerFor(held.workspace);
      let r;
      const result = await ledger.heartbeat(held.issue, worker, args.claim_id, args.fence, ttl);
      if (result.ok) {
        r = result.receipt;
      } else if (result.error === 'ledger_outcome_unknown') {
        const holder = await whoHolds(held.issue, worker);
        if (holder?.mine?.claim_id !== args.claim_id) return result;
        r = holder.mine;
      } else {
        return result;
      }
      await write((repo, at) => repo.updateClaim(args.claim_id, { fence_sha: r.fence_sha, expires_at: r.expires_at, updated_at: at },
        held.claim.fence_sha));
      return { ok: true, issue: held.issue.ref, claim_id: args.claim_id, fence: r.fence_sha, expires_at: r.expires_at };
    },

    async taskRelease(args, meta) {
      if (!OUTCOMES.includes(args.outcome)) return fail('invalid_input', 'outcome');
      return releaseHeld(args, args.outcome, null, meta);
    },

    // task_release with outcome completed and an optional summary kept with the claim.
    async taskComplete(args, meta) {
      const summary = cleanText(args.summary, SUMMARY_MAX, { multiline: true });
      if (summary === undefined) return fail('invalid_input', 'summary');
      return releaseHeld(args, 'completed', summary, meta);
    },

    // The checkpoint is a write boundary: the ledger verifies the fence immediately before it.
    async taskCheckpoint(args) {
      if (!validBranch(args.branch)) return fail('invalid_input', 'branch');
      if (typeof args.commit !== 'string' || !COMMIT_RE.test(args.commit.toLowerCase())) return fail('invalid_input', 'commit');
      const commit = args.commit.toLowerCase();
      const note = cleanText(args.note, 500, { multiline: true });
      if (note === undefined) return fail('invalid_input', 'note');
      const held = await heldClaim(args);
      if (held.error) return held.error;
      // Git first (it can be slow), then the ledger verify, then the insert at once.
      const project = await resolveProject(held.workspace.project_id);
      const check = await verifyCheckpoint({ repoPath: project.ok ? project.project.repoPath : null, branch: args.branch, commit });
      if (!check.ok) return fail(check.error);
      const verified = await ledger.verify(held.issue, workerFor(held.workspace), args.claim_id, args.fence);
      if (!verified.ok) return verified;
      return write((repo, at) => {
        repo.insertCheckpoint({ issue_ref: held.issue.ref, claim_id: args.claim_id, workspace_id: held.workspace.id,
          fence_sha: args.fence, branch: args.branch, commit_sha: commit, durability: check.durability, note, at });
        return { ok: true, issue: held.issue.ref, branch: args.branch, commit, durability: check.durability,
          ...(check.durability === 'remote' ? {} : {
            warning: check.durability === 'local_only'
              ? 'Commit is not reachable from origin/<branch> locally; another machine cannot resume from it yet.'
              : 'Repository not available on this host; commit was not verified.'
          }) };
      });
    }
  };

  // Batches (TODO-P5-50 to 52). A batch is a label on ordinary claimable Issues; claims go
  // through operations.taskClaim, the same path as task_claim.
  Object.assign(operations, {
    // Create up to BATCH_MAX Issues labelled agent:ready, priority:<p> and agent:batch-<id>.
    // Stops at the first failure and reports what exists: the answer is ok either way (a
    // retry with the same client_request_id replays it and never creates duplicates).
    async batchCreate(args, meta) {
      const checked = validateBatchTasks(args.tasks);
      if (checked.error) return fail('invalid_input', checked.error);
      const name = batchLabelText(args.name);
      if (name === undefined) return fail('invalid_input', 'name');
      const target = await batchRepo(args.project);
      if (!target.ok) return target;
      const gh = await gitHub();
      const batch = newBatchId();
      const label = batchLabel(batch);
      const made = await gh.ensureLabel(target.repo, { name: label, color: BATCH_LABEL_COLOR,
        description: (name ? `Memo Bridge batch: ${name}` : 'Memo Bridge batch').slice(0, 100) });
      if (!made.ok) return made;
      const created = []; let failure = null;
      for (const task of checked.tasks) {
        const labels = [READY_LABEL, `priority:${task.priority}`, label];
        const r = await gh.createIssue(target.repo, { title: task.title, body: issueBody(task, batch, name), labels });
        if (!r.ok) { failure = { index: created.length, error: r.error, ...(r.uncertain ? { uncertain: true } : {}) }; break; }
        // Labels set by someone without push access are silently dropped (GitHub REST docs,
        // "Create an issue"): an Issue without them would never be claimable.
        const missing = labels.filter(l => !(r.issue.labels ?? []).includes(l));
        created.push({ issue: `${target.repo.full}#${r.issue.number}`, number: r.issue.number, title: r.issue.title,
          url: r.issue.url, priority: task.priority, ...(missing.length ? { missing_labels: missing } : {}) });
        void sync?.taskCreated({ issue: `${target.repo.full}#${r.issue.number}`, priority: task.priority, batch, name },
          syncing({ issue: `${target.repo.full}#${r.issue.number}` }, meta));
        if (missing.length) { failure = { index: created.length - 1, error: 'labels_dropped' }; break; }
      }
      return { ok: true, batch, label, project: target.project, repo: target.repo.full, count: created.length, tasks: created,
        ...(failure ? { partial: true, failed: failure, not_created: checked.tasks.length - created.length +
          (failure.error === 'labels_dropped' ? 1 : 0) } : {}),
        paste: pasteSentence(batch, target.project),
        next: 'Open one ChatGPT conversation per task and paste the sentence in each. Follow progress with batch_status.' };
    },

    // Claim the next ready, unclaimed task of a batch for this workspace. A claim the ledger
    // refuses because someone else got there first moves on to the next task.
    async taskNext(args, meta) {
      if (!BATCH_ID_RE.test(args.batch ?? '')) return fail('invalid_input', 'batch');
      const ttl = ttlOf(args.ttl_seconds);
      if (ttl === undefined) return fail('invalid_input', 'ttl_seconds');
      const ws = await ownedWorkspace(args.workspace_id);
      if (ws.error) return ws.error;
      const target = await batchRepo(ws.workspace.project_id);
      if (!target.ok) return target;
      const listed = await batchIssues(target.repo, args.batch);
      if (!listed.ok) return listed;
      if (!listed.issues.length) return fail('unknown_batch');
      const byRef = new Map(listed.issues.map(i => [i.ref, i]));
      const local = await read((repo, at) => ({ at,
        mine: repo.claimsOf(ws.workspace.id, 'claimed').filter(c => byRef.has(c.issue_ref) && Date.parse(c.expires_at) > at),
        others: new Set(listed.issues.filter(i => repo.claimsOfIssue(i.ref, 5).some(c => c.workspace_id !== ws.workspace.id &&
          liveLocal(c, at))).map(i => i.ref)) }));
      // One task per conversation: a workspace that already holds one of the batch gets it back.
      if (local.mine.length) {
        const c = local.mine[local.mine.length - 1];
        return { ok: true, done: false, already_held: true, batch: args.batch,
          task: nextTask(byRef.get(c.issue_ref), { claim_id: c.claim_id, fence: c.fence_sha, expires_at: c.expires_at }, ws.workspace.id) };
      }
      const candidates = claimOrder(listed.issues.filter(i => isClaimable(i, claimRules) && !local.others.has(i.ref)), PRIORITIES,
        new Set(listed.issues.filter(i => claiming(i.ref)).map(i => i.ref))).slice(0, BATCH_MAX);
      const skipped = [];
      for (const issue of candidates) {
        holdClaiming(issue.ref);
        let claim;
        try { claim = await operations.taskClaim({ workspace_id: ws.workspace.id, issue: issue.ref, ttl_seconds: ttl }, meta); }
        finally { dropClaiming(issue.ref); }
        if (claim.ok) {
          return { ok: true, done: false, batch: args.batch, task: nextTask(issue, claim, ws.workspace.id),
            ...(skipped.length ? { skipped } : {}) };
        }
        if (!NEXT_ON.has(claim.error)) return { ...claim, ...(skipped.length ? { skipped } : {}) };
        skipped.push({ issue: issue.ref, error: claim.error });
      }
      const open = listed.issues.filter(i => i.state === 'open').length;
      return { ok: true, done: true, batch: args.batch, open_tasks: open, held_elsewhere: local.others.size + skipped.length,
        detail: 'no ready, unclaimed task left in this batch' };
    },

    // Per task: state, holder, pull requests; counts and stale leases. Reads only.
    async batchStatus(args, meta) {
      if (!BATCH_ID_RE.test(args.batch ?? '')) return fail('invalid_input', 'batch');
      const target = await batchRepo(args.project);
      if (!target.ok) return target;
      const listed = await batchIssues(target.repo, args.batch);
      if (!listed.ok) return listed;
      if (!listed.issues.length) return fail('unknown_batch');
      const leases = await Promise.all(listed.issues.map(i => ledger.status(parseIssueRef(i.ref)).catch(() => fail('ledger_unavailable'))));
      const local = await read((repo, at) => ({ at, rows: listed.issues.map(i => {
        const claims = repo.claimsOfIssue(i.ref, 5);
        const branches = repo.listWorktrees({ issue_ref: i.ref, limit: 5 }).map(w => w.branch);
        const workspaces = new Map(claims.map(c => [c.workspace_id, repo.getWorkspace(c.workspace_id)]));
        return { claims, branches, workspaces };
      }) }));
      const pulls = await (await gitHub()).linkedPulls(target.repo, { numbers: listed.issues.map(i => i.number),
        branches: new Map(listed.issues.map((i, k) => [i.number, local.rows[k].branches])) });
      const tasks = listed.issues.map((issue, k) => {
        const lease = leases[k]?.ok ? leases[k].receipt : null;
        const row = local.rows[k];
        // The local claim the ledger's current lease is about, else the most recent one.
        const claim = row.claims.find(c => lease?.claim_id && c.claim_id === lease.claim_id) ?? row.claims[0] ?? null;
        const decoded = claim ? decodeOutcome(claim.outcome) : { outcome: null };
        const state = taskState(issue, lease, claim ? { ...claim, outcome: decoded.outcome } : null, { ...claimRules, now: local.at });
        const ws = claim ? row.workspaces.get(claim.workspace_id) : null;
        const holder = lease?.state === 'claimed' ? { worker: lease.worker, expires_at: lease.expires_at,
          ...(ws && claim?.claim_id === lease.claim_id ? { workspace_id: ws.id, client_type: ws.client_type,
            // Labels are free text of another principal's session: shown only for your own.
            ...(ownsWorkspace(principal, ws) ? { client_label: ws.client_label, mine: true } : { mine: false }) } : {}) } : null;
        return { issue: issue.ref, number: issue.number, title: issue.title, url: issue.url, state,
          priority: (priorityOf(issue, PRIORITIES) ?? '').slice('priority:'.length) || null,
          ...(holder ? { holder } : {}), ...(leases[k]?.ok ? {} : { lease_error: leases[k]?.error ?? 'ledger_unavailable' }),
          ...(decoded.outcome && state !== 'claimed' ? { last_outcome: decoded.outcome } : {}),
          pull_requests: pulls.ok ? (pulls.pulls.get(issue.number) ?? []) : null };
      });
      const counts = Object.fromEntries(TASK_STATES.map(s => [s, tasks.filter(t => t.state === s).length]).filter(([, n]) => n));
      const stale = tasks.filter(t => t.state === 'stale').map(t => ({ issue: t.issue, worker: t.holder?.worker ?? null,
        expired_at: t.holder?.expires_at ?? null }));
      // An expired lease can be taken over by anyone: the board shows the task as Prêt again.
      // Only a principal that may write moves the board; a read-only caller just reads.
      if (sync && principal.capabilities.has(CAPABILITIES.WRITE)) {
        for (const t of stale) {
          void sync.taskStale({ issue: t.issue, lease: `${t.worker ?? ''}@${t.expired_at ?? ''}` }, syncing({ issue: t.issue }, meta));
        }
      }
      return { ok: true, batch: args.batch, project: target.project, repo: target.repo.full, total: tasks.length, counts,
        stale_leases: stale, tasks, ...(pulls.ok ? {} : { pull_requests_error: pulls.error }),
        truncated: listed.issues.length >= BATCH_SCAN,
        ...(sync ? { project_url: sync.url() } : projectSync?.error ? { project_sync_error: projectSync.error } : {}) };
    }
  });

  // Every call: authorization first (so every refusal is journaled whatever the arguments),
  // then the operation, then the journal entry. Store failures never crash the server.
  // The operation name is the MCP tool name and the policy key (policy.mjs OPERATION_CAPABILITY).
  const METHOD_OPERATION = {
    workspaceOpen: 'workspace_open', workspaceStatus: 'workspace_status', workspaceList: 'workspace_list',
    workspaceClose: 'workspace_close', workspaceRecover: 'workspace_recover',
    tasksList: 'tasks_list', taskStatus: 'task_status', taskClaim: 'task_claim', taskRenew: 'task_renew',
    taskRelease: 'task_release', taskComplete: 'task_complete', taskCheckpoint: 'task_checkpoint',
    batchCreate: 'batch_create', taskNext: 'task_next', batchStatus: 'batch_status'
  };
  // GitHub origins (owner/repo, lower case) of the allowlisted projects, for remote principals.
  async function remoteOrigins() {
    const origins = new Set();
    if (!remotePolicy.configured) return origins;
    for (const name of remotePolicy.projects) {
      const project = await resolveProject(name);
      const origin = project?.ok ? await projectRemote(project.project) : null;
      if (origin) origins.add(origin.toLowerCase());
    }
    return origins;
  }

  // The project an op works on, for the allowlist: the argument of workspace_open, else the
  // project of the owned workspace it names. null when there is nothing to check yet (the
  // operation itself then refuses the unknown or foreign workspace).
  async function projectOf(op, args) {
    if (op === 'workspace_open' || op === 'batch_create' || op === 'batch_status') return typeof args.project === 'string' ? args.project : '';
    if (!WS_RE.test(args.workspace_id ?? '')) return null;
    const workspace = await read(repo => repo.getWorkspace(args.workspace_id));
    return workspace && ownsWorkspace(principal, workspace) ? workspace.project_id : null;
  }

  // The checks and bookkeeping around one operation. Returns {result, warning}.
  async function guarded(op, method, args, meta) {
    if (remote && REMOTE_PROJECT_OPS.has(op)) {
      const project = await projectOf(op, args);
      const refusal = project === null ? null : remoteProjectRefusal(principal, project, remotePolicy);
      if (refusal) return { result: refusal };
    }
    let warning = null;
    if (BOUND_OPS.has(op) && meta.client_session && WS_RE.test(args.workspace_id ?? '')) {
      const workspace = await read(repo => repo.getWorkspace(args.workspace_id));
      if (workspace && ownsWorkspace(principal, workspace)) {
        const decision = sessionBindingDecision(workspace.client_session, meta.client_session, remotePolicy.session_binding);
        if (!decision.ok) return { result: decision, mismatch: true };
        warning = decision.warning ?? null;
      }
    }
    const run = () => operations[method](args, meta);
    let result = IDEMPOTENT_OPS.has(op)
      ? await runOnce(store, { principal: principal.id, op, clientRequestId: args.client_request_id, now: now() }, run)
      : await run();
    if (op === 'workspace_open' && result?.ok && meta.client_session) {
      // D8: the conversation that opened the workspace is the one it is bound to.
      await write(repo => repo.updateWorkspace(result.workspace.workspace_id, { client_session: meta.client_session }));
    }
    if (op === 'workspace_recover' && result?.ok && meta.client_session) result = { ...result, session: await rebind(result, meta) };
    if (warning && result && typeof result === 'object') result = { ...result, session_warning: warning };
    return { result, warning, mismatch: Boolean(warning) };
  }

  // workspace_recover rebinds the workspace to the recovering conversation (D8, scenario D),
  // explicitly and journaled. Only a principal that may write does it, on an active workspace.
  async function rebind(recovered, meta) {
    const id = recovered.workspace.workspace_id;
    const current = await read(repo => repo.getWorkspace(id));
    if (!current) return { bound: false };
    if (current.client_session === meta.client_session) return { bound: true, rebound: false };
    if (current.status !== 'active') return { bound: false, rebound: false, reason: 'workspace_closed' };
    if (!principal.capabilities.has(CAPABILITIES.WRITE)) return { bound: false, rebound: false, reason: 'read_only' };
    await write(repo => repo.updateWorkspace(id, { client_session: meta.client_session, updated_at: now() }));
    await note('workspace_rebind', 'ok', current.client_session ? 'session_changed' : 'session_bound', { workspace_id: id }, meta);
    return { bound: true, rebound: true };
  }

  // Every call: authorization first (so every refusal is journaled whatever the arguments),
  // then the remote guards, then the operation, then the journal entry. Store failures never
  // crash the server. `rawMeta` is the per-request metadata the runtime received next to the
  // principal ({client_session, request_id}, bridge/forward.mjs); it is never read from args.
  const api = { principal: principal.id };
  for (const [method, op] of Object.entries(METHOD_OPERATION)) {
    api[method] = async (raw = {}, rawMeta = null) => {
      const args = raw ?? {};
      const meta = requestMeta(rawMeta);
      const ids = { workspace_id: args.workspace_id, issue: args.issue };
      if (!authorize(principal, op)) {
        const denied = fail('forbidden');
        await journal(op, denied, ids, meta);
        return denied;
      }
      const tracked = meta.request_id && IN_FLIGHT.size < IN_FLIGHT_MAX ? meta.request_id : null;
      if (tracked) IN_FLIGHT.set(tracked, { op, principal: principal.id, started: now(),
        workspace_id: WS_RE.test(args.workspace_id ?? '') ? args.workspace_id : null });
      let outcome;
      try { outcome = await guarded(op, method, args, meta); } catch {
        outcome = { result: fail('store_unavailable') };
      } finally {
        if (tracked) IN_FLIGHT.delete(tracked);
      }
      const { result } = outcome;
      const journalIds = { ...ids, workspace_id: ids.workspace_id ?? result?.workspace?.workspace_id,
        // task_next journals the Issue it claimed.
        issue: ids.issue ?? result?.task?.issue };
      if (outcome.mismatch) {
        // A session mismatch is journaled on its own row as well, whatever the mode.
        await note('session_check', result?.ok === false ? 'denied' : 'ok', 'session_mismatch', journalIds, meta);
      }
      await journal(op, result, journalIds, meta);
      return result;
    };
  }
  return Object.freeze(api);
}
