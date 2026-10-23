// Multi-session coordination (.agent/project/multi-session/spec.md): up to ten ChatGPT
// conversations of one owner at once. sessions_overview, session_binding enforce, task_next over
// the whole backlog with a brief, operator locks in the hub, the default operator host, and the
// instructions every client receives. Offline: an atomic in-memory ledger, a stub GitHub search,
// a hub with stub workspaces and, for the host default, a fake operator-mac agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { parseRemotePolicy, sessionBindingDecision, sessionTag } from '../bridge/write-gate.mjs';
import { parseRemoteJson } from '../bridge/remote-config.mjs';
import { clientSessionHash } from '../bridge/forward.mjs';
import { OVERVIEW, REBIND_IDLE_MS, SESSION_RULES } from '../server/coordinator/index.mjs';
import { LOCK_TTL, createOperatorLocks, mergeOverview, normalizePath } from '../bridge/operator-locks.mjs';
import { createHub } from '../bridge/hub.mjs';
import { createAgent } from '../bridge/agent.mjs';
import { generateAgentIdentity } from '../bridge/crypto.mjs';
import { REMOTE_INSTRUCTIONS } from '../bridge/remote-surface.mjs';
import { MERGE_INSTRUCTIONS, MULTI_SESSION_INSTRUCTIONS, OPERATOR_FLOW_INSTRUCTIONS, OPERATOR_HOST_INSTRUCTIONS, STOP_CODES } from '../server/instructions.mjs';
import { REMOTE_TOOLS_READ, REMOTE_OPERATOR_TOOLS } from '../server/registry.mjs';
import { OWNER, coordinatorOn, journal, tempStateDir } from './helpers/coordinator-fixture.mjs';
import { memoryLedger } from './helpers/memory-ledger.mjs';
import { operatorKeys } from './helpers/operator-fixture.mjs';
import { labRemoteJson } from './helpers/remote-stack.mjs';

const ALL = Object.values(CAPABILITIES);
const CHAT = makePrincipal('oidc:owner-sub', ALL, { client_type: 'chatgpt', via: 'hub' });
const session = name => clientSessionHash({ mcpReq: { _meta: { 'openai/session': name } } });
const meta = name => ({ client_session: session(name) });

// The backlog: Issues of the two allowed repositories, as the GitHub search API returns them.
function backlog(spec) {
  return spec.map(([repo, number, priority, created]) => ({ number, state: 'open', title: `Task ${repo}#${number}`,
    body: `## Scope\n\nChange ${number} only.\n\n## Acceptance\n\n- test ${number} passes`,
    repository_url: `https://api.github.com/repos/memolabs-dev/${repo}`, labels: [{ name: 'agent:ready' }, { name: `priority:${priority}` }],
    created_at: `2026-10-${String(created).padStart(2, '0')}T10:00:00Z`, updated_at: '2026-10-14T10:00:00Z' }));
}
const BACKLOG = backlog([
  ['drop', 1, 'p2', 1], ['drop', 2, 'p1', 2], ['drop', 3, 'p0', 9], ['drop', 4, 'p1', 3], ['drop', 5, 'p2', 2],
  ['cuesheet', 1, 'p0', 5], ['cuesheet', 2, 'p1', 1], ['cuesheet', 3, 'p2', 3], ['cuesheet', 4, 'p1', 7], ['cuesheet', 5, 'p0', 1]
]);

function setup(t, { mode = 'warn', principal = CHAT, items = BACKLOG, stateDir } = {}) {
  let at = Date.parse('2026-10-14T16:00:00Z');
  const clock = () => at;
  const ledger = memoryLedger(clock);
  const searches = [];
  const remotePolicy = parseRemotePolicy({ projects: ['memolabs-dev/drop', 'memolabs-dev/cuesheet'], session_binding: mode });
  const searchIssues = async query => {
    searches.push(query);
    const repos = [...query.matchAll(/repo:(\S+)/g)].map(m => m[1].toLowerCase());
    const hits = items.filter(i => repos.some(r => i.repository_url.toLowerCase().endsWith(r)));
    return { ok: true, total_count: hits.length, incomplete: false, items: hits };
  };
  const fx = coordinatorOn(stateDir, { principal, now: clock, ledger, tasks: { remotePolicy, searchIssues } });
  t.after(() => fx.store.close());
  return { ...fx, ledger, searches, advance: ms => { at += ms; }, clock };
}
const open = async (coordinator, name, project = 'drop') => {
  const opened = await coordinator.workspaceOpen({ project, client_label: name }, meta(name));
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return opened.workspace.workspace_id;
};

// ---------------------------------------------------------------------------------------------
// task_next over the backlog (D-MS7, D-MS8)

test('MS-R9: 11 concurrent conversations call task_next: 10 distinct tasks by priority across projects, no double lease, one done', async t => {
  const { coordinator, ledger, store } = setup(t, { stateDir: await tempStateDir(t) });
  const names = Array.from({ length: 11 }, (_, i) => `conversation-${i}`);
  const ids = [];
  for (const name of names) ids.push(await open(coordinator, name));
  const answers = await Promise.all(names.map((name, i) => coordinator.taskNext({ workspace_id: ids[i] }, meta(name))));
  for (const a of answers) assert.equal(a.ok, true, JSON.stringify(a));
  const taken = answers.filter(a => !a.done).map(a => a.task.issue);
  assert.equal(taken.length, 10);
  assert.equal(new Set(taken).size, 10, 'every task handed out once');
  assert.equal(answers.filter(a => a.done).length, 1);
  // The ledger holds each one for exactly the workspace that got it.
  for (const a of answers.filter(x => !x.done)) {
    const lease = ledger.leases.get(a.task.issue);
    assert.equal(lease.worker, `mb.vps.${a.task.workspace_id}`);
    assert.equal(lease.claim_id, a.task.claim_id);
  }
  // Both projects served, workspaces moved to the project of their task.
  const rows = await store.transaction(repo => ids.map(id => repo.getWorkspace(id)), { write: false });
  for (const a of answers.filter(x => !x.done)) {
    assert.equal(rows.find(r => r.id === a.task.workspace_id).project_id, a.task.project);
    assert.equal(a.task.issue.startsWith(`memolabs-dev/${a.task.project}#`), true);
  }
  assert.ok(answers.some(a => a.project_changed?.to === 'cuesheet'));
  assert.ok((await journal(store)).some(e => e.op === 'workspace_retarget'));
  // The four p0 tasks are all taken.
  for (const ref of ['memolabs-dev/drop#3', 'memolabs-dev/cuesheet#1', 'memolabs-dev/cuesheet#5']) assert.ok(taken.includes(ref), ref);
});

test('MS-R9: one conversation at a time follows the priority order (p0, then p1, then oldest) and never gets a leased task', async t => {
  const { coordinator } = setup(t, { stateDir: await tempStateDir(t) });
  const order = [];
  for (let i = 0; i < 4; i += 1) {
    const id = await open(coordinator, `serial-${i}`);
    order.push((await coordinator.taskNext({ workspace_id: id }, meta(`serial-${i}`))).task.issue);
  }
  assert.deepEqual(order, ['memolabs-dev/cuesheet#5', 'memolabs-dev/cuesheet#1', 'memolabs-dev/drop#3', 'memolabs-dev/cuesheet#2']);
  // project restricts the backlog.
  const id = await open(coordinator, 'drop-only');
  assert.equal((await coordinator.taskNext({ workspace_id: id, project: 'drop' }, meta('drop-only'))).task.issue, 'memolabs-dev/drop#2');
});

test('MS-R10: task_next answers carry a brief (task, project, other conversations, rules); a held task comes back', async t => {
  const { coordinator } = setup(t, { stateDir: await tempStateDir(t) });
  const a = await open(coordinator, 'brief-a', 'cuesheet');
  const b = await open(coordinator, 'brief-b', 'cuesheet');
  const first = await coordinator.taskNext({ workspace_id: a }, meta('brief-a'));
  const second = await coordinator.taskNext({ workspace_id: b }, meta('brief-b'));
  assert.equal(second.brief.task, second.task.issue);
  assert.equal(second.brief.project, 'cuesheet');
  assert.equal(second.brief.you.session_tag, sessionTag(session('brief-b')));
  assert.deepEqual(second.brief.others_on_project.map(o => [o.session_tag, o.task]), [[sessionTag(session('brief-a')), first.task.issue]]);
  assert.match(second.brief.summary, /and only on it/);
  assert.deepEqual(second.brief.rules, [...SESSION_RULES]);
  assert.ok(second.task.scope && second.task.acceptance && second.task.instructions.length >= 4);
  const again = await coordinator.taskNext({ workspace_id: a }, meta('brief-a'));
  assert.equal(again.already_held, true);
  assert.equal(again.task.issue, first.task.issue);
  assert.equal(again.task.claim_id, first.task.claim_id);
  assert.ok(again.brief.rules.length);
});

// ---------------------------------------------------------------------------------------------
// sessions_overview (D-MS1)

test('MS-R1: sessions_overview lists every conversation with tag, project, task, lease and you; no raw hint or hash', async t => {
  const { coordinator, ledger, searches } = setup(t, { stateDir: await tempStateDir(t) });
  const a = await open(coordinator, 'overview-a');
  const b = await open(coordinator, 'overview-b');
  const held = await coordinator.taskNext({ workspace_id: a }, meta('overview-a'));
  const claimsBefore = ledger.claims; const searchesBefore = searches.length;
  const view = await coordinator.sessionsOverview({}, meta('overview-b'));
  assert.equal(view.ok, true);
  assert.equal(view.count, 2);
  assert.equal(view.truncated, false);
  const byId = Object.fromEntries(view.sessions.map(s => [s.workspace_id, s]));
  assert.equal(byId[a].task.issue, held.task.issue);
  assert.equal(byId[a].task.lease, 'held');
  assert.equal(byId[a].project, held.task.project);
  assert.equal(byId[a].session_tag, sessionTag(session('overview-a')));
  assert.equal(byId[a].you, false);
  assert.equal(byId[b].you, true);
  assert.equal(byId[b].task, null);
  assert.equal(byId[b].client_label, 'overview-b');
  assert.deepEqual(view.you, { session_tag: sessionTag(session('overview-b')), workspaces: [b] });
  assert.ok(byId[a].last_activity);
  const text = JSON.stringify(view);
  for (const raw of ['overview-a', 'overview-b'].map(session)) assert.equal(text.includes(raw), false, 'the binding hash never leaves');
  assert.equal(text.includes('openai/session'), false);
  assert.equal(ledger.claims, claimsBefore, 'no ledger call');
  assert.equal(searches.length, searchesBefore, 'no GitHub call');
  // Without a hint, the workspace_id passed marks you.
  assert.deepEqual((await coordinator.sessionsOverview({ workspace_id: a })).you.workspaces, [a]);
  assert.equal((await coordinator.sessionsOverview({ workspace_id: 'nope' })).error, 'invalid_input');
});

test('MS-R1: sessions_overview is bounded (20 newest active workspaces, then truncated) and leaves closed ones out', async t => {
  const { coordinator, advance } = setup(t, { stateDir: await tempStateDir(t) });
  const ids = [];
  for (let i = 0; i < 25; i += 1) { ids.push(await open(coordinator, `bound-${i}`)); advance(1000); }
  await coordinator.workspaceClose({ workspace_id: ids[24] }, meta('bound-24'));
  const view = await coordinator.sessionsOverview({}, meta('bound-0'));
  assert.equal(view.count, OVERVIEW.workspaces);
  assert.equal(view.truncated, true);
  assert.equal(view.sessions[0].workspace_id, ids[23], 'newest first, closed left out');
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < 24 * 1024, 'fits the remote result budget');
});

// ---------------------------------------------------------------------------------------------
// session_binding enforce (D-MS3)

test('MS-R4: remote.json and the runtime policy accept session_binding enforce; anything else is refused', () => {
  assert.equal(parseRemotePolicy({ projects: ['drop'], session_binding: 'enforce' }).session_binding, 'enforce');
  assert.throws(() => parseRemotePolicy({ projects: ['drop'], session_binding: 'strict' }), /invalid_remote_policy/);
  const parsed = parseRemoteJson(labRemoteJson({ session_binding: 'enforce' }));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.config.policy.session_binding, 'enforce');
});

test('MS-R3: the decision: enforce is strict for remote principals only; warn and block unchanged', () => {
  const [s1, s2] = [session('one'), session('two')];
  assert.deepEqual(sessionBindingDecision(s1, s1, 'enforce', { remote: true }), { ok: true });
  assert.deepEqual(sessionBindingDecision(s1, s2, 'enforce', { remote: true }), { ok: false, error: 'workspace_other_session' });
  assert.deepEqual(sessionBindingDecision(null, s2, 'enforce', { remote: true }), { ok: false, error: 'workspace_other_session' });
  assert.deepEqual(sessionBindingDecision(s1, null, 'enforce', { remote: true }), { ok: false, error: 'session_required' });
  assert.deepEqual(sessionBindingDecision(s1, null, 'enforce'), { ok: true }, 'stdio and 9443 never carry a session');
  assert.deepEqual(sessionBindingDecision(s1, s2, 'enforce'), { ok: false, error: 'session_mismatch' });
  assert.deepEqual(sessionBindingDecision(s1, null, 'block', { remote: true }), { ok: true });
  assert.deepEqual(sessionBindingDecision(s1, s2, 'warn', { remote: true }), { ok: true, warning: 'session_mismatch' });
  assert.match(sessionTag(s1), /^s[0-9a-f]{6}$/);
  assert.equal(sessionTag('not-a-hash'), null);
});

test('MS-R3: enforce refuses another conversation\'s workspace (reads too) and a call without hint; journaled', async t => {
  const { coordinator, store } = setup(t, { mode: 'enforce', stateDir: await tempStateDir(t) });
  const a = await open(coordinator, 'enforce-a');
  for (const [method, args] of [['workspaceStatus', {}], ['taskNext', {}], ['taskClaim', { issue: 'memolabs-dev/drop#2' }],
    ['workspaceClose', {}], ['workspaceRecover', {}]]) {
    assert.deepEqual(await coordinator[method]({ workspace_id: a, ...args }, meta('enforce-b')), { ok: false, error: 'workspace_other_session' }, method);
    assert.deepEqual(await coordinator[method]({ workspace_id: a, ...args }), { ok: false, error: 'session_required' }, `${method} without hint`);
  }
  assert.deepEqual(await coordinator.workspaceOpen({ project: 'drop' }), { ok: false, error: 'session_required' });
  const rows = (await journal(store)).map(e => `${e.op}:${e.outcome}:${e.code}`);
  assert.ok(rows.includes('session_check:denied:workspace_other_session'), rows.join(' '));
  assert.ok(rows.includes('task_claim:denied:workspace_other_session'));
  // The owning conversation works.
  assert.equal((await coordinator.taskNext({ workspace_id: a }, meta('enforce-a'))).ok, true);
  assert.equal((await coordinator.workspaceStatus({ workspace_id: a }, meta('enforce-a'))).ok, true);
});

test('MS-R3: under enforce, recover from another conversation rebinds only after 30 min without activity', async t => {
  const { coordinator, advance } = setup(t, { mode: 'enforce', stateDir: await tempStateDir(t) });
  const a = await open(coordinator, 'idle-a');
  advance(REBIND_IDLE_MS - 60_000);
  assert.equal((await coordinator.workspaceRecover({ workspace_id: a }, meta('idle-b'))).error, 'workspace_other_session');
  advance(120_000);
  const taken = await coordinator.workspaceRecover({ workspace_id: a }, meta('idle-b'));
  assert.equal(taken.ok, true, JSON.stringify(taken));
  assert.deepEqual(taken.session, { bound: true, rebound: true });
  assert.equal((await coordinator.workspaceStatus({ workspace_id: a }, meta('idle-a'))).error, 'workspace_other_session');
  assert.equal((await coordinator.workspaceStatus({ workspace_id: a }, meta('idle-b'))).ok, true);
});

test('MS-R3: enforce leaves stdio and warn unchanged', async t => {
  const local = setup(t, { mode: 'enforce', principal: OWNER, stateDir: await tempStateDir(t) });
  const opened = await local.coordinator.workspaceOpen({ project: 'drop' });
  assert.equal(opened.ok, true);
  assert.equal((await local.coordinator.workspaceStatus({ workspace_id: opened.workspace.workspace_id })).ok, true);
  const warn = setup(t, { mode: 'warn', stateDir: await tempStateDir(t) });
  const a = await open(warn.coordinator, 'warn-a');
  assert.equal((await warn.coordinator.workspaceStatus({ workspace_id: a }, meta('warn-b'))).ok, true);
  const next = await warn.coordinator.taskNext({ workspace_id: a }, meta('warn-b'));
  assert.equal(next.ok, true);
  assert.equal(next.session_warning, 'session_mismatch');
});

// ---------------------------------------------------------------------------------------------
// Operator locks (D-MS4 to D-MS6)

const WS_A = 'ws_AAAAAAAAAAAAAAAA';
const WS_B = 'ws_BBBBBBBBBBBBBBBB';
const [SA, SB] = [session('lock-a'), session('lock-b')];
function locksTable({ bound = { [WS_A]: SA, [WS_B]: SB }, clock = { t: Date.parse('2026-10-14T16:00:00Z') } } = {}) {
  const verifyWorkspace = async (principal, id) => (Object.hasOwn(bound, id)
    ? { ok: true, workspace: { workspace_id: id, status: 'active', session_tag: sessionTag(bound[id]), project: 'drop' } }
    : { ok: false, error: 'unknown_workspace' });
  return { clock, locks: createOperatorLocks({ now: () => clock.t, verifyWorkspace }) };
}
const lock = (locks, ws, s, args) => locks.handle('operator_lock', { host: 'vps', workspace_id: ws, ...args }, { principal: CHAT, clientSession: s });
const unlock = (locks, ws, s, args = {}) => locks.handle('operator_unlock', { host: 'vps', workspace_id: ws, ...args }, { principal: CHAT, clientSession: s });
const check = (locks, op, args, { principal = CHAT, s } = {}) => locks.check(op, { host: 'vps', ...args }, { principal, clientSession: s });

test('MS-R6: lock contention: a second conversation is refused with the holder, then allowed after unlock or TTL expiry', async t => {
  const { locks, clock } = locksTable();
  const taken = await lock(locks, WS_A, SA, { kind: 'path', target: '/srv/app', reason: 'deploying the app config' });
  assert.equal(taken.ok, true, JSON.stringify(taken));
  assert.equal(taken.lock.ttl, undefined);
  assert.equal(Date.parse(taken.lock.expires_at) - clock.t, LOCK_TTL.default * 1000);
  // B: a lock inside A's subtree, an edit inside it, both refused with A's tag and reason.
  const refused = await lock(locks, WS_B, SB, { kind: 'path', target: '/srv/app/sub' });
  assert.equal(refused.error, 'locked_by_other_session');
  assert.deepEqual([refused.holder.session_tag, refused.holder.workspace_id, refused.holder.reason, refused.holder.target],
    [sessionTag(SA), WS_A, 'deploying the app config', '/srv/app']);
  await lock(locks, WS_B, SB, { kind: 'global' }).then(r => assert.equal(r.error, 'locked_by_other_session'));
  assert.equal(check(locks, 'operator_edit', { workspace_id: WS_B, path: '/srv/app/x.conf' }, { s: SB }).error, 'locked_by_other_session');
  assert.equal(check(locks, 'operator_delete', { workspace_id: WS_B, path: '/srv', recursive: true }, { s: SB }).error, 'locked_by_other_session',
    'a parent of a locked subtree is refused too');
  // A works under its own lock.
  assert.equal(check(locks, 'operator_edit', { workspace_id: WS_A, path: '/srv/app/x.conf' }, { s: SA }).ok, true);
  // Unlock, then B gets it.
  assert.equal((await unlock(locks, WS_A, SA, { kind: 'path', target: '/srv/app/' })).released.length, 1);
  assert.equal((await lock(locks, WS_B, SB, { kind: 'path', target: '/srv/app/sub', ttl_seconds: 60 })).ok, true);
  // TTL: B's 60 s lock expires, A takes the subtree again.
  assert.equal((await lock(locks, WS_A, SA, { kind: 'path', target: '/srv/app' })).error, 'locked_by_other_session');
  clock.t += 61_000;
  assert.equal((await lock(locks, WS_A, SA, { kind: 'path', target: '/srv/app' })).ok, true);
  // Renewing returns the same lock with a later expiry.
  clock.t += 1000;
  const renewed = await lock(locks, WS_A, SA, { kind: 'path', target: '/srv/app', ttl_seconds: 7200 });
  assert.equal(renewed.renewed, true);
  assert.equal(await lock(locks, WS_A, SA, { kind: 'path', target: '/srv/app', ttl_seconds: 7201 }).then(r => r.error), 'invalid_arguments');
});

test('MS-R6: operator_service on a locked unit and operator_run with a cwd under a lock are refused to another conversation', async t => {
  const { locks } = locksTable();
  assert.equal((await lock(locks, WS_A, SA, { kind: 'unit', target: 'traefik' })).lock.target, 'traefik.service');
  assert.equal((await lock(locks, WS_A, SA, { kind: 'path', target: '/srv/site' })).ok, true);
  await lock(locks, WS_B, SB, { kind: 'unit', target: 'nginx.service' });
  await lock(locks, WS_B, SB, { kind: 'path', target: '/srv/other' });
  assert.equal(check(locks, 'operator_service', { workspace_id: WS_B, unit: 'traefik.service', action: 'restart' }, { s: SB }).error,
    'locked_by_other_session');
  assert.equal(check(locks, 'operator_run', { workspace_id: WS_B, argv: ['make'], cwd: '/srv/site/build' }, { s: SB }).error,
    'locked_by_other_session');
  assert.equal(check(locks, 'operator_service', { workspace_id: WS_B, unit: 'nginx', action: 'reload' }, { s: SB }).ok, true);
  assert.equal(check(locks, 'operator_run', { workspace_id: WS_B, argv: ['make'], cwd: '/srv/other' }, { s: SB }).ok, true);
  assert.equal(check(locks, 'operator_service', { workspace_id: WS_A, unit: 'traefik.service', action: 'restart' }, { s: SA }).ok, true);
});

test('MS-R7: remote writes need workspace_id and a covering lock; 9443 callers only stop at another workspace\'s lock', async t => {
  const { locks } = locksTable();
  const owner = makePrincipal('hub:owner', ALL, { via: 'hub' });
  assert.equal(check(locks, 'operator_edit', { path: '/srv/x' }, { s: SA }).error, 'workspace_required');
  assert.equal(check(locks, 'operator_edit', { workspace_id: WS_A, path: '/srv/x' }, { s: SA }).error, 'lock_required');
  assert.equal(check(locks, 'operator_read', { workspace_id: WS_A, path: '/srv/x' }, { s: SA }).ok, true, 'T0 needs nothing');
  await lock(locks, WS_A, SA, { kind: 'path', target: '/srv/x' });
  assert.equal(check(locks, 'operator_edit', { workspace_id: WS_A, path: '/srv/x/y' }, { s: SA }).ok, true);
  assert.equal(check(locks, 'operator_move', { workspace_id: WS_A, src: '/srv/x/a', dst: '/srv/y' }, { s: SA }).error, 'lock_required',
    'both ends of a move');
  for (const [op, args] of [['operator_run', { argv: ['id'] }], ['operator_run', { argv: ['id'], cwd: '/srv/x', as_root: true }],
    ['operator_script', { interpreter: 'bash', content: 'id' }]]) {
    assert.equal(check(locks, op, { workspace_id: WS_A, ...args }, { s: SA }).error, 'lock_required', `${op} needs global`);
  }
  // 9443: no workspace needed where nobody holds a lock, refused under one.
  assert.equal(check(locks, 'operator_edit', { path: '/etc/x' }, { principal: owner }).ok, true);
  assert.equal(check(locks, 'operator_edit', { path: '/srv/x/z' }, { principal: owner }).error, 'locked_by_other_session');
  // The same workspace from another conversation.
  assert.equal(check(locks, 'operator_edit', { workspace_id: WS_A, path: '/srv/x/y' }, { s: SB }).error, 'workspace_other_session');
  // The runtime says the workspace belongs to another conversation: no lock.
  assert.equal((await lock(locks, WS_A, SB, { kind: 'path', target: '/srv/q' })).error, 'workspace_other_session');
  assert.equal((await lock(locks, 'ws_CCCCCCCCCCCCCCCC', SB, { kind: 'path', target: '/srv/q' })).error, 'unknown_workspace');
});

test('MS-R8: a restart drops the locks; the holder\'s next write answers lock_required, so it takes the lock again', async t => {
  const first = locksTable();
  await lock(first.locks, WS_A, SA, { kind: 'path', target: '/srv/x' });
  assert.equal(check(first.locks, 'operator_edit', { workspace_id: WS_A, path: '/srv/x/f' }, { s: SA }).ok, true);
  const restarted = locksTable();
  assert.equal(check(restarted.locks, 'operator_edit', { workspace_id: WS_A, path: '/srv/x/f' }, { s: SA }).error, 'lock_required');
  await lock(restarted.locks, WS_B, SB, { kind: 'path', target: '/srv/x' });
  assert.equal((await lock(restarted.locks, WS_A, SA, { kind: 'path', target: '/srv/x' })).error, 'locked_by_other_session');
});

test('MS-R1/R2: the overview stays under the remote budget with 20 workspaces and the maximum of locks', async t => {
  const { coordinator } = setup(t, { stateDir: await tempStateDir(t) });
  const ids = [];
  for (let i = 0; i < 21; i += 1) ids.push(await open(coordinator, `budget-${i}-${'l'.repeat(60)}`));
  const runtime = await coordinator.sessionsOverview({}, meta('budget-0'));
  const bound = Object.fromEntries(ids.map((id, i) => [id, session(`budget-${i}`)]));
  const { locks } = locksTable({ bound });
  let taken = 0;
  for (const [i, id] of ids.slice(0, 4).entries()) {
    for (let k = 0; k < 8; k += 1) {
      const out = await lock(locks, id, bound[id], { kind: 'path', target: `/srv/${'d'.repeat(120)}/${i}/${k}`, reason: 'r'.repeat(200) });
      taken += out.ok ? 1 : 0;
    }
  }
  assert.equal(taken, 32);
  assert.equal((await lock(locks, ids[5], bound[ids[5]], { kind: 'unit', target: 'x' })).error, 'lock_limit');
  const merged = mergeOverview(runtime, locks.overview(CHAT, bound[ids[0]]));
  assert.ok(Buffer.byteLength(JSON.stringify(merged)) < 24 * 1024, `${Buffer.byteLength(JSON.stringify(merged))} bytes`);
});

test('lock paths: normalized, ~ on the Mac, case folded on the Mac, refused when malformed', () => {
  assert.deepEqual(normalizePath('vps', '/srv/./a/../b/'), { key: '/srv/b', shown: '/srv/b' });
  assert.equal(normalizePath('mac', '~/Docs/X').key, '/users/memo/docs/x');
  assert.equal(normalizePath('vps', '~/x').unresolved, true);
  assert.equal(normalizePath('vps', '/..'), null);
  assert.equal(normalizePath('vps', 'relative'), null);
});

test('MS-R2: sessions_overview gets the locks per workspace and as a list, with you', async t => {
  const { locks } = locksTable();
  await lock(locks, WS_A, SA, { kind: 'path', target: '/srv/x', reason: 'r' });
  locks.seen(SA);
  const runtime = { ok: true, sessions: [{ workspace_id: WS_A, session_tag: sessionTag(SA) }, { workspace_id: WS_B, session_tag: sessionTag(SB) }] };
  const merged = mergeOverview(runtime, locks.overview(CHAT, SB));
  assert.equal(merged.sessions[0].operator_locks.length, 1);
  assert.equal(merged.sessions[0].operator_locks[0].target, '/srv/x');
  assert.ok(merged.sessions[0].last_call_at);
  assert.deepEqual(merged.sessions[1].operator_locks, []);
  assert.equal(merged.operator_locks[0].you, false);
  assert.equal(merged.operator_locks[0].session_tag, sessionTag(SA));
  assert.equal(merged.operator_locks[0].target, undefined, 'details sit on the workspace shown');
  assert.ok(merged.locks_since);
  assert.equal(locks.overview(CHAT, SA).locks[0].you, true);
  assert.deepEqual(mergeOverview({ ok: false, error: 'x' }, locks.overview(CHAT, SA)), { ok: false, error: 'x' });
});

// ---------------------------------------------------------------------------------------------
// The hub: locks before signing, default host (owner decision 2026-10-14)

function tls(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memo-ms-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return { tlsKey: readFileSync(join(dir, 'k'), 'utf8'), tlsCert: readFileSync(join(dir, 'c'), 'utf8') };
}
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)); }
}
async function hubWith(t, { mac = false } = {}) {
  const { tlsKey, tlsCert } = tls(t);
  const id = generateAgentIdentity();
  const audit = [];
  const verifyWorkspace = async (principal, ws) => ({ ok: true, workspace: { workspace_id: ws, status: 'active', session_tag: null, project: 'drop' } });
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: 'a'.repeat(64), port: 0, audit: ev => audit.push(ev),
    allowedAgentKeys: { mac: generateAgentIdentity().publicKey, vps: generateAgentIdentity().publicKey, 'operator-mac': id.publicKey },
    operator: { signingKeyPem: operatorKeys().privateKeyPem, anchorIntervalMs: 0, verifyWorkspace } });
  const { port } = await hub.start();
  t.after(() => hub.stop());
  if (mac) {
    const agent = createAgent({ host: 'operator-mac', url: `wss://127.0.0.1:${port}/agent`, privateKey: id.privateKey, ca: tlsCert,
      reconnectMs: 100_000, operations: { host_status: async () => ({ host: 'operator-mac', online: true }),
        operator_policy: async () => ({ ok: true, served_by: 'fake-mac' }) } });
    t.after(() => agent.stop());
    await until(() => hub.agentInfo('operator-mac')?.version === 2);
  }
  return { hub, audit };
}

test('hub: a lock refuses another workspace before anything is signed; workspace_id never reaches the agent', async t => {
  const { hub, audit } = await hubWith(t);
  const call = (op, args, s) => hub.requestOperator('vps', op, { args: { host: 'vps', ...args }, principal: CHAT, clientSession: s });
  assert.equal((await call('operator_lock', { workspace_id: WS_A, kind: 'path', target: '/srv/a', reason: 'migration' }, SA)).ok, true);
  const refused = await call('operator_edit', { workspace_id: WS_B, path: '/srv/a/f', mode: 'append', new_text: 'x' }, SB);
  assert.equal(refused.error, 'locked_by_other_session');
  assert.equal(refused.holder.reason, 'migration');
  assert.equal(refused.host, 'vps');
  // Repatriation D-R14: without a workspace the call gets an implicit one and an implicit lock, which the held lock still refuses.
  assert.equal((await call('operator_edit', { path: '/srv/a/f', mode: 'append', new_text: 'x' }, SB)).error, 'locked_by_other_session');
  // The holder passes the gate: the call goes on to the (absent) agent.
  assert.equal((await call('operator_edit', { workspace_id: WS_A, path: '/srv/a/f', mode: 'append', new_text: 'x' }, SA)).error, 'host_offline');
  assert.ok(audit.some(e => e.event === 'operator_refused' && e.reason === 'locked_by_other_session'));
  assert.ok(audit.some(e => e.event === 'operator_lock' && e.outcome === 'ok'));
  assert.equal(hub.operatorLocks.size, 1);
});

test('host default: the Mac when operator-mac is connected, with the host in the result', async t => {
  const { hub } = await hubWith(t, { mac: true });
  const out = await hub.requestOperator(undefined, 'operator_policy', { args: {}, principal: CHAT });
  // Repatriation D-R4: the hub adds the host's standing approvals to operator_policy.
  assert.deepEqual(out, { ok: true, served_by: 'fake-mac', host: 'mac', standing_approvals: [] });
});

test('host default: vps when the Mac is not connected; root, script and dangerous calls need the host', async t => {
  const { hub } = await hubWith(t);
  assert.deepEqual(await hub.requestOperator(undefined, 'operator_policy', { args: {}, principal: CHAT }), { ok: false, error: 'host_offline', host: 'vps' });
  for (const [op, args] of [['operator_run', { argv: ['id'], as_root: true }], ['operator_script', { interpreter: 'bash', content: 'id' }],
    ['operator_run', { argv: ['rm', '-rf', '/srv/x'] }], ['operator_service', { unit: 'ssh.service', action: 'stop' }]]) {
    const out = await hub.requestOperator(undefined, op, { args, principal: CHAT });
    assert.equal(out.error, 'host_required', `${op} ${JSON.stringify(args)}`);
    assert.match(out.detail, /Mac ou VPS \?/);
  }
  // Named explicitly, the same root call passes the gate without any workspace (owner decision
  // 2026-10-23) and reaches the host, offline here.
  assert.equal((await hub.requestOperator('vps', 'operator_run', { args: { host: 'vps', argv: ['id'], as_root: true }, principal: CHAT })).error,
    'host_offline');
});

// ---------------------------------------------------------------------------------------------
// Instructions (D-MS9)

// Owner decision 2026-10-21 (~/memolabs/AGENTS.md rule 9): the agent lands its own PR; Mergify
// keeps the repositories where it merges on its own. No merge tool is added to the server.
test('MS-R12: the instructions tell the agent to land its own PR by the merge rule, never to leave it unmerged', () => {
  for (const text of [MULTI_SESSION_INSTRUCTIONS, REMOTE_INSTRUCTIONS]) {
    assert.ok(text.includes(MERGE_INSTRUCTIONS));
    assert.doesNotMatch(text, /Mergify lands green PRs: never merge/);
  }
  for (const part of ['your own PR', 'gh pr merge <n> --match-head-commit <sha>', 'never --admin', 'required CI green',
    'exact head SHA', 'draft', 'hold-merge', 'no conflict', 'T2/T3', 'independent review', 'memo-bridge, cuesheet', 'let it'])
    assert.ok(MERGE_INSTRUCTIONS.includes(part), part);
  assert.equal(/[\u2013\u2014]/.test(MERGE_INSTRUCTIONS), false, 'no dashes');
  const stdio = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
  assert.match(stdio, /you land your own PR yourself/);
  const skill = readFileSync(new URL('../plugin/skills/memo-bridge-operations/SKILL.md', import.meta.url), 'utf8');
  for (const part of ['--match-head-commit', 'hold-merge', '`--admin`', 'memo-bridge, cuesheet']) assert.ok(skill.includes(part), `skill: ${part}`);
  assert.equal(/landing contract merges when CI is green/.test(skill), false);
});

test('MS-R11: stdio carries the start sequence and the stop codes; the canonical checkout comes first', () => {
  const rules = ['sessions_overview', 'task_next', 'task_claim', 'operator_lock', 'operator_unlock', 'global', ...STOP_CODES];
  for (const rule of rules) assert.ok(MULTI_SESSION_INSTRUCTIONS.includes(rule), rule);
  for (const step of ['batch_create', 'task_claim', 'worktree_create', 'jobs_submit', 'worktree_push', 'github_create_pr', 'task_complete'])
    assert.ok(MULTI_SESSION_INSTRUCTIONS.includes(step), `chain: ${step}`);
  // Owner decision 2026-10-23: the project's own checkout on a branch by default, the chain only on request.
  assert.ok(MULTI_SESSION_INSTRUCTIONS.includes('own checkout'));
  assert.ok(MULTI_SESSION_INSTRUCTIONS.indexOf('own checkout') < MULTI_SESSION_INSTRUCTIONS.indexOf('worktree_create'));
  // Owner, 2026-10-14 21:37: "il doit comprendre mon intention". Intent first, act through to the result, no scope creep.
  for (const phrase of ["understand the owner's intent", 'restate in one line', 'without stopping at a plan', 'never widen the scope'])
    assert.ok(MULTI_SESSION_INSTRUCTIONS.includes(phrase) && REMOTE_INSTRUCTIONS.includes(phrase), phrase);
  assert.ok(REMOTE_INSTRUCTIONS.includes(OPERATOR_HOST_INSTRUCTIONS));
  for (const word of ['Mac ou VPS ?', 'host_required', 'as_root', 'operator_script']) assert.ok(OPERATOR_HOST_INSTRUCTIONS.includes(word), word);
  const stdio = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
  assert.ok(stdio.includes('MULTI_SESSION_INSTRUCTIONS'));
  const skill = readFileSync(new URL('../plugin/skills/memo-bridge-operations/SKILL.md', import.meta.url), 'utf8');
  for (const rule of [...rules, 'Mac ou VPS ?']) assert.ok(skill.includes(rule), `skill: ${rule}`);
  for (const text of [MULTI_SESSION_INSTRUCTIONS, OPERATOR_HOST_INSTRUCTIONS, skill]) assert.equal(/[\u2013\u2014]/.test(text), false, 'no dashes');
});

// Owner, 2026-10-23: "créer aussi un guide pour ChatGPT qu'il utilise Memo Bridge correctement".
// OpenAI: "Keep the most important details in the first 512 characters" of the server instructions
// (developers.openai.com/plugins/build/mcp-server).
test('ChatGPT guide: the first 512 characters say what Memo Bridge is and how to work; no dev flow anywhere', () => {
  const head = REMOTE_INSTRUCTIONS.slice(0, 512);
  for (const word of ['"mac"', '"vps"', 'operator_run', 'operator_read', 'operator_edit', 'projects_list', 'path_relative', 'branch', 'worktree'])
    assert.ok(head.includes(word), `first 512: ${word}`);
  for (const word of ['workspace_open', 'workspace_id', 'task_claim', 'task_next', 'batch_create', 'worktree_create', 'jobs_submit',
    'github_create_pr', 'operator_lock', 'delegation', 'memory_save', 'use_dev_flow'])
    assert.equal(REMOTE_INSTRUCTIONS.includes(word), false, `no ${word}`);
  for (const word of ['locked_by_other_session', 'pending_approval', 'operator_help', 'operator_snapshot', 'operator_grant'])
    assert.ok(REMOTE_INSTRUCTIONS.includes(word), word);
  // 2026-10-23 14:06: ChatGPT called the unserved github_* tools 29 times. GitHub goes through gh.
  for (const word of ['no GitHub tool', 'gh pr list', 'gh pr checks', 'gh run list', 'gh run view'])
    assert.ok(REMOTE_INSTRUCTIONS.includes(word), word);
  assert.ok(OPERATOR_FLOW_INSTRUCTIONS.includes(' gh,') || OPERATOR_FLOW_INSTRUCTIONS.includes(' gh '), 'gh is in the grant list');
  assert.equal(/[\u2013\u2014]/.test(REMOTE_INSTRUCTIONS), false, 'no dashes');
  const guide = readFileSync(new URL('../docs/CHATGPT_GUIDE.md', import.meta.url), 'utf8');
  for (const word of ['operator_run', 'worktree', 'branche', 'Mac ou VPS', 'gh pr list', 'gh run list']) assert.ok(guide.includes(word), `guide: ${word}`);
  assert.equal(/[\u2013\u2014]/.test(guide), false, 'guide: no dashes');
});
