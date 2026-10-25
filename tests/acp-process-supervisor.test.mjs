import { test } from 'node:test';
import assert from 'node:assert/strict';
import {createAcpProcessSupervisor} from '../server/runners/acp-process-supervisor.mjs';
import {createAcpRecoveryJournal} from '../server/runners/acp-recovery-journal.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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


test('an internal ACP prompt rechecks the lease before the model can work',async()=>{
 let checks=0,calls=[];
 const session={
  prompt:async text=>{calls.push(text);return {ok:true,stop_reason:'end_turn'}},
  close:()=>{}
 };
 let tickConfig;
 const f=fixture({
  launch:async()=>({...fixture().process,conversation:session}),
  admit:async()=>{checks++;return admission},
  createMonitor:cfg=>{tickConfig=cfg;return {
   start:async()=>({ok:true}),stop:async()=>{},
   tick:async()=>{const result=await cfg.check();if(!result.ok)await cfg.terminate(result.error);}
  }}
 });
 const started=await f.supervisor.start(args);
 assert.equal(started.ok,true);
 const checkedBefore=checks;
 const result=await f.supervisor.prompt(started.session_id,'Apply one safe patch');
 assert.deepEqual(result,{ok:true,session_id:started.session_id,stop_reason:'end_turn'});
 assert.ok(checks>checkedBefore,'lease must be rechecked for the prompt');
 assert.deepEqual(calls,['Apply one safe patch']);
 await f.supervisor.close();
});

test('no prompt after lease revocation and the sandbox child is stopped',async()=>{
 let denied=false,calls=0;
 let stopped=false,finish;
 const child={
  alive:()=>!stopped,stop:()=>{stopped=true;finish()},
  exited:new Promise(resolve=>finish=resolve),
  conversation:{prompt:async()=>{calls++;return {stop_reason:'end_turn'}}}
 };
 const f=fixture({
  launch:async()=>child,
  admit:async()=>denied?{ok:false,error:'stale_lease'}:admission,
  createMonitor:cfg=>({
    start:async()=>({ok:true}),stop:async()=>{},
    tick:async()=>{const r=await cfg.check();if(!r.ok)await cfg.terminate(r.error);}
  })
 });
 const started=await f.supervisor.start(args);
 assert.equal(started.ok,true);
 denied=true;
 const value=await f.supervisor.prompt(started.session_id,'unsafe');
 assert.equal(value.ok,false);
 assert.equal(calls,0);
 assert.equal(stopped,true);
 assert.equal(f.supervisor.status(started.session_id).state,'stopped');
});

test('duplicate prompts, missing sessions and invalid text never run an agent',async()=>{
 let finish,resolveExit;
 let calls=0,stopped=false;
 const child={
  alive:()=>!stopped,
  stop:()=>{stopped=true;resolveExit()},
  exited:new Promise(resolve=>resolveExit=resolve),
  conversation:{prompt:()=>{calls++;return new Promise(resolve=>finish=resolve)}}
 };
 const f=fixture({launch:async()=>child,createMonitor:cfg=>({
  start:async()=>({ok:true}),stop:async()=>{},tick:async()=>{await cfg.check()}
 })});
 assert.equal((await f.supervisor.prompt('missing','safe')).error,'agent_not_running');
 const started=await f.supervisor.start(args);
 assert.equal((await f.supervisor.prompt(started.session_id,'')).error,'agent_prompt_invalid');
 assert.equal((await f.supervisor.prompt(started.session_id,'X'.repeat(8193))).error,'agent_prompt_invalid');
 const one=f.supervisor.prompt(started.session_id,'first');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await f.supervisor.prompt(started.session_id,'second')).error,'agent_prompt_busy');
 assert.equal(calls,1);
 finish({stop_reason:'end_turn'});
 await one;
 await f.supervisor.close();
});

test('failed interactive transport fails closed and stops the process',async()=>{
 let stopped=false,finish;
 const f=fixture({
  launch:async()=>({
   alive:()=>!stopped,
   stop:()=>{stopped=true;finish()},
   exited:new Promise(resolve=>finish=resolve),
   conversation:{prompt:async()=>{throw Error('disconnected')}}
  }),
  createMonitor:cfg=>({start:async()=>({ok:true}),stop:async()=>{},
    tick:async()=>{await cfg.check()}})
 });
 const started=await f.supervisor.start(args);
 assert.equal((await f.supervisor.prompt(started.session_id,'run')).error,'acp_prompt_failed');
 assert.equal(stopped,true);
 assert.equal(f.supervisor.status(started.session_id).state,'stopped');
});


test('restart exposes a durable recovery-required receipt, never a live process handle', async()=>{
 const folder=mkdtempSync(join(tmpdir(),'acp-supervisor-recovery-'));
 let done;
 const child={alive:()=>true,stop:()=>done(),
   exited:new Promise(resolve=>{done=resolve})};
 const journal=createAcpRecoveryJournal(folder);
 const make=()=>createAcpProcessSupervisor({
  admit:async()=>admission,renew:async()=>({ok:true,claim_id:admission.claim_id}),
  launch:async()=>child,journal,
  createMonitor:()=>({start:async()=>({ok:true}),stop:async()=>{}})
 });
 const original=make();
 try{
  const started=await original.start(args);
  assert.equal(started.ok,true);
  const reopened=make();
  const observed=reopened.status(started.session_id);
  assert.equal(observed.ok,false);
  assert.equal(observed.state,'recovery_required');
  assert.equal(observed.error,'acp_recovery_required');
  assert.equal(child.alive(),true,'read-only observation cannot kill a child');
  const deniedStop=await reopened.stop(started.session_id);
  assert.equal(deniedStop.error,'acp_recovery_required');
  await original.stop(started.session_id);
  const stopped=reopened.status(started.session_id);
  assert.equal(stopped.ok,true);
  assert.equal(stopped.state,'stopped');
  assert.equal(stopped.reason,'user_cancelled');
 }finally{await original.close();rmSync(folder,{recursive:true,force:true})}
});

test('unwritable recovery journal refuses to launch any OpenCode process',async()=>{
 let launches=0;
 const f=fixture({
  journal:{save:()=>{throw Error('unavailable')},read:()=>null},
  launch:async()=>{launches++}
 });
 const started=await f.supervisor.start(args);
 assert.equal(started.error,'agent_start_failed');
 assert.equal(launches,0);
});

test('failure to record running state stops a newly created child',async()=>{
 let exited,stopped=false,launches=0;
 const f=fixture({
  journal:{
   save:row=>{if(row.state==='running')throw Error('storage_failed')},
   read:()=>null
  },
  launch:async()=>{launches++;return {
   alive:()=>!stopped,
   stop:()=>{stopped=true;exited()},
   exited:new Promise(resolve=>{exited=resolve})
  }}
 });
 const result=await f.supervisor.start(args);
 assert.equal(result.error,'agent_start_failed');
 assert.equal(launches,1);
 assert.equal(stopped,true);
});


test('SIGTERM/SIGKILL without confirmed exit stays stopping and blocks a second agent',async()=>{
 let resolveExit,alive=true,signals=[];
 const child={
  alive:()=>alive,stop:signal=>{signals.push(signal)},
  exited:new Promise(resolve=>{resolveExit=resolve})
 };
 const rows=[];
 const f=fixture({
  launch:async()=>child,wait:async()=>{},
  journal:{save:row=>rows.push({...row}),read:()=>null},
  createMonitor:()=>({start:async()=>({ok:true}),stop:async()=>{}})
 });
 const started=await f.supervisor.start(args);
 assert.equal(started.ok,true);
 const stopped=await f.supervisor.stop(started.session_id);
 assert.equal(stopped.state,'stopping');
 assert.equal(stopped.reason,'termination_unconfirmed');
 assert.deepEqual(signals,['SIGTERM','SIGKILL']);
 assert.equal(rows.at(-1).state,'stopping','durable receipt must not say stopped');
 assert.equal((await f.supervisor.start(args)).error,'agent_already_running');
 alive=false;
 resolveExit();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.supervisor.status(started.session_id).state,'stopped');
 assert.equal(rows.at(-1).state,'stopped');
});


test('live-only ACP status never traverses journal receipts from another process',()=>{
 let journalReads=0;
 const sup=createAcpProcessSupervisor({
  admit:async()=>admission,
  renew:async()=>({ok:true,claim_id:admission.claim_id}),
  launch:async()=>fixture().process,
  journal:{save:()=>{},read:()=>{journalReads++;return {ok:true,state:'running'}}}
 });
 assert.deepEqual(sup.statusLive('missing'),
   {ok:false,error:'unknown_session'});
 assert.equal(journalReads,0);
 assert.equal(sup.status('missing').state,'running',
   'existing recovery-aware status is a separate internal API');
 assert.equal(journalReads,1);
});
