// Source Engine query tools: scoped, read-only metadata. No merge or repository writes.
import { z } from 'zod/v4';
import { listProjects } from '../catalog.mjs';
import { createGitHub } from '../integrations/github.mjs';
import { sourceChange, sourceHistory } from '../source-engine/changes.mjs';
import { isRemotePrincipal } from '../coordinator/policy.mjs';
import { remotePolicyFromEnv, remoteProjectRefusal } from '../../bridge/write-gate.mjs';

export const SOURCE_TOOLS = Object.freeze(['source_changes_list', 'source_change_status', 'source_change_history']);
const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = error => ({ ok: false, error });
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const CHANGE_ID = /^[a-z0-9][a-z0-9_.:-]{0,99}$/;
const ISSUE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]{0,8}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_LIMIT = 100;

function matchesOrigin(issue, origin) {
  return typeof issue === 'string' && ISSUE.test(issue) && issue.split('#')[0].toLowerCase() === origin.toLowerCase();
}

function compact(row, origin) {
  const linked = matchesOrigin(row.issue_ref, origin);
  const issueNum = linked ? row.issue_ref.split('#')[1] : null;
  const change = {
    id: row.id,
    project: row.project_id,
    issue: linked ? row.issue_ref : null,
    worktree_id: row.worktree_id,
    branch: row.branch,
    base_sha: row.base_sha,
    head_sha: row.head_sha,
    pr_number: linked ? row.pr_number : null,
    ci_state: row.ci_state,
    landing_state: row.landing_state,
    source_at: row.source_at,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  if (linked) {
    change.issue_url = 'https://github.com/' + origin + '/issues/' + issueNum;
    if (Number.isSafeInteger(row.pr_number) && row.pr_number > 0) {
      change.pr_url = 'https://github.com/' + origin + '/pull/' + row.pr_number;
    }
    if (SHA.test(row.head_sha ?? '')) {
      change.checks_url = 'https://github.com/' + origin + '/commit/' + row.head_sha + '/checks';
    }
  }
  return change;
}

export function registerSourceTools(server, getRuntime, options = {}) {
  const catalog = options.listProjects ?? listProjects;
  const getPolicy = options.remotePolicy ?? remotePolicyFromEnv;
  const ghCache = new WeakMap();
  const repoFor = options.repoFor ?? (async (rt, name) => {
    let gh = ghCache.get(rt);
    if (!gh) {
      gh = createGitHub({ catalogOptions: rt.catalogOptions, now: rt.now,
        credentials: rt.githubCredentials ?? null });
      ghCache.set(rt, gh);
    }
    return gh.projectRepo(name);
  });

  function register(name, description, fields, operation) {
    server.registerTool(name, { description, inputSchema: z.object(fields), annotations: readonly }, async (args = {}) => {
      let rt;
      try { rt = await getRuntime(); } catch { return result(fail('runtime_unavailable')); }
      if (!rt.authorize(name)) {
        await rt.audit(name, 'denied', 'forbidden');
        return result(fail('forbidden'));
      }
      if (typeof args.project !== 'string' || !PROJECT.test(args.project)) return result(fail('invalid_input'));
      try {
        const listed = await catalog({ search: args.project }, rt.catalogOptions ?? {});
        if (!listed?.projects?.some(p => p.name === args.project && p.kind === 'repo')) {
          await rt.audit(name, 'denied', 'unknown_project');
          return result(fail('unknown_project'));
        }
        if (isRemotePrincipal(rt.principal)) {
          const refusal = remoteProjectRefusal(rt.principal, args.project, getPolicy());
          if (refusal) {
            await rt.audit(name, 'denied', 'project_not_allowed');
            return result(fail('project_not_allowed'));
          }
        }
        const origin = await repoFor(rt, args.project);
        if (typeof origin !== 'string' || !REPO.test(origin)) return result(fail('repo_unavailable'));
        const outcome = await operation(rt, args, origin);
        await rt.audit(name, outcome.ok ? 'ok' : 'denied', outcome.ok ? null : outcome.error);
        return result(outcome);
      } catch {
        await rt.audit(name, 'error', 'source_unavailable');
        return result(fail('source_unavailable'));
      }
    });
  }

  const project = z.string().max(80).describe('Registered name, e.g. "stasis".');
  const id = z.string().max(100).describe('Change id from source_changes_list.');
  const limit = z.number().int().min(1).max(MAX_LIMIT).optional().describe('e.g. 30.');
  register('source_changes_list',
    'Use this when the owner asks which changes Memo Bridge tracks on a project and their Issue, PR and CI links. Read-only.',
    { project, issue: z.string().max(160).optional().describe('Only this Issue, owner/repo#n.'), limit,
      offset: z.number().int().min(0).max(10000).optional().describe('From next_offset.') },
    async (rt, args, origin) => {
      const size = args.limit ?? 30;
      const offset = args.offset ?? 0;
      if (!Number.isInteger(size) || size < 1 || size > MAX_LIMIT ||
          !Number.isInteger(offset) || offset < 0 || offset > 10000 ||
          (args.issue !== undefined && !matchesOrigin(args.issue, origin))) return fail('invalid_input');
      const rows = await rt.store().transaction(
        repo => repo.listSourceChanges({ project_id: args.project, issue_ref: args.issue, limit: size, offset }),
        { write: false });
      const scoped = rows.filter(row => matchesOrigin(row.issue_ref, origin));
      return { ok: true, project: args.project, count: scoped.length,
        changes: scoped.map(row => compact(row, origin)),
        next_offset: rows.length === size ? offset + size : null };
    });

  register('source_change_status',
    'Use this to read one tracked change by id. Read-only.',
    { project, id },
    async (rt, args, origin) => {
      if (typeof args.id !== 'string' || !CHANGE_ID.test(args.id)) return fail('invalid_input');
      const change = (await sourceChange(rt.store(), args.id)).change;
      if (!change || change.project_id !== args.project || !matchesOrigin(change.issue_ref, origin)) return fail('not_found');
      return { ok: true, project: args.project, change: compact(change, origin) };
    });

  register('source_change_history',
    'Use this for the history of one tracked change, paged by after_seq. Read-only.',
    { project, id, after_seq: z.number().int().min(0).optional().describe('From next_after_seq.'), limit },
    async (rt, args, origin) => {
      if (typeof args.id !== 'string' || !CHANGE_ID.test(args.id) ||
          !Number.isInteger(args.after_seq ?? 0) || (args.after_seq ?? 0) < 0 ||
          (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIMIT))) return fail('invalid_input');
      const change = (await sourceChange(rt.store(), args.id)).change;
      if (!change || change.project_id !== args.project || !matchesOrigin(change.issue_ref, origin)) return fail('not_found');
      const history = await sourceHistory(rt.store(), args.id, {
        after_seq: args.after_seq ?? 0, limit: args.limit ?? 30
      });
      if (!history.ok) return history;
      const events = history.events.map(event => {
        let snapshot = null;
        try { snapshot = compact(JSON.parse(event.snapshot_json), origin); } catch { /* malformed record, never leak raw */ }
        return { seq: event.seq, revision: event.revision, at: event.at, snapshot };
      });
      return { ok: true, project: args.project, id: args.id, count: events.length, events,
        next_after_seq: events.length ? events.at(-1).seq : null };
    });
}
