// host_capabilities, host_resources, audit_events and audit_operation.
// Every test uses a private temporary state directory and stubbed probes: no real gh, ssh,
// python or GitHub, and nothing under the user's real state or the real registry root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../server/runtime.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { createHostService, execProbe, PROBE_CACHE_MS, PRODUCTION_FIRST_NOTE, TOOL_PROBES, cleanLine }
  from '../server/runners/hosts.mjs';
import { HOST_TOOLS, registerHostTools } from '../server/tools/host-tools.mjs';
import { AUDIT_TOOLS, registerAuditTools } from '../server/tools/audit-tools.mjs';

const ALL = Object.values(CAPABILITIES);
const OWNER = makePrincipal('local:alice', ALL.filter(c => c !== CAPABILITIES.AUDIT));
const AUDITOR = makePrincipal('local:auditor', ALL);
const NOBODY = makePrincipal('local:mallory', []);
const WS_ALICE = 'ws_aaaaaaaaaaaaaaaa';
const WS_BOB = 'ws_bbbbbbbbbbbbbbbb';
const ISSUE = 'memolabs-dev/drop#7';
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);

const stubLedger = () => {
  const receipt = { state: 'claimed', claim_id: 'c'.repeat(32), fence_sha: 'f'.repeat(40) };
  const ok = async () => ({ ok: true, receipt });
  return { status: ok, claim: ok, verify: ok, heartbeat: ok, release: ok };
};

async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Minimal MCP server double: records registrations and calls handlers like the SDK does.
function fakeServer() {
  const tools = {};
  return {
    tools,
    registerTool(name, config, handler) { tools[name] = { config, handler }; },
    async call(name, args = {}) {
      const response = await tools[name].handler(args);
      assert.equal(response.content[0].type, 'text');
      return JSON.parse(response.content[0].text);
    }
  };
}

async function runtimeFor(t, { principal = OWNER, host = 'mac', stateDir, now = () => T0, catalogOptions } = {}) {
  const dir = stateDir ?? join(await tempDir(t, 'memo-ha-'), 'state');
  const rt = createRuntime({ stateDir: dir, principal, ledger: stubLedger(), now, host, catalogOptions });
  t.after(() => rt.close());
  return rt;
}

// Scripted probe runner: answers per command, records every argv it receives.
function scriptedRun(answers = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    const key = [command, ...args].join(' ');
    if (key in answers) return answers[key];
    if (command in answers) return answers[command];
    return { code: null, missing: true };
  };
  return { run, calls };
}
const okOut = stdout => ({ code: 0, stdout, stderr: '' });
const MAC_TOOLS = {
  node: okOut('v24.21.0\n'), npm: okOut('11.6.2\n'), python3: okOut('Python 3.13.7\n'), git: okOut('git version 2.51.0\n'),
  'gh --version': okOut('gh version 2.83.0 (2025-11-01)\nhttps://github.com/cli/cli/releases/tag/v2.83.0\n'),
  'gh auth status': { code: 0, stdout: 'Logged in to github.com account secret-user (keyring)\n', stderr: '' },
  swift: okOut('swift-driver version: 1.127 Apple Swift version 6.2\n'),
  xcodebuild: { code: 1, stdout: '', stderr: 'xcode-select: error: tool requires Xcode' }
  // docker: missing
};
const macOs = (platform = 'darwin') => ({
  platform: () => platform, arch: () => 'arm64', release: () => '25.0.0', hostname: () => 'test-host',
  loadavg: () => [1.234, 0.5, 0.25], cpus: () => new Array(10).fill({}), freemem: () => 4e9, totalmem: () => 32e9
});

function hostSetup(t, { answers = MAC_TOOLS, platform = 'darwin', collect, clock } = {}) {
  const script = scriptedRun(answers);
  const collected = [];
  const now = clock ?? (() => T0);
  const hosts = createHostService({ run: script.run, now, os: macOs(platform), env: {},
    collect: async host => { collected.push(host); return collect ? collect(host) : { host, online: false, error: 'timeout' }; } });
  return { hosts, script, collected };
}

// ---------------------------------------------------------------- host_capabilities

test('host tools register the contract names', () => {
  const server = fakeServer();
  registerHostTools(server, () => null);
  assert.deepEqual(Object.keys(server.tools).sort(), [...HOST_TOOLS].sort());
  for (const name of HOST_TOOLS) assert.equal(server.tools[name].config.annotations.readOnlyHint, true);
});

test('local mac capabilities are observed with fixed probes, labelled and cached five minutes', async t => {
  let clock = T0;
  const { hosts, script, collected } = hostSetup(t, { clock: () => clock });
  const rt = await runtimeFor(t);
  const server = fakeServer();
  registerHostTools(server, () => rt, { hosts });

  const r = await server.call('host_capabilities', { host: 'mac' });
  assert.equal(r.ok, true);
  assert.equal(r.local, true);
  assert.equal(r.os.source, 'observed');
  assert.deepEqual([r.os.platform, r.os.arch], ['darwin', 'arm64']);
  assert.equal(r.tools.source, 'observed');
  assert.equal(r.tools.node.version, '24.21.0');
  assert.equal(r.tools.python3.version, '3.13.7');
  assert.equal(r.tools.git.version, '2.51.0');
  assert.equal(r.tools.gh.version, '2.83.0');
  assert.equal(r.tools.gh.authenticated, true);
  assert.equal(r.tools.swift.present, true);
  assert.equal(r.tools.swift.version, '6.2', 'language version, not the driver version');
  assert.equal(r.tools.xcodebuild.present, false, 'Command Line Tools only: xcodebuild is not usable');
  assert.equal(r.tools.docker.present, false);
  // gh auth output (account names) never leaks.
  assert.ok(!JSON.stringify(r).includes('secret-user'));
  const recipes = Object.fromEntries(r.recipes.toolchains.map(x => [x.toolchain, x]));
  assert.deepEqual(Object.keys(recipes), ['npm', 'swiftpm', 'python', 'cargo', 'go', 'make']);
  assert.equal(recipes.npm.available, true);
  assert.deepEqual(recipes.npm.recipes, ['test', 'build', 'lint']);
  assert.equal(recipes.swiftpm.available, true);
  assert.deepEqual(recipes.python.recipes, ['test']);
  assert.deepEqual(recipes.cargo.missing, ['cargo']);
  assert.equal(r.roles.source, 'declared');
  assert.ok(r.roles.roles.some(x => x.id === 'apple-native-builds'));
  assert.deepEqual(collected, [], 'local host is never probed through host_status');

  // Only the fixed argv arrays ran.
  const allowed = new Set([...Object.values(TOOL_PROBES).map(p => [p.command, ...p.args].join(' ')), 'gh auth status']);
  for (const call of script.calls) assert.ok(allowed.has(call.join(' ')), call.join(' '));
  const first = script.calls.length;

  clock += PROBE_CACHE_MS - 1;
  await server.call('host_capabilities', { host: 'mac' });
  assert.equal(script.calls.length, first, 'cached within five minutes');
  clock += 1;
  await server.call('host_capabilities', { host: 'mac' });
  assert.equal(script.calls.length, first * 2, 'probed again after five minutes');
});

test('probe output is sanitized and gh auth is null when it cannot be established', async t => {
  const { hosts } = hostSetup(t, { answers: { ...MAC_TOOLS,
    git: okOut('\u202egit\u0007 version 2.51.0\u001b[0m\n'),
    'gh auth status': { code: null, timedOut: true },
    node: okOut('\u0000\u2066weird build\u2069 without numbers\n') } });
  const rt = await runtimeFor(t);
  const server = fakeServer();
  registerHostTools(server, () => rt, { hosts });
  const r = await server.call('host_capabilities', { host: 'mac' });
  assert.equal(r.tools.git.version, '2.51.0');
  assert.equal(r.tools.gh.authenticated, null);
  assert.ok(!/[\u0000-\u001f\u202e\u2066\u2069]/.test(r.tools.node.version), r.tools.node.version);
  assert.equal(cleanLine('a\u202eb\nsecond line'), 'a b');
});

test('Apple toolchains are not probed on Linux', async t => {
  const { hosts, script } = hostSetup(t, { platform: 'linux' });
  const rt = await runtimeFor(t, { host: 'vps' });
  const server = fakeServer();
  registerHostTools(server, () => rt, { hosts });
  const r = await server.call('host_capabilities', { host: 'vps' });
  assert.equal(r.local, true);
  assert.equal(r.tools.swift.present, false);
  assert.equal(r.tools.xcodebuild.reason, 'not_macos');
  assert.ok(!script.calls.some(c => c[0] === 'swift' || c[0] === 'xcodebuild'));
  assert.ok(r.roles.limitations.some(l => /Cannot build Xcode projects/.test(l)));
});

test('remote vps capabilities: declared roles plus host_status reachability, no new probe', async t => {
  const { hosts, script, collected } = hostSetup(t, {
    collect: host => ({ host, online: true, hostname: 'lab\u202e', system: 'Linux', architecture: 'x86_64' }) });
  const rt = await runtimeFor(t, { host: 'mac' });
  const server = fakeServer();
  registerHostTools(server, () => rt, { hosts });
  const r = await server.call('host_capabilities', { host: 'vps' });
  assert.equal(r.ok, true);
  assert.equal(r.local, false);
  assert.equal(r.roles.source, 'declared');
  assert.ok(r.roles.roles.some(x => x.id === 'linux-builds'));
  assert.ok(r.roles.limitations.some(l => /Cannot build Xcode projects/.test(l)));
  assert.deepEqual({ source: r.reachability.source, online: r.reachability.online, hostname: r.reachability.hostname },
    { source: 'observed', online: true, hostname: 'lab' });
  assert.equal(r.tools, null);
  assert.deepEqual(collected, ['vps']);
  assert.equal(script.calls.length, 0, 'no local tool probe for a remote host');
});

test('from the VPS the Mac is declared only: no route, no probe', async t => {
  const { hosts, script, collected } = hostSetup(t, { platform: 'linux' });
  const rt = await runtimeFor(t, { host: 'vps' });
  const server = fakeServer();
  registerHostTools(server, () => rt, { hosts });
  const r = await server.call('host_capabilities', { host: 'mac' });
  assert.equal(r.local, false);
  assert.equal(r.reachability.source, 'unknown');
  assert.deepEqual(collected, []);
  assert.equal(script.calls.length, 0);
});

// ---------------------------------------------------------------- host_resources

test('local resources: load, memory, disks and job counts from the store', async t => {
  const projectsRoot = await tempDir(t, 'memo-ha-projects-');
  const rt = await runtimeFor(t, { catalogOptions: { projectsRoot } });
  await rt.store().transaction(repo => {
    repo.insertWorkspace({ id: WS_ALICE, principal: OWNER.id, client_type: 'cli', project_id: 'drop', host: 'mac',
      status: 'active', created_at: T0, updated_at: T0 });
    repo.insertWorktree({ id: 'wt_1', workspace_id: WS_ALICE, project_id: 'drop', host: 'mac', path: '/tmp/x', branch: 'feat/x',
      base_ref: 'main', base_commit: 'a'.repeat(40), created_at: T0, updated_at: T0 });
    for (const [id, status] of [['job_1', 'running'], ['job_2', 'running'], ['job_3', 'queued'], ['job_4', 'succeeded']]) {
      repo.insertJob({ id, workspace_id: WS_ALICE, worktree_id: 'wt_1', project_id: 'drop', host: 'mac', recipe: 'test',
        argv_json: '[]', timeout_ms: 1000, log_path: '/tmp/log', created_at: T0 });
      if (status !== 'queued') repo.updateJob(id, { status }, 'queued');
    }
  });
  const { hosts, collected } = hostSetup(t);
  const server = fakeServer();
  registerHostTools(server, () => rt, { hosts });
  const r = await server.call('host_resources', { host: 'mac' });
  const limited = createHostService({ run: async () => ({ missing: true }), os: macOs(), env: { MEMO_BRIDGE_MAX_JOBS: '3' } });
  const r3 = await limited.resources('mac', { localHost: 'mac', stateDir: rt.stateDir, projectsRoot, jobs: null });
  assert.equal(r3.job_concurrency_limit, 3, 'same limit and variable as the job runner');
  assert.equal(r.ok, true);
  assert.equal(r.source, 'observed');
  assert.deepEqual(r.load_average, [1.23, 0.5, 0.25]);
  assert.equal(r.cpu_count, 10);
  assert.deepEqual([r.memory.free_bytes, r.memory.total_bytes], [4e9, 32e9]);
  assert.ok(r.disk.state_dir.free_gib > 0 && r.disk.state_dir.total_gib >= r.disk.state_dir.free_gib);
  assert.ok(r.disk.projects.total_gib > 0);
  assert.deepEqual([r.jobs.running, r.jobs.queued], [2, 1]);
  assert.equal(r.job_concurrency_limit, 2);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(collected, []);
});

test('remote vps resources reuse host_status only and carry the production-first rule', async t => {
  const { hosts, script, collected } = hostSetup(t, { collect: host => ({ host, online: true, cpu_count: 4,
    load_average: [0.1, 0.2, 0.3], disk_free_gib: 50.5, disk_total_gib: 150, docker_running_containers: 12 }) });
  const rt = await runtimeFor(t);
  const server = fakeServer();
  registerHostTools(server, () => rt, { hosts });
  const r = await server.call('host_resources', { host: 'vps' });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'host_status');
  assert.deepEqual(r.disk_root, { free_gib: 50.5, total_gib: 150 });
  assert.equal(r.docker_running_containers, 12);
  assert.equal(r.job_concurrency_limit, null, 'a remote runner enforces its own limit');
  assert.deepEqual(r.notes, [PRODUCTION_FIRST_NOTE]);
  assert.deepEqual(collected, ['vps']);
  assert.equal(script.calls.length, 0);

  const offline = hostSetup(t);
  const server2 = fakeServer();
  registerHostTools(server2, () => rt, { hosts: offline.hosts });
  const down = await server2.call('host_resources', { host: 'vps' });
  assert.deepEqual([down.ok, down.online, down.error], [true, false, 'timeout']);
});

test('host tools refuse a principal without coordinator:read and journal the refusal', async t => {
  const rt = await runtimeFor(t, { principal: NOBODY });
  const { hosts, script } = hostSetup(t);
  const server = fakeServer();
  registerHostTools(server, () => rt, { hosts });
  for (const name of HOST_TOOLS) assert.deepEqual(await server.call(name, { host: 'mac' }), { ok: false, error: 'forbidden' });
  assert.equal(script.calls.length, 0);
  const events = await rt.store().transaction(repo => repo.listEvents({ limit: 10 }), { write: false });
  assert.deepEqual(events.map(e => [e.op, e.outcome, e.code, e.principal]).sort(),
    [['host_capabilities', 'denied', 'forbidden', NOBODY.id], ['host_resources', 'denied', 'forbidden', NOBODY.id]]);
});

test('the default probe runner uses execFile without a shell and reports missing commands', async () => {
  const node = await execProbe(process.execPath, ['--version']);
  assert.equal(node.code, 0);
  assert.match(node.stdout, /^v\d+\./);
  const missing = await execProbe('memo-bridge-no-such-command', ['--version']);
  assert.equal(missing.missing, true);
  // A shell metacharacter is an argument, never interpreted.
  const literal = await execProbe(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo injected);']);
  assert.equal(literal.stdout, '$(echo injected);');
});

// ---------------------------------------------------------------- audit

async function auditFixture(t) {
  const stateDir = join(await tempDir(t, 'memo-ha-audit-'), 'state');
  const alice = await runtimeFor(t, { stateDir, principal: OWNER });
  const auditor = await runtimeFor(t, { stateDir, principal: AUDITOR });
  const seqs = {};
  await alice.store().transaction(repo => {
    repo.insertWorkspace({ id: WS_ALICE, principal: OWNER.id, client_type: 'cli', project_id: 'drop', host: 'mac',
      status: 'active', created_at: T0, updated_at: T0 });
    repo.insertWorkspace({ id: WS_BOB, principal: 'local:bob', client_type: 'cli', project_id: 'drop', host: 'mac',
      status: 'active', created_at: T0, updated_at: T0 });
    repo.insertClaim({ claim_id: 'c'.repeat(32), workspace_id: WS_ALICE, issue_ref: ISSUE, fence_sha: 'f'.repeat(40), epoch: 1,
      expires_at: '2026-10-13T12:10:00Z', updated_at: T0 });
    // v9: one claimed row per Issue; Bob's later claim supersedes Alice's mirror row.
    repo.updateClaim('c'.repeat(32), { state: 'released', outcome: 'expired', updated_at: T0 }, 'f'.repeat(40));
    repo.insertClaim({ claim_id: 'd'.repeat(32), workspace_id: WS_BOB, issue_ref: ISSUE, fence_sha: 'e'.repeat(40), epoch: 2,
      expires_at: '2026-10-13T13:10:00Z', updated_at: T0 });
    repo.insertCheckpoint({ issue_ref: ISSUE, claim_id: 'c'.repeat(32), workspace_id: WS_ALICE, fence_sha: 'f'.repeat(40),
      branch: 'feat/a', commit_sha: '1'.repeat(40), durability: 'remote', at: T0 + 1000 });
    repo.insertCheckpoint({ issue_ref: ISSUE, claim_id: 'd'.repeat(32), workspace_id: WS_BOB, fence_sha: 'e'.repeat(40),
      branch: 'feat/b', commit_sha: '2'.repeat(40), durability: 'remote', at: T0 + 2000 });
    repo.insertWorktree({ id: 'wt_near', workspace_id: WS_ALICE, project_id: 'drop', host: 'mac', path: '/private/secret/path',
      branch: 'feat/a', base_ref: 'main', base_commit: 'a'.repeat(40), issue_ref: ISSUE, created_at: T0 - 60_000, updated_at: T0 });
    repo.insertWorktree({ id: 'wt_old', workspace_id: WS_ALICE, project_id: 'drop', host: 'mac', path: '/tmp/old',
      branch: 'feat/old', base_ref: 'main', base_commit: 'a'.repeat(40), created_at: T0 - 5 * 3600_000, updated_at: T0 });
    repo.updateWorktree('wt_old', { status: 'removed', removed_at: T0 - 4 * 3600_000 });
    repo.insertJob({ id: 'job_near', workspace_id: WS_ALICE, worktree_id: 'wt_near', project_id: 'drop', host: 'mac',
      recipe: 'test', argv_json: '[]', timeout_ms: 1000, log_path: '/private/secret/log', created_at: T0 + 60_000 });
    repo.insertJob({ id: 'job_late', workspace_id: WS_ALICE, worktree_id: 'wt_near', project_id: 'drop', host: 'mac',
      recipe: 'build', argv_json: '[]', timeout_ms: 1000, log_path: '/tmp/log', created_at: T0 + 3 * 3600_000 });
    const add = (name, e) => { repo.appendEvent({ at: T0, ...e }); seqs[name] = repo.listEvents({ limit: 1 })[0].seq; };
    add('aliceClaim', { principal: OWNER.id, workspace_id: WS_ALICE, issue_ref: ISSUE, op: 'task_claim', outcome: 'ok' });
    add('aliceOpen', { principal: OWNER.id, workspace_id: WS_ALICE, op: 'workspace_open', outcome: 'ok' });
    add('aliceDeniedOnBob', { principal: OWNER.id, workspace_id: WS_BOB, issue_ref: ISSUE, op: 'issue_release',
      outcome: 'denied', code: 'forbidden' });
    add('bobClaim', { principal: 'local:bob', workspace_id: WS_BOB, issue_ref: ISSUE, op: 'task_claim', outcome: 'ok' });
    add('bobError', { principal: 'local:bob', workspace_id: WS_BOB, op: 'worktree_push', outcome: 'error', code: 'push_failed' });
  });
  const aliceServer = fakeServer(); registerAuditTools(aliceServer, () => alice);
  const auditorServer = fakeServer(); registerAuditTools(auditorServer, () => auditor);
  return { alice, auditor, aliceServer, auditorServer, seqs };
}

test('audit tools register the contract names', () => {
  const server = fakeServer();
  registerAuditTools(server, () => null);
  assert.deepEqual(Object.keys(server.tools).sort(), [...AUDIT_TOOLS].sort());
});

test('audit_events: own events only without coordinator:audit, everything with it, newest first', async t => {
  const { aliceServer, auditorServer, seqs } = await auditFixture(t);
  const own = await aliceServer.call('audit_events');
  assert.equal(own.scope, 'own');
  assert.deepEqual(own.events.map(e => e.seq), [seqs.aliceDeniedOnBob, seqs.aliceOpen, seqs.aliceClaim]);
  assert.ok(own.events.every(e => e.principal === OWNER.id));

  const all = await auditorServer.call('audit_events');
  assert.equal(all.scope, 'all');
  assert.equal(all.count, 5);
  assert.deepEqual(all.events.map(e => e.seq), [...all.events.map(e => e.seq)].sort((a, b) => b - a));
  assert.equal(all.events[0].at, new Date(T0).toISOString());
});

test('audit_events filters by issue, workspace, op, outcome and limit', async t => {
  const { aliceServer, auditorServer, seqs } = await auditFixture(t);
  const byIssue = await auditorServer.call('audit_events', { issue: ISSUE });
  assert.deepEqual(byIssue.events.map(e => e.seq), [seqs.bobClaim, seqs.aliceDeniedOnBob, seqs.aliceClaim]);
  const byWs = await auditorServer.call('audit_events', { workspace_id: WS_BOB });
  assert.deepEqual(byWs.events.map(e => e.seq), [seqs.bobError, seqs.bobClaim, seqs.aliceDeniedOnBob]);
  const byOp = await auditorServer.call('audit_events', { op: 'task_claim' });
  assert.deepEqual(byOp.events.map(e => e.seq), [seqs.bobClaim, seqs.aliceClaim]);
  assert.equal(byOp.window_exhausted, false);
  const denied = await auditorServer.call('audit_events', { outcome: 'denied' });
  assert.deepEqual(denied.events.map(e => [e.seq, e.code]), [[seqs.aliceDeniedOnBob, 'forbidden']]);
  const limited = await auditorServer.call('audit_events', { limit: 2 });
  assert.equal(limited.count, 2);
  // Without coordinator:audit, filters never widen the scope.
  const aliceOnBob = await aliceServer.call('audit_events', { workspace_id: WS_BOB });
  assert.deepEqual(aliceOnBob.events.map(e => e.seq), [seqs.aliceDeniedOnBob]);
  const aliceErrors = await aliceServer.call('audit_events', { outcome: 'error' });
  assert.equal(aliceErrors.count, 0);

  for (const [args, detail] of [[{ issue: 'not an issue' }, 'issue'], [{ workspace_id: 'ws_x' }, 'workspace_id'],
    [{ op: 'Drop Table' }, 'op'], [{ outcome: 'maybe' }, 'outcome'], [{ limit: 0 }, 'limit'], [{ limit: 201 }, 'limit']]) {
    assert.deepEqual(await auditorServer.call('audit_events', args), { ok: false, error: 'invalid_input', detail });
  }
});

test('audit_operation resolves the workspace, claims, checkpoints, worktrees and jobs near the event', async t => {
  const { aliceServer, seqs } = await auditFixture(t);
  const r = await aliceServer.call('audit_operation', { seq: seqs.aliceClaim });
  assert.equal(r.ok, true);
  assert.equal(r.event.op, 'task_claim');
  assert.equal(r.related.workspace.workspace_id, WS_ALICE);
  assert.deepEqual(r.related.claims.map(c => c.claim_id), ['c'.repeat(32)]);
  assert.deepEqual(r.related.checkpoints.map(c => c.workspace_id), [WS_ALICE], "bob's checkpoint is not visible to alice");
  assert.deepEqual(r.related.worktrees.map(w => w.worktree_id), ['wt_near']);
  assert.deepEqual(r.related.jobs.map(j => j.job_id), ['job_near']);
  assert.ok(!JSON.stringify(r).includes('/private/secret'), 'local paths are not part of the audit view');
});

test('audit_operation hides other principals: their events read as unknown and the attempt is journaled', async t => {
  const { alice, aliceServer, auditorServer, seqs } = await auditFixture(t);
  assert.deepEqual(await aliceServer.call('audit_operation', { seq: seqs.bobClaim }), { ok: false, error: 'unknown_event' });
  assert.deepEqual(await aliceServer.call('audit_operation', { seq: 9999 }), { ok: false, error: 'unknown_event' });
  const journal = await alice.store().transaction(repo => repo.listEvents({ principal: OWNER.id, limit: 1 }), { write: false });
  assert.deepEqual([journal[0].op, journal[0].outcome, journal[0].code], ['audit_operation', 'denied', 'forbidden']);

  // Alice's own refusal on bob's workspace: the event is hers, bob's workspace stays hidden.
  const own = await aliceServer.call('audit_operation', { seq: seqs.aliceDeniedOnBob });
  assert.equal(own.ok, true);
  assert.equal(own.related.workspace, null);
  assert.deepEqual(own.related.claims, []);
  assert.deepEqual(own.withheld, ['workspace']);
  assert.deepEqual(own.related.checkpoints.map(c => c.workspace_id), [WS_ALICE]);

  // The auditor sees bob's event and everything around it.
  const full = await auditorServer.call('audit_operation', { seq: seqs.bobClaim });
  assert.equal(full.related.workspace.workspace_id, WS_BOB);
  assert.deepEqual(full.related.claims.map(c => c.claim_id), ['d'.repeat(32)]);
  assert.equal(full.related.checkpoints.length, 2);
});

test('audit tools refuse a principal without coordinator:read and journal it with well-formed ids only', async t => {
  const rt = await runtimeFor(t, { principal: NOBODY });
  const server = fakeServer();
  registerAuditTools(server, () => rt);
  assert.deepEqual(await server.call('audit_events', { workspace_id: WS_ALICE, issue: ISSUE }), { ok: false, error: 'forbidden' });
  assert.deepEqual(await server.call('audit_events', { workspace_id: 'ws_<script>' }), { ok: false, error: 'forbidden' });
  assert.deepEqual(await server.call('audit_operation', { seq: 1 }), { ok: false, error: 'forbidden' });
  const events = await rt.store().transaction(repo => repo.listEvents({ limit: 10 }), { write: false });
  assert.deepEqual(events.map(e => [e.op, e.outcome, e.code, e.workspace_id, e.issue_ref]).reverse(), [
    ['audit_events', 'denied', 'forbidden', WS_ALICE, ISSUE],
    ['audit_events', 'denied', 'forbidden', null, null],
    ['audit_operation', 'denied', 'forbidden', null, null]
  ]);
});

test('store failures come back as a code, never as an exception or a path', async t => {
  const blocker = await tempDir(t, 'memo-ha-bad-');
  // A state dir inside a git repository is refused by the store.
  await mkdir(join(blocker, '.git'));
  const rt = createRuntime({ stateDir: join(blocker, 'state'), principal: AUDITOR, ledger: stubLedger(), host: 'mac' });
  const server = fakeServer();
  registerAuditTools(server, () => rt);
  assert.deepEqual(await server.call('audit_events'), { ok: false, error: 'store_unavailable' });
  const hostServer = fakeServer();
  registerHostTools(hostServer, () => rt, { hosts: hostSetup(t).hosts });
  const r = await hostServer.call('host_resources', { host: 'mac' });
  assert.equal(r.ok, true);
  assert.equal(r.jobs, null);
});
