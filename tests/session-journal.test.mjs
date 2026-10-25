// Issue #291: every operator journal line is attributable to one session, and someone outside
// the conversation can rebuild the order of events and detect a gap or an edit with a command.
// Two sessions act at once through the agent's real pipeline (v2 session-bound signatures);
// forged, missing and reused session ids are refused and journaled; scripts/audit-verify.mjs
// reports a deleted, edited or cut journal. Temporary files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOperatorOperations } from '../bridge/operator-agent.mjs';
import { createOperatorGuard } from '../bridge/operator-guard.mjs';
import { createAuditChain, fileAuditStore, lineHash, verifyJournal } from '../bridge/operator-audit.mjs';
import { createOperatorTools } from '../bridge/operator-tools.mjs';
import { makeHost, signingPair } from './helpers/operator-fixture.mjs';

const VERIFY = fileURLToPath(new URL('../scripts/audit-verify.mjs', import.meta.url));
const A = 'a1'.repeat(16);
const B = 'b2'.repeat(16);
let seq = 0;
const nextId = () => `req_${String(++seq).padStart(16, '0')}`;

function host(t) {
  const h = makeHost(t);
  const clock = { t: 1_800_000_000_000 };
  const { signer, verifier } = signingPair({ clock });
  const now = () => clock.t;
  const journalPath = h.p('state/audit.jsonl');
  const guard = createOperatorGuard(h.policy, { now });
  const chain = createAuditChain({ store: fileAuditStore(journalPath), now });
  const tools = createOperatorTools(h.policy, { guard, chain, projects: async () => [], platform: 'linux', now });
  const { handlers } = createOperatorOperations({ policy: h.policy, verifier, guard, chain, tools, now });
  // signedSession: the session the hub signed; wireSession: what the request metadata carries.
  const envelope = ({ principal, signedSession = null, args }) => {
    const id = nextId();
    return { id, args, principal, operator: signer.sign({ id, op: 'operator_read', host: 'vps', tier: 0, principal, args, clientSession: signedSession }) };
  };
  const send = (env, wireSession) => handlers.operator_read(env.args, { id: env.id, op: 'operator_read', principal: { id: env.principal },
    operator: env.operator, meta: { request_id: env.id, client_session: wireSession } });
  const lines = () => readFileSync(journalPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { ...h, journalPath, envelope, send, lines, clock };
}

const runVerify = (...args) => {
  const out = spawnSync(process.execPath, [VERIFY, ...args], { encoding: 'utf8' });
  return { code: out.status, json: out.stdout ? JSON.parse(out.stdout) : null, stderr: out.stderr };
};

test('#291: two sessions act concurrently; every line names its session, principal and host; the verifier sees a clean ordered chain', async t => {
  const h = host(t);
  const calls = [];
  for (let i = 0; i < 12; i++) {
    const [session, principal] = i % 2 ? [B, 'oidc:session-b'] : [A, 'oidc:session-a'];
    const env = h.envelope({ principal, signedSession: session, args: { host: 'vps', path: h.p('srv/app/notes.md'), ref: `call-${i}` } });
    calls.push({ env, session, principal });
  }
  const results = await Promise.all(calls.map(c => h.send(c.env, c.session)));
  assert.ok(results.every(r => r.ok === true), JSON.stringify(results.find(r => r.ok !== true)));
  const lines = h.lines();
  assert.deepEqual(lines.map(l => l.seq), Array.from({ length: 12 }, (_, i) => i + 1), 'one monotonic sequence');
  for (const c of calls) {
    const line = lines.find(l => l.request_id === c.env.id);
    assert.deepEqual([line.session, line.principal, line.host, line.session_claimed], [c.session, c.principal, 'vps', undefined], c.env.id);
  }
  for (let i = 1; i < lines.length; i++) assert.equal(lines[i].prev, lines[i - 1].hash, 'each line carries the previous hash');
  const report = runVerify(h.journalPath);
  assert.equal(report.code, 0, report.stderr);
  assert.equal(report.json.ok, true);
  assert.equal(report.json.lines, 12);
  const bySession = Object.fromEntries(report.json.sessions.map(s => [s.session, s]));
  assert.deepEqual(bySession[A].principals, ['oidc:session-a']);
  assert.deepEqual(bySession[B].principals, ['oidc:session-b']);
  assert.deepEqual([bySession[A].lines, bySession[B].lines], [6, 6]);
});

test('#291: a forged, missing or reused session id is refused and journaled; the forged hint is kept apart, never trusted', async t => {
  const h = host(t);
  const args = () => ({ host: 'vps', path: h.p('srv/app/notes.md') });
  // Session A's signed call presented with session B's hint: a swap.
  const swapped = h.envelope({ principal: 'oidc:session-a', signedSession: A, args: args() });
  assert.deepEqual(await h.send(swapped, B), { ok: false, error: 'session_mismatch' });
  // The hint dropped from the metadata.
  const dropped = h.envelope({ principal: 'oidc:session-a', signedSession: A, args: args() });
  assert.deepEqual(await h.send(dropped, null), { ok: false, error: 'session_mismatch' });
  // A valid call, then the same signed request sent again by its session and by another one.
  const once = h.envelope({ principal: 'oidc:session-a', signedSession: A, args: args() });
  assert.equal((await h.send(once, A)).ok, true);
  assert.deepEqual(await h.send(once, A), { ok: false, error: 'replayed' });
  assert.deepEqual(await h.send(once, B), { ok: false, error: 'session_mismatch' });
  // An unsigned hint on a v1 signature: the line carries no session, and says what was claimed.
  const unbound = h.envelope({ principal: 'oidc:session-a', args: args() });
  assert.equal((await h.send(unbound, B)).ok, true);

  const lines = h.lines();
  const pick = l => [l.outcome, l.code, l.session, l.session_claimed ?? null];
  assert.deepEqual(lines.map(pick), [
    ['denied', 'session_mismatch', null, B],
    ['denied', 'session_mismatch', null, null],
    ['ok', null, A, null],
    ['denied', 'replayed', null, A],
    ['denied', 'session_mismatch', null, B],
    ['ok', null, null, B]
  ]);
  const report = verifyJournal(readFileSync(h.journalPath, 'utf8'));
  assert.equal(report.ok, true);
  assert.deepEqual(report.sessions.find(s => s.session === A).lines, 1, 'only the verified call counts for session A');
});

test('#291: deleting, editing or cutting one journal line is detected by the verifier command', async t => {
  const h = host(t);
  for (let i = 0; i < 6; i++) {
    const env = h.envelope({ principal: 'oidc:session-a', signedSession: A, args: { host: 'vps', path: h.p('srv/app/notes.md'), ref: `n${i}` } });
    assert.equal((await h.send(env, A)).ok, true);
  }
  const text = readFileSync(h.journalPath, 'utf8');
  const raw = text.trim().split('\n');
  const anchor = `6:${JSON.parse(raw[5]).hash}`;
  assert.equal(runVerify(h.journalPath, '--anchor', anchor).code, 0, 'clean, and the anchor matches');
  const variant = (name, lines) => { const p = join(h.p('state'), `${name}.jsonl`); writeFileSync(p, `${lines.join('\n')}\n`); return p; };

  const deleted = runVerify(variant('deleted', raw.filter((_, i) => i !== 2)));
  assert.deepEqual([deleted.code, deleted.json.ok, deleted.json.reason, deleted.json.first_broken_line], [1, false, 'sequence', 3]);

  const edited = raw.map((l, i) => (i === 3 ? JSON.stringify({ ...JSON.parse(l), principal: 'hub:owner' }) : l));
  const e = runVerify(variant('edited', edited));
  assert.deepEqual([e.code, e.json.reason, e.json.first_broken_line], [1, 'hash_mismatch', 4]);

  // A careful edit that rehashes the line still breaks the next line's prev.
  const rehashed = raw.map(l => JSON.parse(l));
  rehashed[3].session = B;
  rehashed[3].hash = lineHash(rehashed[3]);
  const r = runVerify(variant('rehashed', rehashed.map(l => JSON.stringify(l))));
  assert.deepEqual([r.code, r.json.reason, r.json.first_broken_line], [1, 'prev_mismatch', 5]);

  // A cut tail leaves a valid chain: only an anchor shows it.
  const cut = variant('cut', raw.slice(0, 4));
  assert.equal(runVerify(cut).code, 0, 'without an anchor a cut tail is undetectable');
  const c = runVerify(cut, '--anchor', anchor);
  assert.deepEqual([c.code, c.json.reason, c.json.anchor], [1, 'truncated', { seq: 6, ok: false }]);
  // The whole tail rewritten after the anchor point (the last line replaced): anchor_mismatch.
  const swapped = raw.slice(0, 5).concat(JSON.stringify((() => { const l = JSON.parse(raw[5]); l.ref = 'x'; l.hash = lineHash(l); return l; })()));
  const s = runVerify(variant('swapped', swapped), '--anchor', anchor);
  assert.deepEqual([s.code, s.json.reason], [1, 'anchor_mismatch']);

  assert.equal(runVerify().code, 2, 'usage');
  assert.equal(runVerify(h.p('state/missing.jsonl')).json.ok, true, 'a missing journal is an empty chain');
  assert.equal(runVerify(h.journalPath, '--anchor', 'x').code, 2);
  rmSync(join(h.p('state'), 'cut.jsonl'));
});
