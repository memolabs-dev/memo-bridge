import test from 'node:test';
import assert from 'node:assert/strict';
import { livePortfolio } from '../server/portfolio-live.mjs';
const projects=[{name:'test',kind:'repo',available:true}];
const base={projectRepo:async()=> 'memolabs-dev/test',resolveRepo:async()=>({ok:true,repo:{full:'memolabs-dev/test'}})};
test('portfolio uses paged endpoints and recognizes records after first 100',async()=>{
 const github={...base,portfolioPages:async (_,{kind})=>({ok:true,items:kind==='issues'?
 [{number:500,title:'later issue',state:'open',labels:['priority:p0','agent:ready'],updated_at:'2026-10-20T08:00:00Z'}]:[],complete:true})};
 const r=await livePortfolio({projects,github});
 assert.equal(r.complete,true);assert.equal(r.next.number,500);
});
test('pagination error makes portfolio explicitly incomplete',async()=>{
 const github={...base,portfolioPages:async()=>({ok:false,error:'page_limit_reached'})};
 const r=await livePortfolio({projects,github});
 assert.equal(r.complete,false);assert.equal(r.observed_projects.length,0);
 assert.equal(r.errors[0].error,'page_limit_reached');
});
