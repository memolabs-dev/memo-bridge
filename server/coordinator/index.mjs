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
import { authorize, ownsWorkspace } from './policy.mjs';
import { COMMIT_RE, validBranch, verifyCheckpoint } from './checkpoints.mjs';
import { LEASE_TTL, OUTCOMES, defaultGovernanceRoot, parseIssueRef } from './issue-lease.mjs';

export const CLIENT_TYPES = Object.freeze(['chatgpt', 'claude-code', 'codex', 'opencode', 'hermes', 'cuesheet', 'cli', 'other']);
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
  'repo_not_allowed', 'issue_not_ready', 'issue_changed', 'lease_race_lost', 'lease_denied']);
const UNCERTAIN = new Set(['ledger_unavailable', 'ledger_outcome_unknown']);
const MAX_LIST = 200;
const WRITES = new Set(['workspace_open', 'workspace_close', 'task_claim', 'task_renew', 'task_release', 'task_complete',
  'task_checkpoint']);
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

// The worker identity recorded in the ledger. It is derived from the workspace, so another
// workspace, even of the same principal, can never act on this claim.
export const workerFor = workspace => `mb.${workspace.host}.${workspace.id}`;

export function createCoordinator({ store, principal, ledger, now = Date.now, catalogOptions = {},
  resolveProject = name => catalogResolver(name, catalogOptions), projectRemote = gitHubRemote, host = defaultHost(),
  listProjectRepos = () => catalogRepos(catalogOptions), governanceRoot = defaultGovernanceRoot(),
  readAllowlist = () => readPublicAllowlist(governanceRoot), searchIssues = query => ghSearchIssues(query) }) {
  if (!store || !principal || !ledger) throw new Error('coordinator_requires_store_principal_and_ledger');

  const audit = (repo, op, outcome, code, ids = {}) => repo.appendEvent({
    at: now(), principal: principal.id,
    // Only well-formed identifiers reach the journal; arbitrary caller text never does.
    workspace_id: WS_RE.test(ids.workspace_id ?? '') ? ids.workspace_id : null,
    issue_ref: parseIssueRef(ids.issue) ? ids.issue : null,
    op, outcome, code: code ?? null
  });
  // Writes always journal their outcome; reads journal only refusals.
  const journal = (op, result, ids) => {
    const failed = result?.ok === false;
    if (!WRITES.has(op) && !(failed && DENIED.has(result.error))) return Promise.resolve();
    const outcome = failed ? (DENIED.has(result.error) ? 'denied' : 'error') : 'ok';
    return store.transaction(repo => audit(repo, op, outcome, failed ? result.error : null, ids)).catch(() => {});
  };
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
  async function releaseHeld(args, outcome, summary) {
    const held = await heldClaim(args, { requireActive: false });
    if (held.error) return held.error;
    if (held.claim.state === 'released') {
      return { ok: true, issue: held.issue.ref, released: true, ...publicOutcome(held.claim.outcome) };
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
    return { ok: true, issue: held.issue.ref, released: true, outcome, ...(summary ? { summary } : {}) };
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
    for (const j of jobs.filter(j => j.status === 'queued' || j.status === 'running')) {
      actions.push(`Job ${j.job_id} is ${j.status}: follow it with job_status or job_events.`);
    }
    if (active && worktrees.length && !claims.some(c => c.state === 'still_held')) {
      actions.push('Active worktrees remain without a held task: claim their task again or remove them with worktree_remove.');
    }
    if (active && !claims.length) actions.push('No task held: pick one with tasks_list, then task_claim.');
    return actions.slice(0, RECOVER.actions).map(a => a.slice(0, 300));
  }

  const operations = {
    async workspaceOpen(args) {
      const clientType = args.client_type ?? 'other';
      if (!CLIENT_TYPES.includes(clientType)) return fail('invalid_input', 'client_type');
      const label = cleanText(args.client_label, 80);
      if (label === undefined) return fail('invalid_input', 'client_label');
      const hostId = args.host ?? host;
      if (!HOSTS.includes(hostId)) return fail('invalid_input', 'host');
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
      const claims = await read(repo => repo.claimsOf(ws.workspace.id, 'claimed'));
      return { ok: true, workspace: publicWorkspace(ws.workspace), worker: workerFor(ws.workspace),
        claims: claims.map(publicClaim) };
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
    async workspaceClose(args) {
      const ws = await ownedWorkspace(args.workspace_id, { requireActive: false });
      if (ws.error) return ws.error;
      // Close first, so no new claim can be recorded for this workspace from now on.
      await write((repo, at) => {
        if (ws.workspace.status !== 'closed') repo.updateWorkspace(ws.workspace.id, { status: 'closed', closed_at: at, updated_at: at });
      });
      const claims = await read(repo => repo.claimsOf(ws.workspace.id, 'claimed'));
      const released = []; const lost = []; const unreleased = [];
      for (const claim of claims) {
        const outcome = await releaseRecorded(ws.workspace, claim, 'cancelled');
        if (outcome.state === 'unreleased') { unreleased.push({ issue: claim.issue_ref, error: outcome.error }); continue; }
        await write((repo, at) => repo.updateClaim(claim.claim_id, { state: 'released',
          outcome: outcome.state === 'released' ? 'cancelled' : 'lost', fence_sha: outcome.fence ?? claim.fence_sha, updated_at: at },
        claim.fence_sha));
        (outcome.state === 'released' ? released : lost).push(claim.issue_ref);
      }
      const workspace = await read(repo => repo.getWorkspace(ws.workspace.id));
      return { ok: true, workspace: publicWorkspace(workspace), released, lost, unreleased };
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
        const project = await resolve(args.project);
        if (!project.ok) return project;
        projects = [project.project];
      } else {
        try { projects = (await listProjectRepos()).slice(0, TASKS_SCAN.projects); } catch { return fail('catalog_unavailable'); }
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
      const lease = await ledger.status(issue);
      const checkpoints = await read(repo => repo.listCheckpoints(issue.ref, 20));
      if (!lease.ok) return { ...lease, checkpoints: checkpoints.map(publicCheckpoint) };
      return { ok: true, issue: issue.ref, lease: lease.receipt, checkpoints: checkpoints.map(publicCheckpoint) };
    },

    async taskClaim(args) {
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

    async taskRelease(args) {
      if (!OUTCOMES.includes(args.outcome)) return fail('invalid_input', 'outcome');
      return releaseHeld(args, args.outcome, null);
    },

    // task_release with outcome completed and an optional summary kept with the claim.
    async taskComplete(args) {
      const summary = cleanText(args.summary, SUMMARY_MAX, { multiline: true });
      if (summary === undefined) return fail('invalid_input', 'summary');
      return releaseHeld(args, 'completed', summary);
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

  // Every call: authorization first (so every refusal is journaled whatever the arguments),
  // then the operation, then the journal entry. Store failures never crash the server.
  // The operation name is the MCP tool name and the policy key (policy.mjs OPERATION_CAPABILITY).
  const METHOD_OPERATION = {
    workspaceOpen: 'workspace_open', workspaceStatus: 'workspace_status', workspaceList: 'workspace_list',
    workspaceClose: 'workspace_close', workspaceRecover: 'workspace_recover',
    tasksList: 'tasks_list', taskStatus: 'task_status', taskClaim: 'task_claim', taskRenew: 'task_renew',
    taskRelease: 'task_release', taskComplete: 'task_complete', taskCheckpoint: 'task_checkpoint'
  };
  const api = { principal: principal.id };
  for (const [method, op] of Object.entries(METHOD_OPERATION)) {
    api[method] = async (raw = {}) => {
      const args = raw ?? {};
      const ids = { workspace_id: args.workspace_id, issue: args.issue };
      if (!authorize(principal, op)) {
        const denied = fail('forbidden');
        await journal(op, denied, ids);
        return denied;
      }
      let result;
      try { result = await operations[method](args); } catch {
        result = fail('store_unavailable');
      }
      await journal(op, result, { ...ids, workspace_id: ids.workspace_id ?? result?.workspace?.workspace_id });
      return result;
    };
  }
  return Object.freeze(api);
}
