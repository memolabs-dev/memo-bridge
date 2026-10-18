// Explicit, scoped Source Engine reconciliation. GitHub is read-only; only the private
// append-only Source Engine observation store is updated. No merge, branch write, or deploy.
import { z } from 'zod/v4';
import { listProjects } from '../catalog.mjs';
import { createGitHub, parseRepo } from '../integrations/github.mjs';
import { reconcileSourceProject } from '../source-engine/reconcile.mjs';
import { isRemotePrincipal } from '../coordinator/policy.mjs';
import { remotePolicyFromEnv, remoteProjectRefusal } from '../../bridge/write-gate.mjs';

export const SOURCE_RECONCILE_TOOLS = Object.freeze(['source_reconcile']);
const result = body => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
const fail = error => ({ ok: false, error });
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export function registerSourceReconcileTools(server, getRuntime, deps = {}) {
  const catalog = deps.listProjects ?? listProjects;
  const getPolicy = deps.remotePolicy ?? remotePolicyFromEnv;
  const cache = new WeakMap();
  const githubOf = rt => {
    if (deps.github) return deps.github;
    let gh = cache.get(rt);
    if (!gh) {
      gh = createGitHub({ catalogOptions: rt.catalogOptions, now: rt.now,
        credentials: rt.githubCredentials ?? null });
      cache.set(rt, gh);
    }
    return gh;
  };
  server.registerTool('source_reconcile', {
    description: 'Use this when the owner asks to refresh the PR and CI state of the changes tracked on a project. Records observations only; never merges.',
    inputSchema: z.object({
      project: z.string().max(80).describe('Registered name, e.g. "stasis".'),
      limit: z.number().int().min(1).max(30).optional().describe('At most 30.')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (args = {}) => {
    let rt;
    try { rt = await getRuntime(); } catch { return result(fail('runtime_unavailable')); }
    if (!rt.authorize('source_reconcile')) {
      await rt.audit('source_reconcile', 'denied', 'forbidden');
      return result(fail('forbidden'));
    }
    if (!PROJECT.test(args.project ?? '') || (args.limit !== undefined &&
      (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 30))) return result(fail('invalid_input'));
    if (isRemotePrincipal(rt.principal)) {
      const refusal = remoteProjectRefusal(rt.principal, args.project, getPolicy());
      if (refusal) {
        await rt.audit('source_reconcile', 'denied', 'project_not_allowed');
        return result(fail('project_not_allowed'));
      }
    }
    try {
      const listed = await catalog({ search: args.project }, rt.catalogOptions ?? {});
      if (!listed.projects.some(p => p.name === args.project && p.kind === 'repo' && !p.metadata_only)) {
        await rt.audit('source_reconcile', 'denied', 'unknown_project');
        return result(fail('unknown_project'));
      }
    } catch { return result(fail('catalog_unavailable')); }
    try {
      const gh = githubOf(rt);
      const origin = await (deps.repoFor ? deps.repoFor(rt, args.project) : gh.projectRepo(args.project));
      if (!parseRepo(origin)) return result(fail('repo_unavailable'));
      const outcome = await reconcileSourceProject({
        store: rt.store(), github: gh, project: args.project, origin,
        limit: args.limit ?? 30, now: rt.now
      });
      await rt.audit('source_reconcile', outcome.ok ? 'ok' : 'error', outcome.ok ? null : outcome.error);
      return result(outcome);
    } catch {
      await rt.audit('source_reconcile', 'error', 'source_unavailable');
      return result(fail('source_unavailable'));
    }
  });
}
