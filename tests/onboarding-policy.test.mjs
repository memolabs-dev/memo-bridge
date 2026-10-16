import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTrustedEnrollmentPolicy, loadTrustedEnrollmentPolicy } from '../server/onboarding-policy.mjs';
import { ownerApprovedPolicy } from '../server/onboarding-auto-worker.mjs';
import { reconcileWithHostPolicy } from '../server/onboarding-auto-orchestrator.mjs';

const org='memolabs-dev', installationId=170927025;
const radar=org+'/rebuild-radar', mobile=org+'/mobile-explorer';
const selected=()=>({schema:'memo-bridge.owner-enrollment.v1',org,installationId,
  approvedFor:org,enabled:true,mode:'selected',enrolledRepositories:[radar,mobile],
  excludedRepositories:[]});
const orgwide=()=>({...selected(),mode:'organization',orgWideAutoEnrollment:true,
  enrolledRepositories:[]});
const changes={ok:true,org,installationId,change:'added',repositories:[
  {name:'rebuild-radar',fullName:radar,repositoryId:1422117761},
  {name:'mobile-explorer',fullName:mobile,repositoryId:1422117945}
]};
const proofs={
  [radar]: {repositoryId:1422117761,fullName:radar,private:true,archived:false,
    installationAccess:true,installationId,defaultBranch:'main',manifestVerified:true,
    governanceMerged:false},
  [mobile]:{repositoryId:1422117945,fullName:mobile,private:true,archived:false,
    installationAccess:false,installationId,defaultBranch:'main',manifestVerified:true,
    governanceMerged:false}
};
const catalog=['rebuild-radar','mobile-explorer'].map(name=>({kind:'repo',name,catalog_stale:false}));
async function withFixture(policy, callback) {
  const dir=await mkdtemp(join(tmpdir(),'memo-onboarding-owner-'));
  const file=join(dir,'policy.json');
  try {
    await writeFile(file,JSON.stringify(policy),{mode:0o600});
    await chmod(file,0o600);
    return await callback({dir,file});
  } finally {await rm(dir,{recursive:true,force:true});}
}
test('default selected mode never silently extends repository access',()=>{
  const {policy}=parseTrustedEnrollmentPolicy(selected());
  const prepared=ownerApprovedPolicy({policy,change:changes,proofs});
  assert.equal(prepared.orgWideAutoEnrollment,false);
  assert.deepEqual(prepared.enrolledRepositories,[mobile,radar].sort());
  assert.equal(prepared.enrolledRepositories.includes(org+'/unlisted'),false);
});
test('organization mode still requires verified App installation, exact repo ID and opt-in manifest',()=>{
  const {policy}=parseTrustedEnrollmentPolicy(orgwide());
  const result=ownerApprovedPolicy({policy,change:changes,proofs});
  assert.deepEqual(result.enrolledRepositories,[radar]);
  assert.equal(result.enrolledRepositories.includes(mobile),false);
  const changed={...proofs,[radar]:{...proofs[radar],manifestVerified:false}};
  assert.deepEqual(ownerApprovedPolicy({policy,change:changes,proofs:changed}).enrolledRepositories,[]);
});
test('policy is bounded to exact owner and installation and refuses contradictory authorization',()=>{
  for (const candidate of [
    {...selected(),org:'other'}, {...selected(),installationId:123},
    {...selected(),enrolledRepositories:['other/steal']},
    {...selected(),enrolledRepositories:[radar,radar]},
    {...selected(),excludedRepositories:[radar]},
    {...orgwide(),enabled:false},
    {...selected(),orgWideAutoEnrollment:true}
  ]) assert.throws(()=>parseTrustedEnrollmentPolicy(candidate));
});
test('service only loads host-private config from trusted directory',async()=>{
  await withFixture(orgwide(),async({dir,file})=>{
    const result=await loadTrustedEnrollmentPolicy({configPath:file,trustedRoot:dir});
    assert.equal(result.policy.orgWideAutoEnrollment,true);
    assert.match(result.revision,/^[a-f0-9]{24}$/);
    await chmod(file,0o644);
    await assert.rejects(loadTrustedEnrollmentPolicy({configPath:file,trustedRoot:dir}),
      /policy_file_not_private/);
  });
});
test('symlinked policy and paths outside trusted root are rejected before parsing',async()=>{
  await withFixture(selected(),async({dir,file})=>{
    const link=join(dir,'symlink.json');
    await symlink(file,link);
    await assert.rejects(loadTrustedEnrollmentPolicy({configPath:link,trustedRoot:dir}));
    const nested=join(dir,'nested');
    await mkdir(nested);
    await assert.rejects(loadTrustedEnrollmentPolicy({configPath:file,trustedRoot:nested}),
      /policy_path_untrusted/);
  });
});
test('host policy orchestrator cannot propose for repository without scoped App access',async()=>{
  await withFixture(orgwide(),async({dir,file})=>{
    const plan=await reconcileWithHostPolicy({
      configPath:file,trustedRoot:dir,change:changes,catalog,proofs,dryRun:false
    });
    assert.equal(plan.ok,true);
    assert.equal(plan.dry_run,true); // no trusted effect adapter exists yet
    const denied=plan.next.find(p=>p.repository===mobile);
    assert.equal(denied.stage,'blocked');
    assert.ok(denied.blockers.includes('not_in_owner_approved_enrollment'));
    const allowed=plan.next.find(p=>p.repository===radar);
    assert.equal(allowed.actions[0].operation,'propose_governance_pr');
  });
});
test('missing trusted config never becomes an implicit org-wide grant',async()=>{
  const r=await reconcileWithHostPolicy({
    configPath:'/nonexistent/no-private-policy.json',
    trustedRoot:'/nonexistent',change:changes,catalog,proofs
  });
  assert.equal(r.ok,false);
  assert.equal(r.error,'trusted_policy_unavailable');
  assert.equal(r.dry_run,true);
});
