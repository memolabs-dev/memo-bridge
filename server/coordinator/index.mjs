// Memo Coordinator: the Memo Bridge face of Memo Labs work coordination.
//
// Ownership, decided on 2026-10-13 (Vault 1-Projects/memo-labs-os.md):
// - a task is a GitHub Issue;
// - a reservation is the Git-ref lease of memolabs-dev/.github (scripts/issue_lease.py), which
//   works across the Mac and the VPS without a central database;
// - this module adds what the ledger does not own: per-session workspaces, the identity of the
//   worker (derived by the server, never by the model), Git-verified checkpoints and an audit
//   journal, all in the private local store.
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { projectInfo } from '../catalog.mjs';
import { CAPABILITIES, authorize, ownsWorkspace } from './policy.mjs';
import { COMMIT_RE, validBranch, verifyCheckpoint } from './checkpoints.mjs';
import { LEASE_TTL, OUTCOMES, parseIssueRef } from './issue-lease.mjs';

export const CLIENT_TYPES = Object.freeze(['chatgpt', 'claude-code', 'codex', 'opencode', 'hermes', 'cuesheet', 'cli', 'other']);
export const HOSTS = Object.freeze(['mac', 'vps']);
const WS_RE = /^ws_[A-Za-z0-9_-]{16}$/;
const CLAIM_RE = /^[0-9a-f]{32}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const DENIED = new Set(['forbidden', 'stale_lease', 'lease_held', 'workspace_closed', 'project_mismatch',
  'repo_not_allowed', 'issue_not_ready', 'issue_changed', 'lease_race_lost', 'lease_denied']);
const UNCERTAIN = new Set(['ledger_unavailable', 'ledger_outcome_unknown']);
const MAX_LIST = 200;
const WRITES = new Set(['workspace_open', 'workspace_close', 'issue_claim', 'issue_heartbeat', 'issue_release', 'issue_checkpoint']);

const newId = prefix => `${prefix}_${randomBytes(12).toString('base64url')}`;
const iso = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail } : {}) });

// Text written by one session is read back by other sessions' models: no control characters,
// no bidirectional overrides, and line breaks only where the field is meant to be multi-line.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‎‏‪-‮⁦-⁩]/;
const LINE_BREAKS = /[\t\n\r]/;
function cleanText(value, max, { multiline = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length > max || CONTROL.test(text) || (!multiline && LINE_BREAKS.test(text))) return undefined;
  return text || null;
}
function limitOf(value, fallback = 50) {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && value >= 1 && value <= MAX_LIST ? value : undefined;
}
function ttlOf(value) {
  if (value === undefined) return LEASE_TTL.default;
  return Number.isInteger(value) && value >= LEASE_TTL.min && value <= LEASE_TTL.max ? value : undefined;
}

function publicWorkspace(w) {
  return {
    workspace_id: w.id, project: w.project_id, principal: w.principal, client_type: w.client_type,
    client_label: w.client_label, host: w.host, branch: w.branch, status: w.status,
    created_at: iso(w.created_at), closed_at: iso(w.closed_at)
  };
}
function publicClaim(c) {
  return { issue: c.issue_ref, claim_id: c.claim_id, fence: c.fence_sha, epoch: c.epoch, expires_at: c.expires_at,
    state: c.state, outcome: c.outcome };
}
function publicCheckpoint(c) {
  return { issue: c.issue_ref, workspace_id: c.workspace_id, claim_id: c.claim_id, fence: c.fence_sha,
    branch: c.branch, commit: c.commit_sha, durability: c.durability, note: c.note, at: iso(c.at) };
}
function publicEvent(e) {
  return { seq: e.seq, at: iso(e.at), principal: e.principal, workspace_id: e.workspace_id, issue: e.issue_ref,
    op: e.op, outcome: e.outcome, code: e.code };
}

async function catalogResolver(name, options) {
  const info = await projectInfo(name, options);
  if (!info.ok) return info;
  const p = info.project;
  return { ok: true, project: { name: p.name, repoPath: p.kind === 'repo' && p.available ? p.local_path : null } };
}

// owner/repo of the project's GitHub origin, read-only; null when it cannot be established.
export function gitHubRemote({ repoPath } = {}) {
  if (!repoPath) return Promise.resolve(null);
  return new Promise(resolve => {
    execFile('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      timeout: 6000, maxBuffer: 4096, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    }, (error, stdout) => {
      if (error) return resolve(null);
      // Any host spelling (github.com, an SSH alias…): only the owner/repo tail is compared.
      const match = /[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?\s*$/.exec(stdout.trim());
      resolve(match ? `${match[1]}/${match[2]}` : null);
    });
  });
}

export function defaultHost() {
  return platform() === 'darwin' ? 'mac' : 'vps';
}

// The worker identity recorded in the ledger. It is derived from the workspace, so another
// workspace, even of the same principal, can never act on this claim.
export const workerFor = workspace => `mb.${workspace.host}.${workspace.id}`;

export function createCoordinator({ store, principal, ledger, now = Date.now, catalogOptions = {},
  resolveProject = name => catalogResolver(name, catalogOptions), projectRemote = gitHubRemote, host = defaultHost() }) {
  if (!store || !principal || !ledger) throw new Error('coordinator_requires_store_principal_and_ledger');

  const audit = (repo, op, outcome, code, ids = {}) => repo.appendEvent({
    at: now(), principal: principal.id,
    // Only well-formed identifiers reach the journal; arbitrary caller text never does.
    workspace_id: WS_RE.test(ids.workspace_id ?? '') ? ids.workspace_id : null,
    issue_ref: parseIssueRef(ids.issue) ? ids.issue : null,
    op, outcome, code: code ?? null
  });
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

  async function resolve(name) {
    if (typeof name !== 'string' || !name) return fail('invalid_input', 'project');
    const resolved = await resolveProject(name);
    if (!resolved.ok) {
      const invalid = resolved.error === 'invalid_project_name';
      return fail(invalid ? 'invalid_input' : 'unknown_project', invalid ? 'project' : undefined);
    }
    return resolved;
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

    async issueStatus(args) {
      const issue = parseIssueRef(args.issue);
      if (!issue) return fail('invalid_input', 'issue');
      const lease = await ledger.status(issue);
      const checkpoints = await read(repo => repo.listCheckpoints(issue.ref, 20));
      if (!lease.ok) return { ...lease, checkpoints: checkpoints.map(publicCheckpoint) };
      return { ok: true, issue: issue.ref, lease: lease.receipt, checkpoints: checkpoints.map(publicCheckpoint) };
    },

    async issueClaim(args) {
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

    async issueHeartbeat(args) {
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

    // Allowed on a closed workspace too, so a claim left behind can always be given back.
    async issueRelease(args) {
      if (!OUTCOMES.includes(args.outcome)) return fail('invalid_input', 'outcome');
      const held = await heldClaim(args, { requireActive: false });
      if (held.error) return held.error;
      if (held.claim.state === 'released') return { ok: true, issue: held.issue.ref, released: true, outcome: held.claim.outcome };
      const result = await ledger.release(held.issue, workerFor(held.workspace), args.claim_id, args.fence, args.outcome);
      let fence;
      if (result.ok) fence = result.receipt.fence_sha;
      else if (result.error === 'ledger_outcome_unknown') {
        const holder = await whoHolds(held.issue, workerFor(held.workspace));
        if (holder?.error || holder?.mine) return result;
      } else return result;
      await write((repo, at) => repo.updateClaim(args.claim_id, { state: 'released', outcome: args.outcome,
        fence_sha: fence ?? held.claim.fence_sha, updated_at: at }, held.claim.fence_sha));
      return { ok: true, issue: held.issue.ref, released: true, outcome: args.outcome };
    },

    // The checkpoint is a write boundary: the ledger verifies the fence immediately before it.
    async issueCheckpoint(args) {
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
    },

    async events(args) {
      if (args.issue !== undefined && !parseIssueRef(args.issue)) return fail('invalid_input', 'issue');
      if (args.workspace_id !== undefined && !WS_RE.test(args.workspace_id)) return fail('invalid_input', 'workspace_id');
      const max = limitOf(args.limit);
      if (max === undefined) return fail('invalid_input', 'limit');
      const everyone = principal.capabilities.has(CAPABILITIES.AUDIT);
      const rows = await read(repo => repo.listEvents({ principal: everyone ? undefined : principal.id,
        issue_ref: args.issue, workspace_id: args.workspace_id, limit: max }));
      return { ok: true, count: rows.length, events: rows.map(publicEvent) };
    }
  };

  // Every call: authorization first (so every refusal is journaled whatever the arguments),
  // then the operation, then the journal entry. Store failures never crash the server.
  const METHOD_OPERATION = {
    workspaceOpen: 'workspace_open', workspaceStatus: 'workspace_status', workspaceList: 'workspace_list',
    workspaceClose: 'workspace_close', issueStatus: 'issue_status', issueClaim: 'issue_claim',
    issueHeartbeat: 'issue_heartbeat', issueRelease: 'issue_release', issueCheckpoint: 'issue_checkpoint',
    events: 'coordinator_events'
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
