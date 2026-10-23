import test from 'node:test';
import assert from 'node:assert/strict';
import {createAcpLeaseMonitor} from '../server/runners/acp-lease-monitor.mjs';

function rig(check){
 let callback,stops=[],cleared=0;
 const m=createAcpLeaseMonitor({
  check,terminate:async reason=>{stops.push(reason);},
  setIntervalFn:fn=>{callback=fn;return {unref(){}};},
  clearIntervalFn:()=>{cleared++;}
 });
 return {m,stops,cleared:()=>cleared,pulse:async()=>{callback();await m.tick();}};
}
test('starts with successful preflight and shuts down on lease loss',async()=>{
 let ok=true;const h=rig(async()=>ok?{ok:true}:{ok:false,error:'stale_lease'});
 assert.deepEqual(await h.m.start(),{ok:true,status:'running'});
 ok=false;await h.pulse();
 assert.deepEqual(h.stops,['stale_lease']);
 assert.equal(h.m.status().state,'stopped');
 assert.equal(h.cleared(),1);
});
test('unknown/offline lease fails closed before starting',async()=>{
 const h=rig(async()=>{throw Error('disconnected');});
 assert.equal((await h.m.start()).error,'lease_unavailable');
 assert.deepEqual(h.stops,['lease_unavailable']);
 assert.equal(h.m.status().state,'stopped');
});
test('repeated termination is idempotent',async()=>{
 const h=rig(async()=>({ok:true}));
 await h.m.start();await h.m.stop('user_cancelled');await h.m.stop('crash');
 assert.deepEqual(h.stops,['user_cancelled']);
});
test('does not overlap lease checks under slow network',async()=>{
 let pending;let calls=0;
 const h=rig(async()=>{calls++;if(calls===1)return {ok:true};return new Promise(resolve=>pending=resolve);});
 await h.m.start();
 const a=h.m.tick(),b=h.m.tick();
 assert.equal(calls,2);pending({ok:false,error:'lease_held'});
 await Promise.all([a,b]);
 assert.deepEqual(h.stops,['lease_held']);assert.equal(calls,2);
});
test('rejects invalid setup',()=>{
 assert.throws(()=>createAcpLeaseMonitor({check:null,terminate:()=>{}}));
 assert.throws(()=>createAcpLeaseMonitor({check:()=>{},terminate:()=>{},intervalMs:0}));
});
