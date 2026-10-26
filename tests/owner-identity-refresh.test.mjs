import test from 'node:test';
import assert from 'node:assert/strict';
import { githubOrigin, buildRegisteredIdentitySnapshot }
  from '../server/projects/owner-identity-refresh.mjs';
import { parseRegisteredIdentities } from '../server/projects/github-identity-audit.mjs';

const NOW=new Date('2026-10-26T13:00:00.000Z');
const make=(name='demo',url='https://github.com/example/demo.git',extra={})=>({
  name,pathRelative:'products/'+name,kind:'repo',available:true,
  path:'/private/'+name,origin:url,...extra
});
const origin=p=>p.origin;
const github=async name=>({id:name==='example/demo'?101:202,
  full_name:name,owner:{login:name.split('/')[0]}});
const build=(projects,extra={})=>buildRegisteredIdentitySnapshot({
  projects,readOrigin:origin,resolveGitHub:github,now:NOW,...extra
});
const prior=() =>({
  schema:'memolabs.registered-project-identities.v1',observed_at:'2026-10-26T12:00:00.000Z',
  authoritative_for_execution:false,source:'owner private',
  projects:[{project:'demo',path_relative:'products/demo',kind:'repo',
    status:'observed_identity',requested_origin:'example/demo',
    canonical_repo:'example/demo',github_repository_id:101,
    provenance:'live_github_api'}],
  same_repository_multiple_registered_projects:[],policy:'read-only'
});

test('GitHub origin parsing is strict and never accepts embedded tokens or other hosts',()=>{
  for(const url of ['https://github.com/example/demo.git',
    'git@github.com:example/demo.git','ssh://git@github.com/example/demo.git']){
    assert.equal(githubOrigin(url),'example/demo');
  }
  for(const bad of ['https://token@github.com/example/demo.git',
    'https://github.com.evil.io/example/demo','https://github.com/example/demo?token=secret',
    'https://github.com/example/../demo', 'file:///tmp/demo','https://gitlab.com/example/demo',
    'https://github.com/a/repo#main','https://github.com//demo',null]){
    assert.equal(githubOrigin(bad),null,String(bad));
  }
});

test('GitHub identity IDs are registered as observations, with validated private schema',async()=>{
  const out=await build([make()]);
  assert.equal(out.project_count,1);
  assert.equal(out.identity_count,1);
  assert.equal(out.unresolved_count,0);
  assert.equal(out.counts.observed_identity,1);
  assert.equal(out.snapshot.authoritative_for_execution,false);
  assert.equal(out.snapshot.projects[0].github_repository_id,101);
  assert.equal(parseRegisteredIdentities(out.snapshot,{now:NOW.getTime()}).identity_count,1);
});

test('path migration keeps immutable github identity without modifying any paths',async()=>{
  const next=await build([make('demo','https://github.com/example/demo.git',{
    pathRelative:'studio/new-location'
  })],{previous:prior()});
  assert.equal(next.snapshot.projects[0].path_relative,'studio/new-location');
  assert.equal(next.snapshot.projects[0].github_repository_id,101);
});

test('verified transfer requires prior known numeric ID and a live matching owner',async()=>{
  const p=make('demo','https://github.com/example/demo.git');
  const moved=async()=>({id:101,full_name:'company/demo',owner:{login:'company'}});
  const out=await build([p],{previous:prior(),resolveGitHub:moved});
  assert.equal(out.counts.verified_github_redirect,1);
  assert.equal(out.snapshot.projects[0].canonical_repo,'company/demo');
  await assert.rejects(build([p],{resolveGitHub:moved}),/identity_review_required/);
});

test('a replaced repo or fork has another ID and is never silently accepted',async()=>{
  const modified=async()=>({id:202,full_name:'example/demo',owner:{login:'example'}});
  await assert.rejects(build([make()],{previous:prior(),resolveGitHub:modified}),
    /identity_review_required/);
});

test('duplicate project names and duplicate observed repo IDs are refused, never collapsed',async()=>{
  await assert.rejects(build([make(),make()]),/duplicate_project_name/);
  await assert.rejects(build([make(),make('copy','https://github.com/example/demo.git')]),
    /duplicate_registered_repository_id/);
});

test('private 404 and inaccessible upstream remain unknown; never inferred by name',async()=>{
  const bad=async()=>{throw new Error('private_or_missing')};
  const out=await build([make()],{resolveGitHub:bad});
  assert.equal(out.identity_count,0);
  assert.equal(out.unresolved_count,1);
  assert.equal(out.snapshot.projects[0].status,'github_resolution_unavailable');
  assert.equal(out.snapshot.projects[0].github_repository_id,undefined);
});

test('unknown local folders, non-git remotes, and missing git origins stay unresolved',async()=>{
  const local=make('missing','anything',{available:false,path:null});
  const none=make('noorigin','', {});
  const gitlab=make('external','https://gitlab.com/example/external.git');
  const out=await build([local,none,gitlab]);
  assert.equal(out.counts.local_checkout_missing,1);
  assert.equal(out.counts.non_github_remote,2);
  assert.equal(out.unresolved_count,3);
});

test('GitHub replies must contain valid numeric IDs and trustworthy owner login',async()=>{
  const invalid=async()=>({id:101,full_name:'company/demo',owner:{login:'other'}});
  const out=await build([make()],{resolveGitHub:invalid});
  assert.equal(out.counts.github_resolution_unavailable,1);
  const noId=async()=>({id:'101',full_name:'example/demo',owner:{login:'example'}});
  const alt=await build([make()],{resolveGitHub:noId});
  assert.equal(alt.counts.github_resolution_unavailable,1);
});

test('prior snapshots with incorrect schema or authorization properties cannot attest aliases',async()=>{
  await assert.rejects(build([make()],{previous:{...prior(),authoritative_for_execution:true}}),
    /invalid_identity_snapshot/);
});
