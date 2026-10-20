import test from 'node:test';import assert from 'node:assert/strict';
import {livePortfolio} from '../server/portfolio-live.mjs';
const projects=[{name:'app',kind:'repo',available:true},{name:'missing',kind:'repo',available:false}];
const github={projectRepo:async()=> 'org/app',resolveRepo:async()=>({ok:true,repo:{full:'org/app'}}),
 issues:async()=>({ok:true,count:1,issues:[{number:2,title:'Fix',state:'open',labels:['agent:ready','priority:p0'],updated_at:'2026-10-20T00:00:00Z'}]}),
 pullRequests:async()=>({ok:true,count:0,pull_requests:[]})};
test('fetches actual registered repositories using injected authenticated integration',async()=>{const p=await livePortfolio({projects,github});assert.equal(p.complete,true);assert.equal(p.next.number,2);assert.equal(p.observed_projects.length,1)});
test('partial GitHub failures are exposed, not silently treated as no issues',async()=>{const p=await livePortfolio({projects,github:{...github,issues:async()=>({ok:false,error:'github_forbidden'})}});assert.equal(p.complete,false);assert.equal(p.next,null)});
test('pagination ceiling is explicitly incomplete',async()=>{const p=await livePortfolio({projects,github:{...github,issues:async()=>({ok:true,count:100,issues:[]})}});assert.equal(p.complete,false);assert.equal(p.errors[0].error,'possibly_truncated')});
test('owner allowlist filters projects',async()=>{const p=await livePortfolio({projects,github,allowedProjects:[]});assert.equal(p.observed_projects.length,0);assert.equal(p.next,null)});
