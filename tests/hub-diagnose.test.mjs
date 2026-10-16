import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseHubJournal} from '../bridge/hub-diagnose.mjs';
const time=n=>new Date(Date.parse('2026-10-16T09:00:00Z')+n*60_000).toISOString();
test('six reconnects inside ten minutes is tunnel_flapping with redacted evidence',()=>{
 const lines=[0,1,2,3,4,9].map(n=>`${time(n)} agent reconnect token=secret`);
 const r=diagnoseHubJournal(lines);
 assert.equal(r.conclusion,'tunnel_flapping');assert.equal(r.reconnections_in_window,6);
 assert.equal(JSON.stringify(r).includes('secret'),false);assert.ok(r.evidence.length>=6);
});
test('automatic freeze wins and requires explicit owner action',()=>{
 const r=diagnoseHubJournal([`${time(1)} auto_frozen reason=high-impact`]);
 assert.equal(r.conclusion,'auto_frozen');assert.match(r.owner_action,/explicit/);
});
test('unknown pattern remains inconclusive with bounded evidence',()=>{
 const r=diagnoseHubJournal([`${time(1)} unclassified event`]);
 assert.equal(r.conclusion,'inconclusive');assert.equal(r.lines_inspected,1);
});
test('reconnect outside ten minutes is not flapping',()=>{
 const r=diagnoseHubJournal([0,11,22,33,44,55].map(n=>`${time(n)} reconnect`));
 assert.equal(r.conclusion,'inconclusive');assert.equal(r.reconnections_in_window,1);
});
test('no raw log echoed and recognized refusals summarized',()=>{
 const r=diagnoseHubJournal([`${time(1)} invalid signature bearer=never-print-me`]);
 assert.equal(r.conclusion,'signature_refused');assert.equal(JSON.stringify(r).includes('never-print-me'),false);
});
