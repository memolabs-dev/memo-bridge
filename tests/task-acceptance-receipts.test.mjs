import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { receiptFilename, sealAcceptanceReceipt, verifyAcceptanceReceipt, privateReceiptVerifier } from '../server/task-acceptance-receipts.mjs';

const now = Date.parse('2026-10-23T12:00:00Z');
const node = {ref:'memolabs-dev/drop#8',body:'verified change',state:'closed',
  updated_at:'2026-10-23T11:15:00Z',closed_at:'2026-10-23T11:05:00Z'};
const key = randomBytes(32);
const draft = {schema:1,issue:node.ref,issue_updated_at:node.updated_at,issue_closed_at:node.closed_at,
  body_sha256:createHash('sha256').update(node.body).digest('hex'),
  verifier_id:'independent:owner-reviewer',producer_id:'agent:implementation',
  verified_at:'2026-10-23T11:30:00Z',pr_ref:'https://github.com/memolabs-dev/drop/pull/123',
  deployment_ref:'https://example.test/deploy/verified',policy_ref:null,
  e2e_ref:'https://example.test/e2e/receipt'};
const sign = overrides => sealAcceptanceReceipt({...draft,...overrides},key);
test('independent signed delivery receipt accepts an exact closed issue revision',()=>{
  assert.deepEqual(verifyAcceptanceReceipt(node,sign(),key,{now}),
    {verified:true,passed:true,evidence_ref:draft.e2e_ref});
});
test('CI / PR merge or closed state alone cannot be used as acceptance',()=>{
  assert.equal(verifyAcceptanceReceipt(node,null,key,{now}),null);
  assert.equal(verifyAcceptanceReceipt({...node,state:'open'},sign(),key,{now}),null);
  assert.equal(verifyAcceptanceReceipt({...node,body:'edited'},sign(),key,{now}),null);
  assert.equal(verifyAcceptanceReceipt({...node,updated_at:'2026-10-23T11:50:00Z'},sign(),key,{now}),null);
});
test('tampering, replay, self-review and stale signatures fail closed',()=>{
  const signed=sign();
  assert.equal(verifyAcceptanceReceipt(node,{...signed,e2e_ref:'https://attacker.test'},key,{now}),null);
  assert.equal(verifyAcceptanceReceipt(node,signed,randomBytes(32),{now}),null);
  assert.equal(verifyAcceptanceReceipt(node,sign({verifier_id:draft.producer_id}),key,{now}),null);
  assert.equal(verifyAcceptanceReceipt(node,sign({verified_at:'2026-09-01T10:00:00Z'}),key,{now}),null);
  assert.equal(verifyAcceptanceReceipt(node,sign({deployment_ref:null,policy_ref:null}),key,{now}),null);
  assert.equal(verifyAcceptanceReceipt(node,sign({deployment_ref:'verified',policy_ref:'also verified'}),key,{now}),null);
  assert.equal(verifyAcceptanceReceipt(node,{...signed,evil:true},key,{now}),null);
});
test('private receipt reader verifies 0600 files in a 0700 directory and rejects permissive files and symlinks',async t=>{
  const root=await mkdtemp(join(tmpdir(),'memo-receipt-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const dir=join(root,'dependency-acceptance'),keyfile=join(root,'dependency-acceptance.key');
  await mkdir(dir,{mode:0o700});await writeFile(keyfile,key,{mode:0o600});
  const path=join(dir,receiptFilename(node.ref));
  await writeFile(path,JSON.stringify(sign()),{mode:0o600});
  const verifier=privateReceiptVerifier({stateDir:root,now:()=>now});
  assert.deepEqual(await verifier(node),{verified:true,passed:true,evidence_ref:draft.e2e_ref});
  await chmod(path,0o644);assert.equal(await verifier(node),null);
  await chmod(path,0o600);await chmod(dir,0o755);assert.equal(await verifier(node),null);
  await chmod(dir,0o700);
  const saved=join(root,'saved.json');await writeFile(saved,JSON.stringify(sign()),{mode:0o600});
  await rm(path);await symlink(saved,path);assert.equal(await verifier(node),null);
});
