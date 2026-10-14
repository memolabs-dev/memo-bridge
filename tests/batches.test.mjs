// Phase 5, TODO-P5-50 to 52: batches for a conductor conversation. batch_create opens up to 10
// claimable Issues under one agent:batch-<id> label, task_next claims the next free one through
// the ledger (a lost race moves on), batch_status reports each task. Offline: an in-memory
// atomic ledger and an in-memory GitHub stand in for issue_lease.py and the GitHub API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { parseRemotePolicy } from '../bridge/write-gate.mjs';
import { RETRY_SAFE_OPS, clientSessionHash } from '../bridge/forward.mjs';
import { OPS } from '../bridge/ops.mjs';
import { REMOTE_TOOLS_READ, REMOTE_TOOLS_WRITE, collectToolDefinitions, registryProblems, toolsFor } from '../server/registry.mjs';
import { BATCH_ID_RE, parseTaskBody, taskState } from '../server/coordinator/batches.mjs';
import { coordinatorOn, journal, tempStateDir } from './helpers/coordinator-fixture.mjs';

const REPO = 'memolabs-dev/drop';
const ALL = Object.values(CAPABILITIES);
const CHAT = makePrincipal('oidc:owner-sub', ALL, { client_type: 'chatgpt', via: 'hub' });

// The ledger's contract (scripts/issue_lease.py): one live lease per Issue, check and write in
// one step; an expired lease can be claimed again. A random delay interleaves parallel calls.
function memoryLedger(clock) {
  const leases = new Map();
  const tick = () => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 4)));
  const view = l => ({ ...l, expired: l.state === 'claimed' && Date.parse(l.expires_at) <= clock() });
  const unclaimed = { state: 'unclaimed', expired: false, worker: null, claim_id: null, fence_sha: null, epoch: null, expires_at: null };
  const owned = (issue, worker, claimId, fence) => {
    const l = leases.get(issue.ref);
    return l && l.state === 'claimed' && l.worker === worker && l.claim_id === claimId && l.fence_sha === fence &&
      Date.parse(l.expires_at) > clock() ? l : null;
  };
  return {
    leases,
    claims: 0,
    refuseOnce: new Map(),
    async status(issue) { await tick(); const l = leases.get(issue.ref); return { ok: true, receipt: l ? view(l) : unclaimed }; },
    async claim(issue, worker, ttl) {
      await tick();
      this.claims += 1;
      const forced = this.refuseOnce.get(issue.ref);
      if (forced) { this.refuseOnce.delete(issue.ref); return { ok: false, error: forced }; }
      const l = leases.get(issue.ref);
      if (l && l.state === 'claimed' && Date.parse(l.expires_at) > clock()) return { ok: false, error: 'lease_held', detail: 'Active lease exists' };
      const r = { state: 'claimed', worker, claim_id: randomBytes(16).toString('hex'), fence_sha: randomBytes(20).toString('hex'),
        epoch: (l?.epoch ?? 0) + 1, expires_at: new Date(clock() + ttl * 1000).toISOString() };
      leases.set(issue.ref, r);
      return { ok: true, receipt: view(r) };
    },
    async verify(issue, worker, claimId, fence) {
      await tick(); const l = owned(issue, worker, claimId, fence);
      return l ? { ok: true, receipt: view(l) } : { ok: false, error: 'stale_lease' };
    },
    async heartbeat(issue, worker, claimId, fence, ttl) {
      await tick(); const l = owned(issue, worker, claimId, fence);
      if (!l) return { ok: false, error: 'stale_lease' };
      Object.assign(l, { fence_sha: randomBytes(20).toString('hex'), expires_at: new Date(clock() + ttl * 1000).toISOString() });
      return { ok: true, receipt: view(l) };
    },
    async release(issue, worker, claimId, fence) {
      await tick(); const l = owned(issue, worker, claimId, fence);
      if (!l) return { ok: false, error: 'stale_lease' };
      Object.assign(l, { state: 'released', fence_sha: randomBytes(20).toString('hex') });
      return { ok: true, receipt: view(l) };
    }
  };
}

// GitHub for one repository: labels, Issues and pull requests in memory.
function memoryGitHub() {
  const gh = {
    issues: [], labels: new Set(['agent:ready', 'priority:p0', 'priority:p1', 'priority:p2']), pulls: [], failAt: null, dropLabels: false,
    async ensureLabel(repo, { name }) { const created = !gh.labels.has(name); gh.labels.add(name); return { ok: true, created }; },
    async createIssue(repo, { title, body, labels }) {
      if (gh.failAt === gh.issues.length) return { ok: false, error: 'github_forbidden' };
      const number = gh.issues.length + 1;
      const issue = { number, title, body, state: 'open', state_reason: null,
        labels: gh.dropLabels ? [] : [...labels], url: `https://github.com/${repo.full}/issues/${number}` };
      gh.issues.push(issue);
      return { ok: true, issue: { number, title, state: 'open', labels: issue.labels, url: issue.url } };
    },
    async labelledIssues(repo, label) {
      return { ok: true, repo: repo.full, issues: gh.issues.filter(i => i.labels.includes(label)).map(i => ({ ...i, labels: [...i.labels] })) };
    },
    async linkedPulls(repo, { numbers }) {
      const pulls = new Map();
      for (const p of gh.pulls) if (numbers.includes(p.closes)) pulls.set(p.closes, [{ number: p.number, state: p.state, url: p.url }]);
      return { ok: true, pulls };
    }
  };
  return gh;
}

function setup(t, stateDir, { principal, remotePolicy } = {}) {
  let at = Date.parse('2026-10-14T10:00:00Z');
  const clock = () => at;
  const ledger = memoryLedger(clock);
  const github = memoryGitHub();
  const fx = coordinatorOn(stateDir, { principal, now: clock, ledger, tasks: { github, ...(remotePolicy ? { remotePolicy } : {}) } });
  t.after(() => fx.store.close());
  return { ...fx, ledger, github, advance: ms => { at += ms; } };
}
const tasks = n => Array.from({ length: n }, (_, i) => ({ title: `Task ${i + 1}`, scope: `Change module ${i + 1} only.`,
  acceptance: `- test ${i + 1} passes`, ...(i === n - 1 && n > 2 ? { priority: 'p0' } : {}) }));
const openWorkspace = async (coordinator, meta = null) => (await coordinator.workspaceOpen({ project: 'drop' }, meta)).workspace.workspace_id;

test('TODO-P5-50 batch_create opens claimable Issues under one batch label and returns the paste sentence', async t => {
  const { coordinator, github } = setup(t, await tempStateDir(t));
  const made = await coordinator.batchCreate({ project: 'drop', name: 'Refonte export', tasks: tasks(3) });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.match(made.batch, BATCH_ID_RE);
  assert.equal(made.label, `agent:batch-${made.batch}`);
  assert.equal(made.repo, REPO);
  assert.equal(made.count, 3);
  assert.equal(made.paste, `@Memo Bridge prends la prochaine tâche du lot ${made.batch} du projet drop`);
  assert.ok(github.labels.has(made.label));
  for (const issue of github.issues) {
    assert.ok(issue.labels.includes('agent:ready') && issue.labels.includes(made.label));
    assert.equal(issue.labels.filter(l => l.startsWith('priority:')).length, 1);
  }
  assert.deepEqual(github.issues.map(i => i.labels.find(l => l.startsWith('priority:'))), ['priority:p1', 'priority:p1', 'priority:p0']);
  assert.deepEqual(parseTaskBody(github.issues[0].body), { scope: 'Change module 1 only.', acceptance: '- test 1 passes' });
  assert.equal(made.partial, undefined);
});

test('batch_create refuses bad input before any GitHub write, and reports a partial batch', async t => {
  const { coordinator, github } = setup(t, await tempStateDir(t));
  const refused = async (args, detail) => assert.deepEqual(await coordinator.batchCreate({ project: 'drop', ...args }),
    { ok: false, error: 'invalid_input', detail });
  await refused({ tasks: tasks(11) }, 'tasks');
  await refused({ tasks: [] }, 'tasks');
  await refused({ tasks: [{ title: 'x', scope: 'y' }] }, 'tasks[0].acceptance');
  await refused({ tasks: [{ title: 'a\nb', scope: 'y', acceptance: 'z' }] }, 'tasks[0].title');
  await refused({ tasks: [{ title: 'x', scope: 'y', acceptance: 'z', priority: 'p9' }] }, 'tasks[0].priority');
  await refused({ tasks: [{ title: 'x', scope: 'y', acceptance: 'z\n\nCo-authored-by: Claude <noreply@anthropic.com>' }] },
    'tasks[0]: AI attribution');
  assert.equal(github.issues.length, 0);
  assert.equal((await coordinator.batchCreate({ project: 'unknown-origin', tasks: tasks(1) })).error, 'project_origin_unknown');

  github.failAt = 2;
  const partial = await coordinator.batchCreate({ project: 'drop', tasks: tasks(4) });
  assert.equal(partial.ok, true);
  assert.equal(partial.partial, true);
  assert.equal(partial.count, 2);
  assert.deepEqual(partial.failed, { index: 2, error: 'github_forbidden' });
  assert.equal(partial.not_created, 2);

  github.failAt = null; github.dropLabels = true;
  const dropped = await coordinator.batchCreate({ project: 'drop', tasks: tasks(2) });
  assert.equal(dropped.failed.error, 'labels_dropped');
  assert.equal(dropped.count, 1);
});

test('batch_create replays its first result for the same client_request_id: no duplicate Issues', async t => {
  const { coordinator, github } = setup(t, await tempStateDir(t));
  const first = await coordinator.batchCreate({ project: 'drop', tasks: tasks(2), client_request_id: 'conductor-0001' });
  const again = await coordinator.batchCreate({ project: 'drop', tasks: tasks(2), client_request_id: 'conductor-0001' });
  assert.equal(again.replayed, true);
  assert.equal(again.batch, first.batch);
  assert.equal(github.issues.length, 2);
});

test('TODO-P5-51 ten parallel task_next calls on a ten-task batch each claim a distinct task; the next one is done', async t => {
  const { coordinator, ledger, store } = setup(t, await tempStateDir(t));
  const made = await coordinator.batchCreate({ project: 'drop', tasks: tasks(10) });
  const workspaces = [];
  for (let i = 0; i < 10; i += 1) workspaces.push(await openWorkspace(coordinator));
  const results = await Promise.all(workspaces.map(id => coordinator.taskNext({ workspace_id: id, batch: made.batch })));
  assert.ok(results.every(r => r.ok && r.done === false), JSON.stringify(results.filter(r => !r.ok || r.done)));
  const issues = results.map(r => r.task.issue);
  assert.equal(new Set(issues).size, 10, 'each conversation got its own task');
  // The ledger agrees: ten live leases, ten different workers.
  assert.equal(new Set([...ledger.leases.values()].map(l => l.worker)).size, 10);
  // p0 first: the last task of the batch was the p0 one.
  assert.ok(issues.includes(`${REPO}#10`));
  const task = results[0].task;
  assert.match(task.claim_id, /^[0-9a-f]{32}$/);
  assert.ok(task.scope && task.acceptance && task.instructions.length >= 4);
  assert.equal(results[0].task.workspace_id, workspaces[0]);

  const late = await coordinator.taskNext({ workspace_id: await openWorkspace(coordinator), batch: made.batch });
  assert.equal(late.ok, true);
  assert.equal(late.done, true);
  assert.equal(late.held_elsewhere, 10);
  // Journal: one ok task_next per claim, naming the Issue it claimed.
  const rows = (await journal(store)).filter(e => e.op === 'task_next' && e.outcome === 'ok');
  assert.equal(rows.length, 11);
  assert.equal(rows.filter(e => e.issue_ref).length, 10);
});

test('task_next moves on when another machine holds a task or wins the ref race, and stops on a ledger failure', async t => {
  const { coordinator, ledger } = setup(t, await tempStateDir(t));
  const made = await coordinator.batchCreate({ project: 'drop', tasks: [{ title: 'a', scope: 's', acceptance: 'x' },
    { title: 'b', scope: 's', acceptance: 'x' }, { title: 'c', scope: 's', acceptance: 'x' }] });
  // #1 is held by a worker this store has never seen (another machine); #2 loses a ref race.
  ledger.leases.set(`${REPO}#1`, { state: 'claimed', worker: 'mb.mac.ws_elsewhere000000001', claim_id: 'a'.repeat(32),
    fence_sha: 'a'.repeat(40), epoch: 1, expires_at: '2099-01-01T00:00:00Z' });
  ledger.refuseOnce.set(`${REPO}#2`, 'lease_race_lost');
  const ws = await openWorkspace(coordinator);
  const next = await coordinator.taskNext({ workspace_id: ws, batch: made.batch });
  assert.equal(next.ok, true);
  assert.equal(next.task.issue, `${REPO}#3`);
  assert.deepEqual(next.skipped, [{ issue: `${REPO}#1`, error: 'lease_held' }, { issue: `${REPO}#2`, error: 'lease_race_lost' }]);

  // Asked again (a retry, a lost answer): the same task comes back, nothing new is claimed.
  const claims = ledger.claims;
  const again = await coordinator.taskNext({ workspace_id: ws, batch: made.batch });
  assert.equal(again.already_held, true);
  assert.equal(again.task.issue, `${REPO}#3`);
  assert.equal(again.task.claim_id, next.task.claim_id);
  assert.equal(ledger.claims, claims);

  ledger.refuseOnce.set(`${REPO}#2`, 'ledger_unavailable');
  const failed = await coordinator.taskNext({ workspace_id: await openWorkspace(coordinator), batch: made.batch });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'ledger_unavailable');

  assert.equal((await coordinator.taskNext({ workspace_id: ws, batch: 'ffffffffff' })).error, 'unknown_batch');
  assert.equal((await coordinator.taskNext({ workspace_id: ws, batch: 'nope' })).detail, 'batch');
});

test('lease expiry: an abandoned task shows as a stale lease, then another conversation takes it over', async t => {
  const { coordinator, advance } = setup(t, await tempStateDir(t));
  const made = await coordinator.batchCreate({ project: 'drop', tasks: tasks(1) });
  const first = await coordinator.taskNext({ workspace_id: await openWorkspace(coordinator), batch: made.batch, ttl_seconds: 60 });
  assert.equal(first.task.issue, `${REPO}#1`);
  const second = await openWorkspace(coordinator);
  assert.equal((await coordinator.taskNext({ workspace_id: second, batch: made.batch })).done, true);

  advance(120_000);
  const status = await coordinator.batchStatus({ project: 'drop', batch: made.batch });
  assert.equal(status.tasks[0].state, 'stale');
  assert.deepEqual(status.stale_leases.map(s => s.issue), [`${REPO}#1`]);
  assert.deepEqual(status.counts, { stale: 1 });

  const taken = await coordinator.taskNext({ workspace_id: second, batch: made.batch });
  assert.equal(taken.ok, true);
  assert.equal(taken.task.issue, `${REPO}#1`);
  assert.notEqual(taken.task.claim_id, first.task.claim_id);
});

test('TODO-P5-52 batch_status: per-task state, holder, pull requests, counts', async t => {
  const { coordinator, github } = setup(t, await tempStateDir(t));
  const made = await coordinator.batchCreate({ project: 'drop', name: 'Lot', tasks: tasks(4) });
  const a = await coordinator.taskNext({ workspace_id: await openWorkspace(coordinator), batch: made.batch });
  const b = await coordinator.taskNext({ workspace_id: await openWorkspace(coordinator), batch: made.batch });
  const done = await coordinator.taskComplete({ workspace_id: b.task.workspace_id, issue: b.task.issue, claim_id: b.task.claim_id,
    fence: b.task.fence, summary: 'ok' });
  assert.equal(done.ok, true);
  github.pulls.push({ number: 40, closes: Number(b.task.issue.split('#')[1]), state: 'open', url: 'https://github.com/memolabs-dev/drop/pull/40' });
  github.issues[1].labels.push('status:blocked');
  const blockedRef = `${REPO}#2`;

  const status = await coordinator.batchStatus({ project: 'drop', batch: made.batch });
  assert.equal(status.ok, true);
  assert.equal(status.total, 4);
  const byIssue = Object.fromEntries(status.tasks.map(t => [t.issue, t]));
  assert.equal(byIssue[a.task.issue].state, 'claimed');
  assert.equal(byIssue[a.task.issue].holder.workspace_id, a.task.workspace_id);
  assert.equal(byIssue[a.task.issue].holder.client_type, 'other');
  assert.equal(byIssue[a.task.issue].holder.mine, true);
  assert.equal(byIssue[b.task.issue].state, 'done');
  assert.equal(byIssue[b.task.issue].last_outcome, 'completed');
  assert.deepEqual(byIssue[b.task.issue].pull_requests.map(p => p.number), [40]);
  if (![a.task.issue, b.task.issue].includes(blockedRef)) assert.equal(byIssue[blockedRef].state, 'blocked');
  const sum = Object.values(status.counts).reduce((x, y) => x + y, 0);
  assert.equal(sum, 4);
  for (const t of status.tasks) {
    assert.deepEqual(Object.keys(t).filter(k => ['issue', 'number', 'title', 'url', 'state', 'priority', 'pull_requests'].includes(k)).sort(),
      ['issue', 'number', 'priority', 'pull_requests', 'state', 'title', 'url']);
  }
  assert.deepEqual(status.stale_leases, []);
  assert.equal((await coordinator.batchStatus({ project: 'drop', batch: 'ffffffffff' })).error, 'unknown_batch');
});

test('taskState covers every state from the Issue, the lease and the local mirror', () => {
  const rules = { ready: 'agent:ready', priorities: ['priority:p0', 'priority:p1', 'priority:p2'],
    blocking: ['status:blocked', 'needs:human', 'type:epic', 'agent:working'], now: 0 };
  const ready = { state: 'open', labels: ['agent:ready', 'priority:p1'] };
  assert.equal(taskState({ state: 'closed', state_reason: 'completed' }, null, null, rules), 'done');
  assert.equal(taskState({ state: 'closed', state_reason: 'not_planned' }, null, null, rules), 'closed');
  assert.equal(taskState(ready, { state: 'claimed', expired: false }, null, rules), 'claimed');
  assert.equal(taskState(ready, { state: 'claimed', expired: true }, null, rules), 'stale');
  assert.equal(taskState(ready, { state: 'released' }, { outcome: 'completed' }, rules), 'done');
  assert.equal(taskState(ready, { state: 'released' }, { outcome: 'blocked' }, rules), 'blocked');
  assert.equal(taskState(ready, { state: 'unclaimed' }, null, rules), 'ready');
  assert.equal(taskState({ state: 'open', labels: ['agent:ready'] }, { state: 'unclaimed' }, null, rules), 'not_ready');
  assert.equal(taskState(ready, null, null, rules), 'unknown');
});

test('remote: classification, allowlists, annotations, project allowlist and session binding apply to batch tools', async t => {
  assert.ok(REMOTE_TOOLS_READ.includes('batch_status'));
  assert.ok(REMOTE_TOOLS_WRITE.includes('batch_create') && REMOTE_TOOLS_WRITE.includes('task_next'));
  const defs = await collectToolDefinitions();
  assert.deepEqual(registryProblems(defs), []);
  assert.equal(defs.get('batch_status').annotations.readOnlyHint, true);
  assert.equal(defs.get('batch_create').annotations.readOnlyHint, false);
  assert.equal(defs.get('task_next').annotations.readOnlyHint, false);
  assert.equal(OPS.batch_create.mutating, true);
  assert.equal(OPS.task_next.mutating, true);
  assert.equal(OPS.batch_status.mutating, false);
  assert.ok(RETRY_SAFE_OPS.has('task_next') && RETRY_SAFE_OPS.has('batch_create'));
  // Gate layer 1: writes closed, only batch_status is listed.
  const listed = toolsFor(CHAT, { remoteWrites: false });
  assert.ok(listed.includes('batch_status') && !listed.includes('batch_create') && !listed.includes('task_next'));
  assert.ok(toolsFor(CHAT, { remoteWrites: true }).includes('task_next'));

  // A read-only remote principal is refused (and journaled) by the runtime too.
  const reader = makePrincipal('oidc:owner-sub', [CAPABILITIES.READ], { client_type: 'chatgpt', via: 'hub' });
  const ro = setup(t, await tempStateDir(t), { principal: reader, remotePolicy: parseRemotePolicy({ projects: ['drop'] }) });
  assert.deepEqual(await ro.coordinator.batchCreate({ project: 'drop', tasks: tasks(1) }), { ok: false, error: 'forbidden' });
  assert.equal(ro.github.issues.length, 0);
  assert.ok((await journal(ro.store)).some(e => e.op === 'batch_create' && e.outcome === 'denied'));

  // Project allowlist (D9): cuesheet is registered but not allowlisted for the remote surface.
  const remote = setup(t, await tempStateDir(t), { principal: CHAT,
    remotePolicy: parseRemotePolicy({ projects: ['drop'], session_binding: 'block' }) });
  assert.equal((await remote.coordinator.batchCreate({ project: 'cuesheet', tasks: tasks(1) })).error, 'project_not_allowed');
  assert.equal((await remote.coordinator.batchStatus({ project: 'cuesheet', batch: 'ffffffffff' })).error, 'project_not_allowed');
  assert.equal(remote.github.issues.length, 0);

  // Session binding (D8): task_next from another conversation on a bound workspace is refused.
  const S1 = clientSessionHash({ mcpReq: { _meta: { 'openai/session': 'one' } } });
  const S2 = clientSessionHash({ mcpReq: { _meta: { 'openai/session': 'two' } } });
  const made = await remote.coordinator.batchCreate({ project: 'drop', tasks: tasks(2) });
  const ws = await openWorkspace(remote.coordinator, { client_session: S1 });
  assert.equal(remote.ledger.claims, 0);
  const crossed = await remote.coordinator.taskNext({ workspace_id: ws, batch: made.batch }, { client_session: S2 });
  assert.deepEqual(crossed, { ok: false, error: 'session_mismatch' });
  assert.equal(remote.ledger.claims, 0, 'nothing claimed for the wrong conversation');
  const own = await remote.coordinator.taskNext({ workspace_id: ws, batch: made.batch }, { client_session: S1 });
  assert.equal(own.ok, true);
});
