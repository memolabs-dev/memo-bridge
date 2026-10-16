import test from 'node:test';
import assert from 'node:assert/strict';
import { assessProductOnboarding } from '../server/onboarding-readiness.mjs';

const names = ['rebuild-radar', 'mobile-explorer'];
const projects = names.map(name => ({name, kind:'repo', available:true, path:'/tmp/test/' + name}));
const origins = Object.fromEntries(names.map(name => [name, 'memolabs-dev/' + name]));
const ledgerRepos = names.map(name => 'memolabs-dev/' + name);

test('both valid registered and allowlisted repos pass coordinator preflight', () => {
  const r = assessProductOnboarding({names,projects,origins,ledgerRepos});
  assert.equal(r.all_coordinator_ready,true);
  assert.equal(r.projects.length,2);
  assert.ok(r.projects.every(p=>p.coordinator_ready && p.blockers.length===0));
  assert.ok(r.projects.every(p=>p.app_installation_verified===false && p.landing_verified===false));
});
test('snapshot-only metadata never grants execution readiness', () => {
  const r = assessProductOnboarding({names:['rebuild-radar'],projects:[
    {name:'rebuild-radar',kind:'repo',available:false,path:null,metadata_only:true}
  ],origins,ledgerRepos});
  assert.equal(r.all_coordinator_ready,false);
  assert.deepEqual(r.projects[0].blockers,['checkout_unavailable']);
});
test('unregistered projects cannot gain readiness from origin and allowlist alone', () => {
  const r = assessProductOnboarding({names:['rebuild-radar'],projects:[],origins,ledgerRepos});
  assert.equal(r.projects[0].coordinator_ready,false);
  assert.deepEqual(r.projects[0].blockers,['not_registered_locally']);
});
test('wrong origin never inherits a same-name project authorization', () => {
  const r = assessProductOnboarding({names:['rebuild-radar'],projects,origins:{'rebuild-radar':'attacker/rebuild-radar'},ledgerRepos});
  assert.deepEqual(r.projects[0].blockers,['origin_not_verified']);
});
test('registry and origin alone are not sufficient without ledger allowlisting', () => {
  const r = assessProductOnboarding({names:['mobile-explorer'],projects,origins,ledgerRepos:[]});
  assert.deepEqual(r.projects[0].blockers,['ledger_not_allowlisted']);
  assert.equal(r.all_coordinator_ready,false);
});
test('invalid names and duplicate inputs fail closed', () => {
  for(const bad of [['../root'],['mobile-explorer','mobile-explorer'],[],['x\\nInjected'],new Array(21).fill('a')]){
    assert.throws(()=>assessProductOnboarding({names:bad,projects,origins,ledgerRepos}),/invalid_names/);
  }
});
