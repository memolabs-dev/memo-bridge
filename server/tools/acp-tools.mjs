// Read-only readiness gate for an owner-controlled Mac OpenCode ACP session.
// The agent runner must invoke the same boundary at launch and on every lease tick;
// preflight alone never starts OpenCode or grants a file path to a model.
import { z } from 'zod/v4';
import { checkAcpAdmission } from '../runners/acp-admission.mjs';
import { acpRuntimeOwners } from '../runners/acp-runtime-owner.mjs';
import { localOwnerId } from '../coordinator/policy.mjs';

export const ACP_TOOLS = Object.freeze(['agent_preflight',
  'agent_sandbox_start', 'agent_sandbox_status', 'agent_sandbox_stop']);
export function registerAcpTools(server, getRuntime) {
  const canaryAllowed=rt=>rt?.host==='mac'&&!rt.readOnly&&
    rt.principal?.id===localOwnerId()&&
    process.env.MEMO_BRIDGE_ACP_SANDBOX_CANARY==='enabled';
  const managerFor=rt=>acpRuntimeOwners.get(rt);
  const respond=data=>({content:[{type:'text',text:JSON.stringify(data)}]});
  const call=(op,method)=>async args=>{
    let rt;
    try{rt=await getRuntime();}catch{return respond({ok:false,error:'store_unavailable'});}
    if(!canaryAllowed(rt)||!rt.authorize(op))
      return respond({ok:false,error:'canary_disabled'});
    let result;
    try{result=await managerFor(rt)[method](...(method==='start'?[args]:
      [args.session_id]));}
    catch{result={ok:false,error:'internal_error'};}
    if(method!=='status'||!result.ok)
      await rt.audit(op,result.ok?'ok':'denied',result.ok?null:result.error,{});
    return respond(result);
  };
  const sessionId=z.string().uuid();
  server.registerTool('agent_sandbox_start',{
    description:'Owner Mac canary only: start a real OpenCode ACP process in a no-network, no-credentials Seatbelt sandbox on a verified, claimed worktree. Does NOT yet provide interactive prompting or durable recovery.',
    inputSchema:z.object({
      workspace_id:z.string().max(40),worktree_id:z.string().max(40)
    }),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
  },call('agent_sandbox_start','start'));
  server.registerTool('agent_sandbox_status',{
    description:'Inspect one opaque Mac sandbox canary session ID. Unknown after restart; never auto-relaunch.',
    inputSchema:z.object({session_id:sessionId}),
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },call('agent_sandbox_status','status'));
  server.registerTool('agent_sandbox_stop',{
    description:'Stop an owner Mac sandbox canary ACP process; no provider or GitHub work is triggered.',
    inputSchema:z.object({session_id:sessionId}),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },call('agent_sandbox_stop','stop'));

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
