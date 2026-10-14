// Memo Bridge private hub: authenticated MCP over HTTPS on loopback, plus the agent
// WebSocket. Stateless router (spec D1): it authenticates the caller, maps the credential to
// a principal, checks the op registry (bridge/ops.mjs) and the principal's capabilities, and
// forwards the op to the agent that serves it. Protocol v2 is described in bridge/protocol.mjs.
//
// This listener (127.0.0.1:9443) takes the static owner bearer, the optional read-only bearer
// and the agents' WebSocket. It never takes OAuth tokens: ChatGPT reaches the hub through the
// separate, OIDC-only public listener (bridge/public-listener.mjs, Phase 5 decision D4), which
// shares nothing with this one except requestAgent(). The Phase 1 OIDC mode of this listener
// was removed in Phase 5: it switched the whole 9443 surface to OAuth and accepted any JWT
// with the right audience, ID tokens included.
import { createServer } from 'node:https';
import WebSocket, { WebSocketServer } from 'ws';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { bearerValid, nonce, verifyChallenge, keyFingerprint } from './crypto.mjs';
import {
  MAX_FRAME_BYTES, MAX_IN_FLIGHT, MAX_REQUEST_BYTES, MAX_RESULT_BYTES, PING_INTERVAL_MS, PROTOCOL_VERSION, SUBPROTOCOL,
  CODE_RE, OP_RE, PACKAGE_VERSION, createReassembler, encodeFrames, idempotencyKey, makeRequest, newId, parseFrame,
  validateHello
} from './protocol.mjs';
import { HOSTS, HUB_LOCAL_OPS, HUB_PRINCIPALS, OPS, PRINCIPAL_IDS, RUNTIME_OPS, collectToolDefinitions, denialReason, isForwardable } from './ops.mjs';

const tags = {readOnlyHint:true, destructiveHint:false,idempotentHint:true,openWorldHint:false};
const result = value => ({content:[{type:'text',text:JSON.stringify(value)}]});
const fail = error => ({ok:false,error});
const MAX_HTTP_BYTES = 64 * 1024;

export function createHub(options) {
  // The OIDC options of Phase 1 are refused rather than ignored: a deployment still setting
  // them must fail visibly, not silently fall back to the bearer.
  for (const key of ['oidc', 'oidcPrincipal']) if (Object.hasOwn(options ?? {}, key)) throw new Error(`hub does not take ${key}: OAuth is served by the public listener only`);
  const { tlsKey, tlsCert, allowedAgentKeys, tokenSha256, readOnlyTokenSha256 = null, runtimeHost = null, mutatingOps = false,
    toolDefinitions = null, port = 9443, bind = '127.0.0.1', audit = () => {}, pingIntervalMs = PING_INTERVAL_MS, timeouts = {} } = options;
  if (!tlsKey || !tlsCert) throw new Error('TLS is mandatory');
  if (!/^[0-9a-f]{64}$/.test(tokenSha256)) throw new Error('Invalid bearer token digest');
  if (readOnlyTokenSha256 !== null && (!/^[0-9a-f]{64}$/.test(readOnlyTokenSha256) || readOnlyTokenSha256 === tokenSha256)) {
    throw new Error('Invalid read-only bearer token digest');
  }
  if (runtimeHost !== null && !HOSTS.includes(runtimeHost)) throw new Error('Invalid runtime host');
  // TODO-P4-40: mutating ops are enabled for the owner principal only, by explicit config.
  if (mutatingOps !== false && mutatingOps !== 'owner') throw new Error('mutatingOps must be false or "owner"');
  if (mutatingOps === 'owner' && runtimeHost === null) throw new Error('mutatingOps requires a runtime host');
  const permitted = new Map(Object.entries(allowedAgentKeys || {}).filter(([host])=>HOSTS.includes(host)));
  const agents = new Map();   // host -> connection
  const pending = new Map();  // request id -> {conn, op, host, resolve, timer}
  const wss = new WebSocketServer({noServer:true, maxPayload:MAX_FRAME_BYTES, clientTracking:true, perMessageDeflate:false});
  const gate = { runtimeEnabled: runtimeHost !== null, mutatingOps };
  let definitions = toolDefinitions;
  let pinger = null;

  function record(event, host, details={}) { audit({at:new Date().toISOString(),event,host,...details}); }
  // Refusals are journaled with principal, op and reason only; never arguments or secrets.
  function denied(principal, op, reason) {
    record('op_denied', null, {principal: principal?.id ?? null, op: OP_RE.test(String(op)) ? op : 'invalid', reason});
    return fail(reason);
  }
  function inventory() {
    return HOSTS.map(host=>({host, online:agents.has(host), enrolled:permitted.has(host)}));
  }
  function availableOps(principal) {
    const ops = [...HUB_LOCAL_OPS, 'host_status'];
    if (gate.runtimeEnabled && definitions) for (const op of RUNTIME_OPS) {
      if (definitions.has(op) && !denialReason(principal, op, gate)) ops.push(op);
    }
    return ops.sort();
  }

  // Forward one op to `host`. Resolves with the agent's checked data, or {ok:false, error}.
  // requestId and clientSession (Phase 5, bridge/forward.mjs) travel in the envelope's meta,
  // never in args; the wire id stays the hub's own.
  function requestAgent(host, op, { args = {}, principal = HUB_PRINCIPALS[PRINCIPAL_IDS.readonly], timeoutMs, requestId = null,
    clientSession = null } = {}) {
    if (!HOSTS.includes(host) || !isForwardable(op)) return Promise.resolve(fail('unsupported_op'));
    const spec = OPS[op];
    const conn = agents.get(host);
    if (!conn || conn.ws.readyState!==WebSocket.OPEN) return Promise.resolve(fail('host_offline'));
    if (!conn.ops.has(op)) return Promise.resolve(fail('unsupported_op'));
    if (conn.pending.size >= conn.maxInFlight) return Promise.resolve(fail('agent_busy'));
    const id = newId();
    let frames;
    if (conn.version === 1) {
      frames = [JSON.stringify({type:'request',id,op})];
    } else {
      const requestKey = spec.mutating ? idempotencyKey(principal.id, op, args.client_request_id) : null;
      frames = encodeFrames(makeRequest({id, op, args, principal, timeoutMs: timeoutMs ?? timeouts[op] ?? spec.timeoutMs, requestKey,
        meta: {request_id: requestId, client_session: clientSession}}),
        {maxMessageBytes:MAX_REQUEST_BYTES});
      if (!frames) return Promise.resolve(fail('request_too_large'));
    }
    return new Promise(resolve => {
      const timer = setTimeout(()=>{
        if (pending.delete(id)) { conn.pending.delete(id); record('op_timeout',host,{op}); resolve(fail('timeout')); }
      }, timeoutMs ?? timeouts[op] ?? spec.timeoutMs);
      pending.set(id,{conn,op,host,resolve,timer});
      conn.pending.add(id);
      for (const frame of frames) conn.ws.send(frame);
    });
  }
  function settle(id, value) {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id); job.conn.pending.delete(id); clearTimeout(job.timer);
    job.resolve(value);
  }
  // A closed connection fails its outstanding requests at once (spec REQ-P4-02).
  function flush(conn, code) {
    for (const id of [...conn.pending]) settle(id, fail(code));
  }

  function onAgentMessage(conn, msg) {
    if (msg.type === 'hello') {
      if (conn.version === 2) { conn.ws.close(1008,'duplicate hello'); return; }
      const hello = validateHello(msg, conn.host);
      if (!hello.ok) {
        record('agent_hello_refused', conn.host, {reason: hello.code});
        conn.ws.close(1008, hello.code); return;
      }
      // Effective ops: what the registry allows AND the agent serves. Anything else advertised
      // is ignored, so an agent can never widen what the hub forwards.
      const effective = hello.ops.filter(isForwardable);
      conn.version = 2; conn.ops = new Set(effective); conn.maxInFlight = hello.maxInFlight; conn.agentVersion = hello.version;
      record('agent_hello', conn.host, {version: hello.version, ops: effective.length, ignored: hello.ops.length - effective.length});
      conn.ws.send(JSON.stringify({v:PROTOCOL_VERSION,type:'welcome',ops:effective}));
      return;
    }
    if (msg.type !== 'result' && msg.type !== 'error') return;
    if (typeof msg.id !== 'string') return;
    const job = pending.get(msg.id);
    if (!job || job.conn !== conn) return;
    if (msg.type === 'error') {
      settle(msg.id, fail(typeof msg.code === 'string' && CODE_RE.test(msg.code) ? msg.code : 'invalid_agent_response'));
      return;
    }
    const spec = OPS[job.op];
    if (spec.checkResult(msg.data, conn.host)) settle(msg.id, msg.data);
    else { record('invalid_agent_response', conn.host, {op: job.op}); settle(msg.id, fail('invalid_agent_response')); }
  }

  wss.on('connection',ws=>{
    const value=nonce();
    let conn=null;
    const authTimer=setTimeout(()=>ws.close(1008,'authentication timeout'),6000);
    ws.send(JSON.stringify({type:'challenge',nonce:value}));
    ws.on('message',(raw,isBinary)=>{
      const msg = isBinary ? null : parseFrame(raw);
      if (!msg) { ws.close(1008,'invalid message'); return; }
      if (!conn) {
        if (msg.type!=='authenticate'|| typeof msg.host!=='string'||typeof msg.signature!=='string'|| !permitted.has(msg.host)|| !verifyChallenge(msg.host,value,msg.signature,permitted.get(msg.host))) {
          record('agent_auth_denied',null); ws.close(1008,'unauthorized'); return;
        }
        clearTimeout(authTimer);
        // Until a v2 hello arrives the agent is treated as v1: host_status only.
        conn = {ws, host:msg.host, version:1, ops:new Set(['host_status']), pending:new Set(), maxInFlight:MAX_IN_FLIGHT,
          alive:true, agentVersion:null, parts:createReassembler({maxMessageBytes:MAX_RESULT_BYTES, tooLarge:'result_too_large'})};
        const existing=agents.get(conn.host);
        if(existing && existing.ws!==ws) existing.ws.close(1000,'reconnected');
        agents.set(conn.host,conn);
        record('agent_connected',conn.host,{fingerprint:keyFingerprint(permitted.get(conn.host))});
        ws.send(JSON.stringify({type:'authenticated'}));
        return;
      }
      if (msg.type==='part') {
        const out = conn.parts.accept(msg);
        if (!out) return;
        if (out.error) { if (out.id) settle(out.id, fail(out.error)); return; }
        onAgentMessage(conn, out.message);
        return;
      }
      // v1 result (legacy agent), host_status only.
      if (conn.version===1 && msg.type==='result' && msg.v===undefined) { onAgentMessage(conn, msg); return; }
      if (msg.v!==undefined && msg.v!==PROTOCOL_VERSION) { ws.close(1008,'unsupported version'); return; }
      onAgentMessage(conn, msg);
    });
    ws.on('pong',()=>{ if (conn) conn.alive=true; });
    ws.on('close',()=>{
      clearTimeout(authTimer);
      if (!conn) return;
      flush(conn,'agent_disconnected');
      conn.parts.clear();
      if (agents.get(conn.host)===conn){
        agents.delete(conn.host);
        record('agent_disconnected',conn.host);
      }
    });
    ws.on('error',()=>{});
  });

  // Ping every agent; one that has not answered the previous ping is dropped (and its
  // pending requests flushed by the close handler).
  function heartbeat() {
    for (const conn of agents.values()) {
      if (!conn.alive) { record('agent_ping_timeout',conn.host); conn.ws.terminate(); continue; }
      conn.alive=false;
      try { conn.ws.ping(); } catch { /* closed meanwhile */ }
    }
  }

  async function forward(principal, op, args) {
    const reason = denialReason(principal, op, gate);
    if (reason) return denied(principal, op, reason);
    const out = await requestAgent(runtimeHost, op, {args, principal});
    if (out?.ok===false && out.error==='forbidden') record('op_denied_by_runtime',runtimeHost,{principal:principal.id,op,reason:'forbidden'});
    return out;
  }

  function makeMcp(principal) {
    const mcp=new McpServer({name:'memo-bridge-hub',version:PACKAGE_VERSION},{instructions:'Memo Bridge private hub. Read-only inventory of owner-enrolled Mac and VPS; when enabled, the VPS runtime tools (workspaces, tasks, worktrees, jobs) for the principal of your credential. No arbitrary commands.'});
    mcp.registerTool('list_hosts',{description:'Show authenticated and connected Mac/VPS agents',inputSchema:z.object({}),annotations:tags},async()=>result(inventory()));
    mcp.registerTool('host_status',{description:'Get fixed, read-only host information',inputSchema:z.object({host:z.enum(['mac','vps'])}),annotations:tags},async({host})=>{
      const out=await requestAgent(host,'host_status',{principal});
      return result(out?.ok===false ? {host,online:false,error:out.error} : out);
    });
    mcp.registerTool('bridge_info',{description:'Show current security and feature limitations',inputSchema:z.object({}),annotations:tags},async()=>result({
      mode: gate.mutatingOps==='owner' ? 'read-write-owner' : 'read-only', protocol: PROTOCOL_VERSION, version: PACKAGE_VERSION,
      transport:'https private-loopback', agent_transport:'authenticated-wss',
      oauth:'public listener only (bridge/public-listener.mjs)', public_exposure:false, principal:{id:principal.id, capabilities:[...principal.capabilities].sort()},
      runtime_host: runtimeHost, mutating_ops: gate.mutatingOps==='owner' ? 'owner' : 'disabled',
      agents: [...agents.values()].map(c=>({host:c.host, protocol:c.version, version:c.agentVersion, ops:c.ops.size})),
      tools: availableOps(principal)
    }));
    if (gate.runtimeEnabled && definitions) {
      for (const op of availableOps(principal)) {
        if (HUB_LOCAL_OPS.includes(op) || op==='host_status') continue;
        const def = definitions.get(op);
        mcp.registerTool(op,{description:def.description,inputSchema:def.inputSchema,annotations:def.annotations},
          async args=>result(await forward(principal, op, args ?? {})));
      }
    }
    return mcp;
  }
  // Journal every tools/call this principal may not make, before the MCP layer answers it
  // (an op that is not listed for the principal is "unknown tool" to the MCP SDK).
  function inspectCalls(principal, raw) {
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return; }
    for (const msg of Array.isArray(body) ? body : [body]) {
      if (msg?.method!=='tools/call' || typeof msg.params?.name!=='string') continue;
      const op = msg.params.name;
      if (availableOps(principal).includes(op)) continue;
      denied(principal, op, denialReason(principal, op, gate) ?? (isForwardable(op) ? 'runtime_disabled' : 'unsupported_op'));
    }
  }
  async function handleMcp(req,res,principal) {
    if (req.method!=='POST'){res.writeHead(405,{allow:'POST'}).end();return;}
    const ct=(req.headers['content-type']||'');
    if(!ct.startsWith('application/json')){res.writeHead(415).end();return;}
    const body=[];
    let size=0;
    try{
      for await (const chunk of req){size+=chunk.length;if(size>MAX_HTTP_BYTES)throw new Error('body_too_large');body.push(chunk);}
    }catch{res.writeHead(413).end();return;}
    const raw=Buffer.concat(body);
    inspectCalls(principal, raw);
    const mcp=makeMcp(principal);
    const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined, enableJsonResponse:true,maxRequestBodySize:MAX_HTTP_BYTES});
    try{
      await mcp.connect(transport);
      const request=new Request('https://localhost/mcp',{method:'POST',headers:{'content-type':'application/json','accept':req.headers.accept||'application/json, text/event-stream'},body:raw});
      const response=await transport.handleRequest(request);
      res.writeHead(response.status,Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {record('mcp_internal_error',null);if(!res.headersSent)res.writeHead(500).end();}
    finally{await transport.close().catch(()=>{});await mcp.close().catch(()=>{});}
  }
  // Credential -> principal (spec D9). Both bearer digests are always compared, in constant time.
  function principalOf(header) {
    const owner = bearerValid(header, tokenSha256);
    const reader = readOnlyTokenSha256 ? bearerValid(header, readOnlyTokenSha256) : false;
    if (owner) return HUB_PRINCIPALS[PRINCIPAL_IDS.owner];
    if (reader) return HUB_PRINCIPALS[PRINCIPAL_IDS.readonly];
    return null;
  }
  const server=createServer({key:tlsKey,cert:tlsCert,minVersion:'TLSv1.2',requestCert:false},async(req,res)=>{
    const path=new URL(req.url||'/', 'https://localhost').pathname;
    if (path==='/health' && req.method==='GET'){
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end('{"status":"ok"}');return;
    }
    if (path!=='/mcp'){res.writeHead(404).end();return;}
    const principal = principalOf(req.headers.authorization);
    if(!principal){
      record('owner_auth_denied',null);
      res.writeHead(401,{'www-authenticate':'Bearer realm="memo-bridge"', 'cache-control':'no-store'}).end();return;
    }
    record('mcp_request',null,{principal:principal.id});
    await handleMcp(req,res,principal);
  });
  server.on('upgrade',(req,socket,head)=>{
    const path=(req.url||'').split('?')[0];
    if (path!=='/agent' || req.headers.origin || !req.headers['sec-websocket-protocol']?.split(',').map(x=>x.trim()).includes(SUBPROTOCOL)){
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;
    }
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
  });
  return {
    async start(){
      if (gate.runtimeEnabled && !definitions) definitions = await collectToolDefinitions();
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,bind,resolve);});
      pinger = setInterval(heartbeat, pingIntervalMs); pinger.unref();
      return server.address();
    },
    async stop(){
      clearInterval(pinger);
      for (const id of [...pending.keys()]) settle(id, fail('shutting_down'));
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve=>server.close(resolve));
    },
    inventory, requestAgent, availableOps,
    agentInfo(host){ const c=agents.get(host); return c ? {version:c.version, ops:[...c.ops].sort(), pending:c.pending.size} : null; }
  };
}
