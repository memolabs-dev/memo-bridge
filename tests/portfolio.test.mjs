import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPortfolio,rankPortfolio,summarizeIssue} from '../server/portfolio.mjs';
const issue=(number,labels,created_at='2026-10-01T00:00:00Z')=>({number,title:'task '+number,state:'open',labels:labels.map(name=>({name})),created_at});
test('prioritize ready p0 over p1, suppress claimed and blocked',()=>{
 const a=['priority:p0','agent:ready'];
 const q=rankPortfolio({issues:[summarizeIssue(issue(1,a),'org/a'),summarizeIssue(issue(2,['priority:p0','agent:ready','blocked']),'org/a'),summarizeIssue(issue(3,['priority:p1','agent:ready']),'org/b')],prs:[]});
 assert.equal(q.next.number,1);assert.equal(q.totals.ready,2);
});
test('global pagination and partial permissions fail closed',async()=>{
 const report=await collectPortfolio(['org/b','org/a'],async({repo,kind,page})=>{
  if(repo==='org/b')throw new Error('forbidden');
  if(kind==='issues'&&page===1)return {items:[issue(1,['priority:p0','agent:ready']),{number:99,pull_request:{}}],hasNext:true};
  return {items:[],hasNext:false};
 },{perPage:2});
 assert.equal(report.complete,false);assert.equal(report.errors.length,2);assert.equal(report.totals.open_issues,1);assert.equal(report.next.repo,'org/a');
});
test('draft PR is tracked without claiming deployment',()=>{
 const q=rankPortfolio({issues:[summarizeIssue(issue(4,['priority:p0','agent:ready']),'org/a')],prs:[{repo:'org/a',kind:'pr',state:'open',draft:true,number:10,title:'Fixes #4'}]});
 assert.equal(q.next,null);assert.equal(q.queue[0].reason,'pr_in_progress');assert.equal(q.totals.open_prs,1);
});
test('no priority is surfaced for triage, not agent claim',()=>{
 const q=rankPortfolio({issues:[summarizeIssue(issue(1,['agent:ready']),'org/a')],prs:[]});
 assert.equal(q.next,null);assert.equal(q.totals.needs_triage,1);
});
test('collectPortfolio caps concurrent fetches at the concurrency limit',async()=>{
 const repos=['org/a','org/b','org/c','org/d','org/e'];
 const inFlight=new Set(); let maxInFlight=0;
 const fetchPage=async({repo})=>{
  inFlight.add(repo); maxInFlight=Math.max(maxInFlight,inFlight.size);
  await new Promise(r=>setTimeout(r,10)); inFlight.delete(repo);
  return {items:[],hasNext:false};
 };
 const report=await collectPortfolio(repos,fetchPage,{perPage:100,maxPages:1,concurrency:2});
 assert.equal(maxInFlight,2);assert.equal(report.totals.open_issues,0);
});
test('collectPortfolio default concurrency is 4',async()=>{
 const repos=['org/a','org/b','org/c','org/d','org/e','org/f','org/g'];
 const inFlight=new Set(); let maxInFlight=0;
 const fetchPage=async({repo})=>{
  inFlight.add(repo); maxInFlight=Math.max(maxInFlight,inFlight.size);
  await new Promise(r=>setTimeout(r,10)); inFlight.delete(repo);
  return {items:[],hasNext:false};
 };
 await collectPortfolio(repos,fetchPage,{perPage:100,maxPages:1});
 assert.equal(maxInFlight,4);
});

test('collectPortfolio caps excessive requested concurrency at eight',async()=>{
 const repos=Array.from({length:12},(_,i)=>'org/a'+i);
 let inFlight=0,max=0;
 const fetchPage=async()=>{inFlight++;max=Math.max(max,inFlight);await new Promise(r=>setTimeout(r,5));inFlight--;return {items:[],hasNext:false}};
 await collectPortfolio(repos,fetchPage,{concurrency:10_000,maxPages:1});
 assert.equal(max,8);
});
