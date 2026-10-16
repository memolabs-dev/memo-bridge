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
