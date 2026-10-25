import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createAcpV1Transport } from '../server/runners/acp-v1-transport.mjs';

const nextTick = () => new Promise(resolve => setImmediate(resolve));
function peer(handler = () => {}) {
  const stdin = new PassThrough(), stdout = new PassThrough(), sent = [];
  let pending = '';
  stdin.on('data', chunk => {
    pending += String(chunk);
    while (pending.includes('\n')) {
      const index = pending.indexOf('\n');
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      sent.push(msg);
      handler(msg, {stdin,stdout,sent});
    }
  });
  const emit = msg => stdout.write(JSON.stringify({jsonrpc:'2.0',...msg}) + '\n');
  const stop = () => { stdout.destroy(); stdin.destroy(); };
  return {stdin,stdout,sent,emit,stop};
}
const ok = (msg, result) => ({id:msg.id,result});

test('creates a real ACP v1 session after initialize, sends text and gets a stop reason', async () => {
  const side = peer((msg,wire) => {
    if (msg.method==='session/new') side.emit(ok(msg,{sessionId:'sess_001'}));
    if (msg.method==='session/prompt') {
      assert.equal(msg.params.sessionId,'sess_001');
      side.emit({method:'session/update',params:{sessionId:'sess_001',
        update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello'}}}});
      side.emit(ok(msg,{stopReason:'end_turn'}));
    }
  });
  const updates=[];
  const t=createAcpV1Transport(side,{onUpdate:update=>updates.push(update)});
  try {
    assert.deepEqual(await t.newSession({cwd:'/Users/owner/worktree'}),{ok:true,session_id:'sess_001'});
    assert.deepEqual(await t.prompt('Read this example'),{ok:true,stop_reason:'end_turn'});
    assert.deepEqual(side.sent.map(m=>m.method),['session/new','session/prompt']);
    assert.deepEqual(side.sent[0].params,{cwd:'/Users/owner/worktree',mcpServers:[]});
    assert.deepEqual(side.sent[1].params.prompt,[{type:'text',text:'Read this example'}]);
    assert.deepEqual(updates,[{type:'agent_message_chunk',text:'Hello'}]);
    assert.deepEqual(t.status(),{state:'session_ready',busy:false});
  } finally {t.close();side.stop()}
});

test('permission is always cancelled; no allow option is selected', async () => {
  const side=peer(msg=>{
    if(msg.method==='session/new')side.emit(ok(msg,{sessionId:'sess_001'}));
    if(msg.method==='session/prompt') {
      side.emit({id:99,method:'session/request_permission',params:{
        sessionId:'sess_001',toolCall:{toolCallId:'call1'},options:[
          {optionId:'allow',kind:'allow_always',name:'Allow always'}]}});
    }
    if(msg.id===99) {
      assert.deepEqual(msg.result,{outcome:{outcome:'cancelled'}});
      side.emit({id:2,result:{stopReason:'cancelled'}});
    }
  });
  const t=createAcpV1Transport(side);
  try {
    await t.newSession({cwd:'/tmp/project'});
    assert.deepEqual(await t.prompt('Change a file'),{ok:true,stop_reason:'cancelled'});
    assert.equal(side.sent.some(m=>m.result?.outcome?.outcome==='selected'),false);
  } finally{t.close();side.stop()}
});

test('all agent-initiated filesystem and shell methods are explicitly denied',async()=>{
  const side=peer(msg=>{
    if(msg.method==='session/new')side.emit(ok(msg,{sessionId:'s'}));
  });
  const t=createAcpV1Transport(side);
  try{
    await t.newSession({cwd:'/tmp/project'});
    for(const [n,method] of ['fs/write_text_file','terminal/create','fs/read_text_file'].entries())
      side.emit({id:20+n,method,params:{path:'/tmp/x'}});
    await nextTick();
    assert.deepEqual(side.sent.filter(m=>[20,21,22].includes(m.id)).map(m=>m.error?.code),
      [-32601,-32601,-32601]);
  }finally{t.close();side.stop()}
});

test('rejects prompts before session creation and rejects user-supplied invalid inputs',async()=>{
  const side=peer();
  const t=createAcpV1Transport(side);
  try{
    await assert.rejects(t.prompt('Go'),/acp_session_not_open/);
    for (const cwd of ['../../etc','', '/tmp/evil\0path'])
      await assert.rejects(t.newSession({cwd}),/acp_invalid_cwd/);
    assert.equal(side.sent.length,0);
  }finally{t.close();side.stop()}
});

test('cannot open two sessions or run concurrent prompt turns',async()=>{
  let finish;
  const side=peer(msg=>{
    if(msg.method==='session/new')side.emit(ok(msg,{sessionId:'s'}));
    if(msg.method==='session/prompt')finish=()=>side.emit(ok(msg,{stopReason:'end_turn'}));
  });
  const t=createAcpV1Transport(side);
  try{
    await t.newSession({cwd:'/tmp/a'});
    await assert.rejects(t.newSession({cwd:'/tmp/b'}),/acp_session_already_open/);
    const pending=t.prompt('First');
    await assert.rejects(t.prompt('Second'),/acp_prompt_busy/);
    finish();
    await pending;
    assert.deepEqual(side.sent.map(msg=>msg.method),['session/new','session/prompt']);
  }finally{t.close();side.stop()}
});

test('v1 cancellation sends a notification to the correct agent session',async()=>{
  let pending;
  const side=peer(msg=>{
    if(msg.method==='session/new')side.emit(ok(msg,{sessionId:'the-session'}));
    if(msg.method==='session/prompt')pending=msg;
    if(msg.method==='session/cancel')side.emit(ok(pending,{stopReason:'cancelled'}));
  });
  const t=createAcpV1Transport(side);
  try{
    assert.equal(t.cancel(),false);
    await t.newSession({cwd:'/tmp/a'});
    const p=t.prompt('Write code');
    assert.equal(t.cancel(),true);
    assert.deepEqual(await p,{ok:true,stop_reason:'cancelled'});
    const cancellation=side.sent.find(x=>x.method==='session/cancel');
    assert.deepEqual(cancellation.params,{sessionId:'the-session'});
    assert.equal('id' in cancellation,false);
  }finally{t.close();side.stop()}
});

test('a mismatched or malformed response aborts transport, never falsely completes prompt',async()=>{
  for(const payload of [
    '{"jsonrpc":"2.0","id":9999,"result":{}}\n',
    '{"jsonrpc":"2.0","id":1,"result":{}\n',
    'x'.repeat(65537)
  ]) {
    const side=peer(msg=>{if(msg.method==='session/new')side.stdout.write(payload)});
    const t=createAcpV1Transport(side,{sessionTimeoutMs:100});
    try{
      await assert.rejects(t.newSession({cwd:'/tmp/a'}),/acp_(unexpected_response|invalid_json|frame_oversized)/);
      assert.equal(t.status().state,'closed');
    }finally{t.close();side.stop()}
  }
});

test('RPC deadline aborts the transport and late responses cannot complete another call',async()=>{
  const side=peer();
  const t=createAcpV1Transport(side,{sessionTimeoutMs:20});
  try{
    await assert.rejects(t.newSession({cwd:'/tmp/a'}),/acp_rpc_timeout/);
    assert.equal(t.status().state,'closed');
    await assert.rejects(t.newSession({cwd:'/tmp/a'}),/acp_transport_closed/);
  }finally{t.close();side.stop()}
});

test('disconnection and stop reject pending prompt, removing all pipe listeners',async()=>{
  const side=peer(msg=>{
    if(msg.method==='session/new')side.emit(ok(msg,{sessionId:'s'}));
  });
  const t=createAcpV1Transport(side);
  try{
    await t.newSession({cwd:'/tmp/a'});
    const pending=t.prompt('hello');
    t.close();
    await assert.rejects(pending,/acp_transport_closed/);
    assert.equal(side.stdout.listenerCount('data'),0);
    assert.equal(t.cancel(),false);
  }finally{t.close();side.stop()}
});

test('strict v1 negotiation, bounded user text and observer isolation',async()=>{
  const side=peer(msg=>{
    if(msg.method==='session/new')side.emit(ok(msg,{sessionId:'s'}));
    if(msg.method==='session/prompt')side.emit(ok(msg,{stopReason:'end_turn'}));
  });
  assert.throws(()=>createAcpV1Transport(side,{protocolVersion:2}),/invalid_acp_v1_transport/);
  const t=createAcpV1Transport(side,{onUpdate:()=>{throw Error('observer_fault')}});
  try{
    await t.newSession({cwd:'/tmp/a'});
    await assert.rejects(t.prompt('x'.repeat(8193)),/acp_prompt_invalid/);
    await assert.rejects(t.prompt(' '),/acp_prompt_invalid/);
    side.emit({method:'session/update',params:{sessionId:'s',update:{
      sessionUpdate:'agent_message_chunk',content:{type:'text',text:'safe'}}}});
    assert.deepEqual(await t.prompt('okay'),{ok:true,stop_reason:'end_turn'});
    assert.equal(side.sent.filter(m=>m.method==='session/prompt').length,1);
  }finally{t.close();side.stop()}
});
