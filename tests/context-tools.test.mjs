import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteStore } from '../server/coordinator/store.mjs';
import { registerContextTools } from '../server/tools/context-tools.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { tempStateDir } from './helpers/coordinator-fixture.mjs';
const gh = { projectRepo: async () => 'memolabs-dev/drop', resolveRepo: async () => ({ ok:true, repo:{full:'memolabs-dev/drop'} }),
  issues: async () => ({ok:true,issues:[{number:12,title:'Existing issue',state:'open'}]}),
  pullRequests: async () => ({ok:true,pull_requests:[{number:13,title:'Existing PR',state:'open'}]}) };
async function fixture(t, principal = makePrincipal('local:owner',[CAPABILITIES.READ]), extra = {}) {
  const store = openSqliteStore({dir:await tempStateDir(t)}); t.after(()=>store.close());
  const tools = new Map();
  const rt = { principal, store:()=>store, now:Date.now, catalogOptions:{},
    authorize:op=>op==='project_context'&&principal.capabilities.has(CAPABILITIES.READ), audit:async()=>{} };
  registerContextTools({registerTool:(n,def,handler)=>tools.set(n,{def,handler})},()=>rt,{
    github:gh, repoFor:async()=> 'memolabs-dev/drop',
    listProjects:async()=>({projects:[{name:'drop',kind:'repo',nature:'app',status:'active'},
      {name:'snapshot',kind:'repo',metadata_only:true}]}),
    remotePolicy:()=>({configured:true,projects:['drop']}), ...extra });
  return {invoke:async args=>JSON.parse((await tools.get('project_context').handler(args)).content[0].text),tools};
}
test('existing PR and Issue discovered without claiming deployment',async t=>{
  const {invoke,tools}=await fixture(t); const v=await invoke({project:'drop'});
  assert.equal(v.ok,true); assert.equal(v.pull_requests[0].number,13);
  assert.equal(v.issues[0].number,12); assert.equal(v.capability_evidence.source_engine,'observed');
  assert.equal(tools.get('project_context').def.annotations.readOnlyHint,true);
});
test('unknown and metadata-only projects denied',async t=>{
  const {invoke}=await fixture(t);
  assert.equal((await invoke({project:'missing'})).error,'unknown_project');
  assert.equal((await invoke({project:'snapshot'})).error,'unknown_project');
});
test('remote allowlist enforced',async t=>{
  const {invoke}=await fixture(t,makePrincipal('oidc:remote',[CAPABILITIES.READ]));
  assert.equal((await invoke({project:'snapshot'})).error,'project_not_allowed');
});
test('upstream unavailable explicitly marked',async t=>{
  const {invoke}=await fixture(t,makePrincipal('local:owner',[CAPABILITIES.READ]),{
    github:{...gh,pullRequests:async()=>{throw Error('offline')}}});
  const v=await invoke({project:'drop'}); assert.equal(v.ok,true);
  assert.equal(v.sources.github_pull_requests.available,false);
});
