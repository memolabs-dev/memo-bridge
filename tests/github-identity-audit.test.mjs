import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY_SCHEMA, parseRegisteredIdentities, verifyLiveGitHubIdentity,
  compareRegisteredIdentities
} from '../server/projects/github-identity-audit.mjs';

const NOW=Date.parse('2026-10-26T12:00:00.000Z');
const entry=(project='uni',path='products/uni')=>({
  project,path_relative:path,kind:'repo',status:'verified_github_redirect',
  requested_origin:'guillaume-flambard/uni-protocol',
  canonical_repo:'memolabs-dev/uni-protocol',
  github_repository_id:1370011909,provenance:'live_github_api'
});
const snapshot=(projects=[entry()])=>({
  schema:IDENTITY_SCHEMA,observed_at:'2026-10-26T11:00:00.000Z',
  authoritative_for_execution:false,
  source:'PROJECTS.md local checkout remotes + authenticated GitHub metadata',
  projects,same_repository_multiple_registered_projects:[],
  policy:'Observation only: not authorization'
});
const check=doc=>parseRegisteredIdentities(doc,{now:NOW});

test('verified owner transfer uses a stable repo ID but is never authorization',()=>{
  const valid=check(snapshot());
  assert.equal(valid.identity_count,1);
  assert.equal(valid.unresolved_count,0);
  assert.equal(valid.entries[0].stable_key,'github:1370011909');
  assert.equal(valid.redirects[0].from,'guillaume-flambard/uni-protocol');
  const observed=verifyLiveGitHubIdentity('guillaume-flambard/uni-protocol',{
    id:1370011909,full_name:'memolabs-dev/uni-protocol',owner:{login:'memolabs-dev'}
  },1370011909);
  assert.equal(observed.ok,true);
  assert.equal(observed.redirected,true);
  assert.equal(observed.grants_access,false);
});

test('a local directory move does not create a second GitHub repository identity',()=>{
  const before=check(snapshot([entry('uni','products/uni')]));
  const after=check(snapshot([entry('uni','os/uni')]));
  assert.deepEqual(compareRegisteredIdentities(before,after),{
    moved:[{project:'uni',stable_key:'github:1370011909',path_changed:true,canonical_changed:false}],
    changed:[],removed:[]
  });
});

test('a verified transfer updates the canonical owner but not the immutable ID',()=>{
  const initial={...entry(),status:'observed_identity',requested_origin:'guillaume-flambard/uni-protocol',
    canonical_repo:'guillaume-flambard/uni-protocol',provenance:'authenticated_inventory'};
  const before=check(snapshot([initial]));
  const after=check(snapshot([entry()]));
  assert.deepEqual(compareRegisteredIdentities(before,after),{
    moved:[{project:'uni',stable_key:'github:1370011909',path_changed:false,canonical_changed:true}],
    changed:[],removed:[]
  });
});

test('a fork lookalike with another repo ID is never treated as an alias or transfer',()=>{
  const observed=verifyLiveGitHubIdentity('guillaume-flambard/mediterranean-rescue',{
    id:1432083166,full_name:'guillaume-flambard/mediterranean-rescue',
    owner:{login:'guillaume-flambard'}
  },1433119674);
  assert.deepEqual(observed,{ok:false,error:'repository_id_mismatch'});
  const a={...entry(),project:'rescue',requested_origin:'memolabs-dev/mediterranean-rescue',
    canonical_repo:'memolabs-dev/mediterranean-rescue',github_repository_id:1433119674,
    status:'observed_identity'};
  const b={...a,github_repository_id:1432083166};
  const compared=compareRegisteredIdentities(check(snapshot([a])),check(snapshot([b])));
  assert.equal(compared.changed[0].status,'identity_changed_not_alias');
});

test('two project names pointing to one repo ID remain separate and flagged for review',()=>{
  const a={...entry(),project:'uni',path_relative:'products/uni'};
  const b={...entry(),project:'uni-protocol',path_relative:'products/uni-protocol'};
  const parsed=check(snapshot([a,b]));
  assert.equal(parsed.identity_count,1);
  assert.deepEqual(parsed.same_id_projects,[{
    stable_key:'github:1370011909',projects:['uni','uni-protocol']
  }]);
});

test('ambiguous aliases or duplicate IDs with inconsistent canonical identities are rejected',()=>{
  const a={...entry(),project:'uni'};
  assert.throws(()=>check(snapshot([a,a])),/duplicate_project_name/);
  assert.throws(()=>check(snapshot([a,{...a,project:'other',requested_origin:'another/repo',
    canonical_repo:'another/repo',status:'observed_identity'}])),/conflicting_canonical_alias/);
  assert.throws(()=>check(snapshot([a,{...a,project:'other',github_repository_id:666}])),
    /conflicting_origin_id/);
});

test('a saved alias with no live verification is refused; stale snapshots are visible',()=>{
  const alias={...entry(),provenance:'authenticated_inventory'};
  assert.throws(()=>check(snapshot([alias])),/unverified_alias/);
  assert.equal(parseRegisteredIdentities(snapshot(),{now:NOW+3*24*3600_000}).stale,true);
  assert.deepEqual(verifyLiveGitHubIdentity('guillaume-flambard/uni-protocol',{
    id:999,full_name:'memolabs-dev/uni-protocol',owner:{login:'memolabs-dev'}
  },1370011909),{ok:false,error:'repository_id_mismatch'});
});

test('unresolved private or inaccessible observations cannot supply verified repo IDs',()=>{
  const unresolved={project:'private',path_relative:'products/private',kind:'repo',
    status:'github_resolution_unavailable',requested_origin:'guillaume-flambard/private'};
  const parsed=check(snapshot([unresolved]));
  assert.equal(parsed.identity_count,0);
  assert.equal(parsed.unresolved_count,1);
  assert.throws(()=>check(snapshot([{...unresolved,github_repository_id:10}])),/unverified_identity/);
  assert.throws(()=>check(snapshot([{...unresolved,canonical_repo:'memolabs-dev/private'}])),/unverified_identity/);
});

test('malformed or hostile metadata fails closed, does not expose arbitrary properties',()=>{
  for(const value of [
    snapshot([{...entry(),local_path:'/Users/memo/Vault'}]),
    snapshot([{...entry(),path_relative:'../../private'}]),
    {...snapshot(),authoritative_for_execution:true},
    {...snapshot(),observed_at:'not-a-date'},
    snapshot([{...entry(),status:'ready_for_execution'}])
  ]) assert.throws(()=>check(value));
  const wrongOwner=verifyLiveGitHubIdentity('guillaume-flambard/uni-protocol',{
    id:1370011909,full_name:'memolabs-dev/uni-protocol',owner:{login:'other'}
  },1370011909);
  assert.deepEqual(wrongOwner,{ok:false,error:'invalid_github_identity'});
});
