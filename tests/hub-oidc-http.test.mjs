import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createHub } from '../bridge/hub.mjs';

test('OIDC metadata and auth gate over actual HTTPS MCP transport', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'memo-oidc-http-'));
  let hub;
  try {
    const c=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',join(dir,'tls.key'),'-out',join(dir,'tls.crt')],{encoding:'utf8'});
    assert.equal(c.status,0,c.stderr);
    const crt=readFileSync(join(dir,'tls.crt'));
    const pair=await generateKeyPair('ES256');
    const pub=await exportJWK(pair.publicKey);
    const keys=createLocalJWKSet({keys:[{...pub,alg:'ES256',kid:'key1',use:'sig'}]});
    const issuer='https://auth.memolabs.dev';
    const audience='https://bridge.memolabs.dev/mcp';
    hub=createHub({tlsKey:readFileSync(join(dir,'tls.key')),tlsCert:crt,oidc:{issuer,audience,ownerSub:'owner-only',jwks:keys},allowedAgentKeys:{},port:0});
    const {port}=await hub.start();
    // Test HTTP semantics without trusting an unverified public server certificate.
    const call=async(path,{token,method='GET',body}={})=>{
      const request=await import('node:https');
      return await new Promise((resolve,reject)=>{
        const req=request.request({hostname:'127.0.0.1',port,path,method,ca:crt,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json',accept:'application/json, text/event-stream'}:{})}},res=>{
          let data='';res.on('data',b=>data+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data}));
        });
        req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
      });
    };
    const meta=await call('/.well-known/oauth-protected-resource');
    assert.equal(meta.status,200);
    assert.deepEqual(JSON.parse(meta.data).authorization_servers,[issuer]);
    assert.equal(JSON.parse(meta.data).resource,audience);
    const request={jsonrpc:'2.0',id:5,method:'tools/list',params:{}};
    const unauth=await call('/mcp',{method:'POST',body:request});
    assert.equal(unauth.status,401);
    assert.match(unauth.headers['www-authenticate'],/resource_metadata=/);
    const mint=(sub,scope='hosts:read')=>new SignJWT({scope}).setProtectedHeader({alg:'ES256',kid:'key1'}).setIssuer(issuer).setAudience(audience).setSubject(sub).setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
    const wrong=await call('/mcp',{method:'POST',body:request,token:await mint('not-the-owner')});
    assert.equal(wrong.status,401);
    const badScope=await call('/mcp',{method:'POST',body:request,token:await mint('owner-only','hosts:write')});
    assert.equal(badScope.status,401);
    const owner=await call('/mcp',{method:'POST',body:request,token:await mint('owner-only')});
    assert.equal(owner.status,200,owner.data);
    assert.equal(JSON.parse(owner.data).result.tools.length,3);
    assert.equal((await call('/not-found')).status,404);
  }finally{await hub?.stop();rmSync(dir,{recursive:true,force:true});}
});
