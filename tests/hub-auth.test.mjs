import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import https from 'node:https';
import WebSocket from 'ws';
import {createHub} from '../bridge/hub.mjs';
import {createAgent} from '../bridge/agent.mjs';
import {generateAgentIdentity,signChallenge,bearerValid} from '../bridge/crypto.mjs';

async function until(fn,ms=5000){
  const expire=Date.now()+ms;
  while(!fn()){if(Date.now()>expire)throw new Error('wait expired');await new Promise(r=>setTimeout(r,40));}
}
function call({port,ca,path='/mcp',method='POST',token,body}) {
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:'127.0.0.1',port,path,method,ca,headers:{
      ...(token&&{authorization:'Bearer '+token}),
      ...(body&&{'content-type':'application/json',accept:'application/json, text/event-stream'})
    }},res=>{
      let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:text}));
    });
    req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
}
const probe={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'0.1'}}};
test('auth, TLS, agent proof, scope and MCP tools', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'memo-bridge-tls-'));
  let hub,agent,forged;
  try{
    const openssl=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',join(dir,'server.key'),'-out',join(dir,'server.crt')],{encoding:'utf8'});
    assert.equal(openssl.status,0,openssl.stderr);
    const tlsKey=readFileSync(join(dir,'server.key'),'utf8'),tlsCert=readFileSync(join(dir,'server.crt'),'utf8');
    const mac=generateAgentIdentity(),vps=generateAgentIdentity();
    const token='test-owner-only-'.repeat(6);
    const tokenSha256=createHash('sha256').update(token).digest('hex');
    assert.equal(bearerValid('Bearer '+token,tokenSha256),true);
    assert.equal(bearerValid('Bearer '+token+'x',tokenSha256),false);
    hub=createHub({tlsKey,tlsCert,allowedAgentKeys:{mac:mac.publicKey,vps:vps.publicKey},tokenSha256,port:0});
    const {port}=await hub.start();
    const unauthorized=await call({port,ca:tlsCert,body:probe});
    assert.equal(unauthorized.status,401);
    assert.match(unauthorized.headers['www-authenticate'],/Bearer/);
    const wrong=await call({port,ca:tlsCert,token:'wrong',body:probe});
    assert.equal(wrong.status,401);
    assert.deepEqual(hub.inventory().map(x=>x.online),[false,false]);
    forged=new WebSocket('wss://127.0.0.1:'+port+'/agent','memo-bridge-agent-v1',{ca:tlsCert});
    const fake=generateAgentIdentity();
    forged.on('message',payload=>{
      const msg=JSON.parse(payload.toString());
      if(msg.type==='challenge')forged.send(JSON.stringify({type:'authenticate',host:'vps',signature:signChallenge('vps',msg.nonce,fake.privateKey)}));
    });
    await new Promise(resolve=>forged.on('close',resolve));
    assert.equal(hub.inventory().find(x=>x.host==='vps').online,false);
    agent=createAgent({host:'mac',url:'wss://127.0.0.1:'+port+'/agent',privateKey:mac.privateKey,ca:tlsCert,reconnectMs:100000});
    await until(()=>hub.inventory().find(x=>x.host==='mac').online);
    const init=await call({port,ca:tlsCert,token,body:probe});
    assert.equal(init.status,200,init.body);
    assert.equal(JSON.parse(init.body).result.serverInfo.name,'memo-bridge-hub');
    const tools=await call({port,ca:tlsCert,token,body:{jsonrpc:'2.0',id:2,method:'tools/list',params:{}}});
    assert.equal(tools.status,200,tools.body);
    const names=JSON.parse(tools.body).result.tools.map(x=>x.name).sort();
    assert.deepEqual(names,['bridge_info','host_status','list_hosts']);
    const status=await call({port,ca:tlsCert,token,body:{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'host_status',arguments:{host:'mac'}}}});
    assert.equal(status.status,200,status.body);
    const parsed=JSON.parse(status.body);
    const hostData=JSON.parse(parsed.result.content[0].text);
    assert.equal(hostData.online,true);
    assert.equal(hostData.host,'mac');
    assert.ok(hostData.cpu_count>0);
    const bad=await call({port,ca:tlsCert,token,body:{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'host_status',arguments:{host:'../../root'}}}});
    assert.equal(bad.status,200);
    assert.ok(JSON.parse(bad.body).result?.isError || JSON.parse(bad.body).error, bad.body);
    const unsafe=await call({port,ca:tlsCert,token,body:{jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'exec',arguments:{command:'whoami'}}}});
    assert.equal(unsafe.status,200);
    assert.ok(JSON.parse(unsafe.body).result?.isError || JSON.parse(unsafe.body).error,unsafe.body);
    console.log('TLS_OWNER_AUTH_AGENT_SIGNATURE_MCP_TESTS_PASSED');
  } finally {
    agent?.stop();forged?.terminate();await hub?.stop();rmSync(dir,{recursive:true,force:true});
  }
});
