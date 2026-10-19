// Phase 3 tool module (audit). Reads the audit journal (events table) and resolves one
// operation into the records around it. Visibility follows the Coordinator rule: a principal
// holding coordinator:audit sees every event; any other principal sees only its own events
// and only workspaces it owns. Read-only: only refusals are journaled.
// Services come from getRuntime() (server/runtime.mjs).
import { z } from 'zod/v4';
import { CAPABILITIES, ownsWorkspace } from '../coordinator/policy.mjs';
import { parseIssueRef } from '../coordinator/issue-lease.mjs';

export const AUDIT_TOOLS = Object.freeze(['audit_events', 'audit_operation']);

const OUTCOMES = Object.freeze(['ok', 'denied', 'error']);
const WS_RE = /^ws_[A-Za-z0-9_-]{16}$/;
const OP_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_LIST = 200;
// The store filters events by principal, issue and workspace; op and outcome are filtered
// here over a bounded window of the newest events, reported as `scanned`.
const SCAN_WINDOW = 5000;
// "Near that time" for audit_operation: records whose lifetime overlaps the event ± 30 min.
const NEAR_MS = 30 * 60 * 1000;
const MAX_RELATED = 20;

const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail } : {}) });
const iso = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

// Only well-formed identifiers reach the journal; arbitrary caller text never does.
const safeIds = (args = {}) => ({
  ...(WS_RE.test(args.workspace_id ?? '') ? { workspace_id: args.workspace_id } : {}),
  ...(parseIssueRef(args.issue) ? { issue: args.issue } : {})
});

export function publicEvent(e) {
  return { seq: e.seq, at: iso(e.at), principal: e.principal, workspace_id: e.workspace_id, issue: e.issue_ref,
    op: e.op, outcome: e.outcome, code: e.code };
}
function publicWorkspace(w) {
  return { workspace_id: w.id, project: w.project_id, principal: w.principal, client_type: w.client_type,
    client_label: w.client_label, host: w.host, branch: w.branch, status: w.status,
    created_at: iso(w.created_at), closed_at: iso(w.closed_at) };
}
function publicClaim(c) {
  return { issue: c.issue_ref, claim_id: c.claim_id, fence: c.fence_sha, epoch: c.epoch, expires_at: c.expires_at,
    state: c.state, outcome: c.outcome, updated_at: iso(c.updated_at) };
}
function publicCheckpoint(c) {
  return { issue: c.issue_ref, workspace_id: c.workspace_id, claim_id: c.claim_id, branch: c.branch, commit: c.commit_sha,
    durability: c.durability, at: iso(c.at) };
}
// Local filesystem paths (worktree path, job log path) are not part of the audit view.
function publicWorktree(w) {
  return { worktree_id: w.id, project: w.project_id, host: w.host, branch: w.branch, base_ref: w.base_ref,
    base_commit: w.base_commit, issue: w.issue_ref, status: w.status, created_at: iso(w.created_at), removed_at: iso(w.removed_at) };
}
function publicJob(j) {
  return { job_id: j.id, worktree_id: j.worktree_id, project: j.project_id, host: j.host, recipe: j.recipe, status: j.status,
    exit_code: j.exit_code, created_at: iso(j.created_at), started_at: iso(j.started_at), ended_at: iso(j.ended_at) };
}
const overlaps = (start, end, at) => start <= at + NEAR_MS && (end === null || end === undefined || end >= at - NEAR_MS);

export function registerAuditTools(server, getRuntime) {
  // Authorization first; a refusal is journaled and nothing else runs.
  const guarded = (op, fn) => async (raw = {}) => {
    const args = raw ?? {};
    let rt;
    try { rt = await getRuntime(); } catch { return result(fail('runtime_unavailable')); }
    if (!rt.authorize(op)) {
      await rt.audit(op, 'denied', 'forbidden', safeIds(args));
      return result(fail('forbidden'));
    }
    try { return result(await fn(rt, args)); } catch { return result(fail('store_unavailable')); }
  };
  const seesEverything = rt => Boolean(rt.principal?.capabilities?.has(CAPABILITIES.AUDIT));

  server.registerTool('audit_events', {
    description: 'Use this when the owner asks what Memo Bridge did and when («qu\'est-ce qui a été fait sur l\'issue 12 ?», "who claimed it?"): the audit journal, newest first, filtered by Issue, workspace, operation or outcome. Read-only.',
    inputSchema: z.object({
      issue: z.string().max(160).optional().describe('e.g. "memolabs-dev/cuesheet#42".'),
      workspace_id: z.string().max(40).optional().describe('A ws_... id.'),
      op: z.string().max(64).optional().describe('Operation (tool) name, e.g. task_claim.'),
      outcome: z.enum(OUTCOMES).optional().describe('"ok", "denied" or "error".'),
      limit: z.number().int().min(1).max(MAX_LIST).optional().describe('At most 200, e.g. 20.')
    }),
    annotations: readonly
  }, guarded('audit_events', async (rt, args) => {
    if (args.issue !== undefined && !parseIssueRef(args.issue)) return fail('invalid_input', 'issue');
    if (args.workspace_id !== undefined && !WS_RE.test(args.workspace_id)) return fail('invalid_input', 'workspace_id');
    if (args.op !== undefined && !OP_RE.test(args.op)) return fail('invalid_input', 'op');
    if (args.outcome !== undefined && !OUTCOMES.includes(args.outcome)) return fail('invalid_input', 'outcome');
    const limit = args.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) return fail('invalid_input', 'limit');
    const everyone = seesEverything(rt);
    const filtered = args.op !== undefined || args.outcome !== undefined;
    const rows = await rt.store().transaction(repo => repo.listEvents({
      principal: everyone ? undefined : rt.principal.id, issue_ref: args.issue, workspace_id: args.workspace_id,
      op: args.op, outcome: args.outcome, limit: filtered ? SCAN_WINDOW : limit
    }), { write: false });
    const matching = rows.filter(e => (args.op === undefined || e.op === args.op)
      && (args.outcome === undefined || e.outcome === args.outcome)).slice(0, limit);
    return { ok: true, scope: everyone ? 'all' : 'own', count: matching.length, events: matching.map(publicEvent),
      ...(filtered ? { scanned: rows.length, window_exhausted: rows.length >= SCAN_WINDOW && matching.length < limit } : {}) };
  }));

  server.registerTool('audit_operation', {
    description: 'Use this to explain one audit event by its seq: the event and the workspace, claims, checkpoints, worktrees and jobs around it. Read-only.',
    inputSchema: z.object({ seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe('Event seq from audit_events.') }),
    annotations: readonly
  }, guarded('audit_operation', async (rt, args) => {
    if (!Number.isSafeInteger(args.seq) || args.seq < 1) return fail('invalid_input', 'seq');
    const everyone = seesEverything(rt);
    const outcome = await rt.store().transaction(repo => {
      const event = repo.getEvent(args.seq);
      if (!event) return { missing: true };
      if (!everyone && event.principal !== rt.principal.id) return { hidden: event };
      const related = { workspace: null, claims: [], checkpoints: [], worktrees: [], jobs: [] };
      const workspace = event.workspace_id ? repo.getWorkspace(event.workspace_id) : null;
      // A denied attempt on someone else's workspace is the caller's own event, but the
      // workspace and everything under it stay invisible to them.
      const workspaceVisible = Boolean(workspace) && (everyone || ownsWorkspace(rt.principal, workspace));
      if (workspaceVisible) {
        related.workspace = publicWorkspace(workspace);
        if (event.issue_ref) {
          related.claims = repo.claimsOf(workspace.id).filter(c => c.issue_ref === event.issue_ref)
            .slice(-MAX_RELATED).map(publicClaim);
        }
        related.worktrees = repo.listWorktrees({ workspace_id: workspace.id, limit: 200 })
          .filter(w => overlaps(w.created_at, w.removed_at, event.at)).slice(0, MAX_RELATED).map(publicWorktree);
        related.jobs = repo.listJobs({ workspace_id: workspace.id, limit: 200 })
          .filter(j => overlaps(j.created_at, j.ended_at, event.at)).slice(0, MAX_RELATED).map(publicJob);
      }
      if (event.issue_ref) {
        // Checkpoints of the Issue, kept only for workspaces the caller may see.
        const visible = new Map();
        related.checkpoints = repo.listCheckpoints(event.issue_ref, 50).filter(c => {
          if (everyone) return true;
          if (!visible.has(c.workspace_id)) visible.set(c.workspace_id, ownsWorkspace(rt.principal, repo.getWorkspace(c.workspace_id)));
          return visible.get(c.workspace_id);
        }).slice(0, MAX_RELATED).map(publicCheckpoint);
      }
      return { event, related, workspaceKnown: Boolean(workspace), workspaceVisible };
    }, { write: false });
    if (outcome.missing) return fail('unknown_event');
    if (outcome.hidden) {
      // Same answer as a missing seq, so other principals' activity is not disclosed; the
      // attempt itself is journaled as a refusal.
      await rt.audit('audit_operation', 'denied', 'forbidden');
      return fail('unknown_event');
    }
    return { ok: true, scope: everyone ? 'all' : 'own', event: publicEvent(outcome.event), related: outcome.related,
      ...(outcome.workspaceKnown && !outcome.workspaceVisible ? { withheld: ['workspace'] } : {}) };
  }));
}
