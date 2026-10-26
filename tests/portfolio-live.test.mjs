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
test('livePortfolio caps concurrent per-project fetches at the concurrency limit',async()=>{
 const many=Array.from({length:6},(_,i)=>({name:`org/app${i}`,kind:'repo',available:true}));
 const inFlight=new Set(); let maxInFlight=0;
 const gh={
  projectRepo:async(name)=>{inFlight.add(name);maxInFlight=Math.max(maxInFlight,inFlight.size);await new Promise(r=>setTimeout(r,10));inFlight.delete(name);return `org/${name}`;},
  resolveRepo:async()=>({ok:true,repo:{full:'org/app'}}),
  issues:async()=>({ok:true,count:1,issues:[{number:1,title:'Fix',state:'open',labels:['agent:ready','priority:p0'],updated_at:'2026-10-20T00:00:00Z'}]}),
  pullRequests:async()=>({ok:true,count:0,pull_requests:[]})};
 const p=await livePortfolio({projects:many,github:gh,concurrency:2});
 assert.equal(maxInFlight,2);assert.equal(p.observed_projects.length,6);
});
test('livePortfolio default concurrency is 4',async()=>{
 const many=Array.from({length:8},(_,i)=>({name:`org/app${i}`,kind:'repo',available:true}));
 const inFlight=new Set(); let maxInFlight=0;
 const gh={
  projectRepo:async(name)=>{inFlight.add(name);maxInFlight=Math.max(maxInFlight,inFlight.size);await new Promise(r=>setTimeout(r,10));inFlight.delete(name);return `org/${name}`;},
  resolveRepo:async()=>({ok:true,repo:{full:'org/app'}}),
  issues:async()=>({ok:true,count:1,issues:[{number:1,title:'Fix',state:'open',labels:['agent:ready','priority:p0'],updated_at:'2026-10-20T00:00:00Z'}]}),
  pullRequests:async()=>({ok:true,count:0,pull_requests:[]})};
 await livePortfolio({projects:many,github:gh});
 assert.equal(maxInFlight,4);
});

test('paginated portfolioPages results stay complete rather than falsely truncated', async () => {
 const paged = {...github,
  issues: async () => { throw new Error('fallback issues must not be called'); },
  pullRequests: async () => { throw new Error('fallback pulls must not be called'); },
  portfolioPages: async (_repo, {kind}) => kind === 'issues'
   ? {ok:true,items:[{number:3,title:'Paged',state:'open',labels:['priority:p0','agent:ready'],created_at:'2026-10-20T00:00:00Z'}]}
   : {ok:true,items:[{number:7,title:'Aux PR',state:'open',draft:false,updated_at:'2026-10-20T00:00:00Z'}]},
 };
 const report = await livePortfolio({projects,github:paged,limit:1,concurrency:2});
 assert.equal(report.complete,true);
 assert.equal(report.totals.open_issues,1);
 assert.equal(report.totals.open_prs,1);
 assert.equal(report.observed_projects.length,1);
});
test('livePortfolio caps excessive caller concurrency at eight',async()=>{
 const many=Array.from({length:12},(_,i)=>({name:'app'+i,kind:'repo',available:true}));
 let inFlight=0,max=0;
 const gh={...github,projectRepo:async name=>{
  inFlight++;max=Math.max(max,inFlight);await new Promise(r=>setTimeout(r,5));inFlight--;return 'org/'+name;
 }};
 await livePortfolio({projects:many,github:gh,concurrency:10_000});
 assert.equal(max,8);
});
