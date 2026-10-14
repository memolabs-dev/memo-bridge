// Smoke test of the bundled stdio server (plugin/server/dist/index.mjs), run as a real MCP client.
//
// Everything is local and temporary: a registry with one project whose origin is a bare
// repository, a private state directory, a worktrees root, a sandboxed Git configuration, and an
// offline GitHub (tests/helpers/fake-gh) behind the canonical lease ledger script. Nothing reads
// or writes the user's real state, ~/projects or GitHub.
//
// Round trip: workspace_open -> task_claim -> worktree_create -> worktree_write_file ->
// jobs_submit test -> job succeeded -> worktree_commit -> worktree_push -> task_complete ->
// worktree_remove -> workspace_close. github_create_pr is not called: it needs a real GitHub
// repository (tests/github.test.mjs covers it with a recording gh stub).
import { strict as assert } from 'node:assert';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FAKE_GH_DIR, GOVERNANCE_ROOT, HAS_GOVERNANCE } from './helpers/coordinator-fixture.mjs';

const root = await realpath(await mkdtemp(join(tmpdir(), 'memo-bridge-smoke-')));
const repository = join(root, 'memo-bridge');
// The bare origin's path ends in memolabs-dev/cuesheet.git, so the project's origin reads as that
// GitHub repository, the one the claimed Issue belongs to (task_claim refuses a project mismatch).
const origin = join(root, 'remotes', 'memolabs-dev', 'cuesheet.git');
await mkdir(repository);
await writeFile(join(root, 'PROJECTS.md'), [
  '# Local test registry',
  '## Projets appartenant à Memo Labs',
  '| Name | Path | Kind | Status | Nature | Stack | Vault note |',
  '|---|---|---|---|---|---|---|',
  '| memo-bridge | memo-bridge | repo | active | infrastructure | Node.js | - |',
  '## Dépôts de référence'
].join('\n'));

// Git never reads the user's own configuration (identity, signing, hooks) here, neither in this
// process nor in the server it starts.
const gitconfig = join(root, 'gitconfig');
await writeFile(gitconfig, ['[user]', '\tname = Smoke Owner', '\temail = smoke@example.invalid',
  '[init]', '\tdefaultBranch = main', '[commit]', '\tgpgsign = false', ''].join('\n'));
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE']) {
  delete gitEnv[name];
}
const git = (...args) => execFileSync('git', ['-C', repository, ...args], { env: gitEnv, encoding: 'utf8' }).trim();
execFileSync('git', ['init', '-q', '-b', 'main', repository], { env: gitEnv });
// A test script that passes, so jobs_submit 'test' has something real to run.
await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'smoke-project', private: true,
  scripts: { test: 'node -e "console.log(\'smoke tests pass\')"' } }, null, 2) + '\n');
git('add', '-A');
git('commit', '-q', '-m', 'smoke');
const head = git('rev-parse', 'HEAD');
await mkdir(join(root, 'remotes', 'memolabs-dev'), { recursive: true });
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: gitEnv });
git('remote', 'add', 'origin', origin);
git('push', '-q', '-u', 'origin', 'main');

// Offline GitHub for the canonical lease ledger.
const githubState = join(root, 'github.json');
const ledgerRoot = 'f'.repeat(40);
await writeFile(githubState, JSON.stringify({ refs: { 'refs/heads/main': ledgerRoot },
  commits: { [ledgerRoot]: { message: 'root', tree: { sha: 'e'.repeat(40) }, parents: [] } },
  issues: { 'memolabs-dev/cuesheet#3': {} } }));

const BASE_TOOLS = ['bridge_info', 'host_status', 'list_hosts', 'project_git_status', 'project_info', 'projects_audit',
  'projects_list'];
const OBSERVER_TOOLS = ['observe_agents', 'observe_focus', 'observe_guardian', 'observe_live_state'];
const COORDINATOR_TOOLS = ['workspace_open', 'workspace_status', 'workspace_list', 'workspace_close', 'workspace_recover',
  'tasks_list', 'task_status', 'task_claim', 'task_renew', 'task_release', 'task_complete', 'task_checkpoint',
  'batch_create', 'task_next', 'batch_status', 'sessions_overview'];
const WORKTREE_TOOLS = ['worktrees_list', 'worktree_create', 'worktree_status', 'worktree_list_files', 'worktree_read_file',
  'worktree_write_file', 'worktree_diff', 'worktree_commit', 'worktree_push', 'worktree_remove'];
const JOB_TOOLS = ['jobs_submit', 'jobs_list', 'job_status', 'job_events', 'job_results', 'job_cancel'];
const HOST_TOOLS = ['host_capabilities', 'host_resources'];
const GITHUB_TOOLS = ['github_issues', 'github_pull_requests', 'github_workflows', 'github_checks', 'github_create_pr'];
const AUDIT_TOOLS = ['audit_events', 'audit_operation'];
const MEMORY_TOOLS = ['memory_save', 'memory_search', 'memory_get', 'memory_list'];
const EXPECTED = [...BASE_TOOLS, ...OBSERVER_TOOLS, ...COORDINATOR_TOOLS, ...WORKTREE_TOOLS, ...JOB_TOOLS, ...HOST_TOOLS,
  ...GITHUB_TOOLS, ...AUDIT_TOOLS, ...MEMORY_TOOLS].sort();

const client = new Client({ name: 'memo-bridge-smoke', version: '0.2.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['plugin/server/dist/index.mjs'],
  cwd: process.cwd(),
  env: { ...gitEnv, MEMO_BRIDGE_PROJECTS_ROOT: root, MEMO_BRIDGE_STATE_DIR: join(root, 'state'),
    MEMO_BRIDGE_WORKTREES_ROOT: join(root, 'worktrees'), MEMO_BRIDGE_GOVERNANCE_ROOT: GOVERNANCE_ROOT,
    PATH: `${FAKE_GH_DIR}:${process.env.PATH}`, FAKE_GH_STATE: githubState,
    // Jobs run inside the macOS job sandbox; there is none on Linux CI, where the smoke runs the
    // test recipe unsandboxed (the owner's explicit opt-out).
    ...(process.platform === 'darwin' ? {} : { MEMO_BRIDGE_JOB_SANDBOX: 'off' }) }
});
const call = async (name, args = {}) => {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError, undefined, `${name}: ${JSON.stringify(response)}`);
  return JSON.parse(response.content[0].text);
};
const ok = (payload, what) => { assert.equal(payload.ok, true, `${what}: ${JSON.stringify(payload)}`); return payload; };

try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(x => x.name).sort();
  assert.deepEqual(names, EXPECTED, 'the exact tool list');
  assert.equal(new Set(names).size, names.length);
  // Multi-session (D-MS9): the server instructions carry the start sequence and the stop codes.
  const instructions = client.getInstructions() ?? '';
  for (const rule of ['workspace_open', 'sessions_overview', 'task_next', 'operator_lock', 'operator_unlock', 'stale_lease',
    'locked_by_other_session', 'workspace_other_session']) assert.ok(instructions.includes(rule), `instructions mention ${rule}`);

  // bridge_info reports exactly the registered tools.
  const info = await call('bridge_info');
  assert.equal(info.version, '0.6.0');
  assert.deepEqual([...info.allowed_tools].sort(), EXPECTED);
  assert.ok(info.excluded.includes('arbitrary-shell') && info.excluded.includes('merge'));
  // Phase 4: the bundle on the Mac keeps the local executor (no queue), and says so.
  assert.equal(info.runner.executor, 'local');
  assert.equal(info.runner.queueing, false);
  assert.ok(info.runner.job_statuses.includes('deferred') && info.runner.ops.includes('jobs_submit'));

  // Phase 1: observation.
  for (const name of OBSERVER_TOOLS) {
    const payload = await call(name);
    assert.equal(typeof payload.ok, 'boolean', `${name}: ${JSON.stringify(payload)}`);
    if (!payload.ok) assert.equal(payload.error, 'source_unavailable');
  }
  for (const name of BASE_TOOLS.filter(n => !['bridge_info', 'list_hosts'].includes(n))) {
    const args = name === 'host_status' ? { host: 'mac' } :
      ['project_info', 'project_git_status'].includes(name) ? { project: 'memo-bridge' } : {};
    const payload = await call(name, args);
    if (name === 'project_info' || name === 'project_git_status') {
      ok(payload, name);
      assert.equal(payload.project === 'memo-bridge' || payload.project?.name === 'memo-bridge', true);
    }
    if (name === 'projects_list') assert.ok(payload.projects.some(p => p.name === 'memo-bridge'));
    if (name === 'projects_audit') assert.equal(payload.registered_count, 1);
  }
  assert.equal((await call('list_hosts')).length, 2);
  // Context memory through the bundle: save, find, read back with its note.
  const saved = await call('memory_save', { scope: 'environment', host: 'mac', title: 'smoke memory', body: 'The bundle stores memories.', tags: ['smoke'] });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const found = await call('memory_search', { query: 'bundle' });
  assert.equal(found.results[0].id, saved.memory.id);
  assert.match((await call('memory_get', { id: saved.memory.id })).note, /knowledge, not authorization/);

  // Phase 3 reads that need no claim.
  const here = info.this_host;
  ok(await call('host_capabilities', { host: here }), 'host_capabilities');
  ok(await call('host_resources', { host: here }), 'host_resources');
  assert.equal((await call('github_issues', { repo: 'someone/unregistered' })).error, 'repo_not_registered');

  // Phase 2 and 3 round trip.
  const ws = ok(await call('workspace_open', { project: 'memo-bridge', client_type: 'cli', client_label: 'smoke' }), 'workspace_open');
  const workspace_id = ws.workspace.workspace_id;
  const tasks = await call('tasks_list', {});
  assert.equal(typeof tasks.ok, 'boolean', JSON.stringify(tasks));
  let roundTrip = false;
  if (HAS_GOVERNANCE) {
    const issue = 'memolabs-dev/cuesheet#3';
    const claim = ok(await call('task_claim', { workspace_id, issue, ttl_seconds: 600 }), 'task_claim');
    const other = ok(await call('workspace_open', { project: 'memo-bridge', client_type: 'cli' }), 'second workspace');
    assert.equal((await call('task_claim', { workspace_id: other.workspace.workspace_id, issue })).error, 'lease_held');

    const created = ok(await call('worktree_create', { workspace_id, issue }), 'worktree_create');
    const worktree_id = created.worktree.worktree_id;
    assert.equal(created.worktree.base_commit, head);
    assert.ok(!JSON.stringify(created).includes(root), 'local paths never reach the client');

    ok(await call('worktree_write_file', { worktree_id, path: 'src/hello.txt', content: 'hello from the smoke test\n' }),
      'worktree_write_file');
    assert.equal((await call('worktree_write_file', { worktree_id, path: '../escape.txt', content: 'x' })).ok, false);
    assert.equal((await call('worktree_read_file', { worktree_id, path: 'src/hello.txt' })).content,
      'hello from the smoke test\n');

    const submitted = ok(await call('jobs_submit', { workspace_id, worktree_id, recipe: 'test', timeout_seconds: 120 }),
      'jobs_submit');
    assert.equal((await call('jobs_submit', { workspace_id, worktree_id, recipe: 'lint' })).error, 'unknown_recipe');
    const job_id = submitted.job.job_id;
    let job;
    for (const deadline = Date.now() + 90_000; Date.now() < deadline;) {
      job = ok(await call('job_status', { job_id }), 'job_status').job;
      if (!['queued', 'running'].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const results = ok(await call('job_results', { job_id }), 'job_results');
    assert.equal(job.status, 'succeeded', JSON.stringify({ job, results }));
    assert.equal(job.exit_code, 0);
    assert.ok(results.log.lines.some(line => line.includes('smoke tests pass')), JSON.stringify(results.log));
    assert.ok(ok(await call('job_events', { job_id }), 'job_events').events.some(e => e.kind === 'exit'));

    const committed = ok(await call('worktree_commit', { worktree_id, message: 'Add hello file from the smoke test' }),
      'worktree_commit');
    const pushed = ok(await call('worktree_push', { worktree_id }), 'worktree_push');
    assert.equal(pushed.commit, committed.commit);
    assert.equal(pushed.checkpoint.ok, true, JSON.stringify(pushed));
    assert.equal(pushed.checkpoint.durability, 'remote', JSON.stringify(pushed));
    assert.equal(execFileSync('git', ['--git-dir', origin, 'rev-parse', `refs/heads/${created.worktree.branch}`],
      { env: gitEnv, encoding: 'utf8' }).trim(), committed.commit, 'the branch reached origin');
    assert.equal(execFileSync('git', ['--git-dir', origin, 'rev-parse', 'refs/heads/main'], { env: gitEnv, encoding: 'utf8' })
      .trim(), head, 'the default branch is untouched');

    const recovered = ok(await call('workspace_recover', { workspace_id }), 'workspace_recover');
    assert.equal(recovered.claims[0]?.state, 'still_held', JSON.stringify(recovered.claims));
    assert.equal(recovered.worktrees.length, 1);

    const held = { workspace_id, issue, claim_id: claim.claim_id, fence: claim.fence };
    ok(await call('task_complete', { ...held, summary: 'smoke round trip' }), 'task_complete');
    assert.equal((await call('task_status', { issue })).lease.state, 'released');
    // The claim is gone: repository writes are refused from now on.
    assert.equal((await call('worktree_write_file', { worktree_id, path: 'late.txt', content: 'x' })).error, 'no_live_claim');

    ok(await call('worktree_remove', { worktree_id }), 'worktree_remove');
    const events = ok(await call('audit_events', { issue, limit: 200 }), 'audit_events');
    const ops = new Set(events.events.map(e => e.op));
    for (const op of ['task_claim', 'worktree_create', 'worktree_write_file', 'jobs_submit', 'worktree_commit', 'worktree_push',
      'task_checkpoint', 'task_complete']) {
      assert.ok(ops.has(op), `audit journal has ${op}: ${[...ops].join(', ')}`);
    }
    ok(await call('audit_operation', { seq: events.events[0].seq }), 'audit_operation');
    roundTrip = true;
  }
  assert.equal((await call('workspace_close', { workspace_id })).workspace.status, 'closed');
  const rejected = await client.callTool({ name: 'task_claim', arguments: { workspace_id, issue: 'x', ttl_seconds: 5 } });
  assert.equal(rejected.isError, true, 'schema bounds are enforced at the MCP boundary');
  console.log(JSON.stringify({ ok: true, tools: names.length, roundTrip, githubCreatePr: 'skipped: needs real GitHub',
    multiHost: true, fixture: true }));
} finally {
  await client.close();
  await rm(root, { recursive: true, force: true });
}
