import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../server/runtime.mjs';
import {createRuntimeOperations} from '../bridge/agent.mjs';
import {OperationError} from '../bridge/protocol.mjs';

test('Mac runtime forwards owner session status read-only with locally checked principal',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'acp-wire-owner-'));
  t.after(async()=>rm(stateDir,{recursive:true,force:true}));
  const base=createRuntime({host:'mac',stateDir,hubGrants:{
    'hub:owner':'owner','hub:readonly':'read'
  }});
  t.after(()=>base.close());
  const wire=await createRuntimeOperations({
    runtimeFor:principal=>base.as(principal),
    principalFromWire:claimed=>base.principalFromHub(claimed)
  });
  t.after(()=>wire.close());
  const id=randomUUID();
  const call=(p,args={session_id:id})=>wire.handlers.agent_sandbox_status(args,{
    principal:{id:p}
  });
  assert.deepEqual(await call('hub:owner'),{ok:false,error:'unknown_session'});
  assert.deepEqual(await call('hub:readonly'),{ok:false,error:'forbidden'});
  await assert.rejects(call('hub:unlisted'),error=>
    error?.code==='unknown_principal' || error instanceof OperationError);
  await assert.rejects(call('hub:owner',{session_id:'../../not-valid'}),
    error=>error?.code==='invalid_arguments');
  // The client cannot choose the principal in arguments; the hub's signed
  // transport identity remains authoritative.
  assert.deepEqual(await call('hub:readonly',{
    session_id:id,principal:'hub:owner'
  }),{ok:false,error:'forbidden'});
});
