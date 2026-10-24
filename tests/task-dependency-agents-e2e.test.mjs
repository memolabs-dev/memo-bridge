import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes,createHash } from 'node:crypto';
import { writeFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeGitHub, tempStateDir } from './helpers/coordinator-fixture.mjs';
import { sealAcceptanceReceipt,receiptFilename } from '../server/task-acceptance-receipts.mjs';

const WORKER=fileURLToPath(new URL('./helpers/claim-worker.mjs',import.meta.url));
const ROOT='memolabs-dev/drop#7',PRE='memolabs-dev/drop#8';
const now='2026-10-23T12:00:00Z';
function spawn(state, fake, receiptDir) {
 const child=fork(WORKER,[state,fake,receiptDir],{stdio:['ignore','ignore','pipe','ipc']});
 const waiting=new Map(), buffered=new Map();
 child.on('message',m=>{const resolve=waiting.get(m.type);if(resolve){waiting.delete(m.type);resolve(m);}else buffered.set(m.type,m);});
 const next=type=>new Promise((resolve,reject)=>{
   if(buffered.has(type)){const msg=buffered.get(type);buffered.delete(type);return resolve(msg);}
   waiting.set(type,resolve);child.once('exit',code=>reject(Error('worker exited '+code)));
 });
 return {child,next,claim:async()=>{child.send({type:'claim',issue:ROOT});return (await next('claimed')).claim;}};
}
test('two isolated worker processes: missing independent receipt blocks both; signed receipt permits exactly one ledger claim', {timeout:60000},async t=>{
 const body='verified prerequisite';
 const gh=await fakeGitHub(t,{
  [ROOT]:{state:'open',body:'<!-- memo-bridge:requires:v1 {"requires":["'+PRE+'"]} -->',
          labels:['agent:ready','priority:p1']},
  [PRE]:{state:'closed',body,updated_at:'2026-10-23T11:15:00Z',closed_at:'2026-10-23T11:05:00Z'}
 });
 const state=await tempStateDir(t),receiptRoot=await tempStateDir(t);
 await mkdir(join(receiptRoot,'dependency-acceptance'),{mode:0o700,recursive:true});
 const key=randomBytes(32);
 await writeFile(join(receiptRoot,'dependency-acceptance.key'),key,{mode:0o600});
 const workers=[spawn(state,gh.file,receiptRoot),spawn(state,gh.file,receiptRoot)];
 t.after(async()=>{await Promise.all(workers.map(w=>new Promise(res=>{
    if(w.child.exitCode!==null)return res();
    w.child.once('exit',res);w.child.send({type:'exit'});
  })))});
 await Promise.all(workers.map(w=>w.next('ready')));
 const before=await Promise.all(workers.map(w=>w.claim()));
 assert.ok(before.every(x=>!x.ok&&x.error==='dependency_blocked'),JSON.stringify(before));
 const receipt=sealAcceptanceReceipt({
   schema:1,issue:PRE,issue_updated_at:'2026-10-23T11:15:00Z',
   issue_closed_at:'2026-10-23T11:05:00Z',
   body_sha256:createHash('sha256').update(body).digest('hex'),
   verifier_id:'independent:reviewer',producer_id:'agent:author',verified_at:'2026-10-23T11:30:00Z',
   pr_ref:'https://github.test/drop/pull/12',deployment_ref:'https://deploy.test/receipt/12',
   policy_ref:null,e2e_ref:'https://e2e.test/acceptance/12'
 },key);
 await writeFile(join(receiptRoot,'dependency-acceptance',receiptFilename(PRE)),JSON.stringify(receipt),{mode:0o600});
 const after=await Promise.all(workers.map(w=>w.claim()));
 assert.equal(after.filter(x=>x.ok).length,1,JSON.stringify(after));
 assert.ok(after.filter(x=>!x.ok).every(x=>x.error==='lease_held'),JSON.stringify(after));
});
