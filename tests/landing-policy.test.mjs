import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateLanding} from '../bridge/landing-policy.mjs';
const SHA='a'.repeat(40);
const good=()=>({draft:false,state:'open',author:'memo-labs-automation[bot]',headRepo:'memolabs-dev/memo-bridge',baseRepo:'memolabs-dev/memo-bridge',baseBranch:'main',headSha:SHA,approved:true,mergeable:true,checks:[{name:'test (22)',headSha:SHA,conclusion:'success'},{name:'test (24)',headSha:SHA,conclusion:'success'}]});
const check=p=>evaluateLanding(p,{requiredChecks:['test (22)','test (24)']});
test('approved trusted same-repo PR with two green checks eligible',()=>assert.equal(check(good()).eligible,true));
for(const [reason,patch] of [['draft',{draft:true}],['untrusted_author',{author:'stranger'}],['fork_or_unknown_origin',{headRepo:'stranger/fork'}],['hold_merge',{holdMerge:true}],['acceptance_not_approved',{approved:false}],['not_mergeable',{mergeable:false}],['review_required',{reviewRequired:true}],['unresolved_review',{unresolvedThreads:1}],['unexpected_base',{baseBranch:'release'}]]) {
 test('fail closed: '+reason,()=>assert.ok(check({...good(),...patch}).reasons.includes(reason)));
}
test('stale check SHA rejected',()=>assert.equal(check({...good(),checks:[{name:'test (22)',headSha:'b'.repeat(40),conclusion:'success'},good().checks[1]]}).eligible,false));
test('missing or failed check rejected',()=>{assert.equal(check({...good(),checks:[good().checks[0]]}).eligible,false);assert.equal(check({...good(),checks:[{...good().checks[0],conclusion:'failure'},good().checks[1]]}).eligible,false)});
test('duplicate status names fail closed',()=>assert.equal(check({...good(),checks:[...good().checks,good().checks[0]]}).eligible,false));
