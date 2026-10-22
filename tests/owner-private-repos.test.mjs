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

// #257: the owner's local principal, the owner namespaces and the pre-filter.
import { allowedRepo, ownerKind, OWNER_NAMESPACES, MAX_REPOS } from '../server/coordinator/owner-private-repos.mjs';
import { localOwnerPrincipal, readerPrincipal, makePrincipal } from '../server/coordinator/policy.mjs';

test('the owner local principal reads the Mac owner policy on mac only',async()=>{
 const local=localOwnerPrincipal();
 const ok=await loadOwnerPrivatePolicy({...context,principal:local});
 assert.deepEqual(ok,{ok:true,repos:[good.repos[0]]});
 assert.equal((await loadOwnerPrivatePolicy({...context,principal:local,host:'vps'})).error,'private_policy_owner_only');
 // The owner sub still comes from the configured policy and must match the file.
 assert.equal((await loadOwnerPrivatePolicy({...context,principal:local,remotePolicy:{configured:true,owner_sub:'someone'}})).error,
  'private_policy_owner_mismatch');
 // Without a configured owner sub there is nothing to match the file against: no private repository.
 assert.deepEqual(await loadOwnerPrivatePolicy({...context,principal:local,remotePolicy:{configured:false}}),{ok:true,repos:[],owner:false});
 assert.equal((await loadOwnerPrivatePolicy({...context,principal:local,fs:{...context.fs,lstat:async()=>({...await context.fs.lstat(),mode:0o100640})}})).error,
  'private_policy_untrusted_file');
});
test('an object that merely looks like the local principal is not the owner',async()=>{
 const forged={id:localOwnerPrincipal().id};
 assert.equal(ownerKind(forged,'owner-123'),null);
 assert.deepEqual((await loadOwnerPrivatePolicy({...context,principal:forged})).repos,[]);
});
test('other local principals keep the public list, other remote principals are refused',async()=>{
 for(const p of [readerPrincipal(),makePrincipal('hub:owner',['coordinator:read'])]){
  const r=await loadOwnerPrivatePolicy({...context,principal:p});
  assert.deepEqual([r.ok,r.repos],[true,[]]);
 }
 for(const id of ['oidc:someone-else','oidc:owner-1234']){
  assert.equal((await loadOwnerPrivatePolicy({...context,principal:makePrincipal(id,['coordinator:read'])})).error,'private_policy_owner_only');
 }
 assert.equal(ownerKind(makePrincipal('oidc:owner-123',['coordinator:read']),'owner-123'),'remote');
 assert.equal(ownerKind(localOwnerPrincipal(),'owner-123'),'local');
});
test('the owner account namespace is enrollable, any other owner is not',()=>{
 const personal='guillaume-flambard/private-example';
 assert.deepEqual(parseOwnerPrivatePolicy({...good,repos:[good.repos[0],personal]},{expectedOwnerSub:'owner-123'}).repos,[good.repos[0],personal]);
 for(const repo of ['someone-else/x','guillaume-flambard-x/x','memolabs-devx/x']){
  assert.equal(parseOwnerPrivatePolicy({...good,repos:[repo]},{expectedOwnerSub:'owner-123'}).ok,false,repo);
 }
 const many=Array.from({length:MAX_REPOS},(_,i)=>`memolabs-dev/r${i}`);
 assert.equal(parseOwnerPrivatePolicy({...good,repos:many},{expectedOwnerSub:'owner-123'}).ok,true);
 assert.equal(parseOwnerPrivatePolicy({...good,repos:[...many,'memolabs-dev/one-more']},{expectedOwnerSub:'owner-123'}).ok,false);
});
test('pre-filter: exact entries first, then the owner namespaces, never another owner',async()=>{
 const list=await withOwnerPrivateRepos({ok:true,repos:['memolabs-dev/memo-bridge']},{...context,principal:localOwnerPrincipal()});
 assert.deepEqual(list.namespaces,OWNER_NAMESPACES);
 assert.equal(allowedRepo(list,'MemoLabs-Dev/Memo-Bridge'),'memolabs-dev/memo-bridge');
 assert.equal(allowedRepo(list,'memolabs-dev/clinical-data-knowledge-foundation'),'memolabs-dev/clinical-data-knowledge-foundation');
 assert.equal(allowedRepo(list,'memolabs-dev/any-public'),'memolabs-dev/any-public');
 assert.equal(allowedRepo(list,'guillaume-flambard/spec-guard'),'guillaume-flambard/spec-guard');
 for(const origin of ['someone-else/spec-guard','guillaume-flambard-x/a','memolabs-dev/../x',null]){
  assert.equal(allowedRepo(list,origin),null,String(origin));
 }
 assert.equal(allowedRepo({ok:false,error:'ledger_unavailable'},'memolabs-dev/memo-bridge'),null);
 // A list without namespaces (an older caller) keeps the exact behaviour.
 assert.equal(allowedRepo({ok:true,repos:['memolabs-dev/memo-bridge']},'memolabs-dev/other'),null);
});
