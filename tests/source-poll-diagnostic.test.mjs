import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSourceChanges } from '../server/source-engine/poll.mjs';
test('diagnostic: stubbed exact identity qualifies with remote checkpoint', async () => {
 const org='memolabs-dev/memo-bridge', ref=org+'#50', sha='a'.repeat(40),branch='agent/50-wwww';
 const worktree={id:'wt_'+'w'.repeat(16),workspace_id:'ws_'+'w'.repeat(16),
   issue_ref:ref,branch};
 const check={issue_ref:ref,workspace_id:worktree.workspace_id,branch,commit_sha:sha,durability:'remote'};
 const store={transaction:async fn=>fn({
   listSourceChanges:()=>[],
   listWorktrees:()=>[worktree],
   listCheckpoints:()=>[check]
 })};
 const github={
   resolveRepo:async()=>({ok:true,repo:{full:org}}),
   pullRequests:async()=>({ok:true,pull_requests:[{
     number:51,author:'memo-labs-automation[bot]',state:'open',head:branch,head_sha:sha,
     base:'main',base_sha:'b'.repeat(40),head_repo_full_name:org
   }]}),
   defaultBranch:async()=>({ok:true,branch:'main'})
 };
 const x=await discoverSourceChanges({store,github,project:'memo-bridge',
   origin:org,trustedAuthors:['memo-labs-automation[bot]'],dryRun:true});
 assert.equal(x.candidates,1,JSON.stringify(x));
});