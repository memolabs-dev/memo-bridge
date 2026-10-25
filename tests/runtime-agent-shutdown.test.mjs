import test from 'node:test';
import assert from 'node:assert/strict';
import {closeRuntimeAgent} from '../bridge/runtime-agent-shutdown.mjs';

test('long-lived agent shutdown closes ACP-owning runtime in order',async()=>{
 const calls=[];
 const r=await closeRuntimeAgent({
  agent:{stop:()=>calls.push('agent')},
  supervisor:{stop:async()=>{calls.push('jobs')}},
  runtimeOps:{close:async()=>{calls.push('ops')}},
  base:{close:async()=>{calls.push('runtime')}}
 });
 assert.deepEqual(calls,['agent','jobs','ops','runtime']);
 assert.deepEqual(r,{ok:true,failed:[]});
});

test('ACP owner runtime shutdown is attempted even after unrelated teardown failures',async()=>{
 const calls=[];
 const r=await closeRuntimeAgent({
  agent:{stop:()=>{calls.push('agent');throw Error('socket')}},
  supervisor:{stop:async()=>{calls.push('jobs');throw Error('executor')}},
  runtimeOps:{close:async()=>{calls.push('ops');throw Error('collector')}},
  base:{close:async()=>{calls.push('runtime')}}
 });
 assert.deepEqual(calls,['agent','jobs','ops','runtime']);
 assert.deepEqual(r,{ok:false,failed:['agent','jobs','operations']});
});

test('a runtime agent without job executor still closes its owner and is idempotent at resource level',async()=>{
 let stops=0;
 const agent={stop:()=>{stops++}};
 const base={close:async()=>{}};
 assert.deepEqual(await closeRuntimeAgent({agent,base}),{ok:true,failed:[]});
 assert.equal(stops,1);
});
