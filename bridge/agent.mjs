// Memo Bridge agent: connects out to the hub, proves its Ed25519 identity (v1 handshake),
// advertises the ops it serves (protocol v2 hello, bridge/protocol.mjs) and answers requests.
// Probe mode serves host_status only. Runtime mode (bridge/agent-cli.mjs) also serves the
// runtime tools through createRuntimeOperations(), re-authorizing every request.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { signChallenge } from './crypto.mjs';
import {
  MAX_FRAME_BYTES, MAX_IN_FLIGHT, MAX_REQUEST_BYTES, MAX_RESULT_BYTES, OP_RE, PING_INTERVAL_MS, PROTOCOL_VERSION, SUBPROTOCOL,
  OperationError, backoffDelay, createReassembler, encodeFrames, errorFrame, makeHello, parseFrame, resultFrame, validateRequest
} from './protocol.mjs';
import { RUNTIME_OPS, collectTools, principalFromWire as hubPrincipalFromWire } from './ops.mjs';
import { authorize as policyAuthorize } from '../server/coordinator/policy.mjs';

const PROBE=String.raw`import json,platform,os,shutil
disk=shutil.disk_usage("/")
print(json.dumps({"hostname":platform.node(),"system":platform.system(),"architecture":platform.machine(),"cpu_count":os.cpu_count(),"load_average":[round(v,2) for v in os.getloadavg()] if hasattr(os,"getloadavg") else None,"disk_free_gib":round(disk.free/(1024**3),1)}))
`;
export async function localStatus(host){
  if(!['mac','vps'].includes(host))throw new Error('Unknown host');
  return await new Promise(resolve=>{
    // -I: isolated mode, no user site or environment-driven imports.
    const p=spawn('python3',['-I','-'],{stdio:['pipe','pipe','ignore']});
    let output='';
    const timer=setTimeout(()=>p.kill('SIGKILL'),3000);
    p.stdout.on('data',x=>output=(output+x).slice(0,4096));
    p.on('error',()=>{clearTimeout(timer);resolve({host,online:false,error:'probe_unavailable'});});
    p.on('close',status=>{clearTimeout(timer);
      try{const d=JSON.parse(output);if(status!==0)throw new Error();resolve({host,online:true,...d});}catch{resolve({host,online:false,error:'probe_failed'});}
    });
    p.stdin.on('error',()=>{});p.stdin.end(PROBE);
  });
}

export const probeOperations = host => ({ host_status: async () => localStatus(host) });

// operations: {op: async (args, ctx) => data}. ctx = {op, principal:{id, client_type?}, requestKey, timeoutMs, meta}.
// meta is the hub's per-request metadata ({request_id?, client_session?}, protocol.mjs wireMeta) or null.
// A handler throws OperationError(code) to answer {type:'error', code}.
export function createAgent({ host, url, privateKey, ca, operations = probeOperations(host), reconnectMs, backoff = {},
  maxInFlight = MAX_IN_FLIGHT, pingIntervalMs = PING_INTERVAL_MS, livenessMs = pingIntervalMs * 3, random = Math.random,
  log = () => {} }) {
  if (!['mac','vps'].includes(host))throw new Error('Invalid host');
  const endpoint=new URL(url);
  if(endpoint.protocol!=='wss:' || !['localhost','127.0.0.1'].includes(endpoint.hostname) || endpoint.pathname!=='/agent' || endpoint.search || !endpoint.port) throw new Error('Only private TLS tunnel endpoints accepted');
  const handlers = new Map(Object.entries(operations).filter(([op,fn])=>OP_RE.test(op) && typeof fn==='function'));
  if (!handlers.has('host_status')) throw new Error('host_status is mandatory');
  // reconnectMs (v1 option) sets the first delay; the ceiling never drops below 60 s.
  const minMs = backoff.minMs ?? reconnectMs ?? 1000;
  const maxMs = Math.max(backoff.maxMs ?? 60_000, minMs);
  let stopped=false, ws=null, timer=null, liveness=null, attempt=0, inFlight=0, trusted=false;

  const send = (socket, message) => {
    const frames = encodeFrames(message, {maxMessageBytes: MAX_RESULT_BYTES});
    if (!frames) return false;
    if (socket.readyState!==WebSocket.OPEN) return true;
    for (const frame of frames) socket.send(frame);
    return true;
  };
  const armLiveness = socket => {
    clearTimeout(liveness);
    // No ping (or message) from the hub for livenessMs: the link is dead; reconnect.
    liveness = setTimeout(()=>{ log('hub_ping_timeout',host); socket.terminate(); }, livenessMs);
    liveness.unref?.();
  };

  async function serve(socket, req) {
    const handler = handlers.get(req.op);
    if (!handler) { send(socket, errorFrame(req.id,'unsupported_op')); return; }
    if (inFlight >= maxInFlight) { send(socket, errorFrame(req.id,'agent_busy')); return; }
    inFlight++;
    try {
      const data = await handler(req.args, {op:req.op, principal:req.principal, requestKey:req.requestKey, timeoutMs:req.timeoutMs, meta:req.meta ?? null});
      if (!send(socket, resultFrame(req.id, data))) send(socket, errorFrame(req.id,'result_too_large'));
    } catch (error) {
      const code = error instanceof OperationError ? error.code : 'internal_error';
      if (code==='internal_error') log('op_failed',host,{op:req.op});
      send(socket, errorFrame(req.id, code));
    } finally { inFlight--; }
  }

  const open=()=>{
    if(stopped)return;
    const socket=new WebSocket(url,SUBPROTOCOL,{ca, rejectUnauthorized:true,perMessageDeflate:false,handshakeTimeout:5000,maxPayload:MAX_FRAME_BYTES});
    ws=socket;
    const parts=createReassembler({maxMessageBytes:MAX_REQUEST_BYTES, tooLarge:'request_too_large'});
    let authed=false;
    const onMessage = async msg => {
      if(msg.type==='challenge' && !authed){
        socket.send(JSON.stringify({type:'authenticate',host,signature:signChallenge(host,msg.nonce,privateKey)}));return;
      }
      if(msg.type==='authenticated' && !authed){
        authed=true; trusted=true; attempt=0; log('connected',host);
        socket.send(JSON.stringify(makeHello({host, ops:[...handlers.keys()], maxInFlight})));
        armLiveness(socket);
        return;
      }
      if(!authed) return;
      if(msg.type==='welcome'){ log('hello_accepted',host,{ops:Array.isArray(msg.ops)?msg.ops.length:0}); return; }
      if(msg.type!=='request') return;
      // v1 request from an older hub: host_status, answered in v1.
      if(msg.v===undefined){
        if(msg.op==='host_status' && typeof msg.id==='string'){
          const data=await localStatusFor(handlers);
          if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'result',id:msg.id,data}));
        }
        return;
      }
      const checked=validateRequest(msg);
      if(!checked.ok){ if(checked.id) send(socket, errorFrame(checked.id, checked.code)); return; }
      await serve(socket, checked.value);
    };
    socket.on('message',(data,isBinary)=>{
      if(authed) armLiveness(socket);
      const msg=isBinary ? null : parseFrame(data);
      if(!msg){socket.close(1008,'invalid message');return;}
      if(msg.type==='part' && authed){
        const out=parts.accept(msg);
        if(!out) return;
        if(out.error){ if(out.id) send(socket, errorFrame(out.id, out.error)); return; }
        if(out.message.v===PROTOCOL_VERSION && out.message.type==='request') onMessage(out.message).catch(()=>{});
        return;
      }
      onMessage(msg).catch(()=>{});
    });
    socket.on('ping',()=>{ if(authed) armLiveness(socket); });
    socket.on('error',()=>{});
    socket.on('close',()=>{
      clearTimeout(liveness); parts.clear();
      if(ws===socket) trusted=false;
      if(stopped) return;
      const delay=backoffDelay(attempt++,{minMs,maxMs,random});
      log('reconnect_scheduled',host,{delay_ms:delay});
      timer=setTimeout(open,delay);
    });
  };
  open();
  return {
    stop(){stopped=true;clearTimeout(timer);clearTimeout(liveness);ws?.terminate();},
    get connected(){ return trusted; },
    get inFlight(){ return inFlight; },
    get ops(){ return [...handlers.keys()]; }
  };
}

async function localStatusFor(handlers){
  try { return await handlers.get('host_status')({}, {op:'host_status'}); } catch { return {online:false,error:'probe_failed'}; }
}

// The identity claim a runtime maps (runtime.principalFromHub): the forwarded id and, when the
// hub sent one, the client_type label. Nothing else of the wire principal is passed on.
export function wireClaim(wire) {
  return wire?.client_type === undefined ? { id: wire?.id } : { id: wire?.id, client_type: wire.client_type };
}

// Runtime mode: serve the runtime tools for hub principals. For every request:
//  1. the principal id from the wire maps to capabilities with this side's own table
//     (bridge/ops.mjs); capabilities never come from the hub;
//  2. authorize(principal, op) again, journaling a refusal in the runtime store (with the
//     principal) and in the service journal (stderr), before any argument is looked at;
//  3. the arguments are validated against the tool's own input schema;
//  4. the tool handler runs against a runtime scoped to that principal.
// runtimeFor(principal) returns that runtime: runtime.as(principal) (server/runtime.mjs).
// principalFromWire(wire) maps the forwarded {id, client_type?}: runtime.principalFromHub with the runtime's grants.
// The hub's per-request metadata (ctx.meta) reaches the tool handler as extra.meta: the
// coordinator, worktree and GitHub tools read the request id and the session hash from there,
// never from tool arguments.
export async function createRuntimeOperations({ runtimeFor, collect = collectTools, principalFromWire = hubPrincipalFromWire,
  authorize = policyAuthorize, ops = RUNTIME_OPS, log = () => {} }) {
  const scoped = new Map();
  async function scope(principal) {
    let entry = scoped.get(principal.id);
    if (!entry) {
      entry = (async () => {
        const rt = await runtimeFor(principal);
        return { rt, tools: await collect(() => rt) };
      })();
      scoped.set(principal.id, entry);
      entry.catch(() => scoped.delete(principal.id));
    }
    return entry;
  }
  const handlers = {};
  for (const op of ops) {
    handlers[op] = async (args, ctx) => {
      const principal = principalFromWire(ctx.principal);
      if (!principal) {
        log('op_denied', { principal: 'unknown', op, reason: 'unknown_principal' });
        throw new OperationError('unknown_principal');
      }
      const { rt, tools } = await scope(principal);
      if (!authorize(principal, op)) {
        log('op_denied', { principal: principal.id, op, reason: 'forbidden' });
        await rt.audit(op, 'denied', 'forbidden');
        return { ok: false, error: 'forbidden' };
      }
      const tool = tools.get(op);
      if (!tool) throw new OperationError('unsupported_op');
      const parsed = tool.inputSchema.safeParse(args ?? {});
      if (!parsed.success) throw new OperationError('invalid_arguments');
      return unwrapToolResult(await tool.handler(parsed.data, { requestKey: ctx.requestKey ?? null, principal: principal.id, meta: ctx.meta ?? null }));
    };
  }
  return {
    handlers,
    async close() {
      for (const entry of scoped.values()) { try { await (await entry).rt.close?.(); } catch { /* closing */ } }
      scoped.clear();
    }
  };
}

// Tool handlers answer MCP content: one text item holding JSON. The wire carries the JSON.
export function unwrapToolResult(out) {
  const text = out?.content?.[0]?.type === 'text' ? out.content[0].text : null;
  if (typeof text !== 'string') throw new OperationError('internal_error');
  let data;
  try { data = JSON.parse(text); } catch { throw new OperationError('internal_error'); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new OperationError('internal_error');
  return data;
}
