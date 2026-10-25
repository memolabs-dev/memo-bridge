import test from 'node:test';
import assert from 'node:assert/strict';
import {createAcpRuntimeOwners} from '../server/runners/acp-runtime-owner.mjs';
import {createRuntime} from '../server/runtime.mjs';

function runtime() {
  const hooks=[];
  let shuttingDown=false;
  return {
    onShutdown(callback) {
      if (shuttingDown) throw Error('runtime_shutdown_unavailable');
      hooks.push(callback);
    },
    async close() {
      shuttingDown=true;
      await Promise.allSettled(hooks.map(fn=>fn()));
    }
  };
}

test('two MCP collectors in same process share exactly one runtime-scoped ACP owner', async()=>{
  const rt=runtime();
  let made=0,closed=0;
  const registry=createAcpRuntimeOwners({createSupervisor:()=>({
    start:async()=>({ok:true}),close:async()=>{closed++;made===1||assert.fail()}
  })});
  const first=registry.get(rt);made++;
  const second=registry.get(rt);
  assert.strictEqual(first,second);
  assert.equal(made,1);
  await rt.close();
  assert.equal(closed,1);
});

test('a second identity/runtime cannot reuse another owner', async()=>{
  const x=runtime(), y=runtime();
  let created=0,stopped=0;
  const registry=createAcpRuntimeOwners({createSupervisor:()=>({
    start:()=>{},close:async()=>{stopped++},n:++created
  })});
  assert.notStrictEqual(registry.get(x),registry.get(y));
  assert.strictEqual(registry.get(x),registry.get(x));
  assert.equal(created,2);
  await Promise.all([x.close(),y.close()]);
  assert.equal(stopped,2);
});

test('shutdown makes later owner acquisition fail closed; never start an unowned process',async()=>{
  const rt=runtime();
  let created=0,closed=0;
  const registry=createAcpRuntimeOwners({createSupervisor:()=>({
    start:()=>{},close:async()=>{closed++;},id:++created
  })});
  registry.get(rt);
  await rt.close();
  assert.throws(()=>registry.get(rt),/acp_runtime_shutting_down/);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(created,2);
  assert.equal(closed,2);
});

test('invalid lifecycle or invalid supervisor is rejected before giving a handler',()=>{
  const registry=createAcpRuntimeOwners({createSupervisor:()=>({start:()=>{}})});
  assert.throws(()=>registry.get({}),/acp_runtime_lifecycle_unavailable/);
  assert.throws(()=>registry.get(runtime()),/invalid_acp_supervisor/);
});

test('base createRuntime owns cleanup registered from its principal views, once',async()=>{
  const base=createRuntime({readOnly:true});
  const reader=base.as(base.principal);
  let calls=0;
  reader.onShutdown(async()=>{calls++;});
  const c1=base.close(), c2=base.close();
  assert.strictEqual(c1,c2,'close is singleflight and cannot race store close');
  await Promise.all([c1,c2]);
  assert.equal(calls,1);
  assert.throws(()=>base.onShutdown(()=>{}),/runtime_shutdown_unavailable/);
});

test('one failed callback cannot prevent other supervisor shutdown or runtime close',async()=>{
  const base=createRuntime({readOnly:true});
  let second=false;
  base.onShutdown(()=>{throw Error('failed_manager')});
  base.onShutdown(async()=>{second=true});
  await base.close();
  assert.equal(second,true);
});
