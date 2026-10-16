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
