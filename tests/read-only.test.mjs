// Read-only local principal and the reader contract (#252, docs/READER_CONTRACT.md).
//
// A store is filled by the owner's runtime (two conversations on two projects, held and released
// leases, a checkpoint, a finished job, a running job whose process is gone, job and audit
// events). A read-only runtime then serves every tool through the read-only gate:
//  - every write tool answers read_only, and the refused set is exactly the tools whose policy
//    capability is a write capability;
//  - a full pass over every tool (reads and refused writes) leaves every table's row count and
//    content unchanged, while the owner's own jobs_list would have reconciled the dead job;
//  - reader_activity over one project returns its jobs, leases and sessions with ISO timestamps,
//    and audit events page with next_after_seq.
// The stdio entry point is checked as well, started with --read-only on the same store.
// Everything runs on private temporary directories with a stub ledger and a registry without checkouts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createRuntime } from '../server/runtime.mjs';
import { TOOL_MODULES } from '../server/registry.mjs';
import { withImplicitWorkspace } from '../server/tools/implicit-workspace.mjs';
import { READ_ONLY_ERROR, readOnlyAllows, withReadOnly } from '../server/tools/read-only.mjs';
import { READER_CONTRACT, READER_TOOLS, registerReaderTools } from '../server/tools/reader-tools.mjs';
import { CAPABILITIES, OPERATION_CAPABILITY, READER_CAPABILITIES, READER_OPERATION_CAPABILITY, WRITE_CAPABILITIES,
  holdsWriteCapability, localOwnerPrincipal, makePrincipal, readOnlyRequested, readerPrincipal } from '../server/coordinator/policy.mjs';
import { SCHEMA_VERSION, openSqliteStore } from '../server/coordinator/store.mjs';
import { logPathFor } from '../server/runners/jobs.mjs';
import { stubLedger, stubProjects, stubRemote, tempDir } from './helpers/coordinator-fixture.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OWNER = makePrincipal('local:owner', Object.values(CAPABILITIES));
const OTHER = makePrincipal('hub:owner', Object.values(CAPABILITIES), { via: 'hub' });
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const wsId = () => `ws_${randomBytes(12).toString('base64url')}`;
const jobId = () => `job_${randomBytes(12).toString('base64url')}`;

// The owner's store: drop (local:owner, active, one held claim, a checkpoint, two jobs) and
// cuesheet (hub:owner, closed, one released claim, one job), plus job and audit events.
async function populate(t) {
  const base = await tempDir(t, 'memo-reader-');
  const stateDir = join(base, 'state');
  const projectsRoot = join(base, 'projects');
  await mkdir(projectsRoot);
  // A registry whose projects have no checkout here: catalog reads work, nothing reaches GitHub.
  await writeFile(join(projectsRoot, 'PROJECTS.md'), ['# Test registry', '## Projets appartenant à Memo Labs',
    '| Name | Path | Kind | Status | Nature | Stack | Vault note |', '|---|---|---|---|---|---|---|',
    '| drop | drop | repo | active | product | Node.js | - |', '| cuesheet | cuesheet | repo | active | product | Node.js | - |',
    '## Dépôts de référence', ''].join('\n'));
  const rt = createRuntime({ stateDir, principal: OWNER, ledger: stubLedger(), host: 'mac', env: {}, resolveProject: stubProjects(),
    projectRemote: stubRemote, catalogOptions: { projectsRoot } });
  const t0 = Date.parse('2026-10-21T10:00:00.000Z');
  // A pid that no longer runs: the owner's jobs_list would reconcile this job to interrupted.
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = await new Promise(resolve => dead.once('exit', () => resolve(dead.pid)));
  const ids = { drop: wsId(), cuesheet: wsId(), held: randomBytes(16).toString('hex'), released: randomBytes(16).toString('hex'),
    wtDrop: `wt_${randomBytes(12).toString('base64url')}`, wtCue: `wt_${randomBytes(12).toString('base64url')}`,
    done: jobId(), running: jobId(), cue: jobId() };
  await rt.store().transaction(repo => {
    repo.insertWorkspace({ id: ids.drop, principal: OWNER.id, client_type: 'claude-code', client_label: 'drop fix', project_id: 'drop',
      host: 'mac', branch: 'agent/drop-7', status: 'active', created_at: t0, updated_at: t0 + 1000 });
    repo.insertWorkspace({ id: ids.cuesheet, principal: OTHER.id, client_type: 'chatgpt', project_id: 'cuesheet', host: 'mac',
      status: 'active', created_at: t0, updated_at: t0 });
    repo.updateWorkspace(ids.cuesheet, { status: 'closed', closed_at: t0 + 5000, updated_at: t0 + 5000 });
    repo.insertClaim({ claim_id: ids.held, workspace_id: ids.drop, issue_ref: 'memolabs-dev/drop#7', fence_sha: 'f'.repeat(40), epoch: 1,
      expires_at: '2099-01-01T00:00:00+00:00', updated_at: t0 + 2000 });
    repo.insertClaim({ claim_id: ids.released, workspace_id: ids.cuesheet, issue_ref: 'memolabs-dev/cuesheet#3', fence_sha: 'e'.repeat(40),
      epoch: 2, expires_at: '2026-10-21T12:00:00+02:00', updated_at: t0 + 3000 });
    repo.updateClaim(ids.released, { state: 'released', outcome: 'completed: PR #9', updated_at: t0 + 4000 }, 'e'.repeat(40));
    repo.insertCheckpoint({ issue_ref: 'memolabs-dev/drop#7', claim_id: ids.held, workspace_id: ids.drop, fence_sha: 'f'.repeat(40),
      branch: 'agent/drop-7', commit_sha: 'c'.repeat(40), durability: 'remote', at: t0 + 2500 });
    repo.insertWorktree({ id: ids.wtDrop, workspace_id: ids.drop, project_id: 'drop', host: 'mac', path: join(base, 'wt-drop'),
      branch: 'agent/drop-7', base_ref: 'main', base_commit: 'a'.repeat(40), issue_ref: 'memolabs-dev/drop#7', created_at: t0, updated_at: t0 });
    repo.insertWorktree({ id: ids.wtCue, workspace_id: ids.cuesheet, project_id: 'cuesheet', host: 'mac', path: join(base, 'wt-cue'),
      branch: 'agent/cuesheet-3', base_ref: 'main', base_commit: 'a'.repeat(40), issue_ref: 'memolabs-dev/cuesheet#3', created_at: t0, updated_at: t0 });
    const insert = (id, ws, wt, project, created) => repo.insertJob({ id, workspace_id: ws, worktree_id: wt, project_id: project, host: 'mac',
      recipe: 'test', argv_json: '["npm","test"]', timeout_ms: 60000, log_path: logPathFor(stateDir, id), created_at: created,
      claim_id: project === 'drop' ? ids.held : ids.released, principal: project === 'drop' ? OWNER.id : OTHER.id });
    insert(ids.done, ids.drop, ids.wtDrop, 'drop', t0 + 10_000);
    repo.updateJob(ids.done, { status: 'succeeded', exit_code: 0, started_at: t0 + 11_000, ended_at: t0 + 20_000, summary: 'ok' }, 'queued');
    insert(ids.running, ids.drop, ids.wtDrop, 'drop', t0 + 30_000);
    repo.updateJob(ids.running, { status: 'running', pid: deadPid, started_at: t0 + 31_000 }, 'queued');
    insert(ids.cue, ids.cuesheet, ids.wtCue, 'cuesheet', t0 + 1000);
    repo.updateJob(ids.cue, { status: 'failed', exit_code: 1, started_at: t0 + 1500, ended_at: t0 + 2000 }, 'queued');
    for (let i = 0; i < 3; i++) repo.appendJobEvent({ job_id: ids.done, at: t0 + 11_000 + i, kind: `step${i}`, detail: JSON.stringify({ i }) });
    repo.appendEvent({ at: t0, principal: OWNER.id, workspace_id: ids.drop, issue_ref: 'memolabs-dev/drop#7', op: 'task_claim', outcome: 'ok' });
    repo.appendEvent({ at: t0 + 1, principal: OTHER.id, workspace_id: ids.cuesheet, issue_ref: 'memolabs-dev/cuesheet#3', op: 'task_complete', outcome: 'ok' });
    repo.appendEvent({ at: t0 + 2, principal: OWNER.id, workspace_id: ids.drop, op: 'workspace_open', outcome: 'ok' });
    repo.appendEvent({ at: t0 + 3, principal: OWNER.id, op: 'projects_list', outcome: 'denied', code: 'forbidden' });
  });
  await rt.close();
  return { base, stateDir, projectsRoot, ids, t0 };
}

// Every table's row count, and a hash of every row, read through a separate read-only connection.
function snapshot(stateDir) {
  const db = new DatabaseSync(join(stateDir, 'coordinator.sqlite'), { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
    const counts = {}; const hash = createHash('sha256');
    for (const name of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
      counts[name] = rows.length;
      hash.update(name).update(JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
    }
    return { counts, hash: hash.digest('hex') };
  } finally { db.close(); }
}

function readerRuntime(t, env, options = {}) {
  const rt = createRuntime({ readOnly: true, stateDir: env.stateDir, ledger: stubLedger(), host: 'mac', env: {}, resolveProject: stubProjects(),
    projectRemote: stubRemote, catalogOptions: { projectsRoot: env.projectsRoot }, ...options });
  t.after(() => rt.close());
  return rt;
}

// Every runtime tool module and the reader tools, registered as the stdio entry point does in a
// read-only process: read-only gate first, implicit workspace, no learning counter.
async function readOnlyTools(rt) {
  const tools = new Map();
  const collector = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
  const surface = withImplicitWorkspace(withReadOnly(collector, rt.principal), () => rt);
  for (const [path, fn] of TOOL_MODULES) (await import(new URL(`../server/${path.slice(2)}`, import.meta.url)))[fn](surface, () => rt);
  registerReaderTools(surface, () => rt);
  return tools;
}
const call = async (tools, name, args = {}) => JSON.parse((await tools.get(name).handler(args, {})).content[0].text);

// Plausible arguments for every tool, so each read really reaches the store.
function argsFor(name, { ids }) {
  const known = {
    workspace_id: ids.drop, worktree_id: ids.wtDrop, job_id: ids.done, issue: 'memolabs-dev/drop#7', project: 'drop', host: 'mac',
    claim_id: ids.held, fence: 'f'.repeat(40), seq: 1, path: 'README.md', query: 'drop', id: 'mem_aaaaaaaaaaaaaaaa', recipe: 'test',
    title: 'x', body: 'x', branch: 'agent/drop-7', message: 'x', content: 'x', delegation_id: 'd_0123456789ab', summary: 'x', batch: '0123456789',
    tasks: [{ title: 'x', body: 'x' }], repo: 'memolabs-dev/drop', change_id: 'sc_aaaaaaaaaaaaaaaa', kind: 'fact', text: 'x'
  };
  return name === 'task_status' || name === 'audit_events' ? { issue: known.issue } : known;
}

test('policy: the reader principal reads everything and holds no write capability', () => {
  const reader = readerPrincipal({ USER: 'memo' });
  assert.match(reader.id, /^reader:/);
  assert.deepEqual([...reader.capabilities].sort(), [...READER_CAPABILITIES].sort());
  assert.equal(holdsWriteCapability(reader), false);
  assert.equal(holdsWriteCapability(localOwnerPrincipal()), true);
  assert.equal(reader.via, 'stdio');
  // The reader ops need coordinator:audit, which no remote principal holds, and are not on the hub.
  for (const op of READER_TOOLS) {
    assert.equal(READER_OPERATION_CAPABILITY[op], CAPABILITIES.AUDIT, op);
    assert.equal(Object.hasOwn(OPERATION_CAPABILITY, op), false, op);
  }
  // Selection: --read-only, or MEMO_BRIDGE_READ_ONLY with anything but "", "0", "false".
  assert.equal(readOnlyRequested(['node', 'index.mjs'], {}), false);
  assert.equal(readOnlyRequested(['node', 'index.mjs', '--read-only'], {}), true);
  assert.equal(readOnlyRequested(['--read-only'], {}), false, 'only arguments after the script');
  for (const value of ['1', 'true', 'yes', 'on', 'garbage']) assert.equal(readOnlyRequested(['node', 'x'], { MEMO_BRIDGE_READ_ONLY: value }), true, value);
  for (const value of ['', '0', 'false', 'FALSE']) assert.equal(readOnlyRequested(['node', 'x'], { MEMO_BRIDGE_READ_ONLY: value }), false, value);
  // Unknown names are refused (fail closed); read tools listed by the entry point run.
  assert.equal(readOnlyAllows('some_future_tool', reader), false);
  assert.equal(readOnlyAllows('observe_focus', reader, ['observe_focus']), true);
});

test('read-only runtime: refuses a principal with writes, serves no other principal, store refuses writes', async t => {
  const env = await populate(t);
  assert.throws(() => createRuntime({ readOnly: true, stateDir: env.stateDir, principal: OWNER }), /read_only_principal_writes/);
  const rt = readerRuntime(t, env);
  assert.equal(rt.readOnly, true);
  assert.match(rt.principal.id, /^reader:/);
  assert.throws(() => rt.as(OTHER), /read_only_runtime/);
  assert.equal(rt.principalFromHub('hub:owner'), null);
  await assert.rejects(rt.store().transaction(repo => repo.appendEvent({ at: 1, principal: 'x', op: 'x', outcome: 'ok' })), /state_read_only/);
  // Below the store contract the engine refuses as well.
  await assert.rejects(rt.store().transaction(repo => repo.appendEvent({ at: 1, principal: 'x', op: 'x', outcome: 'ok' }), { write: false }),
    /readonly/);
  await rt.audit('task_claim', 'denied', 'forbidden');
  assert.equal(snapshot(env.stateDir).counts.events, 4, 'audit is a no-op');
  // A missing or outdated store is never created or migrated.
  const empty = join(await tempDir(t), 'state');
  assert.throws(() => openSqliteStore({ dir: empty, readOnly: true }), /state_store_missing/);
  // The database must be a plain file of the state directory, never a link.
  const linked = join(await tempDir(t), 'state');
  await mkdir(linked, { mode: 0o700 });
  await symlink(join(env.stateDir, 'coordinator.sqlite'), join(linked, 'coordinator.sqlite'));
  assert.throws(() => openSqliteStore({ dir: linked, readOnly: true }), /state_dir_not_private/);
  const db = new DatabaseSync(join(env.stateDir, 'coordinator.sqlite'));
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
  db.close();
  assert.throws(() => openSqliteStore({ dir: env.stateDir, readOnly: true }), /state_schema_mismatch/);
});

test('read-only gate: every write tool answers read_only, and only those', async t => {
  const env = await populate(t);
  const rt = readerRuntime(t, env);
  const tools = await readOnlyTools(rt);
  const expected = [...tools.keys()].filter(name => WRITE_CAPABILITIES.includes(OPERATION_CAPABILITY[name])).sort();
  assert.ok(expected.length >= 20, `write tools found: ${expected.length}`);
  for (const name of ['workspace_open', 'task_claim', 'task_next', 'jobs_submit', 'job_cancel', 'worktree_create', 'worktree_write_file',
    'worktree_push', 'github_create_pr', 'memory_save', 'project_create', 'source_reconcile', 'batch_create', 'delegation_join']) {
    assert.ok(expected.includes(name), name);
  }
  const refused = [];
  for (const name of [...tools.keys()].sort()) {
    const out = await call(tools, name, argsFor(name, env));
    if (out.error === READ_ONLY_ERROR) refused.push(name);
  }
  assert.deepEqual(refused, expected);
  for (const name of expected) {
    // Without arguments too: the refusal comes before validation, and it is stable.
    assert.deepEqual(await call(tools, name), { ok: false, error: 'read_only',
      detail: 'this Memo Bridge process was started read-only (--read-only or MEMO_BRIDGE_READ_ONLY): it changes nothing' }, name);
  }
});

test('acceptance: a full pass over every tool leaves every row unchanged, where the owner would reconcile', async t => {
  const env = await populate(t);
  const before = snapshot(env.stateDir);
  assert.equal(before.counts.jobs, 3);
  assert.equal(before.counts.events, 4);
  // Twice: as reader:<user>, which owns nothing, and with the owner's id and no write capability,
  // so the per-workspace reads (job_status, worktree_*, workspace_recover...) reach the rows too.
  const passes = { reader: readerRuntime(t, env), same_id: readerRuntime(t, env, { principal: makePrincipal(OWNER.id, READER_CAPABILITIES) }) };
  for (const [label, rt] of Object.entries(passes)) {
    const tools = await readOnlyTools(rt);
    const answers = {};
    for (const name of [...tools.keys()].sort()) answers[name] = await call(tools, name, argsFor(name, env));
    for (const name of READER_TOOLS) answers[`${name}#all`] = await call(tools, name, name === 'reader_job_events' ? { job_id: env.ids.done } : {});
    assert.deepEqual(snapshot(env.stateDir), before, `${label}: row counts and contents unchanged`);
    // No read needs a write: none fails on the read-only store.
    const report = Object.entries(answers).map(([name, a]) => `${label} ${name}: ${a.ok === false ? a.error + (a.detail ? ` (${a.detail})` : '') : 'ok'}`);
    if (process.env.READ_PASS_REPORT) console.log(report.join('\n'));
    assert.deepEqual(Object.entries(answers).filter(([, a]) => a.error === 'store_unavailable').map(([name]) => name), [], label);
    assert.equal(answers.reader_activity.ok, true, label);
    assert.equal(answers.audit_events.ok, true, label);
  }

  // Same identity as the owner but read-only: jobs_list and job_status show the job as recorded
  // and do not reconcile it.
  const sameIdTools = await readOnlyTools(passes.same_id);
  const listed = await call(sameIdTools, 'jobs_list', { workspace_id: env.ids.drop });
  assert.equal(listed.jobs.find(j => j.job_id === env.ids.running).status, 'running');
  assert.equal((await call(sameIdTools, 'job_status', { job_id: env.ids.running })).job.status, 'running');
  assert.deepEqual(snapshot(env.stateDir), before);

  // The owner's runtime does reconcile on read: the dead job is ended (timed out or interrupted).
  const owner = createRuntime({ stateDir: env.stateDir, principal: OWNER, ledger: stubLedger(), host: 'mac', env: {} });
  t.after(() => owner.close());
  const { createJobService } = await import('../server/runners/jobs.mjs');
  const ownerList = await createJobService(owner).list({ workspace_id: env.ids.drop });
  assert.notEqual(ownerList.jobs.find(j => j.job_id === env.ids.running).status, 'running');
  assert.notDeepEqual(snapshot(env.stateDir), before);
});

test('reader_activity: one project\'s jobs, leases and sessions with ISO timestamps; events page by next_after_seq', async t => {
  const env = await populate(t);
  const rt = readerRuntime(t, env);
  const tools = await readOnlyTools(rt);
  const drop = await call(tools, 'reader_activity', { project: 'drop' });
  assert.equal(drop.ok, true);
  assert.equal(drop.contract, READER_CONTRACT);
  assert.match(drop.at, ISO);
  assert.deepEqual(drop.sessions.map(s => s.workspace_id), [env.ids.drop]);
  const [session] = drop.sessions;
  assert.equal(session.principal, OWNER.id);
  assert.deepEqual(session.held_tasks, ['memolabs-dev/drop#7']);
  for (const key of ['created_at', 'updated_at', 'last_activity']) assert.match(session[key], ISO, key);
  assert.deepEqual(drop.leases.map(l => [l.issue, l.lease]), [['memolabs-dev/drop#7', 'held']]);
  assert.match(drop.leases[0].expires_at, ISO);
  assert.equal(drop.leases[0].fence, undefined, 'the reader never gets a fence');
  assert.deepEqual(drop.leases[0].last_checkpoint, { branch: 'agent/drop-7', commit: 'c'.repeat(40), durability: 'remote',
    at: new Date(env.t0 + 2500).toISOString() });
  assert.deepEqual(drop.jobs.map(j => [j.job_id, j.status]), [[env.ids.running, 'running'], [env.ids.done, 'succeeded']]);
  const done = drop.jobs.find(j => j.job_id === env.ids.done);
  for (const key of ['created_at', 'started_at', 'ended_at']) assert.match(done[key], ISO, key);
  assert.equal(done.issue, 'memolabs-dev/drop#7');
  assert.equal(done.log_path, undefined, 'no local path');
  assert.deepEqual(drop.events.map(e => e.op), ['task_claim', 'workspace_open'], 'only events of the project\'s workspaces');
  assert.equal(drop.status_source, 'recorded');

  // Every project: the other principal's closed conversation and its released lease are there.
  const all = await call(tools, 'reader_activity', {});
  assert.deepEqual(all.sessions.map(s => s.workspace_id).sort(), [env.ids.drop, env.ids.cuesheet].sort());
  const released = all.leases.find(l => l.issue === 'memolabs-dev/cuesheet#3');
  assert.deepEqual([released.lease, released.outcome, released.summary, released.expires_at],
    ['released', 'completed', 'PR #9', '2026-10-21T10:00:00.000Z']);
  assert.equal(all.events.length, 4);

  // since: what changed at or after it, plus what is still live.
  const later = await call(tools, 'reader_activity', { since: new Date(env.t0 + 25_000).toISOString() });
  assert.deepEqual(later.sessions.map(s => s.workspace_id), [env.ids.drop], 'the active workspace only');
  assert.deepEqual(later.leases.map(l => l.issue), ['memolabs-dev/drop#7'], 'the held lease only');
  assert.deepEqual(later.jobs.map(j => j.job_id), [env.ids.running], 'the job still running');
  assert.deepEqual(later.events, []);

  // Audit cursor: two pages of two with limit, here through after_seq.
  const first = await call(tools, 'reader_activity', { after_seq: 0 });
  const second = await call(tools, 'reader_activity', { after_seq: first.events[1].seq });
  assert.deepEqual(second.events.map(e => e.seq), first.events.slice(2).map(e => e.seq));
  assert.equal(second.next_after_seq, first.events[3].seq);
  const end = await call(tools, 'reader_activity', { after_seq: second.next_after_seq });
  assert.deepEqual([end.events, end.next_after_seq, end.more_events], [[], second.next_after_seq, false]);

  // limit cuts each list and says so.
  const cut = await call(tools, 'reader_activity', { limit: 1 });
  assert.equal(cut.jobs.length, 1);
  assert.deepEqual(cut.truncated, { sessions: true, leases: true, jobs: true });

  // Job events of any conversation, paged.
  const events = await call(tools, 'reader_job_events', { job_id: env.ids.done, after_seq: 0 });
  assert.deepEqual(events.events.map(e => e.kind), ['step0', 'step1', 'step2']);
  assert.match(events.events[0].at, ISO);
  const rest = await call(tools, 'reader_job_events', { job_id: env.ids.done, after_seq: events.events[0].seq });
  assert.deepEqual(rest.events.map(e => e.kind), ['step1', 'step2']);
  assert.equal(rest.next_after_seq, events.next_after_seq);

  // Validation.
  // An offset is the same instant; a time without a zone, or a loose date, is refused.
  const offset = await call(tools, 'reader_activity', { since: '2026-10-21T12:00:25+02:00' });
  assert.deepEqual(offset.jobs.map(j => j.job_id), later.jobs.map(j => j.job_id));
  assert.equal(offset.scope.since, new Date(env.t0 + 25_000).toISOString());
  // project, since and after_seq together.
  const combined = await call(tools, 'reader_activity', { project: 'drop', since: new Date(env.t0 + 1).toISOString(), after_seq: 0 });
  assert.deepEqual(combined.events.map(e => e.op), ['workspace_open']);
  for (const [args, field] of [[{ project: '../x' }, 'project'], [{ since: 'yesterday' }, 'since'], [{ since: '2026-10-21T10:00' }, 'since'],
    [{ since: '2026' }, 'since'], [{ since: 'Oct 21 2026' }, 'since'], [{ after_seq: -1 }, 'after_seq'],
    [{ limit: 0 }, 'limit']]) {
    assert.deepEqual(await call(tools, 'reader_activity', args), { ok: false, error: 'invalid_input', detail: field });
  }
  assert.deepEqual(await call(tools, 'reader_job_events', { job_id: 'nope' }), { ok: false, error: 'invalid_input', detail: 'job_id' });
  assert.deepEqual(await call(tools, 'reader_job_events', { job_id: jobId() }), { ok: false, error: 'unknown_job' });
});

test('reader tools: a principal without coordinator:audit is refused, and the refusal is not journaled', async t => {
  const env = await populate(t);
  const before = snapshot(env.stateDir);
  const rt = createRuntime({ stateDir: env.stateDir, principal: makePrincipal('local:owner', [CAPABILITIES.READ, CAPABILITIES.WRITE]),
    ledger: stubLedger(), host: 'mac', env: {} });
  t.after(() => rt.close());
  const tools = new Map();
  registerReaderTools({ registerTool(name, config, handler) { tools.set(name, { config, handler }); } }, () => rt);
  for (const name of READER_TOOLS) assert.deepEqual(await call(tools, name, { job_id: env.ids.done }), { ok: false, error: 'forbidden' });
  assert.deepEqual(snapshot(env.stateDir), before);
});

test('stdio --read-only: write tools answer read_only, reads leave the store unchanged', async t => {
  const env = await populate(t);
  const before = snapshot(env.stateDir);
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'server', 'index.mjs'), '--read-only'],
    cwd: ROOT, env: { ...process.env, MEMO_BRIDGE_STATE_DIR: env.stateDir, MEMO_BRIDGE_PROJECTS_ROOT: env.projectsRoot,
      MEMOLABS_ROOT: env.projectsRoot }, stderr: 'ignore' });
  const client = new Client({ name: 'read-only-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const listed = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of [...READER_TOOLS, 'jobs_list', 'job_events', 'sessions_overview', 'task_status', 'audit_events']) {
    assert.ok(listed.includes(name), name);
  }
  const text = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const info = await text('bridge_info');
  assert.equal(info.read_only, true);
  assert.equal(info.mode, 'read-only');
  assert.match(info.principal.id, /^reader:/);
  assert.deepEqual(info.principal.capabilities, [...READER_CAPABILITIES].sort());
  for (const name of listed.filter(n => WRITE_CAPABILITIES.includes(OPERATION_CAPABILITY[n]))) {
    assert.equal((await text(name, argsFor(name, env))).error, 'read_only', name);
  }
  const activity = await text('reader_activity', { project: 'drop' });
  assert.equal(activity.jobs.length, 2);
  for (const name of ['jobs_list', 'sessions_overview', 'audit_events', 'workspace_list']) assert.equal((await text(name)).ok, true, name);
  assert.equal((await text('job_events', { job_id: env.ids.done })).ok, false, 'per-principal tools see only the reader\'s own (none)');
  assert.deepEqual(snapshot(env.stateDir), before);
});

test('reader paging: more than a page of audit and job events', async t => {
  const env = await populate(t);
  const db = new DatabaseSync(join(env.stateDir, 'coordinator.sqlite'));
  const event = db.prepare('INSERT INTO events (at, principal, workspace_id, op, outcome) VALUES (?, ?, ?, ?, ?)');
  const jobEvent = db.prepare('INSERT INTO job_events (job_id, at, kind) VALUES (?, ?, ?)');
  for (let i = 0; i < 250; i++) { event.run(env.t0 + 100 + i, OWNER.id, env.ids.drop, 'bulk', 'ok'); jobEvent.run(env.ids.done, env.t0 + i, 'tick'); }
  db.close();
  const tools = await readOnlyTools(readerRuntime(t, env));
  const first = await call(tools, 'reader_activity', {});
  assert.deepEqual([first.events.length, first.more_events], [200, true]);
  const second = await call(tools, 'reader_activity', { after_seq: first.next_after_seq });
  assert.deepEqual([second.events.length, second.more_events], [54, false]);
  assert.equal(second.events[0].seq, first.next_after_seq + 1);
  const jobs1 = await call(tools, 'reader_job_events', { job_id: env.ids.done });
  assert.deepEqual([jobs1.events.length, jobs1.more], [200, true]);
  const jobs2 = await call(tools, 'reader_job_events', { job_id: env.ids.done, after_seq: jobs1.next_after_seq });
  assert.deepEqual([jobs2.events.length, jobs2.more], [53, false]);
});

// The stdio entry point on a populated store, as `node server/index.mjs ...args` with `extraEnv`.
async function stdioClient(t, env, args, extraEnv = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'server', 'index.mjs'), ...args],
    cwd: ROOT, env: { ...process.env, MEMO_BRIDGE_STATE_DIR: env.stateDir, MEMO_BRIDGE_PROJECTS_ROOT: env.projectsRoot,
      MEMOLABS_ROOT: env.projectsRoot, MEMO_BRIDGE_READ_ONLY: '', ...extraEnv }, stderr: 'ignore' });
  const client = new Client({ name: 'read-only-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return async (name, args2 = {}) => JSON.parse((await client.callTool({ name, arguments: args2 })).content[0].text);
}

test('stdio MEMO_BRIDGE_READ_ONLY=1 is read-only too; the owner\'s process reads reader_activity without a trace', async t => {
  const env = await populate(t);
  const before = snapshot(env.stateDir);
  const viaEnv = await stdioClient(t, env, [], { MEMO_BRIDGE_READ_ONLY: '1' });
  assert.equal((await viaEnv('bridge_info')).read_only, true);
  assert.equal((await viaEnv('task_claim', { issue: 'memolabs-dev/drop#7' })).error, 'read_only');
  assert.equal((await viaEnv('reader_activity', { project: 'drop' })).ok, true);
  assert.deepEqual(snapshot(env.stateDir), before);
  // The owner's full process: reader tools are not counted for the learning review and journal nothing.
  const owner = await stdioClient(t, env, []);
  const info = await owner('bridge_info');
  assert.equal(info.read_only, false);
  assert.match(info.principal.id, /^local:/);
  for (let i = 0; i < 3; i++) assert.equal((await owner('reader_activity', { project: 'drop' })).ok, true);
  assert.equal((await owner('reader_job_events', { job_id: env.ids.done })).ok, true);
  assert.deepEqual(snapshot(env.stateDir), before);
});
