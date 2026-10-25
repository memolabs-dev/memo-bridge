import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {registerAcpTools} from '../server/tools/acp-tools.mjs';
import {CAPABILITIES,localOwnerId,makePrincipal} from '../server/coordinator/policy.mjs';
import {OPS,TIMEOUTS,RUNTIME_OPS} from '../bridge/ops.mjs';
import {REMOTE_TOOLS} from '../server/registry.mjs';

const FLAGS=['MEMO_BRIDGE_ACP_SANDBOX_CANARY','MEMO_BRIDGE_ACP_INTERACTIVE_CANARY'];
const uuid=randomUUID();
function setup({principal=makePrincipal(localOwnerId(),[CAPABILITIES.READ,CAPABILITIES.EXECUTE]),
  host='mac',readOnly=false,supervisor=null}={}){
  const map=new Map(),calls=[],events=[];
  const rt={host,readOnly,principal,
    authorize:op=>principal.capabilities.has(CAPABILITIES.EXECUTE),
    audit:async(op,outcome,error,ids)=>events.push({op,outcome,error,ids})};
  const owners={
    peek:()=>{calls.push('peek');return supervisor},
    get:()=>{calls.push('get');throw Error('PROMPT MUST NOT START ACP')}
  };
  registerAcpTools({registerTool:(key,config,handler)=>map.set(key,{config,handler})},
    async()=>rt,{owners});
  const raw=async(args={session_id:uuid,text:'inspect the sandbox canary'})=>
    JSON.parse((await map.get('agent_sandbox_prompt').handler(args)).content[0].text);
  return {map,calls,events,raw,rt};
}
function enabled(base,interactive){
  if(base)process.env.MEMO_BRIDGE_ACP_SANDBOX_CANARY='enabled';
  else delete process.env.MEMO_BRIDGE_ACP_SANDBOX_CANARY;
  if(interactive)process.env.MEMO_BRIDGE_ACP_INTERACTIVE_CANARY='enabled';
  else delete process.env.MEMO_BRIDGE_ACP_INTERACTIVE_CANARY;
}

test('ACP prompts are double-gated, locally owner-only, never auto-create an agent',async()=>{
 const before=FLAGS.map(k=>process.env[k]);
 try{
   const denied=setup({supervisor:{prompt:()=>assert.fail('never authorized')}});
   for(const [base,interactive] of [[false,false],[true,false],[false,true]]){
     enabled(base,interactive);
     assert.deepEqual(await denied.raw(),{ok:false,error:'interactive_canary_disabled'});
   }
   assert.deepEqual(denied.calls,[]);
   enabled(true,true);
   const attempted=[];
   const permitted=setup({supervisor:{prompt:async(id,message)=>{
     attempted.push([id,message]);return {ok:true,session_id:id,stop_reason:'end_turn'};
   }}});
   assert.deepEqual(await permitted.raw({session_id:uuid,text:'  examine code  '}),{
     ok:true,session_id:uuid,stop_reason:'end_turn'
   });
   assert.deepEqual(attempted,[[uuid,'  examine code  ']],
     'the tool forwards only the selected id and bounded text');
   assert.deepEqual(permitted.calls,['peek']);
   assert.deepEqual(permitted.events,[{
     op:'agent_sandbox_prompt',outcome:'ok',error:null,ids:{}
   }],'prompt content is never included in the audit event');
   assert.deepEqual(permitted.map.get('agent_sandbox_prompt').config.annotations,{
     readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false
   });
 }finally{
   for(let i=0;i<FLAGS.length;i++){
     if(before[i]===undefined)delete process.env[FLAGS[i]];
     else process.env[FLAGS[i]]=before[i];
   }
 }
});

test('even two enabled canary flags cannot grant remote, VPS or readonly prompting',async()=>{
 const saved=FLAGS.map(k=>process.env[k]);
 try{
   enabled(true,true);
   for(const options of [
     {principal:makePrincipal('hub:owner',[CAPABILITIES.READ,CAPABILITIES.EXECUTE])},
     {principal:makePrincipal('oidc:owner',[CAPABILITIES.READ,CAPABILITIES.EXECUTE])},
     {principal:makePrincipal('hub:readonly',[CAPABILITIES.READ])},
     {host:'vps'}, {readOnly:true},
     {principal:makePrincipal(localOwnerId(),[CAPABILITIES.READ])}
   ]){
     const fx=setup({supervisor:{prompt:()=>assert.fail('remote run')},...options});
     assert.deepEqual(await fx.raw(),{ok:false,error:'interactive_canary_disabled'});
     assert.deepEqual(fx.calls,[]);
   }
 }finally{
   for(let i=0;i<FLAGS.length;i++){
     if(saved[i]===undefined)delete process.env[FLAGS[i]];
     else process.env[FLAGS[i]]=saved[i];
   }
 }
});

test('enabled but nonexistent ACP owner refuses prompt without a spawn',async()=>{
 const saved=FLAGS.map(k=>process.env[k]);
 try{
   enabled(true,true);
   const fx=setup();
   assert.deepEqual(await fx.raw(),{ok:false,error:'agent_not_running'});
   assert.deepEqual(fx.calls,['peek']);
 }finally{
   for(let i=0;i<FLAGS.length;i++){
     if(saved[i]===undefined)delete process.env[FLAGS[i]];
     else process.env[FLAGS[i]]=saved[i];
   }
 }
});

test('transport errors are bounded, audited by code, and never leak prompt content',async()=>{
 const saved=FLAGS.map(k=>process.env[k]);
 try{
   enabled(true,true);
   const fx=setup({supervisor:{prompt:async()=>{throw Error('secret prompt output')}}});
   assert.deepEqual(await fx.raw(),{ok:false,error:'internal_error'});
   assert.deepEqual(fx.events,[{
     op:'agent_sandbox_prompt',outcome:'denied',error:'internal_error',ids:{}
   }]);
 }finally{
   for(let i=0;i<FLAGS.length;i++){
     if(saved[i]===undefined)delete process.env[FLAGS[i]];
     else process.env[FLAGS[i]]=saved[i];
   }
 }
});

test('schema forbids excessive text or extraneous sessions and remote catalogue stays closed',()=>{
 const fx=setup();
 const schema=fx.map.get('agent_sandbox_prompt').config.inputSchema;
 assert.equal(schema.safeParse({session_id:uuid,text:'x'.repeat(4096)}).success,true);
 for(const payload of [
   {session_id:'../unsafe',text:'hello'},
   {session_id:uuid,text:'x'.repeat(4097)},
   {session_id:uuid,text:' '},
   {session_id:uuid,text:null}
 ])assert.equal(schema.safeParse(payload).success,false);
 assert.equal(OPS.agent_sandbox_prompt.mutating,true);
 assert.equal(OPS.agent_sandbox_prompt.timeoutMs,TIMEOUTS.ledger);
 assert.equal(RUNTIME_OPS.includes('agent_sandbox_prompt'),true);
 assert.equal(REMOTE_TOOLS.includes('agent_sandbox_prompt'),false);
});
