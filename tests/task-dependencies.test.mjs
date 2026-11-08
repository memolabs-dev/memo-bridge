import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDependencySpec, inspectDependencies, normalizeIssueRef } from '../server/task-dependencies.mjs';
const id = n => 'memolabs-dev/test-repo#' + n;
const node = (n, deps = [], state = 'closed', extra = {}) => ({
  ref: id(n), state, authorized: true, observed_at: '2026-10-23T12:00:00Z',
  body: deps.length ? '<!-- memo-bridge:requires:v1 ' + JSON.stringify({requires: deps.map(id)}) + ' -->' : '', ...extra
});
const now = Date.parse('2026-10-23T12:01:00Z');
function graph(items, options = {}) {
  const map = new Map(items.map(x => [x.ref, x]));
  return inspectDependencies(id(1), {
    now, loadIssue: async ref => map.get(ref),
    verifyAcceptance: async i => i.accepted === false ? null :
      ({ verified: true, passed: true, evidence_ref: 'verified:receipt:' + i.ref }),
    ...options
  });
}
test('strict declarations and no implicit prose-based dependencies', () => {
  assert.deepEqual(parseDependencySpec('Depends on: ' + id(2)), {ok:true, requires:[]});
  assert.deepEqual(parseDependencySpec(node(1, [2]).body), {ok:true, requires:[id(2)]});
  assert.equal(parseDependencySpec('<!-- memo-bridge:requires:v1 broken -->').ok, false);
  assert.equal(parseDependencySpec('<!-- memo-bridge:requires:v1 {"requires":["bad"]} -->').ok, false);
  assert.equal(parseDependencySpec('<!-- memo-bridge:requires:v1 {"requires":["'+id(2)+'","'+id(2)+'"]} -->').ok, false);
  assert.equal(normalizeIssueRef('MEMOLABS-DEV/Test-repo#02'), 'memolabs-dev/test-repo#2');
});
test('chain and diamond require every closed-and-accepted predecessor', async () => {
  const r = await graph([node(1,[2,3],'open'),node(2,[4]),node(3,[4]),node(4)]);
  assert.equal(r.eligible,true);
  assert.equal(r.evidence.length,3);
});
test('closed issue alone cannot satisfy prerequisite without independent acceptance', async () => {
  const r = await graph([node(1,[2],'open'),node(2,[], 'closed', {accepted:false})]);
  assert.equal(r.eligible,false);assert.equal(r.reason,'dependency_acceptance_missing');
});
test('unfinished priority inversion: parent P0 never bypasses P1 dependency', async () => {
  const r = await graph([node(1,[2],'open'),node(2,[], 'open')]);
  assert.equal(r.eligible,false);assert.equal(r.reason,'dependency_not_closed');
});
test('cycles and self-references block', async () => {
  for(const rows of [[node(1,[1],'open')],[node(1,[2],'open'),node(2,[1])]]) {
    const r = await graph(rows);assert.equal(r.eligible,false);assert.equal(r.reason,'dependency_cycle');
  }
});
test('missing, inaccessible, stale and malformed issues block with no data leakage', async () => {
  const cases = [
    [node(1,[2],'open')],
    [node(1,[2],'open'),node(2,[], 'closed', {authorized:false})],
    [node(1,[2],'open'),node(2,[], 'closed', {observed_at:'2026-10-21T12:00:00Z'})],
    [node(1,[2],'open'),node(2,[], 'closed', {body:'<!-- memo-bridge:requires:v1 XXX -->'})]
  ];
  for(const items of cases) {
    const r = await graph(items);assert.equal(r.eligible,false);
    assert.equal(JSON.stringify(r).includes('secret'),false);
  }
});
test('different repo IDs are not accidentally treated as the same issue', async () => {
  const other = {...node(2),ref:'other-owner/another#2'};
  const r = await graph([node(1,[2],'open'),other]);
  assert.equal(r.eligible,false);
});
test('missing verifier and failed network calls fail closed', async () => {
  const r = await inspectDependencies(id(1), {now,loadIssue:async ref => ref===id(1)?node(1,[2],'open'):node(2)});
  assert.equal(r.reason,'dependency_acceptance_missing');
  const failed = await inspectDependencies(id(1), {now,loadIssue:async()=>{throw Error('private path')}})
  assert.equal(failed.eligible,false);
});
test('stale root observation itself is not a claim authorization',async()=>{
  const r = await graph([node(1,[],'open',{observed_at:'2026-10-20T10:00:00Z'})]);
  assert.equal(r.eligible,false);
});
test('manifest cannot escalate a privileged action or forge verification',async()=>{
  const issue=node(1,[2],'open',{body:'<!-- memo-bridge:requires:v1 {"requires":["'+id(2)+'"],"passed":true} -->'});
  const r=await graph([issue,node(2)]);
  assert.equal(r.eligible,false);
});
test('a long chain of unknown blockers hits the bounded graph limit', async () => {
  const rows=Array.from({length:80},(_,i)=>node(i+1,i<79?[i+2]:[],'closed'));
  const r=await graph(rows);
  assert.equal(r.eligible,false);
  assert.equal(r.reason,'dependency_graph_limit');
});
