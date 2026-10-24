import { test } from 'node:test';
import assert from 'node:assert/strict';
import {createAcpProcessSupervisor} from '../server/runners/acp-process-supervisor.mjs';
const args={workspace_id:'ws_ABCDEFGHIJKLMNOP',worktree_id:'wt_ABCDEFGHIJKLMNOP'};
const admission={ok:true,...args,issue:'memolabs-dev/memo-orbit#174',claim_id:'a'.repeat(32)};
function fixture(options={}){
 let started=0;let stops=[];let done;
 const process={alive:()=>stops.length===0,stop:signal=>{stops.push(signal);done()},exited:new Promise(resolve=>{done=resolve})};
 const opts={admit:async()=>admission,renew:async()=>({ok:true,claim_id:admission.claim_id}),
 launch:async()=>{started++;return process},wait:async()=>{},...options};
 const supervisor=createAcpProcessSupervisor(opts);
 return {supervisor,process,started:()=>started,stops};
}
test('one start, one worktree and safe repeated stop',async()=>{
 const f=fixture(),res=await f.supervisor.start(args);
 assert.equal(res.ok,true);
 assert.equal((await f.supervisor.start(args)).error,'agent_already_running');
 assert.equal(f.started(),1);
 assert.equal((await f.supervisor.stop(res.session_id)).state,'stopped');
 assert.equal(f.stops.length,1);
 await f.supervisor.stop(res.session_id);
 assert.equal(f.stops.length,1);
});
test('rejects stale lease and never launches',async()=>{
 const f=fixture({renew:async()=>({ok:false,error:'stale_lease'})});
 assert.equal((await f.supervisor.start(args)).error,'stale_lease');
 assert.equal(f.started(),0);
});

test('invalid identifiers do not start or reserve',async()=>{
 const f=fixture();
 assert.equal((await f.supervisor.start({workspace_id:'../../',worktree_id:args.worktree_id})).error,'invalid_input');
 assert.equal(f.started(),0);
 assert.equal(f.supervisor.status('missing').error,'unknown_session');
});
test('start is atomic while a slow authorization is pending',async()=>{
 let answer;let calls=0;
 const f=fixture({admit:()=>++calls===1?new Promise(resolve=>answer=resolve):Promise.resolve(admission)});
 const pending=f.supervisor.start(args);
 assert.equal((await f.supervisor.start(args)).error,'agent_already_running');
 answer(admission);
 const r=await pending;assert.equal(r.ok,true);assert.equal(f.started(),1);
 await f.supervisor.close();
});
test('unexpected process exit changes status',async()=>{
 let done;
 const child={alive:()=>false,stop:()=>{},exited:new Promise(resolve=>{done=resolve})};
 const f=fixture({launch:async()=>child});
 const res=await f.supervisor.start(args);
 assert.equal(res.ok,true);
 done();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.supervisor.status(res.session_id).state,'stopped');
});
test('loss during monitoring invokes the process stop callback',async()=>{
 let callbacks;
 let denied=false;
 const f=fixture({
  admit:async()=>denied?{ok:false,error:'stale_lease'}:admission,
  createMonitor:options=>{callbacks=options;return {start:async()=>({ok:true}),stop:async()=>{}}}
 });
 const res=await f.supervisor.start(args);
 denied=true;
 assert.equal((await callbacks.check()).error,'stale_lease');
 await callbacks.terminate('stale_lease');
 assert.equal(f.supervisor.status(res.session_id).state,'stopped');
 assert.equal(f.stops.length,1);
});
test('refuses unknown or mismatched lease receipt before launch',async()=>{
 const f=fixture({admit:async()=>({ok:true,workspace_id:args.workspace_id,worktree_id:'wt_other',claim_id:'a'.repeat(32)})});
 assert.equal((await f.supervisor.start(args)).error,'admission_mismatch');
 assert.equal(f.started(),0);
});

test('cancel during pending admission does not create a process',async()=>{
 let resolveAdmission;
 const f=fixture({admit:()=>new Promise(resolve=>resolveAdmission=resolve)});
 const starting=f.supervisor.start(args);
 const idByWorktree=starting;
 await f.supervisor.close();
 resolveAdmission(admission);
 const result=await idByWorktree;
 assert.equal(result.ok,false);
 assert.equal(f.started(),0);
});
test('lease identity changing after renewal refuses launch',async()=>{
 let calls=0;
 const f=fixture({admit:async()=>{calls++;return calls<2?admission:{...admission,claim_id:'b'.repeat(32)}}});
 const result=await f.supervisor.start(args);
 assert.equal(result.ok,false);
 assert.equal(f.started(),0);
});
test('lost lease state explains why the child was stopped',async()=>{
 let callbacks;
 const f=fixture({createMonitor:config=>{callbacks=config;return {start:async()=>({ok:true}),stop:async()=>{}}}});
 const started=await f.supervisor.start(args);
 await callbacks.terminate('stale_lease');
 assert.equal(f.supervisor.status(started.session_id).reason,'stale_lease');
});
