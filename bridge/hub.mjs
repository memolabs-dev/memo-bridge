import { createServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { bearerValid, nonce, verifyChallenge, keyFingerprint } from './crypto.mjs';

const tags = {readOnlyHint:true, destructiveHint:false,idempotentHint:true,openWorldHint:false};
const result = value => ({content:[{type:'text',text:JSON.stringify(value)}]});
const MAX_HTTP_BYTES = 64 * 1024;

export function createHub({ tlsKey, tlsCert, allowedAgentKeys, tokenSha256, port=9443, bind='127.0.0.1', audit=()=>{} }) {
  if (!tlsKey || !tlsCert) throw new Error('TLS is mandatory');
  if (!/^[0-9a-f]{64}$/.test(tokenSha256)) throw new Error('Invalid bearer token digest');
  const permitted = new Map(Object.entries(allowedAgentKeys || {}).filter(([host])=>['mac','vps'].includes(host)));
  const agents = new Map();
  const pending = new Map();
  const wss = new WebSocketServer({noServer:true, maxPayload:16*1024, clientTracking:true, perMessageDeflate:false});
  let closing = false;

  function record(event, host, details={}) { audit({at:new Date().toISOString(),event,host,...details}); }
  function inventory() {
    return ['mac','vps'].map(host=>({host, online:agents.has(host), enrolled:permitted.has(host)}));
  }
  function requestAgent(host, operation, timeoutMs=6000) {
    if (!['mac','vps'].includes(host) || operation!=='host_status') throw new Error('Denied operation');
    const ws=agents.get(host);
    if (!ws || ws.readyState!==WebSocket.OPEN) return Promise.resolve({host,online:false,error:'offline'});
    return new Promise(resolve => {
      const id=randomUUID();
      const timer=setTimeout(()=>{pending.delete(id);resolve({host,online:false,error:'timeout'});},timeoutMs);
      pending.set(id,{host,resolve,timer});
      ws.send(JSON.stringify({type:'request',id,op:operation}));
    });
  }
  wss.on('connection',ws=>{
    const value=nonce();
    let verifiedHost=null;
    const guard=setTimeout(()=>ws.close(1008,'authentication timeout'),6000);
    ws.send(JSON.stringify({type:'challenge',nonce:value}));
    ws.on('message',raw=>{
      let msg;
      try { msg=JSON.parse(raw.toString()); } catch { ws.close(1008,'invalid message'); return; }
      if (!verifiedHost) {
        if (msg?.type!=='authenticate'|| typeof msg.host!=='string'||typeof msg.signature!=='string'|| !permitted.has(msg.host)|| !verifyChallenge(msg.host,value,msg.signature,permitted.get(msg.host))) {
          record('agent_auth_denied',null); ws.close(1008,'unauthorized'); return;
        }
        verifiedHost=msg.host;
        clearTimeout(guard);
        const existing=agents.get(verifiedHost);
        if(existing && existing!==ws) existing.close(1000,'reconnected');
        agents.set(verifiedHost,ws);
        record('agent_connected',verifiedHost,{fingerprint:keyFingerprint(permitted.get(verifiedHost))});
        ws.send(JSON.stringify({type:'authenticated'}));
        return;
      }
      if(msg?.type==='result' && typeof msg.id==='string'){
        const job=pending.get(msg.id);
        if(!job || job.host!==verifiedHost)return;
        pending.delete(msg.id); clearTimeout(job.timer);
        const data=msg.data;
        if(data && typeof data==='object' && !Array.isArray(data) && data.host===verifiedHost && typeof data.online==='boolean'){
          job.resolve(data);
        } else {job.resolve({host:verifiedHost,online:false,error:'invalid_agent_response'});}
      }
    });
    ws.on('close',()=>{
      clearTimeout(guard);
      if (verifiedHost && agents.get(verifiedHost)===ws){
        agents.delete(verifiedHost);
        record('agent_disconnected',verifiedHost);
      }
    });
    ws.on('error',()=>{});
  });

  function makeMcp() {
    const mcp=new McpServer({name:'memo-bridge-hub',version:'0.2.0'},{instructions:'Read-only inventory of owner-enrolled Mac and VPS; no arbitrary commands.'});
    mcp.registerTool('list_hosts',{description:'Show authenticated and connected Mac/VPS agents',inputSchema:z.object({}),annotations:tags},async()=>result(inventory()));
    mcp.registerTool('host_status',{description:'Get fixed, read-only host information',inputSchema:z.object({host:z.enum(['mac','vps'])}),annotations:tags},async({host})=>result(await requestAgent(host,'host_status')));
    mcp.registerTool('bridge_info',{description:'Show current security and feature limitations',inputSchema:z.object({}),annotations:tags},async()=>result({mode:'read-only',transport:'https private-loopback',agent_transport:'authenticated-wss',oauth_connected:false,public_exposure:false,tools:['list_hosts','host_status','bridge_info']}));
    return mcp;
  }
  async function handleMcp(req,res) {
    if (req.method!=='POST'){res.writeHead(405,{allow:'POST'}).end();return;}
    const ct=(req.headers['content-type']||'');
    if(!ct.startsWith('application/json')){res.writeHead(415).end();return;}
    const body=[];
    let size=0;
    try{
      for await (const chunk of req){size+=chunk.length;if(size>MAX_HTTP_BYTES)throw new Error('body_too_large');body.push(chunk);}
    }catch{res.writeHead(413).end();return;}
    const raw=Buffer.concat(body);
    const mcp=makeMcp();
    const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined, enableJsonResponse:true,maxRequestBodySize:MAX_HTTP_BYTES});
    try{
      await mcp.connect(transport);
      const request=new Request('https://localhost/mcp',{method:'POST',headers:{'content-type':'application/json','accept':req.headers.accept||'application/json, text/event-stream'},body:raw});
      const response=await transport.handleRequest(request);
      res.writeHead(response.status,Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch(err){record('mcp_internal_error',null);if(!res.headersSent)res.writeHead(500).end();}
    finally{await transport.close().catch(()=>{});await mcp.close().catch(()=>{});}
  }
  const server=createServer({key:tlsKey,cert:tlsCert,minVersion:'TLSv1.2',requestCert:false},async(req,res)=>{
    const path=new URL(req.url||'/', 'https://localhost').pathname;
    if (path==='/health' && req.method==='GET'){
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end('{"status":"ok"}');return;
    }
    if (path!=='/mcp'){res.writeHead(404).end();return;}
    if(!bearerValid(req.headers.authorization,tokenSha256)){
      record('owner_auth_denied',null);
      res.writeHead(401,{'www-authenticate':'Bearer realm="memo-bridge"', 'cache-control':'no-store'}).end();return;
    }
    record('mcp_request',null);
    await handleMcp(req,res);
  });
  server.on('upgrade',(req,socket,head)=>{
    const path=(req.url||'').split('?')[0];
    if (path!=='/agent' || req.headers.origin || !req.headers['sec-websocket-protocol']?.split(',').map(x=>x.trim()).includes('memo-bridge-agent-v1')){
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;
    }
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
  });
  return {
    async start(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,bind,resolve);});return server.address();},
    async stop(){closing=true;for(const ws of wss.clients)ws.terminate();for(const [id,job] of pending){clearTimeout(job.timer);job.resolve({host:job.host,online:false,error:'shutting_down'});}pending.clear();await new Promise(resolve=>server.close(resolve));},
    inventory, requestAgent
  };
}
