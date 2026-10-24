import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteStore } from '../server/coordinator/store.mjs';
import { tempStateDir } from './helpers/coordinator-fixture.mjs';
const repo='memolabs-dev/memo-bridge', issue=repo+'#50', wsid='ws_'+'w'.repeat(16),wtid='wt_'+'w'.repeat(16),
 branch='agent/50-wwww',sha='a'.repeat(40);
test('sqlite fixture stores independent Source Engine worktree and remote checkpoint',async t=>{
 const store=openSqliteStore({dir:await tempStateDir(t)});t.after(()=>store.close());
 await store.transaction(db=>{
   db.insertWorkspace({id:wsid,principal:'local:owner',client_type:'chatgpt',project_id:'memo-bridge',
    host:'vps',status:'closed',created_at:1000,updated_at:1000});
   db.insertWorktree({id:wtid,workspace_id:wsid,project_id:'memo-bridge',host:'vps',
    path:'/private/example',branch,base_ref:'origin/main',base_commit:'b'.repeat(40),issue_ref:issue,
    created_at:1000,updated_at:1000});
   db.insertCheckpoint({issue_ref:issue,claim_id:'claim',workspace_id:wsid,
    fence_sha:'f'.repeat(40),branch,commit_sha:sha,durability:'remote',at:1000});
 });
 const rows=await store.transaction(db=>db.listWorktrees({project_id:'memo-bridge',limit:100}),{write:false});
 const checkpoints=await store.transaction(db=>db.listCheckpoints(issue,10),{write:false});
 assert.equal(rows.length,1,JSON.stringify({rows,checkpoints}));
 assert.equal(rows[0].issue_ref,issue,JSON.stringify(rows[0]));
 assert.equal(checkpoints.length,1,JSON.stringify(checkpoints));
 assert.equal(checkpoints[0].commit_sha,sha,JSON.stringify(checkpoints[0]));
});