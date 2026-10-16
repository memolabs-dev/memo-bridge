import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnerPrivatePolicy,loadOwnerPrivatePolicy,withOwnerPrivateRepos,SCHEMA } from '../server/coordinator/owner-private-repos.mjs';

const good = {schema:SCHEMA,owner_sub:'owner-123',repos:['memolabs-dev/clinical-data-knowledge-foundation']};
const context={
 file:'/Users/test/.local/share/memo-bridge/owner-policy/private-repos.json',
 home:'/Users/test',
 uid:501,host:'mac',
 principal:{id:'oidc:owner-123'},
 remotePolicy:{configured:true,owner_sub:'owner-123'},
 fs:{
  lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,size:180,mode:0o100600,uid:501}),
  realpath:async file=>file,
  readFile:async()=>JSON.stringify(good),
 }
};

test('explicit owner private policy accepts just the named repository',()=>{
 assert.deepEqual(parseOwnerPrivatePolicy(good,{expectedOwnerSub:'owner-123'}),{ok:true,repos:[good.repos[0]]});
});
test('reject arbitrary other orgs, duplications, hidden keys and wrong owner',()=>{
 for(const data of [
  {...good,owner_sub:'other'},
  {...good,repos:['evil-org/private']},
  {...good,repos:['memolabs-dev/foo','memolabs-dev/FOO']},
  {...good,extra:'not-allowed'},
  {...good,repos:['../../wrong']},
 ]) {
  assert.equal(parseOwnerPrivatePolicy(data,{expectedOwnerSub:'owner-123'}).ok,false);
 }
});
test('the VPS or a different principal cannot use the Mac owner policy',async()=>{
 for(const update of [
  {host:'vps'},
  {principal:{id:'oidc:other'}},
  {remotePolicy:{configured:false,owner_sub:'owner-123'}},
 ]) {
  assert.equal((await loadOwnerPrivatePolicy({...context,...update})).ok,false);
 }
});
test('wrong file path, group/world readable mode and symlinks fail closed',async()=>{
 const variants = [
  {file:'/Users/test/memolabs/PROJECTS.md'},
  {fs:{...context.fs,lstat:async()=>({...await context.fs.lstat(),mode:0o100644})}},
  {fs:{...context.fs,lstat:async()=>({...await context.fs.lstat(),isSymbolicLink:()=>true})}},
  {fs:{...context.fs,lstat:async()=>({...await context.fs.lstat(),uid:0})}},
  {fs:{...context.fs,realpath:async()=>'/tmp/secret'}},
 ];
 for(const update of variants){
  assert.equal((await loadOwnerPrivatePolicy({...context,...update})).ok,false);
 }
});
test('missing private config is an empty allowlist, not implicit permission',async()=>{
 assert.deepEqual(await loadOwnerPrivatePolicy({...context,file:undefined}),{ok:true,repos:[]});
});
test('append private list only to a successful public grant, never to failed ledger lookup',async()=>{
 const base={ok:true,repos:['memolabs-dev/memo-bridge']};
 const result=await withOwnerPrivateRepos(base,context);
 assert.deepEqual(result.repos,['memolabs-dev/memo-bridge','memolabs-dev/clinical-data-knowledge-foundation']);
 assert.deepEqual(await withOwnerPrivateRepos({ok:false,error:'ledger_unavailable'},context),{ok:false,error:'ledger_unavailable'});
});
