import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {registerAcpTools} from '../server/tools/acp-tools.mjs';
import {
  CAPABILITIES, HUB_PRINCIPALS, localOwnerId, makePrincipal
} from '../server/coordinator/policy.mjs';

const rights=[CAPABILITIES.READ,CAPABILITIES.EXECUTE];
const principal=(id,caps=rights)=>makePrincipal(id,caps);
function fixture(initial) {
  const tools=new Map(), records=[];
  let rt=initial, got=0, peeked=0;
  const owners={
    get:()=>{got++;throw Error('read unexpectedly created ACP supervisor')},
    peek:runtime=>{peeked++;return runtime.owner??null}
  };
  registerAcpTools({
    registerTool:(name,definition,handler)=>tools.set(name,{definition,handler})
  },async()=>rt,{owners});
  const call=async (name,id=randomUUID())=>
    JSON.parse((await tools.get(name).handler({session_id:id})).content[0].text);
  return {tools,call,records,set:r=>rt=r,counts:()=>({got,peeked})};
}
const runtime=(p,owner=null)=>({
  host:'mac',readOnly:false,principal:p,owner,
  authorize:op=>p.capabilities.has(op==='agent_sandbox_status'?
    CAPABILITIES.READ:CAPABILITIES.EXECUTE),
  audit:async()=>{}
});

test('local owner can inspect ONLY a live runtime-owned ACP child without creating one',async()=>{
 const id=randomUUID();
 const rt=runtime(principal(localOwnerId()),{
  statusLive:sessionId=>sessionId===id ?
    {ok:true,session_id:id,state:'running'}:{ok:false,error:'unknown_session'}
 });
 const f=fixture(rt);
 assert.deepEqual(await f.call('agent_sandbox_status',id),
   {ok:true,session_id:id,state:'running'});
 assert.deepEqual(await f.call('agent_sandbox_status',randomUUID()),
   {ok:false,error:'unknown_session'});
 assert.deepEqual(f.counts(),{got:0,peeked:2});
 assert.equal(f.tools.get('agent_sandbox_status').definition.annotations.readOnlyHint,true);
});

test('trusted remote owner with runtime write capability sees its OWN active session',async()=>{
 const id=randomUUID();
 const remote=runtime(principal(HUB_PRINCIPALS.OWNER),{
  statusLive:sessionId=>sessionId===id?
    {ok:true,session_id:id,state:'running'}:{ok:false,error:'unknown_session'}
 });
 const other=runtime(principal('oidc:another-approved-owner'),{
  statusLive:()=>({ok:false,error:'unknown_session'})
 });
 const f=fixture(remote);
 assert.equal((await f.call('agent_sandbox_status',id)).state,'running');
 f.set(other);
 assert.deepEqual(await f.call('agent_sandbox_status',id),
   {ok:false,error:'unknown_session'},
   'even a second authenticated principal cannot inspect the first principal runtime');
 assert.deepEqual(f.counts(),{got:0,peeked:2});
});

test('hub and OIDC readers cannot inspect ACP status despite coordinator read permission',async()=>{
 const ids=[
  principal('hub:readonly',[CAPABILITIES.READ]),
  principal('oidc:reader',[CAPABILITIES.READ])
 ];
 for(const p of ids){
  const f=fixture(runtime(p,{statusLive:()=>assert.fail('read leaked')}));
  assert.deepEqual(await f.call('agent_sandbox_status'),
    {ok:false,error:'forbidden'});
  assert.deepEqual(f.counts(),{got:0,peeked:0});
 }
});

test('a foreign or non-Mac caller never reads even if given execute/read capabilities',async()=>{
 for(const [id,host,readOnly] of [
  ['hub:unlisted','mac',false],
  [localOwnerId(),'vps',false],
  [localOwnerId(),'mac',true]
 ]){
  const rt=runtime(principal(id));
  rt.host=host;rt.readOnly=readOnly;
  const f=fixture(rt);
  assert.deepEqual(await f.call('agent_sandbox_status'),
    {ok:false,error:'forbidden'});
  assert.deepEqual(f.counts(),{got:0,peeked:0});
 }
});

test('no created runtime owner means unknown, never journal replay or agent spawn',async()=>{
 const f=fixture(runtime(principal(localOwnerId())));
 assert.deepEqual(await f.call('agent_sandbox_status'),
   {ok:false,error:'unknown_session'});
 assert.deepEqual(f.counts(),{got:0,peeked:1});
});

test('active status remains read-only even when launch and stop canary are disabled',async()=>{
 const rt=runtime(principal(localOwnerId()),{
  statusLive:()=>({ok:false,error:'unknown_session'})
 });
 const f=fixture(rt);
 // Test process does not set MEMO_BRIDGE_ACP_SANDBOX_CANARY.
 assert.deepEqual(await f.call('agent_sandbox_start'),
   {ok:false,error:'canary_disabled'});
 assert.deepEqual(await f.call('agent_sandbox_stop'),
   {ok:false,error:'canary_disabled'});
 assert.deepEqual(await f.call('agent_sandbox_status'),
   {ok:false,error:'unknown_session'});
 assert.deepEqual(f.counts(),{got:0,peeked:1});
});

test('the existing hub tool operation catalogue is unchanged',()=>{
 const f=fixture(runtime(principal(localOwnerId())));
 assert.deepEqual([...f.tools.keys()].sort(),[
  'agent_preflight','agent_sandbox_start','agent_sandbox_status','agent_sandbox_stop'
 ].sort());
});
