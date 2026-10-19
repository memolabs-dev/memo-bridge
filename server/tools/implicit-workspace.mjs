// Implicit workspace (owner console REQ-Z1, zero ceremony): wraps tool registration so a tool that
// needs a workspace and is called without workspace_id runs in the conversation's own workspace,
// the way the operator tools already do (bridge/hub.mjs implicitGate). The owner says "corrige le
// bug de login dans kollio-mac" and the model never has to call workspace_open first.
//
//  - The input schema of each tool listed here gets an optional workspace_id, so the remote
//    surface and the runtime agent (which validate arguments against it) accept a call without it.
//  - At call time, when workspace_id is absent, the coordinator picks the workspace
//    (server/coordinator/index.mjs conversationWorkspace): only one of this principal bound to
//    this conversation's session hash, opened through workspace_open (every guard included) for
//    OPENING tools only. A refusal is returned as the tool result; nothing else runs.
//  - The result carries implicit_workspace {workspace_id, project, opened} so the model can name
//    it later if it wants to; it never has to.
//
// An explicit workspace_id is passed through untouched: every existing check (ownership, session
// binding, delegation scope, leases) still decides. Without a session hint (stdio) the call gets
// workspace_required with the one next step, as before but explicit.
import { z } from 'zod/v4';

// Tools whose workspace can be found from their other arguments or the conversation.
export const IMPLICIT_WORKSPACE_TOOLS = Object.freeze(['workspace_status', 'workspace_recover', 'workspace_close',
  'task_claim', 'task_next', 'task_renew', 'task_release', 'task_complete', 'task_checkpoint',
  'workspace_delegate', 'delegation_status', 'delegation_report', 'delegation_end',
  'worktree_create', 'jobs_submit', 'github_create_pr']);
// The ones that may open the conversation's workspace when it has none: they start the work.
export const OPENING_TOOLS = Object.freeze(['task_claim', 'task_next']);
const IMPLICIT = new Set(IMPLICIT_WORKSPACE_TOOLS);
const OPENING = new Set(OPENING_TOOLS);

export const IMPLICIT_WORKSPACE_FIELD = z.string().max(40).optional()
  .describe('Usually omit: the server uses this conversation\'s workspace (opened by the first task_claim or task_next). A ws_... id targets another one.');

const text = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

function withWorkspace(out, found) {
  const first = out?.content?.[0];
  if (first?.type !== 'text' || typeof first.text !== 'string') return out;
  let data;
  try { data = JSON.parse(first.text); } catch { return out; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  const block = { workspace_id: found.workspace_id, project: found.project, opened: found.opened === true };
  const extra = found.memory_snapshot ? { memory_snapshot: found.memory_snapshot } : {};
  const body = JSON.stringify({ ...data, implicit_workspace: block, ...extra }, null, first.text.includes('\n') ? 2 : undefined);
  return { ...out, content: [{ type: 'text', text: body }, ...out.content.slice(1)] };
}

async function coordinatorOf(getService) {
  const service = await getService();
  return typeof service?.coordinator === 'function' ? service.coordinator() : service;
}

// A registration target (an McpServer or a collector) whose workspace tools resolve the
// conversation's workspace when called without one.
export function withImplicitWorkspace(server, getService) {
  return {
    registerTool(name, config, handler) {
      if (!IMPLICIT.has(name)) return server.registerTool(name, config, handler);
      const schema = config.inputSchema?.shape?.workspace_id ? config.inputSchema.extend({ workspace_id: IMPLICIT_WORKSPACE_FIELD }) : config.inputSchema;
      return server.registerTool(name, { ...config, inputSchema: schema }, async (args, extra) => {
        if (args?.workspace_id !== undefined) return handler(args, extra);
        const meta = extra && typeof extra === 'object' ? extra.meta ?? null : null;
        let found;
        try {
          const coordinator = await coordinatorOf(getService);
          if (typeof coordinator?.conversationWorkspace !== 'function') return handler(args, extra);
          found = await coordinator.conversationWorkspace({ project: args?.project, issue: args?.issue, claim_id: args?.claim_id,
            worktree_id: args?.worktree_id, open: OPENING.has(name), any_project: name === 'task_next' && args?.project === undefined && args?.batch === undefined }, meta);
        } catch {
          found = { ok: false, error: 'store_unavailable' };
        }
        if (found?.ok !== true) return text(found ?? { ok: false, error: 'store_unavailable' });
        const out = await handler({ ...args, workspace_id: found.workspace_id }, extra);
        try { return withWorkspace(out, found); } catch { return out; }
      });
    }
  };
}
