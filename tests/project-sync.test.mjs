// One-way sync from the Coordinator to a GitHub Projects (v2) board. Offline: a fake GraphQL
// runner stands in for `gh api graphql`, a stub ledger and an in-memory GitHub for the rest.
// Covers field id discovery and caching, the mutation sequence of each hook, the default
// (off), failure isolation (the Coordinator operation stays ok and fast) and the journal (a
// short code, never a token).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { registerGithubTools } from '../server/tools/github-tools.mjs';
import { ghGraphql } from '../server/integrations/github.mjs';
import { AGENTS, DEFAULT_AGENT, PROJECT_ENV, STATUS, agentFor, createProjectSync, lotText, parseProjectSpec, priorityOption }
  from '../server/integrations/project-sync.mjs';
import { coordinatorOn, journal, tempDir, tempStateDir } from './helpers/coordinator-fixture.mjs';

const REPO = 'memolabs-dev/drop';
const SPEC = 'memolabs-dev/1';
const ALL = Object.values(CAPABILITIES);
const TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const NOW = Date.parse('2026-10-14T10:00:00Z');

// Option ids deliberately unlike the real board's: the code must read them, never assume them.
const BOARD = {
  id: 'PVT_board', url: 'https://github.com/orgs/memolabs-dev/projects/1',
  fields: [
    { id: 'F_title', name: 'Title', dataType: 'TITLE' },
    { id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: Object.values(STATUS).map((n, i) => ({ id: `s${i}`, name: n })) },
    { id: 'F_prio', name: 'Priorité', dataType: 'SINGLE_SELECT', options: ['P0', 'P1', 'P2', 'P3'].map((n, i) => ({ id: `p${i}`, name: n })) },
    { id: 'F_agent', name: 'Agent', dataType: 'SINGLE_SELECT',
      options: [...Object.values(AGENTS), DEFAULT_AGENT].map((n, i) => ({ id: `a${i}`, name: n })) },
    { id: 'F_lot', name: 'Lot', dataType: 'TEXT' }
  ]
};

// Fake `gh api graphql`: answers by the shape of the query and records each call as a short,
// readable step ("select Status=Prêt"), with field and option ids mapped back to names.
function fakeGraphql({ board = BOARD, owner = 'organization', fail = null } = {}) {
  const calls = []; const steps = []; const items = new Map();
  const fieldName = id => board.fields.find(f => f.id === id)?.name;
  const optionName = (fid, oid) => board.fields.find(f => f.id === fid)?.options?.find(o => o.id === oid)?.name;
  const graphql = async (query, variables) => {
    calls.push({ query, variables });
    let step;
    if (/projectV2\(number/.test(query)) step = `fields ${/^query[^{]*\{\s*(\w+)\(/.exec(query)[1]}`;
    else if (/issueOrPullRequest/.test(query)) step = `content ${variables.owner}/${variables.name}#${variables.number}`;
    else if (/addProjectV2ItemById/.test(query)) step = `add ${variables.content}`;
    else if (/singleSelectOptionId/.test(query)) step = `select ${fieldName(variables.field)}=${optionName(variables.field, variables.option)}`;
    else if (/text: \$text/.test(query)) step = `text ${fieldName(variables.field)}=${variables.text}`;
    else step = 'unknown';
    steps.push(step);
    if (variables.item) items.set(variables.item, [...(items.get(variables.item) ?? []), step]);
    const forced = fail?.(step, calls.length);
    if (forced) return forced;
    if (step.startsWith('fields ')) {
      const kind = step.slice('fields '.length);
      if (kind !== owner) return { ok: false, error: 'github_not_found' };
      return { ok: true, data: { [kind]: { projectV2: { id: board.id, url: board.url,
        fields: { nodes: board.fields.map(f => ({ __typename: f.options ? 'ProjectV2SingleSelectField' : 'ProjectV2Field', ...f })) } } } } };
    }
    if (step.startsWith('content ')) {
      return { ok: true, data: { repository: { issueOrPullRequest: { id: `I_${variables.name}_${variables.number}` } } } };
    }
    if (step.startsWith('add ')) return { ok: true, data: { addProjectV2ItemById: { item: { id: `PVTI_${variables.content}` } } } };
    return { ok: true, data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.item } } } };
  };
  return { graphql, calls, steps, byItem: item => items.get(item) ?? [] };
}

// Ledger stand-in: every call succeeds; status reports whatever `lease` holds.
function okLedger() {
  const ledger = {
    lease: null,
    receipt: (extra = {}) => ({ state: 'claimed', expired: false, worker: null, claim_id: 'c'.repeat(32),
      fence_sha: 'b'.repeat(40), epoch: 1, expires_at: '2099-01-01T00:00:00+00:00', ...extra }),
    status: async () => ({ ok: true, receipt: ledger.lease ?? { state: 'unclaimed', expired: false } }),
    claim: async (issue, worker) => ({ ok: true, receipt: ledger.receipt({ worker, claim_id: randomBytes(16).toString('hex') }) }),
    verify: async () => ({ ok: true, receipt: ledger.receipt() }),
    heartbeat: async () => ({ ok: true, receipt: ledger.receipt() }),
    release: async () => ({ ok: true, receipt: ledger.receipt({ state: 'released' }) })
  };
  return ledger;
}

// GitHub REST stand-in for batches: labels and Issues in memory.
function memoryGitHub() {
  const issues = [];
  return {
    issues,
    async ensureLabel() { return { ok: true, created: true }; },
    async createIssue(repo, { title, labels }) {
      const number = issues.length + 1;
      const issue = { number, title, body: '', state: 'open', state_reason: null, labels: [...labels],
        url: `https://github.com/${repo.full}/issues/${number}` };
      issues.push(issue);
      return { ok: true, issue: { number, title, state: 'open', labels: [...labels], url: issue.url } };
    },
    async labelledIssues(repo, label) {
      return { ok: true, repo: repo.full, issues: issues.filter(i => i.labels.includes(label)).map(i => ({ ...i })) };
    },
    async linkedPulls() { return { ok: true, pulls: new Map() }; }
  };
}

function setup(t, stateDir, { spec = SPEC, principal, gql = fakeGraphql(), limits, env } = {}) {
  const ledger = okLedger();
  const github = memoryGitHub();
  const projectSync = createProjectSync({ spec, graphql: gql.graphql, limits, now: () => NOW, ...(env ? { env } : {}) });
  const fx = coordinatorOn(stateDir, { principal, now: () => NOW, ledger, tasks: { github, projectSync } });
  t.after(() => fx.store.close());
  return { ...fx, ledger, github, gql, projectSync };
}
const task = (title, priority) => ({ title, scope: 'Change one module.', acceptance: '- tests pass', ...(priority ? { priority } : {}) });
const after = (steps, n) => steps.slice(n);
const failures = async store => (await journal(store)).filter(e => e.op === 'project_sync_failed');

test('helpers: project spec, agent mapping, priority and lot', () => {
  assert.deepEqual(parseProjectSpec('memolabs-dev/1'), { owner: 'memolabs-dev', number: 1 });
  for (const bad of ['memolabs-dev', 'memolabs-dev/0', 'memolabs-dev/x', '-bad/1', 'a/1/2', '', null, 7]) {
    assert.equal(parseProjectSpec(bad), null, String(bad));
  }
  assert.equal(agentFor('chatgpt'), 'ChatGPT');
  assert.equal(agentFor('claude-code'), 'Claude Code');
  assert.equal(agentFor('opencode'), 'opencode');
  assert.equal(agentFor('runner'), 'Runner VPS');
  for (const other of ['codex', 'cli', 'other', null, undefined]) assert.equal(agentFor(other), 'Humain');
  assert.equal(priorityOption('p0'), 'P0');
  assert.equal(priorityOption('priority:p2'), 'P2');
  assert.equal(priorityOption('urgent'), null);
  assert.equal(lotText('a1b2c3d4e5'), 'a1b2c3d4e5');
  assert.equal(lotText('a1b2c3d4e5', 'Refonte export'), 'Refonte export (a1b2c3d4e5)');
});

test('disabled by default: no MEMO_BRIDGE_PROJECT, no GraphQL call, no project_url', async t => {
  const gql = fakeGraphql();
  const sync = createProjectSync({ env: {}, graphql: gql.graphql });
  assert.equal(sync.enabled, false);
  assert.equal(sync.url(), null);
  const { coordinator, store, github } = setup(t, await tempStateDir(t), { spec: null, env: {}, gql });
  const made = await coordinator.batchCreate({ project: 'drop', tasks: [task('One')] });
  assert.equal(made.ok, true);
  const ws = (await coordinator.workspaceOpen({ project: 'drop', client_type: 'claude-code' })).workspace.workspace_id;
  const claim = await coordinator.taskClaim({ workspace_id: ws, issue: `${REPO}#1` });
  assert.equal(claim.ok, true);
  assert.equal((await coordinator.taskComplete({ workspace_id: ws, issue: `${REPO}#1`, claim_id: claim.claim_id, fence: claim.fence })).ok, true);
  const status = await coordinator.batchStatus({ project: 'drop', batch: made.batch });
  assert.equal(status.project_url, undefined);
  assert.equal(status.project_sync_error, undefined);
  assert.equal(gql.calls.length, 0);
  assert.equal(github.issues.length, 1);
  assert.deepEqual(await failures(store), []);
  // A runtime built from an environment without the variable is off as well.
  const rt = createRuntime({ stateDir: await tempStateDir(t), env: {}, ledger: okLedger() });
  t.after(() => rt.close());
  assert.equal(rt.projectSync().enabled, false);
  assert.equal(createRuntime({ stateDir: await tempStateDir(t), env: { [PROJECT_ENV]: SPEC }, ledger: okLedger() }).projectSync().enabled, true);
});

test('an invalid MEMO_BRIDGE_PROJECT keeps the sync off and batch_status says so', async t => {
  const gql = fakeGraphql();
  const { coordinator } = setup(t, await tempStateDir(t), { spec: 'not-a-project', gql });
  const made = await coordinator.batchCreate({ project: 'drop', tasks: [task('One')] });
  const status = await coordinator.batchStatus({ project: 'drop', batch: made.batch });
  assert.equal(status.ok, true);
  assert.equal(status.project_sync_error, 'invalid_project_spec');
  assert.equal(status.project_url, undefined);
  assert.equal(gql.calls.length, 0);
});

test('field and option ids are discovered once, cached, and read again after the cache expires', async t => {
  let at = NOW;
  const gql = fakeGraphql();
  const sync = createProjectSync({ spec: SPEC, graphql: gql.graphql, now: () => at, limits: { fieldsCacheMs: 60_000 } });
  // Two hooks at once share a single discovery.
  sync.taskCreated({ issue: `${REPO}#1`, priority: 'p1' });
  sync.taskCreated({ issue: `${REPO}#2`, priority: 'p0' });
  await sync.idle();
  assert.equal(gql.steps.filter(s => s.startsWith('fields')).length, 1);
  // The option ids sent are the ones read from the board.
  const select = gql.calls.filter(c => /singleSelectOptionId/.test(c.query)).map(c => c.variables.option);
  assert.deepEqual(new Set(select), new Set(['s0', 'p1', 'p0']));
  assert.ok(gql.calls.every(c => !c.variables.project || c.variables.project === 'PVT_board'));
  sync.taskClaimed({ issue: `${REPO}#1`, clientType: 'chatgpt' });
  await sync.idle();
  assert.equal(gql.steps.filter(s => s.startsWith('fields')).length, 1, 'still cached');
  at += 61_000;
  sync.taskClaimed({ issue: `${REPO}#2`, clientType: 'chatgpt' });
  await sync.idle();
  assert.equal(gql.steps.filter(s => s.startsWith('fields')).length, 2, 'read again after expiry');
  assert.equal(sync.url(), BOARD.url);
});

test('a user-owned project is found after the organization lookup misses', async t => {
  const gql = fakeGraphql({ owner: 'user' });
  const sync = createProjectSync({ spec: 'guillaume/3', graphql: gql.graphql });
  sync.taskReleased({ issue: `${REPO}#4`, outcome: 'failed' });
  await sync.idle();
  assert.deepEqual(gql.steps, ['fields organization', 'fields user', `content ${REPO}#4`, 'add I_drop_4', 'select Status=Prêt']);
});

test('batch_create adds each Issue, then sets Prêt, its priority and its batch', async t => {
  const { coordinator, gql, projectSync } = setup(t, await tempStateDir(t));
  const made = await coordinator.batchCreate({ project: 'drop', name: 'Refonte export', tasks: [task('One'), task('Two', 'p0')] });
  assert.equal(made.ok, true);
  await projectSync.idle();
  const lot = `Refonte export (${made.batch})`;
  assert.deepEqual(gql.steps[0], 'fields organization');
  // Per Issue, in order: content id, add (its own call), then one update per field.
  for (const n of [1, 2]) {
    assert.ok(gql.steps.indexOf(`content ${REPO}#${n}`) < gql.steps.indexOf(`add I_drop_${n}`));
  }
  assert.deepEqual(gql.byItem('PVTI_I_drop_1'), ['select Status=Prêt', 'select Priorité=P1', `text Lot=${lot}`]);
  assert.deepEqual(gql.byItem('PVTI_I_drop_2'), ['select Status=Prêt', 'select Priorité=P0', `text Lot=${lot}`]);
  assert.ok(gql.steps.indexOf('add I_drop_1') < gql.steps.indexOf('select Status=Prêt'));
  // No call adds and updates at once.
  assert.ok(gql.calls.every(c => !(/addProjectV2ItemById/.test(c.query) && /updateProjectV2ItemFieldValue/.test(c.query))));
  const status = await coordinator.batchStatus({ project: 'drop', batch: made.batch });
  assert.equal(status.project_url, BOARD.url);
});

test('task_claim and task_next set Réservé and the Agent of the workspace client', async t => {
  const { coordinator, gql, projectSync } = setup(t, await tempStateDir(t));
  const made = await coordinator.batchCreate({ project: 'drop', tasks: [task('One'), task('Two')] });
  await projectSync.idle();
  let n = gql.steps.length;
  const chat = (await coordinator.workspaceOpen({ project: 'drop', client_type: 'chatgpt' })).workspace.workspace_id;
  const next = await coordinator.taskNext({ workspace_id: chat, batch: made.batch });
  assert.equal(next.ok, true, JSON.stringify(next));
  await projectSync.idle();
  // Item already known: no new add, only the two updates.
  assert.deepEqual(after(gql.steps, n), ['select Status=Réservé', 'select Agent=ChatGPT']);
  n = gql.steps.length;
  const cli = (await coordinator.workspaceOpen({ project: 'drop', client_type: 'cli' })).workspace.workspace_id;
  assert.equal((await coordinator.taskClaim({ workspace_id: cli, issue: `${REPO}#2` })).ok, true);
  await projectSync.idle();
  assert.deepEqual(after(gql.steps, n), ['select Status=Réservé', 'select Agent=Humain']);
  n = gql.steps.length;
  const cc = (await coordinator.workspaceOpen({ project: 'drop', client_type: 'claude-code' })).workspace.workspace_id;
  assert.equal((await coordinator.taskClaim({ workspace_id: cc, issue: `${REPO}#9` })).ok, true);
  await projectSync.idle();
  // An Issue the board has not seen yet is added first.
  assert.deepEqual(after(gql.steps, n), [`content ${REPO}#9`, 'add I_drop_9', 'select Status=Réservé', 'select Agent=Claude Code']);
});

test('task_complete sets Fait, task_release sets Bloqué or Prêt, workspace_close sets Prêt', async t => {
  const { coordinator, gql, projectSync } = setup(t, await tempStateDir(t));
  const ws = (await coordinator.workspaceOpen({ project: 'drop', client_type: 'opencode' })).workspace.workspace_id;
  const claim = async n => coordinator.taskClaim({ workspace_id: ws, issue: `${REPO}#${n}` });
  const statusAfter = async action => {
    await projectSync.idle();
    const n = gql.steps.length;
    const out = await action();
    assert.equal(out.ok, true, JSON.stringify(out));
    await projectSync.idle();
    return after(gql.steps, n);
  };
  const c1 = await claim(1);
  assert.deepEqual(await statusAfter(() => coordinator.taskComplete({ workspace_id: ws, issue: `${REPO}#1`, claim_id: c1.claim_id,
    fence: c1.fence, summary: 'done' })), ['select Status=Fait']);
  const c2 = await claim(2);
  assert.deepEqual(await statusAfter(() => coordinator.taskRelease({ workspace_id: ws, issue: `${REPO}#2`, claim_id: c2.claim_id,
    fence: c2.fence, outcome: 'blocked' })), ['select Status=Bloqué']);
  const c3 = await claim(3);
  assert.deepEqual(await statusAfter(() => coordinator.taskRelease({ workspace_id: ws, issue: `${REPO}#3`, claim_id: c3.claim_id,
    fence: c3.fence, outcome: 'failed' })), ['select Status=Prêt']);
  await claim(4);
  assert.deepEqual(await statusAfter(() => coordinator.workspaceClose({ workspace_id: ws })), ['select Status=Prêt']);
});

test('batch_status returns the board URL and moves an expired lease back to Prêt once, never for a reader', async t => {
  const { coordinator, gql, projectSync, ledger } = setup(t, await tempStateDir(t));
  const made = await coordinator.batchCreate({ project: 'drop', tasks: [task('One')] });
  const ws = (await coordinator.workspaceOpen({ project: 'drop', client_type: 'chatgpt' })).workspace.workspace_id;
  assert.equal((await coordinator.taskNext({ workspace_id: ws, batch: made.batch })).ok, true);
  await projectSync.idle();
  ledger.lease = ledger.receipt({ worker: 'mb.mac.ws_gone', expired: true, expires_at: '2026-10-14T09:00:00Z' });
  let n = gql.steps.length;
  const status = await coordinator.batchStatus({ project: 'drop', batch: made.batch });
  assert.equal(status.stale_leases.length, 1);
  assert.equal(status.project_url, BOARD.url);
  await projectSync.idle();
  assert.deepEqual(after(gql.steps, n), ['select Status=Prêt']);
  n = gql.steps.length;
  await coordinator.batchStatus({ project: 'drop', batch: made.batch });
  await projectSync.idle();
  assert.deepEqual(after(gql.steps, n), [], 'written once per expired lease');
  // Another expired lease on the same Issue (claimed again elsewhere, expired again): written.
  ledger.lease = ledger.receipt({ worker: 'mb.vps.ws_other', expired: true, expires_at: '2026-10-14T09:30:00Z' });
  n = gql.steps.length;
  await coordinator.batchStatus({ project: 'drop', batch: made.batch });
  await projectSync.idle();
  assert.deepEqual(after(gql.steps, n), ['select Status=Prêt']);

  const reader = setup(t, await tempStateDir(t), { principal: makePrincipal('local:reader', [CAPABILITIES.READ]) });
  const owner = coordinatorOn(await tempStateDir(t), { now: () => NOW, ledger: reader.ledger,
    tasks: { github: reader.github, projectSync: reader.projectSync } });
  t.after(() => owner.store.close());
  const made2 = await owner.coordinator.batchCreate({ project: 'drop', tasks: [task('One')] });
  await reader.projectSync.idle();
  reader.ledger.lease = reader.ledger.receipt({ expired: true });
  n = reader.gql.steps.length;
  const read = await reader.coordinator.batchStatus({ project: 'drop', batch: made2.batch });
  assert.equal(read.ok, true);
  await reader.projectSync.idle();
  assert.deepEqual(after(reader.gql.steps, n), []);
});

test('the review hook sets En revue on the task, then adds the pull request as En revue', async () => {
  const gql = fakeGraphql();
  const sync = createProjectSync({ spec: SPEC, graphql: gql.graphql });
  sync.taskReview({ issue: `${REPO}#7`, repo: REPO, pull: 42 });
  await sync.idle();
  assert.deepEqual(gql.steps, ['fields organization', `content ${REPO}#7`, 'add I_drop_7', 'select Status=En revue',
    `content ${REPO}#42`, 'add I_drop_42', 'select Status=En revue']);
});

test('hooks of one Issue apply in order', async () => {
  const gql = fakeGraphql();
  const sync = createProjectSync({ spec: SPEC, graphql: gql.graphql });
  sync.taskCreated({ issue: `${REPO}#1`, priority: 'p2' });
  sync.taskClaimed({ issue: `${REPO}#1`, clientType: 'chatgpt' });
  sync.taskReleased({ issue: `${REPO}#1`, outcome: 'completed' });
  await sync.idle();
  assert.deepEqual(gql.steps.filter(s => s.startsWith('select Status')), ['select Status=Prêt', 'select Status=Réservé', 'select Status=Fait']);
});

test('failure isolation: the Coordinator operation stays ok, the failure is journaled with a code and no token', async t => {
  const gql = fakeGraphql({ fail: step => (step.startsWith('select') ? { ok: false, error: 'github_scope_missing', detail: TOKEN } : null) });
  const { coordinator, store, projectSync } = setup(t, await tempStateDir(t), { gql });
  const ws = (await coordinator.workspaceOpen({ project: 'drop', client_type: 'chatgpt' })).workspace.workspace_id;
  const claim = await coordinator.taskClaim({ workspace_id: ws, issue: `${REPO}#5` });
  assert.equal(claim.ok, true);
  await projectSync.idle();
  const rows = await failures(store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'error');
  assert.equal(rows[0].code, 'github_scope_missing');
  assert.equal(rows[0].issue_ref, `${REPO}#5`);
  assert.equal(rows[0].workspace_id, ws);
  assert.ok(!JSON.stringify(await journal(store)).includes(TOKEN));
  // The failed update forgets the item and the fields: the next hook reads them again.
  const before = gql.steps.length;
  await coordinator.taskRelease({ workspace_id: ws, issue: `${REPO}#5`, claim_id: claim.claim_id, fence: claim.fence, outcome: 'failed' });
  await projectSync.idle();
  assert.deepEqual(after(gql.steps, before).slice(0, 3), ['fields organization', 'add I_drop_5', 'select Status=Prêt']);
});

test('failure isolation: a thrown runner and a hung runner never fail or hold up the operation', async t => {
  const thrown = fakeGraphql({ fail: () => { throw new Error(`boom ${TOKEN}`); } });
  const a = setup(t, await tempStateDir(t), { gql: thrown });
  const made = await a.coordinator.batchCreate({ project: 'drop', tasks: [task('One')] });
  assert.equal(made.ok, true);
  await a.projectSync.idle();
  const rows = await failures(a.store);
  assert.deepEqual(rows.map(r => r.code), ['github_unavailable']);
  assert.ok(!JSON.stringify(await journal(a.store)).includes(TOKEN));

  let release;
  const hung = { graphql: () => new Promise(resolve => { release = resolve; }), calls: [], steps: [] };
  const b = setup(t, await tempStateDir(t), { gql: hung, limits: { hookMs: 50 } });
  const ws = (await b.coordinator.workspaceOpen({ project: 'drop' })).workspace.workspace_id;
  const started = Date.now();
  const claim = await b.coordinator.taskClaim({ workspace_id: ws, issue: `${REPO}#3` });
  assert.equal(claim.ok, true);
  assert.ok(Date.now() - started < 1000, 'the claim did not wait for the board');
  await b.projectSync.idle();
  assert.deepEqual((await failures(b.store)).map(r => r.code), ['project_sync_timeout']);
  release?.({ ok: true, data: {} });
});

test('a hook that timed out sends no further write, so the next hook of the Issue is not overtaken', async () => {
  const base = fakeGraphql();
  let slow = true;
  const graphql = async (query, variables, opts) => {
    // The first content lookup outlives the hook budget; everything else answers at once.
    if (slow && /issueOrPullRequest/.test(query)) { slow = false; await new Promise(r => setTimeout(r, 80)); }
    return base.graphql(query, variables, opts);
  };
  const codes = [];
  const sync = createProjectSync({ spec: SPEC, graphql, limits: { hookMs: 30 } });
  sync.taskClaimed({ issue: `${REPO}#1`, clientType: 'chatgpt' }, { onFailure: code => codes.push(code) });
  sync.taskReleased({ issue: `${REPO}#1`, outcome: 'completed' });
  await sync.idle();
  await new Promise(r => setTimeout(r, 120));
  assert.deepEqual(codes, ['project_sync_timeout']);
  // Only the second hook wrote: the timed-out claim never set Réservé after Fait.
  assert.deepEqual(base.steps.filter(s => s.startsWith('select')), ['select Status=Fait']);
});

test('a board without the expected field or option fails with a fixed code', async () => {
  const board = { ...BOARD, fields: BOARD.fields.filter(f => f.name !== 'Agent') };
  const codes = [];
  const sync = createProjectSync({ spec: SPEC, graphql: fakeGraphql({ board }).graphql });
  sync.taskClaimed({ issue: `${REPO}#1`, clientType: 'chatgpt' }, { onFailure: code => codes.push(code) });
  const noOption = { ...BOARD, fields: BOARD.fields.map(f => (f.name === 'Status' ? { ...f, options: [] } : f)) };
  const sync2 = createProjectSync({ spec: SPEC, graphql: fakeGraphql({ board: noOption }).graphql });
  sync2.taskReleased({ issue: `${REPO}#1`, outcome: 'completed' }, { onFailure: code => codes.push(code) });
  const missing = createProjectSync({ spec: SPEC, graphql: fakeGraphql({ owner: 'nobody' }).graphql });
  missing.taskReleased({ issue: `${REPO}#1`, outcome: 'completed' }, { onFailure: code => codes.push(code) });
  await Promise.all([sync.idle(), sync2.idle(), missing.idle()]);
  assert.deepEqual(codes.sort(), ['project_field_missing', 'project_not_found', 'project_option_missing']);
});

test('ghGraphql: fixed argv, body on stdin, GraphQL errors and gh failures become short codes without GitHub text', async () => {
  const calls = [];
  const reply = out => async (args, opts) => { calls.push({ args, opts }); return out; };
  const ok = await ghGraphql('query { viewer { login } }', { a: 1 }, { gh: reply({ code: 0, stdout: '{"data":{"viewer":{"login":"g"}}}', stderr: '' }) });
  assert.deepEqual(ok, { ok: true, data: { viewer: { login: 'g' } } });
  assert.deepEqual(calls[0].args, ['api', 'graphql', '--input', '-']);
  assert.deepEqual(JSON.parse(calls[0].opts.input), { query: 'query { viewer { login } }', variables: { a: 1 } });
  const scope = await ghGraphql('q', {}, { gh: reply({ code: 1, stderr: `gh: ${TOKEN}`,
    stdout: JSON.stringify({ errors: [{ type: 'INSUFFICIENT_SCOPES', message: `token ${TOKEN} lacks project` }] }) }) });
  assert.deepEqual(scope, { ok: false, error: 'github_scope_missing' });
  const auth = await ghGraphql('q', {}, { gh: reply({ code: 1, stdout: '', stderr: `gh: Bad credentials ${TOKEN} (HTTP 401)` }) });
  assert.deepEqual(auth, { ok: false, error: 'github_auth_required' });
  const timeout = await ghGraphql('q', {}, { gh: reply({ code: null, stdout: '', stderr: '', timedOut: true }) });
  assert.deepEqual(timeout, { ok: false, error: 'github_unavailable' });
  const unknown = await ghGraphql('q', {}, { gh: reply({ code: 1, stdout: JSON.stringify({ errors: [{ type: 'WEIRD', message: TOKEN }] }), stderr: '' }) });
  assert.deepEqual(unknown, { ok: false, error: 'github_graphql_error' });
});

test('github_create_pr moves the task and its pull request to En revue on the board, after the PR is open', async t => {
  // A clone with a bare origin and a pushed branch, as in tests/github.test.mjs.
  const dir = await tempDir(t, 'memo-project-sync-git-');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' }).trim();
  const origin = join(dir, 'origin.git'); const clone = join(dir, 'clone');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: 'ignore' });
  git(clone, 'checkout', '-q', '-b', 'main');
  await writeFile(join(clone, 'README.md'), 'hello\n');
  git(clone, 'add', 'README.md'); git(clone, 'commit', '-q', '-m', 'init'); git(clone, 'push', '-q', 'origin', 'main');
  git(clone, 'checkout', '-q', '-b', 'feat/drop-7');
  await writeFile(join(clone, 'f.txt'), 'f\n');
  git(clone, 'add', 'f.txt'); git(clone, 'commit', '-q', '-m', 'f'); git(clone, 'push', '-q', 'origin', 'feat/drop-7');

  const gql = fakeGraphql();
  const projectSync = createProjectSync({ spec: SPEC, graphql: gql.graphql });
  const OWNER = makePrincipal('local:owner', ALL);
  const rt = createRuntime({ stateDir: await tempStateDir(t), principal: OWNER, ledger: okLedger(), host: 'mac', now: () => NOW, projectSync });
  t.after(() => rt.close());
  let created = null;
  const gh = async (args, opts = {}) => {
    const method = args[args.indexOf('-X') + 1];
    const endpoint = args.find(a => /^repos\//.test(a)) ?? '';
    const ok = data => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
    if (method === 'GET' && /^repos\/memolabs-dev\/drop$/.test(endpoint)) return ok({ default_branch: 'main' });
    if (method === 'GET' && /pulls\?state=open&head=/.test(endpoint)) return ok(created ? [created] : []);
    if (method === 'POST' && /pulls$/.test(endpoint)) {
      const p = JSON.parse(opts.input);
      created = { number: 42, title: p.title, state: 'open', draft: false, head: { ref: p.head, sha: 'c'.repeat(40) },
        base: { ref: p.base }, html_url: 'https://github.com/memolabs-dev/drop/pull/42' };
      return ok(created);
    }
    return { code: 1, stdout: '{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)' };
  };
  const tools = new Map();
  registerGithubTools({ registerTool: (name, def, handler) => tools.set(name, handler) }, () => rt,
    { gh, registeredRepos: async () => [REPO], projectRepo: async name => (name === 'drop' ? REPO : null) });
  const WS = 'ws_AAAAAAAAAAAAAAAA'; const WT = 'wt_CCCCCCCCCCCCCCCC';
  await rt.store().transaction(repo => {
    repo.insertWorkspace({ id: WS, principal: OWNER.id, client_type: 'other', project_id: 'drop', host: 'mac', status: 'active',
      created_at: NOW, updated_at: NOW });
    repo.insertWorktree({ id: WT, workspace_id: WS, project_id: 'drop', host: 'mac', path: clone, branch: 'feat/drop-7',
      base_ref: 'main', base_commit: 'c'.repeat(40), issue_ref: `${REPO}#7`, created_at: NOW, updated_at: NOW });
    repo.insertClaim({ claim_id: 'a'.repeat(32), workspace_id: WS, issue_ref: `${REPO}#7`, fence_sha: 'b'.repeat(40), epoch: 1,
      expires_at: new Date(NOW + 300_000).toISOString(), updated_at: NOW });
  });
  const res = JSON.parse((await tools.get('github_create_pr')({ workspace_id: WS, worktree_id: WT, title: 'Drop: fix' })).content[0].text);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.number, 42);
  await projectSync.idle();
  assert.deepEqual(gql.steps, ['fields organization', `content ${REPO}#7`, 'add I_drop_7', 'select Status=En revue',
    `content ${REPO}#42`, 'add I_drop_42', 'select Status=En revue']);
  // A refused call does not touch the board.
  const before = gql.steps.length;
  const refused = JSON.parse((await tools.get('github_create_pr')({ workspace_id: WS, worktree_id: 'wt_DDDDDDDDDDDDDDDD', title: 'x' })).content[0].text);
  assert.equal(refused.ok, false);
  await projectSync.idle();
  assert.equal(gql.steps.length, before);
});
