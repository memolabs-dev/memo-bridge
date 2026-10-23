import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { OnboardingActionStore } from '../server/onboarding-auto-store.mjs';
import { ingestOnboardingWebhook } from '../server/onboarding-auto-ingress.mjs';
import { createOnboardingHttpServer } from '../server/onboarding-auto-http.mjs';

const ORG='memolabs-dev', REPO=ORG+'/rebuild-radar', APPID=170927025;
const secret='onboarding-fixture-strong-webhook-key';
const repo = { name:'rebuild-radar', full_name:REPO, id:333001, owner:{login:ORG} };
function event(action='added'){
  return { action, installation:{account:{login:ORG,type:'Organization'},id:APPID},
    organization:{login:ORG}, repositories_added:[repo],repositories_removed:[repo] };
}
function headers(body) {
  return {'x-hub-signature-256': 'sha256='+createHmac('sha256',secret).update(body).digest('hex'),
    'x-github-event':'installation_repositories',
    'x-github-delivery':'12e77668-141d-4591-877c-701122dc0001',
    'content-type':'application/json'};
}
const policy={org:ORG,installationId:APPID,enabled:true,orgWideAutoEnrollment:true,
  enrolledRepositories:[],excludedRepositories:[]};
const proof={repositoryId:333001,fullName:REPO,private:true,archived:false,
  installationAccess:true,installationId:APPID,defaultBranch:'main',manifestVerified:true,
  governanceMerged:false,runnerMerged:false,landingMerged:false,
  prChecks:{headSha:'a'.repeat(40),checkedSha:'a'.repeat(40),passed:true,pending:false,held:false}};
const catalog=[{kind:'repo',name:'rebuild-radar',catalog_stale:false}];
const providers={catalogProvider:async()=>catalog,evidenceProvider:async r=>r.fullName===REPO?proof:null};
test('persistent reservation survives store reopening and never repeats an already finished PR', async () => {
  const dir=await mkdtemp(join(tmpdir(),'onboard-actions-'));
  const path=join(dir,'actions.sqlite'), key='a'.repeat(24);
  try {
    const a=new OnboardingActionStore({dbPath:path});
    assert.equal(a.reserve(key),true);
    assert.equal(a.reserve(key),false);
    a.finish(key,{id:'pr/123'});
    assert.deepEqual(a.read(key).state,'finished');
    a.close();
    const b=new OnboardingActionStore({dbPath:path});
    assert.equal(b.reserve(key),false);
    assert.equal(b.read(key).receipt,'pr/123');
    b.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('expired reservation can be retried, previous holder cannot finish a stolen lease', async () => {
  const dir=await mkdtemp(join(tmpdir(),'onboard-cas-'));
  const path=join(dir,'actions.sqlite'),key='b'.repeat(24);
  let now=1000;
  try {
    const a=new OnboardingActionStore({dbPath:path,now:()=>now,leaseMs:1000});
    const b=new OnboardingActionStore({dbPath:path,now:()=>now,leaseMs:1000});
    assert.equal(a.reserve(key),true);
    assert.equal(b.reserve(key),false);
    now+=1100;
    assert.equal(b.reserve(key),true);
    assert.throws(()=>a.finish(key,{id:'pr/old'}),/action_lease_lost/);
    b.finish(key,{id:'pr/new'});
    assert.equal(b.read(key).receipt,'pr/new');
    a.close();b.close();
  }finally {await rm(dir,{recursive:true,force:true});}
});
test('signed event triggers one reviewed proposal, duplicate delivery is deduplicated by durable receipt', async () => {
  const dir=await mkdtemp(join(tmpdir(),'onboard-ingress-'));
  const path=join(dir,'actions.sqlite');
  try {
    const store=new OnboardingActionStore({dbPath:path});
    const issued=[];
    const adapter={
      reserve:key=>store.reserve(key),
      propose:async act=>{issued.push(act);return{id:'pr/governance-1'};},
      finish:(key,receipt)=>store.finish(key,receipt),
      fail:key=>store.fail(key)
    };
    const rawBody=Buffer.from(JSON.stringify(event()));
    const args={rawBody,headers:headers(rawBody),webhookSecret:secret,
      trustedPolicy:policy,effectAdapter:adapter,dryRun:false,...providers};
    const result=await ingestOnboardingWebhook(args);
    assert.equal(result.ok,true);
    assert.equal(result.action_count,1);
    assert.equal(result.executions[0].status,'proposed');
    const second=await ingestOnboardingWebhook(args);
    assert.equal(second.executions[0].status,'already_recorded');
    assert.equal(issued.length,1);
    assert.equal(issued[0].operation,'propose_governance_pr');
    store.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('unsigned or changed webhook bytes perform zero provider reads or writes', async () => {
  const rawBody=Buffer.from(JSON.stringify(event()));
  let reads=0;
  const res=await ingestOnboardingWebhook({
    rawBody:Buffer.from(rawBody.toString()+' '),headers:headers(rawBody),
    webhookSecret:secret,trustedPolicy:policy,
    catalogProvider:async()=>{reads++;return catalog},
    evidenceProvider:async()=>{reads++;return proof},
    dryRun:false
  });
  assert.equal(res.status,401);
  assert.equal(reads,0);
});
test('missing scoped App evidence does not propose any PR and reports blocked', async () => {
  const rawBody=Buffer.from(JSON.stringify(event()));
  const result=await ingestOnboardingWebhook({
    rawBody,headers:headers(rawBody),webhookSecret:secret,
    trustedPolicy:policy,...providers,
    evidenceProvider:async()=>({...proof,installationAccess:false}),dryRun:false,
    effectAdapter:{reserve:()=>{throw Error('must not be called')},propose:()=>{},finish:()=>{},fail:()=>{}}
  });
  assert.equal(result.ok,true);
  assert.equal(result.next[0].stage,'blocked');
  assert.equal(result.action_count,0);
});
test('removing App installation repo stops new work regardless of previous PR status', async () => {
  const rawBody=Buffer.from(JSON.stringify(event('removed')));
  const result=await ingestOnboardingWebhook({
    rawBody,headers:headers(rawBody),webhookSecret:secret,
    trustedPolicy:policy,...providers,dryRun:false,
    effectAdapter:{reserve:()=>{throw Error('must not reserve')},propose:()=>{},finish:()=>{},fail:()=>{}}
  });
  assert.equal(result.next[0].stage,'suspended');
  assert.equal(result.next[0].stop_new_work,true);
});
test('HTTP router always bounds request body and rejects unknown routes', async () => {
  const server=createOnboardingHttpServer({handler:async()=>({ok:true,status:200,action_count:0})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const addr=server.address(),base='http://127.0.0.1:'+addr.port;
    const missing=await fetch(base+'/unknown',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(missing.status,404);
    const type=await fetch(base+'/github/onboarding',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'});
    assert.equal(type.status,415);
    const big=await fetch(base+'/github/onboarding',{method:'POST',
      headers:{'content-type':'application/json'},body:'x'.repeat(260*1024)});
    assert.equal(big.status,413);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
