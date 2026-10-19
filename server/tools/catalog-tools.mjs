// Catalogue tool module served by the runtime (Phase 5, FU-4): projects_list, so a client of the
// hub (Phase 4 loopback, Phase 5 ChatGPT) can discover the project names workspace_open takes.
//
// The definition (name, description, input schema, annotations) is the one the stdio entry point
// registers inline in server/index.mjs; tests/registry.test.mjs compares both, so they cannot
// drift. The runtime handler adds what a shared runtime needs: authorization first (journaled on
// refusal), the runtime's own catalogue options (its PROJECTS.md, not the process default) and,
// for a remote (ChatGPT) principal, the remote project allowlist (REQ-P5-09, the same policy
// tasks_list and workspace_open apply, bridge/write-gate.mjs): only allowlisted projects are
// listed, and nothing at all while no allowlist is configured.
import { z } from 'zod/v4';
import { listProjects } from '../catalog.mjs';
import { isRemotePrincipal } from '../coordinator/policy.mjs';
import { remotePolicyFromEnv, remoteProjectRefusal } from '../../bridge/write-gate.mjs';

export const CATALOG_TOOLS = Object.freeze(['projects_list']);
// Shared with the stdio server's own projects_list (server/index.mjs), so both surfaces list the same tool.
export const PROJECTS_LIST_DEFINITION = Object.freeze({
  description: 'Use this when the owner asks about his projects («quels sont mes projets ?», «lesquels je peux faire avancer ?», "list my projects") or names one you do not know yet: registered Memo Labs projects, with status, and which ones you can work on from here. Use it to turn a project name into the exact registered name. Read-only.',
  inputSchema: z.object({ search: z.string().max(80).optional().describe('Part of a name, e.g. "kollio".'),
    status: z.string().max(40).optional().describe('e.g. "active", "lab" or "parked".') })
});

const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = error => ({ ok: false, error });

// deps.remotePolicy() returns the remote policy (tests inject one); default: MEMO_BRIDGE_REMOTE_CONFIG.
export function registerCatalogTools(server, getRuntime, deps = {}) {
  const remotePolicy = deps.remotePolicy ?? (() => remotePolicyFromEnv());
  server.registerTool('projects_list', {
    ...PROJECTS_LIST_DEFINITION,
    annotations: readonly
  }, async (args = {}) => {
    let rt;
    try { rt = await getRuntime(); } catch { return result(fail('runtime_unavailable')); }
    if (!rt.authorize('projects_list')) {
      await rt.audit('projects_list', 'denied', 'forbidden');
      return result(fail('forbidden'));
    }
    let listed;
    // A missing or malformed PROJECTS.md is a short code, never a path or an engine message.
    try { listed = await listProjects(args ?? {}, rt.catalogOptions ?? {}); } catch { return result(fail('catalog_unavailable')); }
    if (!isRemotePrincipal(rt.principal)) return result(listed);
    const policy = remotePolicy();
    const refusal = remoteProjectRefusal(rt.principal, null, policy, { host: rt.host });
    if (refusal && !policy?.configured) {
      await rt.audit('projects_list', 'denied', refusal.error);
      return result(refusal);
    }
    // Opt-in owner discovery: offline Mac snapshot entries are *metadata only*. It never
    // expands the existing project allowlist checked by workspace_open / task_claim / runners.
    // Other remote principals still see only explicitly allowed repositories.
    const ownerDiscovery = rt.catalogDiscoveryEnabled === true && policy?.configured === true &&
      typeof policy.owner_sub === 'string' && rt.principal.id === `oidc:${policy.owner_sub}`;
    const projects = listed.projects.filter(p =>
      !remoteProjectRefusal(rt.principal, p.name, policy, { host: rt.host }) || (ownerDiscovery && p.metadata_only === true));
    return result({ ...listed, total: projects.length, count: projects.length, projects });
  });
}
