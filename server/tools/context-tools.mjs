// Scoped context overview. Observations are NOT authorization to merge.
import { z } from 'zod/v4';
import { listProjects } from '../catalog.mjs';
import { createGitHub } from '../integrations/github.mjs';
import { isRemotePrincipal } from '../coordinator/policy.mjs';
import { remotePolicyFromEnv, remoteProjectRefusal } from '../../bridge/write-gate.mjs';

export const CONTEXT_TOOLS = Object.freeze(['project_context']);
const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const respond = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = error => ({ ok: false, error });
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function registerContextTools(server, getRuntime, deps = {}) {
  const catalog = deps.listProjects ?? listProjects;
  const getPolicy = deps.remotePolicy ?? remotePolicyFromEnv;
  const githubCache = new WeakMap();
  const githubOf = rt => {
    if (deps.github) return deps.github;
    let gh = githubCache.get(rt);
    if (!gh) {
      gh = createGitHub({ catalogOptions: rt.catalogOptions, now: rt.now, credentials: rt.githubCredentials ?? null });
      githubCache.set(rt, gh);
    }
    return gh;
  };
  server.registerTool('project_context', {
    description: 'Use this when the owner asks where a project stands («où en est stasis ?») or before creating new work on it: open Issues and PRs, tracked changes, so you do not duplicate an existing task. Read-only.',
    inputSchema: z.object({ project: z.string().max(80).describe('Registered name, e.g. "stasis".'),
      goal: z.string().max(200).optional().describe('What the owner wants, e.g. "export CSV".') }),
    annotations: readonly
  }, async (args = {}) => {
    let rt;
    try { rt = await getRuntime(); } catch { return respond(fail('runtime_unavailable')); }
    if (!rt.authorize('project_context')) {
      await rt.audit('project_context', 'denied', 'forbidden');
      return respond(fail('forbidden'));
    }
    if (typeof args.project !== 'string' || !PROJECT.test(args.project) ||
        (args.goal !== undefined && (typeof args.goal !== 'string' || args.goal.length > 200))) {
      return respond(fail('invalid_input'));
    }
    // Metadata-only Mac snapshot entries never grant repository access.
    if (isRemotePrincipal(rt.principal)) {
      const refusal = remoteProjectRefusal(rt.principal, args.project, getPolicy());
      if (refusal) {
        await rt.audit('project_context', 'denied', 'project_not_allowed');
        return respond(fail('project_not_allowed'));
      }
    }
    let project;
    try {
      const listed = await catalog({ search: args.project }, rt.catalogOptions ?? {});
      project = listed.projects.find(p => p.name === args.project && p.kind === 'repo' && p.metadata_only !== true);
    } catch { return respond(fail('catalog_unavailable')); }
    if (!project) {
      await rt.audit('project_context', 'denied', 'unknown_project');
      return respond(fail('unknown_project'));
    }
    const gh = githubOf(rt);
    let origin;
    try { origin = await (deps.repoFor ? deps.repoFor(rt, args.project) : gh.projectRepo(args.project)); }
    catch { return respond(fail('repo_unavailable')); }
    if (typeof origin !== 'string' || !REPO.test(origin)) return respond(fail('repo_unavailable'));

    // Bound every source. A failure is reported, never silently treated as an empty successful query.
    const sources = {};
    let changes = [];
    try {
      const rows = await rt.store().transaction(
        repo => repo.listSourceChanges({ project_id: args.project, limit: 30, offset: 0 }), { write: false });
      changes = rows.filter(r => typeof r.issue_ref === 'string' &&
        r.issue_ref.split('#')[0].toLowerCase() === origin.toLowerCase()).map(r => ({
          id: r.id, issue: r.issue_ref, branch: r.branch, head_sha: r.head_sha,
          pr_number: r.pr_number, ci_state: r.ci_state, landing_state: r.landing_state,
          revision: r.revision, updated_at: r.updated_at,
          provenance: 'source-engine-observed'
        }));
      sources.source_engine = { available: true, observed_only: true, count: changes.length, truncated: rows.length === 30 };
    } catch { sources.source_engine = { available: false, error: 'source_unavailable' }; }

    const remote = async (name, fn) => {
      try {
        const value = await fn();
        if (!value?.ok) throw new Error('upstream_unavailable');
        sources[name] = { available: true, observed_at: new Date().toISOString() };
        return value;
      } catch {
        sources[name] = { available: false, error: 'upstream_unavailable' };
        return null;
      }
    };
    const resolved = await remote('github_origin', () => gh.resolveRepo(origin));
    const repo = resolved?.repo;
    let issues = [], pull_requests = [];
    if (repo) {
      const [is, prs] = await Promise.all([
        remote('github_issues', () => gh.issues(repo, { state: 'open', limit: 20 })),
        remote('github_pull_requests', () => gh.pullRequests(repo, { state: 'open', limit: 20 }))
      ]);
      // Keep only bounded fields; never return arbitrary issue bodies or local filesystem paths.
      issues = (is?.issues ?? []).slice(0, 20).map(i => ({
        number: i.number, title: i.title, state: i.state, url: i.url, updated_at: i.updated_at
      }));
      pull_requests = (prs?.pull_requests ?? []).slice(0, 20).map(p => ({
        number: p.number, title: p.title, state: p.state, draft: p.draft,
        mergeable: p.mergeable, head: p.head, url: p.url, updated_at: p.updated_at
      }));
    }
    const output = {
      ok: true, project: { id: args.project, kind: project.kind, status: project.status,
        nature: project.nature, stack: project.stack, origin },
      goal: args.goal ?? null, observed_at: new Date().toISOString(),
      capability_evidence: { source_engine: 'observed', project_context: 'on_branch_unverified',
        warning: 'Presence of an issue or PR is not proof of deployment. No merge authorization is implied.' },
      source_changes: changes, issues, pull_requests, sources,
      limitations: ['Only latest 20 open issues and PRs; latest 30 local source changes',
        'GitHub issue/PR observations are not a substitute for required CI and branch protection',
        'Historical architectural decisions and cross-host workspaces are not yet aggregated']
    };
    await rt.audit('project_context', 'ok', null);
    return respond(output);
  });
}
