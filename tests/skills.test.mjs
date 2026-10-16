import test from 'node:test';
import assert from 'node:assert/strict';
import { lintSkill, SKILL_AUTHORING, SKILL_TOOLS, registerSkillTools } from '../server/tools/skill-tools.mjs';
import { collectToolDefinitions } from '../server/registry.mjs';

const valid = (description='Short description') => `---
name: example
description: ${description}
category: workflow
version: 1.0.0
---
# Example
Simple skill content.
`;

test('skills are registered in the shared remote and local tool registry', async () => {
  const defs=await collectToolDefinitions();
  for (const name of SKILL_TOOLS) assert.ok(defs.has(name), name);
});
test('skill lint: valid metadata, bounded description, references and incident records', () => {
  assert.equal(lintSkill(valid()), null);
  assert.equal(lintSkill(valid('a'.repeat(61))), 'description_too_long');
  assert.equal(lintSkill('missing metadata'), 'frontmatter_required');
  assert.equal(lintSkill(valid()+'\n#1 #2 #3 #4 #5 #6'), 'references_sprawl');
  assert.equal(lintSkill(valid()+'\n# Incident log\nentries'), 'incident_log_invalid');
  assert.equal(lintSkill(valid()+'z'.repeat(33000)), 'skill_oversized');
  assert.ok(SKILL_AUTHORING.includes('pull request'));
});
test('skill_propose requires an earlier view, even when runtime is present', async () => {
  const tools=new Map();
  registerSkillTools({registerTool(name,config,handler){tools.set(name,{config,handler});}},()=>({
    authorize:()=>true,
    principal:{id:'local:test'},
    audit:async()=>{}
  }));
  const out=await tools.get('skill_propose').handler({
    workspace_id:'ws_1234567890123456',worktree_id:'wt_1234567890123456',name:'example',content:valid()
  });
  assert.deepEqual(JSON.parse(out.content[0].text),{ok:false,error:'skill_view_required'});
});

test('skills_list, skill_view, skill_propose: bounded metadata and workspace-scoped view requirement', async () => {
 const doc=valid();
 const writes=[];
 const files=[{path:'skills/example/SKILL.md',content:doc}];
 const fake={
  listFiles:async()=>({ok:true,files:files.map(x=>x.path)}),
  readFile:async(a)=>({ok:true,content:files.find(x=>x.path===a.path)?.content??'',size:doc.length,truncated:false}),
  writeFile:async(a)=>{writes.push(a);return {ok:true};}
 };
 const handlers=new Map();
 const rt={authorize:()=>true,principal:{id:'local:owner'},audit:async()=>{}};
 registerSkillTools({registerTool(n,_c,h){handlers.set(n,h);}},()=>rt,{createRunner:()=>fake});
 const call=async(n,args)=>JSON.parse((await handlers.get(n)(args)).content[0].text);
 const shared={workspace_id:'ws_1234567890123456',worktree_id:'wt_1234567890123456'};
 const list=await call('skills_list',shared);
 assert.deepEqual(list.skills,[{name:'example',description:'Short description',category:'workflow',version:'1.0.0'}]);
 assert.equal(JSON.stringify(list).includes('# Example'),false);
 assert.equal((await call('skill_propose',{...shared,name:'example',content:doc})).error,'skill_view_required');
 assert.equal((await call('skill_view',{...shared,name:'example'})).untrusted_content,doc);
 assert.equal((await call('skill_propose',{...shared,workspace_id:'ws_abcdefabcdefabcd',name:'example',content:doc})).error,'skill_view_required');
 assert.equal((await call('skill_propose',{...shared,name:'example',content:doc})).ok,true);
 assert.equal(writes.length,1);
 assert.equal(writes[0].path,'skills/example/SKILL.md');
 assert.equal((await call('skill_propose',{...shared,name:'example',content:doc})).error,'skill_view_required');
});
test('skill_view: reference-only view does not grant write permission; truncated content fails closed',async()=>{
 const handlers=new Map();
 let oversized=false;
 const fake={
  readFile:async()=>({ok:true,content:valid(),size:oversized?35000:valid().length,truncated:oversized}),
  writeFile:async()=>{throw Error('must not write');}
 };
 registerSkillTools({registerTool(n,_c,h){handlers.set(n,h);}},()=>({authorize:()=>true,principal:{id:'local:owner'},audit:async()=>{}}),{createRunner:()=>fake});
 const call=async(n,args)=>JSON.parse((await handlers.get(n)(args)).content[0].text);
 const a={workspace_id:'ws_1234567890123456',worktree_id:'wt_1234567890123456',name:'example'};
 assert.equal((await call('skill_view',{...a,file:'references/readme.md'})).ok,true);
 assert.equal((await call('skill_propose',{...a,content:valid()})).error,'skill_view_required');
 oversized=true;
 assert.equal((await call('skill_view',a)).error,'skill_oversized');
 assert.equal((await call('skill_propose',{...a,content:valid()})).error,'skill_view_required');
});

test('remote forwarded metadata is preserved for every runner operation', async () => {
 const calls=[];
 const body=valid();
 const fake={
   listFiles:async(_a,ctx)=>{calls.push(ctx.meta?.client_session);return {ok:true,files:['skills/example/SKILL.md']};},
   readFile:async(_a,ctx)=>{calls.push(ctx.meta?.client_session);return {ok:true,content:body,size:body.length,truncated:false};},
   writeFile:async(_a,ctx)=>{calls.push(ctx.meta?.client_session);return {ok:true};}
 };
 const handlers=new Map();
 registerSkillTools({registerTool(n,_c,h){handlers.set(n,h);}},()=>({
   authorize:()=>true, principal:{id:'oidc:owner'},audit:async()=>{}
 }),{createRunner:()=>fake});
 const args={workspace_id:'ws_1234567890123456',worktree_id:'wt_1234567890123456',name:'example'};
 const meta={meta:{client_session:'test-remote-session'}};
 const run=async(n,a)=>JSON.parse((await handlers.get(n)(a,meta)).content[0].text);
 assert.equal((await run('skills_list',args)).ok,true);
 assert.equal((await run('skill_view',args)).ok,true);
 assert.equal((await run('skill_propose',{...args,content:body})).ok,true);
 assert.deepEqual(calls,Array(4).fill('test-remote-session'));
});

test('new skill: requires viewing missing name, explicit create, and no overwrite',async()=>{
 const handlers=new Map();
 let exists=false;let writes=0;
 const fake={
  readFile:async()=>exists?{ok:true,content:valid(),size:valid().length,truncated:false}:{ok:false,error:'not_found'},
  writeFile:async()=>{writes++;exists=true;return {ok:true};}
 };
 registerSkillTools({registerTool(n,_c,h){handlers.set(n,h);}},()=>({
   authorize:()=>true,principal:{id:'local:owner'},audit:async()=>{}
 }),{createRunner:()=>fake});
 const call=async(n,a)=>JSON.parse((await handlers.get(n)(a)).content[0].text);
 const a={workspace_id:'ws_1234567890123456',worktree_id:'wt_1234567890123456',name:'example'};
 assert.equal((await call('skill_propose',{...a,create:true,content:valid()})).error,'skill_view_required');
 assert.equal((await call('skill_view',a)).exists,false);
 assert.equal((await call('skill_propose',{...a,content:valid()})).error,'create_flag_required');
 assert.equal((await call('skill_propose',{...a,create:true,content:valid()})).ok,true);
 assert.equal(writes,1);
 assert.equal((await call('skill_view',a)).exists,undefined);
 assert.equal((await call('skill_propose',{...a,create:true,content:valid()})).error,'skill_already_exists');
});

test('create-only is sent to the runner for new skills, but not for edits',async()=>{
 const handlers=new Map(); let exists=false; const writes=[];
 const fake={readFile:async()=>exists?{ok:true,content:valid(),size:valid().length,truncated:false}:{ok:false,error:'not_found'},
 writeFile:async a=>{writes.push(a);exists=true;return {ok:true};}};
 registerSkillTools({registerTool(n,_c,h){handlers.set(n,h);}},()=>({authorize:()=>true,principal:{id:'local:owner'},audit:async()=>{}}),{createRunner:()=>fake});
 const invoke=async(n,a)=>JSON.parse((await handlers.get(n)(a)).content[0].text);
 const a={workspace_id:'ws_1234567890123456',worktree_id:'wt_1234567890123456',name:'example'};
 await invoke('skill_view',a);
 assert.equal((await invoke('skill_propose',{...a,create:true,content:valid()})).ok,true);
 assert.equal(writes[0].create_only,true);
 await invoke('skill_view',a);
 assert.equal((await invoke('skill_propose',{...a,content:valid()})).ok,true);
 assert.equal(writes[1].create_only,false);
});

test('a skill view cannot authorize a proposal from a different remote chat session',async()=>{
 const handlers=new Map();let writes=0;const body=valid();
 const fake={readFile:async()=>({ok:true,content:body,size:body.length,truncated:false}),writeFile:async()=>{writes++;return {ok:true};}};
 registerSkillTools({registerTool(n,_c,h){handlers.set(n,h);}},()=>({authorize:()=>true,principal:{id:'oidc:owner'},audit:async()=>{}}),{createRunner:()=>fake});
 const a={workspace_id:'ws_1234567890123456',worktree_id:'wt_1234567890123456',name:'example'};
 const call=async(n,args,session)=>JSON.parse((await handlers.get(n)(args,{meta:{client_session:session}})).content[0].text);
 assert.equal((await call('skill_view',a,'session-one')).ok,true);
 assert.equal((await call('skill_propose',{...a,content:body},'session-two')).error,'skill_view_required');
 assert.equal(writes,0);
 assert.equal((await call('skill_propose',{...a,content:body},'session-one')).ok,true);
 assert.equal(writes,1);
});
