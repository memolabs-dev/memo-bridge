// Reader contract v1 (#252, docs/READER_CONTRACT.md): the owner-wide read view of this machine's
// coordination state, for a local reader such as Memo Orbit's Activity timeline. Every
// principal's workspaces (sessions), claims (task leases), jobs and audit events, filtered by
// project and by "changed since", with ISO timestamps; audit events and job events page with
// next_after_seq. Local stdio only (not in server/registry.mjs, so neither the hub nor the
// remote surface serves it), and only to a principal holding coordinator:audit.
//
// These tools only read: read transactions, no journal row (refusals included), no job
// reconciliation, no ledger or GitHub call. Statuses are the ones recorded in the store.
import { z } from 'zod/v4';
import { ACTIVE_JOB_STATUSES } from '../runners/executor.mjs';
import { JOB_ID_RE, publicEvent as publicJobEvent } from '../runners/jobs.mjs';
import { publicEvent as publicAuditEvent } from './audit-tools.mjs';
import { sanitizeExternal, decodeOutcome } from '../coordinator/index.mjs';
import { sessionTag } from '../../bridge/write-gate.mjs';

export const READER_TOOLS = Object.freeze(['reader_activity', 'reader_job_events']);
export const READER_CONTRACT = 'memo-bridge.reader.v1';
export const READER_LIMITS = Object.freeze({ default: 50, max: 200, events: 200, job_events: 200 });

const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MAX_SINCE = 40;
// ISO 8601 with an explicit zone: a time without one would be read in this machine's zone.
const ISO_SINCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail } : {}) });
const iso = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
// The ledger writes expires_at as an ISO string with an offset; the contract gives UTC ISO.
const isoText = text => { const ms = Date.parse(text ?? ''); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };

function session(w, at, claims, jobs) {
  const times = [w.created_at, w.updated_at, w.closed_at, ...claims.map(c => c.updated_at),
    ...jobs.flatMap(j => [j.created_at, j.started_at, j.ended_at])].filter(Number.isFinite);
  return {
    workspace_id: w.id, principal: w.principal, client_type: w.client_type, client_label: w.client_label ?? null,
    session_tag: sessionTag(w.client_session), project: w.project_id, host: w.host, branch: w.branch ?? null,
    status: w.status, created_at: iso(w.created_at), updated_at: iso(w.updated_at), closed_at: iso(w.closed_at),
    last_activity: iso(Math.max(...times)),
    held_tasks: claims.filter(c => c.state === 'claimed' && Date.parse(c.expires_at) > at).map(c => c.issue_ref),
    delegation_id: w.delegation_id ?? null
  };
}

function lease(c, at, checkpoint) {
  const { outcome, summary } = decodeOutcome(c.outcome);
  return {
    issue: c.issue_ref, claim_id: c.claim_id, workspace_id: c.workspace_id, project: c.project_id, principal: c.principal,
    state: c.state, lease: c.state !== 'claimed' ? 'released' : Date.parse(c.expires_at) > at ? 'held' : 'expired',
    epoch: c.epoch, expires_at: isoText(c.expires_at), outcome, summary: sanitizeExternal(summary, 500), updated_at: iso(c.updated_at),
    last_checkpoint: checkpoint ? { branch: checkpoint.branch, commit: checkpoint.commit_sha, durability: checkpoint.durability,
      at: iso(checkpoint.at) } : null
  };
}

function job(j) {
  return {
    job_id: j.id, workspace_id: j.workspace_id, worktree_id: j.worktree_id, project: j.project_id, host: j.host,
    principal: j.principal ?? j.workspace_principal ?? null, issue: j.issue_ref ?? null, claim_id: j.claim_id ?? null,
    recipe: j.recipe, status: j.status, status_reason: sanitizeExternal(j.status_reason, 80), exit_code: j.exit_code ?? null,
    created_at: iso(j.created_at), started_at: iso(j.started_at), ended_at: iso(j.ended_at), summary: sanitizeExternal(j.summary, 500)
  };
}

// project and since, shared by both tools. Returns {project, since} or {error}.
function filters(args) {
  const project = args.project ?? null;
  if (project !== null && (typeof project !== 'string' || !PROJECT_RE.test(project))) return { error: fail('invalid_input', 'project') };
  let since = null;
  if (args.since !== undefined && args.since !== null) {
    since = typeof args.since === 'string' && args.since.length <= MAX_SINCE && ISO_SINCE.test(args.since) ? Date.parse(args.since) : NaN;
    if (!Number.isFinite(since)) return { error: fail('invalid_input', 'since') };
  }
  return { project, since };
}
const cursor = value => (value === undefined ? 0 : Number.isSafeInteger(value) && value >= 0 ? value : undefined);

export function registerReaderTools(server, getRuntime) {
  // Authorization first; a refusal is returned and, unlike the other tools, never journaled:
  // a reader leaves no trace (docs/READER_CONTRACT.md).
  const guarded = (op, fn) => async (raw = {}) => {
    let rt;
    try { rt = await getRuntime(); } catch { return result(fail('runtime_unavailable')); }
    if (!rt.authorize(op)) return result(fail('forbidden'));
    try { return result(await fn(rt, raw ?? {})); } catch (error) {
      const code = String(error?.message ?? '');
      return result({ ok: false, error: 'store_unavailable', ...(/^state_[a-z_]{1,40}$/.test(code) ? { detail: code } : {}) });
    }
  };
  const read = (rt, fn) => rt.store().transaction(repo => fn(repo, rt.now()), { write: false });

  server.registerTool('reader_activity', {
    description: 'Reader contract v1 (docs/READER_CONTRACT.md): every conversation\'s sessions, task leases and jobs on this machine, and the audit events after a cursor, for one project or all, changed since a time. Owner-wide, local only. Read-only: writes nothing, not even an audit row.',
    inputSchema: z.object({
      project: z.string().max(80).optional().describe('Project name, e.g. "cuesheet"; all projects when omitted.'),
      since: z.string().max(MAX_SINCE).optional().describe('ISO time with a zone, e.g. "2026-10-21T10:00:00Z"; keeps what changed at or after it, plus what is still live.'),
      after_seq: z.number().int().min(0).optional().describe('Audit cursor: next_after_seq of the previous call; 0 or omitted from the start.'),
      limit: z.number().int().min(1).max(READER_LIMITS.max).optional().describe('Per list, default 50, at most 200.')
    }),
    annotations: readonly
  }, guarded('reader_activity', async (rt, args) => {
    const scope = filters(args);
    if (scope.error) return scope.error;
    const after = cursor(args.after_seq);
    if (after === undefined) return fail('invalid_input', 'after_seq');
    const limit = args.limit ?? READER_LIMITS.default;
    if (!Number.isInteger(limit) || limit < 1 || limit > READER_LIMITS.max) return fail('invalid_input', 'limit');
    const { project, since } = scope;
    return read(rt, (repo, at) => {
      const workspaces = repo.readerWorkspaces({ project_id: project, since, limit: limit + 1 });
      const claims = repo.readerClaims({ project_id: project, since, limit: limit + 1 });
      const jobs = repo.readerJobs({ project_id: project, since, live: ACTIVE_JOB_STATUSES, limit: limit + 1 });
      const events = repo.readerEvents({ project_id: project, since, after_seq: after, limit: READER_LIMITS.events });
      const sessions = workspaces.slice(0, limit).map(w => session(w, at, repo.claimsOf(w.id),
        repo.listJobs({ workspace_id: w.id, limit: 20 })));
      return {
        ok: true, contract: READER_CONTRACT, at: iso(at), host: rt.host,
        scope: { project, since: since === null ? null : iso(since), after_seq: after },
        sessions,
        leases: claims.slice(0, limit).map(c => lease(c, at, repo.readerLastCheckpoint(c.claim_id))),
        jobs: jobs.slice(0, limit).map(job),
        truncated: { sessions: workspaces.length > limit, leases: claims.length > limit, jobs: jobs.length > limit },
        events: events.map(publicAuditEvent),
        next_after_seq: events.length ? events[events.length - 1].seq : after,
        more_events: events.length === READER_LIMITS.events,
        status_source: 'recorded'
      };
    });
  }));

  server.registerTool('reader_job_events', {
    description: 'Reader contract v1 (docs/READER_CONTRACT.md): the events of one job of any conversation on this machine, after a cursor. Owner-wide, local only. Read-only: writes nothing, not even an audit row.',
    inputSchema: z.object({
      job_id: z.string().max(40).describe('job_... id from reader_activity.'),
      after_seq: z.number().int().min(0).optional().describe('next_after_seq of the previous call; 0 or omitted from the start.')
    }),
    annotations: readonly
  }, guarded('reader_job_events', async (rt, args) => {
    if (!JOB_ID_RE.test(args.job_id ?? '')) return fail('invalid_input', 'job_id');
    const after = cursor(args.after_seq);
    if (after === undefined) return fail('invalid_input', 'after_seq');
    const found = await read(rt, repo => {
      const row = repo.getJob(args.job_id);
      return row ? { row, events: repo.listJobEvents(row.id, after, READER_LIMITS.job_events) } : null;
    });
    if (!found) return fail('unknown_job');
    const { row, events } = found;
    return { ok: true, contract: READER_CONTRACT, job_id: row.id, project: row.project_id, status: row.status,
      events: events.map(publicJobEvent), next_after_seq: events.length ? events[events.length - 1].seq : after,
      more: events.length === READER_LIMITS.job_events, status_source: 'recorded' };
  }));
}
