// Learning review hook (#38): wraps tool registration so every runtime tool call that names a
// workspace is counted (server/coordinator/learning.mjs), and the result of the call that is due
// carries the fixed `learning_review` block. Applied once by the stdio entry point
// (server/index.mjs) and once by collectTools (server/registry.mjs), which the runtime agent
// behind the remote ChatGPT surface uses: both surfaces count the same calls.
//
// The hook never changes what a tool does and never fails a call: the bookkeeping runs after the
// handler, and any error in it returns the handler's result unchanged.
const WS_RE = /^ws_[A-Za-z0-9_-]{16}$/;

// The workspace a call names: its workspace_id argument, or the one workspace_open just created.
function workspaceOf(op, args, data) {
  if (WS_RE.test(args?.workspace_id ?? '')) return args.workspace_id;
  if (op === 'workspace_open' && WS_RE.test(data?.workspace?.workspace_id ?? '')) return data.workspace.workspace_id;
  return null;
}

async function withReview(op, args, extra, out, getService) {
  const first = out?.content?.[0];
  if (first?.type !== 'text' || typeof first.text !== 'string') return out;
  const meta = extra && typeof extra === 'object' ? extra.meta ?? null : null;
  let data;
  try { data = JSON.parse(first.text); } catch { return out; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  const workspaceId = workspaceOf(op, args, data);
  if (!workspaceId && typeof meta?.client_session !== 'string') return out;
  const service = await getService();
  const coordinator = typeof service?.coordinator === 'function' ? service.coordinator() : service;
  if (typeof coordinator?.learningTick !== 'function') return out;
  const review = await coordinator.learningTick({ workspace_id: workspaceId, op, result: data }, meta);
  if (!review) return out;
  // Keep the tool's own formatting (the coordinator tools indent, the others are compact).
  const text = JSON.stringify({ ...data, learning_review: review }, null, first.text.includes('\n') ? 2 : undefined);
  return { ...out, content: [{ type: 'text', text }, ...out.content.slice(1)] };
}

// A registration target (an McpServer or a collector) whose handlers are counted.
export function withLearning(server, getService) {
  return {
    registerTool(name, config, handler) {
      return server.registerTool(name, config, async (args, extra) => {
        const out = await handler(args, extra);
        try { return await withReview(name, args, extra, out, getService); } catch { return out; }
      });
    }
  };
}
