// Read-only readiness gate for an owner-controlled Mac OpenCode ACP session.
// The agent runner must invoke the same boundary at launch and on every lease tick;
// preflight alone never starts OpenCode or grants a file path to a model.
import { z } from 'zod/v4';
import { checkAcpAdmission } from '../runners/acp-admission.mjs';

export const ACP_TOOLS = Object.freeze(['agent_preflight']);
export function registerAcpTools(server, getRuntime) {
  server.registerTool('agent_preflight', {
    description: 'Verify that an existing owner-claimed Mac worktree has a valid live lease, canonical Git checkout and OpenCode binary. Returns only identifiers and a status, never a host path or execution rights. This check does NOT start an agent.',
    inputSchema: z.object({
      worktree_id: z.string().max(40).describe('Registered wt_... ID; never an absolute path.'),
      workspace_id: z.string().max(40).optional().describe('Owned ws_... ID, when known.')
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (args) => {
    const rt = await getRuntime();
    if (!rt.authorize('agent_preflight')) {
      await rt.audit('agent_preflight', 'denied', 'forbidden', {});
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'forbidden' }) }] };
    }
    let data;
    try { data = await checkAcpAdmission(rt, args); }
    catch { data = { ok: false, error: 'internal_error' }; }
    if (!data.ok) await rt.audit('agent_preflight', 'denied', data.error, {});
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  });
}
