// Read-only readiness gate for an owner-controlled Mac OpenCode ACP session.
// The agent runner must invoke the same boundary at launch and on every lease tick;
// preflight alone never starts OpenCode or grants a file path to a model.
import { z } from 'zod/v4';
import { checkAcpAdmission } from '../runners/acp-admission.mjs';
import { acpRuntimeOwners } from '../runners/acp-runtime-owner.mjs';
import { CAPABILITIES, HUB_PRINCIPALS, isRemotePrincipal, localOwnerId } from '../coordinator/policy.mjs';

export const ACP_TOOLS = Object.freeze(['agent_preflight',
  'agent_sandbox_start', 'agent_sandbox_status', 'agent_sandbox_stop',
  'agent_sandbox_prompt']);
export function registerAcpTools(server, getRuntime, {owners=acpRuntimeOwners}={}) {
  const canaryAllowed=rt=>rt?.host==='mac'&&!rt.readOnly&&
    rt.principal?.id===localOwnerId()&&
    process.env.MEMO_BRIDGE_ACP_SANDBOX_CANARY==='enabled';
  const managerFor=rt=>owners.get(rt);
  // Interactive prompts are an additional *independent* opt-in, beyond the
  // already owner-only, no-network sandbox launch canary. Never turn this on
  // from client arguments or an MCP tool; the Mac owner must configure the
  // reviewed runtime environment separately.
  const interactiveAllowed=rt=>canaryAllowed(rt)&&
    process.env.MEMO_BRIDGE_ACP_INTERACTIVE_CANARY==='enabled';
  // Only the transport-minted owner identity can read live ACP status.
  // CAPABILITIES.EXECUTE is used as an owner-role check, never as a new
  // execution grant; OIDC readers without remote write rights fail closed.
  const liveStatusAllowed=rt=>rt?.host==='mac'&&!rt.readOnly&&
    rt.principal?.capabilities?.has(CAPABILITIES.READ)&&
    rt.principal?.capabilities?.has(CAPABILITIES.EXECUTE)&&
    (rt.principal.id===localOwnerId() ||
     rt.principal.id===HUB_PRINCIPALS.OWNER ||
     isRemotePrincipal(rt.principal));
  const respond=data=>({content:[{type:'text',text:JSON.stringify(data)}]});
  const call=(op,method)=>async args=>{
    let rt;
    try{rt=await getRuntime();}catch{return respond({ok:false,error:'store_unavailable'});}
    if(method==='status'){
      // Status is deliberately NOT gated on the launch canary: a legitimate
      // owner may inspect a session even after canary launch was disabled.
      // This never creates a manager, reads old receipts or leaks another
      // principal's session, and never executes agent code.
      if(!liveStatusAllowed(rt)||!rt.authorize(op))
        return respond({ok:false,error:'forbidden'});
      let status;
      try{status=owners.peek(rt)?.statusLive(args.session_id)
        ?? {ok:false,error:'unknown_session'};}
      catch{status={ok:false,error:'internal_error'};}
      if(!status.ok)await rt.audit(op,'denied',status.error,{});
      return respond(status);
    }
    if(method==='prompt'){
      if(!interactiveAllowed(rt)||!rt.authorize(op))
        return respond({ok:false,error:'interactive_canary_disabled'});
      // Never start an ACP child just to handle a prompt. If its owner has
      // gone away, an old receipt is not authority to create a new session.
      const supervisor=owners.peek(rt);
      if(!supervisor)return respond({ok:false,error:'agent_not_running'});
      let result;
      try{result=await supervisor.prompt(args.session_id,args.text);}
      catch{result={ok:false,error:'internal_error'};}
      // Do not audit prompt content; only a short result code/operation.
      await rt.audit(op,result.ok?'ok':'denied',result.ok?null:result.error,{});
      return respond(result);
    }
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
    description:'Read-only owner view of a live Mac ACP session in this runtime/principal. No manager is started, no old receipts or other identities are searched; unknown after restart.',
    inputSchema:z.object({session_id:sessionId}),
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },call('agent_sandbox_status','status'));
  server.registerTool('agent_sandbox_stop',{
    description:'Stop an owner Mac sandbox canary ACP process; no provider or GitHub work is triggered.',
    inputSchema:z.object({session_id:sessionId}),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },call('agent_sandbox_stop','stop'));
  server.registerTool('agent_sandbox_prompt',{
    description:'EXPERIMENTAL Mac owner-only ACP v1 canary. Requires BOTH sandbox and interactive env gates enabled by the operator; sends one bounded text turn to an existing lease-checked no-network/no-provider session. No auto-launch, no filesystem/terminal client permissions, no remote public surface.',
    inputSchema:z.object({
      session_id:sessionId,
      text:z.string().trim().min(1).max(4096)
    }),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
  },call('agent_sandbox_prompt','prompt'));

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
