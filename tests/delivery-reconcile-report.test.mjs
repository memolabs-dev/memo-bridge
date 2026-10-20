import test from 'node:test';import assert from 'node:assert/strict';
import {reconcileDeliveryReport} from '../server/delivery-reconcile-report.mjs';
const issue={repo:'org/app',number:4,state:'open',url:'https://example.test/4'};
const merged={repo:'org/app',number:12,state:'closed',merged_at:'2026-10-20T01:00:00Z',
 merge_commit_sha:'abc',linked_issues:[4],html_url:'https://example.test/pr/12'};
test('merged but not deployed reports verification pending',()=>{const r=reconcileDeliveryReport({issues:[issue],prs:[merged]});assert.equal(r.entries[0].suggested_action,'verify_deployment');assert.equal(r.closure_candidates,0)});
test('no issue mutations and closed only recommended upon corroborated evidence',()=>{const r=reconcileDeliveryReport({issues:[issue],prs:[merged],
 deployments:{'org/app#4':{verified:true,merge_commit_sha:'abc',receipt_ref:'release/42',environment:'production'}},
 acceptances:{'org/app#4':{passed:true,evidence_ref:'test/42'}}});assert.equal(r.entries[0].close_eligible,true);assert.equal(r.mode,'dry_run')});
test('cross-repository PR does not link',()=>{const r=reconcileDeliveryReport({issues:[issue],prs:[{...merged,repo:'org/other'}]});assert.equal(r.entries[0].linked_prs.length,0)});
