// Memo Coordinator: workspaces, tasks, leases with fencing tokens, checkpoints and an
// append-only audit journal. Internal module of Memo Bridge, never a separate MCP server.
import { randomBytes } from 'node:crypto';
import { platform } from 'node:os';
import { projectInfo } from '../catalog.mjs';
import { CAPABILITIES, authorize, ownsWorkspace } from './policy.mjs';
import { checkFence, decideClaim, effectiveStatus, leaseActive, publicLease, releasePatch, ttlMs } from './leases.mjs';
import { COMMIT_RE, validBranch, verifyCheckpoint } from './checkpoints.mjs';

export const CLIENT_TYPES = Object.freeze(['chatgpt', 'claude-code', 'codex', 'opencode', 'hermes', 'cuesheet', 'cli', 'other']);
export const HOSTS = Object.freeze(['mac', 'vps']);
export const TASK_STATUSES = Object.freeze(['open', 'claimed', 'completed']);
const ID_RE = { ws: /^ws_[A-Za-z0-9_-]{16}$/, task: /^task_[A-Za-z0-9_-]{16}$/ };
const ISSUE_REF_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}#[1-9][0-9]{0,8}$/;
const DENIED = new Set(['forbidden', 'stale_lease', 'lease_held', 'workspace_closed', 'task_closed', 'project_mismatch']);
const MAX_LIST = 200;

const newId = prefix => `${prefix}_${randomBytes(12).toString('base64url')}`;
const iso = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail } : {}) });

function cleanText(value, max, { required = false } = {}) {
  if (value === undefined || value === null || value === '') return required ? undefined : null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if ((required && !text) || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return undefined;
  return text || null;
}
function limitOf(value, fallback = 50) {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && value >= 1 && value <= MAX_LIST ? value : undefined;
}

function publicWorkspace(w) {
  return {
    workspace_id: w.id, project: w.project_id, principal: w.principal, client_type: w.client_type,
    client_label: w.client_label, host: w.host, branch: w.branch, status: w.status,
    created_at: iso(w.created_at), closed_at: iso(w.closed_at)
  };
}
function publicTask(t, now) {
  return {
    task_id: t.id, project: t.project_id, title: t.title, issue_ref: t.issue_ref,
    status: effectiveStatus(t, now), lease: publicLease(t, now), created_by: t.created_by,
    created_at: iso(t.created_at), updated_at: iso(t.updated_at), completed_at: iso(t.completed_at),
    summary: t.summary
  };
}
function publicCheckpoint(c) {
  return { task_id: c.task_id, workspace_id: c.workspace_id, generation: c.generation, branch: c.branch,
    commit: c.commit_sha, durability: c.durability, note: c.note, at: iso(c.at) };
}
function publicEvent(e) {
  return { seq: e.seq, at: iso(e.at), principal: e.principal, workspace_id: e.workspace_id, task_id: e.task_id,
    op: e.op, outcome: e.outcome, code: e.code };
}

async function catalogResolver(name, options) {
  const info = await projectInfo(name, options);
  if (!info.ok) return info;
  const p = info.project;
  return { ok: true, project: { name: p.name, repoPath: p.kind === 'repo' && p.available ? p.local_path : null } };
}

export function defaultHost() {
  return platform() === 'darwin' ? 'mac' : 'vps';
}

export function createCoordinator({ store, principal, now = Date.now, catalogOptions = {},
  resolveProject = name => catalogResolver(name, catalogOptions), host = defaultHost() }) {
  if (!store || !principal) throw new Error('coordinator_requires_store_and_principal');
  const writes = new Set(['workspace_open', 'workspace_close', 'task_create', 'task_claim', 'task_renew',
    'task_release', 'task_checkpoint', 'task_complete']);

  const audit = (repo, op, outcome, code, ids = {}) => repo.appendEvent({
    at: now(), principal: principal.id,
    // Only well-formed identifiers reach the journal; arbitrary caller text never does.
    workspace_id: ID_RE.ws.test(ids.workspace_id ?? '') ? ids.workspace_id : null,
    task_id: ID_RE.task.test(ids.task_id ?? '') ? ids.task_id : null,
    op, outcome, code: code ?? null
  });

  // Runs one operation in a transaction and records its outcome. Writes are always audited;
  // reads are audited only when refused, so the journal stays useful rather than noisy.
  async function execute(op, ids, body) {
    if (!authorize(principal, op)) {
      await store.transaction(repo => audit(repo, op, 'denied', 'forbidden', ids)).catch(() => {});
      return fail('forbidden');
    }
    try {
      return await store.transaction(repo => {
        const result = body(repo, now());
        const failed = result && result.ok === false;
        if (writes.has(op) || (failed && DENIED.has(result.error))) {
          const outcome = failed ? (DENIED.has(result.error) ? 'denied' : 'error') : 'ok';
          audit(repo, op, outcome, failed ? result.error : null, ids);
        }
        return result;
      });
    } catch {
      await store.transaction(repo => audit(repo, op, 'error', 'store_unavailable', ids)).catch(() => {});
      return fail('store_unavailable');
    }
  }

  // Shared preconditions for every operation that names a workspace.
  function ownedActiveWorkspace(repo, workspaceId, { requireActive = true } = {}) {
    const workspace = repo.getWorkspace(workspaceId);
    if (!workspace) return { error: fail('unknown_workspace') };
    if (!ownsWorkspace(principal, workspace)) return { error: fail('forbidden') };
    if (requireActive && workspace.status !== 'active') return { error: fail('workspace_closed') };
    return { workspace };
  }

  function fencedTask(repo, args, at) {
    if (!ID_RE.ws.test(args.workspace_id ?? '') || !ID_RE.task.test(args.task_id ?? '')) return { error: fail('invalid_input', 'id') };
    if (!Number.isInteger(args.fencing_token) || args.fencing_token < 1) return { error: fail('invalid_input', 'fencing_token') };
    const ws = ownedActiveWorkspace(repo, args.workspace_id);
    if (ws.error) return ws;
    const task = repo.getTask(args.task_id);
    if (!task) return { error: fail('unknown_task') };
    const fence = checkFence(task, args.workspace_id, args.fencing_token, at);
    if (fence.error) return { error: fail(fence.error) };
    return { task, workspace: ws.workspace };
  }

  async function resolve(name) {
    if (typeof name !== 'string' || !name) return fail('invalid_input', 'project');
    const resolved = await resolveProject(name);
    if (!resolved.ok) return fail(resolved.error === 'invalid_project_name' ? 'invalid_input' : 'unknown_project',
      resolved.error === 'invalid_project_name' ? 'project' : undefined);
    return resolved;
  }

  return {
    principal: principal.id,

    async workspaceOpen(args = {}) {
      const clientType = args.client_type ?? 'other';
      if (!CLIENT_TYPES.includes(clientType)) return fail('invalid_input', 'client_type');
      const label = cleanText(args.client_label, 80);
      if (label === undefined) return fail('invalid_input', 'client_label');
      const hostId = args.host ?? host;
      if (!HOSTS.includes(hostId)) return fail('invalid_input', 'host');
      if (args.branch !== undefined && args.branch !== null && !validBranch(args.branch)) return fail('invalid_input', 'branch');
      if (!authorize(principal, 'workspace_open')) return execute('workspace_open', {}, () => fail('forbidden'));
      const project = await resolve(args.project);
      if (!project.ok) return project;
      const id = newId('ws');
      return execute('workspace_open', { workspace_id: id }, (repo, at) => {
        const row = { id, principal: principal.id, client_type: clientType, client_label: label,
          project_id: project.project.name, host: hostId, branch: args.branch ?? null, status: 'active',
          created_at: at, updated_at: at };
        repo.insertWorkspace(row);
        return { ok: true, workspace: publicWorkspace({ ...row, closed_at: null }) };
      });
    },

    async workspaceStatus({ workspace_id } = {}) {
      if (!ID_RE.ws.test(workspace_id ?? '')) return fail('invalid_input', 'workspace_id');
      return execute('workspace_status', { workspace_id }, (repo, at) => {
        const ws = ownedActiveWorkspace(repo, workspace_id, { requireActive: false });
        if (ws.error) return ws.error;
        const leases = repo.tasksLeasedBy(workspace_id).filter(t => leaseActive(t, at)).map(t => publicTask(t, at));
        return { ok: true, workspace: publicWorkspace(ws.workspace), active_leases: leases };
      });
    },

    async workspaceList({ status, limit } = {}) {
      if (status !== undefined && !['active', 'closed'].includes(status)) return fail('invalid_input', 'status');
      const max = limitOf(limit);
      if (max === undefined) return fail('invalid_input', 'limit');
      return execute('workspace_list', {}, repo => {
        const rows = repo.listWorkspaces({ principal: principal.id, status, limit: max });
        return { ok: true, count: rows.length, workspaces: rows.map(publicWorkspace) };
      });
    },

    async workspaceClose({ workspace_id } = {}) {
      if (!ID_RE.ws.test(workspace_id ?? '')) return fail('invalid_input', 'workspace_id');
      return execute('workspace_close', { workspace_id }, (repo, at) => {
        const ws = ownedActiveWorkspace(repo, workspace_id, { requireActive: false });
        if (ws.error) return ws.error;
        if (ws.workspace.status === 'closed') return { ok: true, workspace: publicWorkspace(ws.workspace), released: [] };
        const released = [];
        for (const task of repo.tasksLeasedBy(workspace_id)) {
          if (repo.updateTask(task.id, releasePatch(at), task.lease_generation) === 1) released.push(task.id);
        }
        repo.updateWorkspace(workspace_id, { status: 'closed', closed_at: at, updated_at: at });
        return { ok: true, workspace: publicWorkspace(repo.getWorkspace(workspace_id)), released };
      });
    },

    async taskCreate(args = {}) {
      const title = cleanText(args.title, 200, { required: true });
      if (!title) return fail('invalid_input', 'title');
      const issueRef = args.issue_ref ?? null;
      if (issueRef !== null && !ISSUE_REF_RE.test(issueRef)) return fail('invalid_input', 'issue_ref');
      if (!authorize(principal, 'task_create')) return execute('task_create', {}, () => fail('forbidden'));
      const project = await resolve(args.project);
      if (!project.ok) return project;
      const id = newId('task');
      return execute('task_create', { task_id: id }, (repo, at) => {
        repo.insertTask({ id, project_id: project.project.name, title, issue_ref: issueRef, created_by: principal.id,
          created_at: at, updated_at: at });
        return { ok: true, task: publicTask(repo.getTask(id), at) };
      });
    },

    async taskStatus({ task_id } = {}) {
      if (!ID_RE.task.test(task_id ?? '')) return fail('invalid_input', 'task_id');
      return execute('task_status', { task_id }, (repo, at) => {
        const task = repo.getTask(task_id);
        if (!task) return fail('unknown_task');
        return { ok: true, task: publicTask(task, at), checkpoints: repo.listCheckpoints(task_id, 20).map(publicCheckpoint) };
      });
    },

    async tasksList({ project, status, limit } = {}) {
      if (status !== undefined && !TASK_STATUSES.includes(status)) return fail('invalid_input', 'status');
      if (project !== undefined && (typeof project !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(project))) {
        return fail('invalid_input', 'project');
      }
      const max = limitOf(limit);
      if (max === undefined) return fail('invalid_input', 'limit');
      return execute('tasks_list', {}, (repo, at) => {
        const tasks = repo.listTasks({ project_id: project, limit: 500 }).map(t => publicTask(t, at))
          .filter(t => !status || t.status === status).slice(0, max);
        return { ok: true, count: tasks.length, tasks };
      });
    },

    async taskClaim({ workspace_id, task_id, ttl_seconds } = {}) {
      if (!ID_RE.ws.test(workspace_id ?? '') || !ID_RE.task.test(task_id ?? '')) return fail('invalid_input', 'id');
      const duration = ttlMs(ttl_seconds);
      if (duration === null) return fail('invalid_input', 'ttl_seconds');
      return execute('task_claim', { workspace_id, task_id }, (repo, at) => {
        const ws = ownedActiveWorkspace(repo, workspace_id);
        if (ws.error) return ws.error;
        const task = repo.getTask(task_id);
        if (!task) return fail('unknown_task');
        if (task.project_id !== ws.workspace.project_id) return fail('project_mismatch');
        const decision = decideClaim(task, ws.workspace, at, duration);
        if (decision.error) return fail(decision.error);
        if (repo.updateTask(task_id, decision.patch, task.lease_generation) !== 1) return fail('lease_held');
        return { ok: true, task_id, workspace_id, fencing_token: decision.generation,
          expires_at: iso(decision.patch.lease_expires_at) };
      });
    },

    async taskRenew(args = {}) {
      const duration = ttlMs(args.ttl_seconds);
      if (duration === null) return fail('invalid_input', 'ttl_seconds');
      return execute('task_renew', { workspace_id: args.workspace_id, task_id: args.task_id }, (repo, at) => {
        const f = fencedTask(repo, args, at);
        if (f.error) return f.error;
        const expires = at + duration;
        if (repo.updateTask(f.task.id, { lease_expires_at: expires, updated_at: at }, f.task.lease_generation) !== 1) {
          return fail('stale_lease');
        }
        return { ok: true, task_id: f.task.id, fencing_token: f.task.lease_generation, expires_at: iso(expires) };
      });
    },

    async taskRelease(args = {}) {
      return execute('task_release', { workspace_id: args.workspace_id, task_id: args.task_id }, (repo, at) => {
        const f = fencedTask(repo, args, at);
        if (f.error) return f.error;
        if (repo.updateTask(f.task.id, releasePatch(at), f.task.lease_generation) !== 1) return fail('stale_lease');
        return { ok: true, task_id: f.task.id, released: true };
      });
    },

    async taskCheckpoint(args = {}) {
      if (!validBranch(args.branch)) return fail('invalid_input', 'branch');
      if (typeof args.commit !== 'string' || !COMMIT_RE.test(args.commit)) return fail('invalid_input', 'commit');
      const note = cleanText(args.note, 500);
      if (note === undefined) return fail('invalid_input', 'note');
      if (!ID_RE.task.test(args.task_id ?? '')) return fail('invalid_input', 'task_id');
      const ids = { workspace_id: args.workspace_id, task_id: args.task_id };
      if (!authorize(principal, 'task_checkpoint')) return execute('task_checkpoint', ids, () => fail('forbidden'));
      // Git verification happens before the write transaction; the fence is re-checked inside it.
      let projectId = null;
      try {
        projectId = await store.transaction(repo => repo.getTask(args.task_id)?.project_id ?? null);
      } catch {
        return fail('store_unavailable');
      }
      if (!projectId) return execute('task_checkpoint', ids, () => fail('unknown_task'));
      const project = await resolveProject(projectId);
      const repoPath = project.ok ? project.project.repoPath : null;
      const verified = await verifyCheckpoint({ repoPath, branch: args.branch, commit: args.commit });
      return execute('task_checkpoint', ids, (repo, at) => {
        const f = fencedTask(repo, args, at);
        if (f.error) return f.error;
        if (!verified.ok) return fail(verified.error);
        repo.insertCheckpoint({ task_id: f.task.id, workspace_id: args.workspace_id, generation: f.task.lease_generation,
          branch: args.branch, commit_sha: args.commit, durability: verified.durability, note, at });
        repo.updateTask(f.task.id, { updated_at: at }, f.task.lease_generation);
        return { ok: true, task_id: f.task.id, branch: args.branch, commit: args.commit, durability: verified.durability,
          ...(verified.durability === 'remote' ? {} : {
            warning: verified.durability === 'local_only'
              ? 'Commit is not reachable from origin/<branch> locally; another machine cannot resume from it yet.'
              : 'Repository not available on this host; commit was not verified.'
          }) };
      });
    },

    async taskComplete(args = {}) {
      const summary = cleanText(args.summary, 2000);
      if (summary === undefined) return fail('invalid_input', 'summary');
      return execute('task_complete', { workspace_id: args.workspace_id, task_id: args.task_id }, (repo, at) => {
        const f = fencedTask(repo, args, at);
        if (f.error) return f.error;
        const patch = { ...releasePatch(at), status: 'completed', completed_at: at, summary };
        if (repo.updateTask(f.task.id, patch, f.task.lease_generation) !== 1) return fail('stale_lease');
        return { ok: true, task: publicTask(repo.getTask(f.task.id), at) };
      });
    },

    async events({ task_id, workspace_id, limit } = {}) {
      if (task_id !== undefined && !ID_RE.task.test(task_id)) return fail('invalid_input', 'task_id');
      if (workspace_id !== undefined && !ID_RE.ws.test(workspace_id)) return fail('invalid_input', 'workspace_id');
      const max = limitOf(limit);
      if (max === undefined) return fail('invalid_input', 'limit');
      const everyone = principal.capabilities.has(CAPABILITIES.AUDIT);
      return execute('coordinator_events', {}, repo => {
        const rows = repo.listEvents({ principal: everyone ? undefined : principal.id, task_id, workspace_id, limit: max });
        return { ok: true, count: rows.length, events: rows.map(publicEvent) };
      });
    }
  };
}
