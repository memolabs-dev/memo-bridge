// GitHub integration and tools. Offline: the gh runner is a recording stub (or a fake gh
// script on PATH for the default runner), Git uses temporary repositories with a bare
// origin, and every test has its own private state directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../server/runtime.mjs';
import { CAPABILITIES, OPERATION_CAPABILITY, makePrincipal } from '../server/coordinator/policy.mjs';
import { GITHUB_TOOLS, registerGithubTools } from '../server/tools/github-tools.mjs';
import { cleanText, createGitHub, parseRepo, runGh } from '../server/integrations/github.mjs';

const OWNER = makePrincipal('local:owner', Object.values(CAPABILITIES));
const READER = makePrincipal('local:reader', [CAPABILITIES.READ]);
const NOBODY = makePrincipal('local:nobody', []);
const NOW = Date.parse('2026-10-13T12:00:00Z');
const WS = 'ws_AAAAAAAAAAAAAAAA';
const WS_OTHER = 'ws_BBBBBBBBBBBBBBBB';
const WT = 'wt_CCCCCCCCCCCCCCCC';
const CLAIM = 'a'.repeat(32);
const FENCE = 'b'.repeat(40);
const SHA = 'c'.repeat(40);

async function tempDir(t, prefix = 'memo-github-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
  { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

// A project clone with a bare origin; the clone is used as the worktree path.
async function gitFixture(t) {
  const dir = await tempDir(t, 'memo-github-git-');
  const origin = join(dir, 'origin.git');
  const clone = join(dir, 'clone');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: 'ignore' });
  git(clone, 'checkout', '-q', '-b', 'main');
  await writeFile(join(clone, 'README.md'), 'hello\n');
  git(clone, 'add', 'README.md');
  git(clone, 'commit', '-q', '-m', 'init');
  git(clone, 'push', '-q', 'origin', 'main');
  git(clone, 'checkout', '-q', '-b', 'feat/drop-7');
  await writeFile(join(clone, 'feature.txt'), 'feature\n');
  git(clone, 'add', 'feature.txt');
  git(clone, 'commit', '-q', '-m', 'feature');
  git(clone, 'push', '-q', 'origin', 'feat/drop-7');
  git(clone, 'checkout', '-q', '-b', 'feat/unpushed');
  return { origin, clone, head: git(clone, 'rev-parse', 'feat/drop-7') };
}

// Recording gh stub. routes: [{ match: (method, endpoint) => bool, reply: (call) => out }].
function fakeGh(routes = []) {
  const calls = [];
  const gh = async (args, opts = {}) => {
    const method = args[args.indexOf('-X') + 1];
    const endpoint = args.find(a => /^repos\//.test(a));
    const call = { args, method, endpoint, input: opts.input };
    calls.push(call);
    for (const route of routes) {
      if (route.match(method, endpoint, call)) return route.reply(call);
    }
    return { code: 1, stdout: '{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)' };
  };
  return { gh, calls };
}
const ok = data => () => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
const route = (method, re, reply) => ({ match: (m, e) => m === method && re.test(e ?? ''), reply });

function stubLedger(verify = { ok: true, receipt: { state: 'claimed' } }) {
  const calls = [];
  const answer = name => async (...args) => { calls.push([name, ...args]); return typeof verify === 'function' ? verify(name) : verify; };
  return { calls, status: answer('status'), claim: answer('claim'), verify: answer('verify'), heartbeat: answer('heartbeat'), release: answer('release') };
}

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) { tools.set(name, { definition, handler }); },
    async call(name, args) {
      const response = await tools.get(name).handler(args);
      return JSON.parse(response.content[0].text);
    }
  };
}

// One runtime and server per test, with a private store.
async function setup(t, { principal = OWNER, gh = fakeGh().gh, ledger = stubLedger(), host = 'mac',
  registered = ['memolabs-dev/drop', 'memolabs-dev/cuesheet'], projects = { drop: 'memolabs-dev/drop', cuesheet: 'memolabs-dev/cuesheet' } } = {}) {
  const stateDir = join(await tempDir(t), 'state');
  const rt = createRuntime({ stateDir, principal, ledger, host, now: () => NOW });
  t.after(() => rt.close());
  const server = fakeServer();
  registerGithubTools(server, () => rt, { gh, registeredRepos: async () => registered,
    projectRepo: async name => projects[name] ?? null });
  return { rt, server, ledger };
}

async function seed(rt, { workspace = {}, worktree = {}, claim = {}, otherWorkspace = false } = {}) {
  await rt.store().transaction(repo => {
    repo.insertWorkspace({ id: WS, principal: OWNER.id, client_type: 'other', project_id: 'drop', host: 'mac',
      status: 'active', created_at: NOW, updated_at: NOW, ...workspace });
    if (otherWorkspace) {
      repo.insertWorkspace({ id: WS_OTHER, principal: OWNER.id, client_type: 'other', project_id: 'drop', host: 'mac',
        status: 'active', created_at: NOW, updated_at: NOW });
    }
    if (worktree !== null) {
      repo.insertWorktree({ id: WT, workspace_id: WS, project_id: 'drop', host: 'mac', path: '/nonexistent',
        branch: 'feat/drop-7', base_ref: 'main', base_commit: SHA, issue_ref: 'memolabs-dev/drop#7',
        created_at: NOW, updated_at: NOW, ...worktree });
    }
    if (claim !== null) {
      repo.insertClaim({ claim_id: CLAIM, workspace_id: WS, issue_ref: 'memolabs-dev/drop#7', fence_sha: FENCE, epoch: 1,
        expires_at: new Date(NOW + 300_000).toISOString(), updated_at: NOW, ...claim });
    }
  });
}

async function events(rt, op) {
  return rt.store().transaction(repo => repo.listEvents({ limit: 50 }), { write: false })
    .then(rows => rows.filter(e => e.op === op));
}

// gh routes for a repository whose default branch is main and that has no open PR yet.
function prRoutes({ existing = null, create } = {}) {
  let created = null;
  return [
    route('GET', /^repos\/memolabs-dev\/drop$/, ok({ full_name: 'memolabs-dev/drop', default_branch: 'main' })),
    route('GET', /^repos\/memolabs-dev\/drop\/pulls\?state=open&head=/, () => ok(created ? [created] : existing ? [existing] : [])()),
    route('POST', /^repos\/memolabs-dev\/drop\/pulls$/, call => {
      const payload = JSON.parse(call.input);
      const pr = { number: 42, title: payload.title, state: 'open', draft: payload.draft, user: { login: 'guillaume' },
        head: { ref: payload.head, sha: SHA }, base: { ref: payload.base }, html_url: 'https://github.com/memolabs-dev/drop/pull/42' };
      // create(call) may simulate a failure; { lands: true } means GitHub created the PR anyway.
      const outcome = create ? create(call) : { lands: true, result: ok(pr)() };
      if (outcome.lands) created = pr;
      return outcome.result;
    })
  ];
}

test('every GitHub tool is registered and mapped to a capability', async t => {
  const { server } = await setup(t);
  assert.deepEqual([...server.tools.keys()].sort(), [...GITHUB_TOOLS].sort());
  for (const name of GITHUB_TOOLS) assert.ok(OPERATION_CAPABILITY[name], name);
  assert.equal(OPERATION_CAPABILITY.github_create_pr, CAPABILITIES.GITHUB_WRITE);
  assert.equal(server.tools.get('github_create_pr').definition.annotations.readOnlyHint, false);
  assert.equal(server.tools.get('github_issues').definition.annotations.readOnlyHint, true);
});

test('repository scope: strict format, registered origins and governance only', async t => {
  const { gh, calls } = fakeGh([route('GET', /issues/, ok([]))]);
  const { rt, server } = await setup(t, { gh });
  for (const repo of ['memolabs-dev', 'a/b/c', '../etc', 'owner/..', '-bad/repo', 'o/r?x=1', 'o/r#1', '']) {
    assert.deepEqual(await server.call('github_issues', { repo }), { ok: false, error: 'invalid_input', detail: 'repo' }, repo);
  }
  assert.equal((await server.call('github_issues', { repo: 'someone/else' })).error, 'repo_not_registered');
  assert.equal(calls.length, 0, 'no GitHub call for a refused repository');
  const denied = await events(rt, 'github_issues');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].outcome, 'denied');
  assert.equal(denied[0].code, 'repo_not_registered');

  const canonical = await server.call('github_issues', { repo: 'MemoLabs-Dev/DROP' });
  assert.equal(canonical.ok, true);
  assert.equal(canonical.repo, 'memolabs-dev/drop');
  assert.equal((await server.call('github_issues', { repo: 'memolabs-dev/.github' })).ok, true);
  assert.equal((await events(rt, 'github_issues')).length, 1, 'successful reads are not journaled');
});

test('authorization comes first and refusals are journaled', async t => {
  const { gh, calls } = fakeGh();
  const { rt, server } = await setup(t, { principal: NOBODY, gh });
  for (const name of ['github_issues', 'github_pull_requests', 'github_workflows']) {
    assert.deepEqual(await server.call(name, { repo: 'not a repo' }), { ok: false, error: 'forbidden' });
  }
  assert.deepEqual(await server.call('github_checks', { repo: 'x', ref: 'y' }), { ok: false, error: 'forbidden' });
  assert.deepEqual(await server.call('github_create_pr', { workspace_id: WS, worktree_id: WT, title: 't' }),
    { ok: false, error: 'forbidden' });
  assert.equal(calls.length, 0);
  const rows = await rt.store().transaction(repo => repo.listEvents({ limit: 50 }), { write: false });
  assert.equal(rows.length, 5);
  assert.ok(rows.every(e => e.outcome === 'denied' && e.code === 'forbidden' && e.principal === 'local:nobody'));
  assert.equal(rows.find(e => e.op === 'github_create_pr').workspace_id, WS);
});

test('a reader can read but not open pull requests', async t => {
  const { gh } = fakeGh([route('GET', /pulls/, ok([]))]);
  const { rt, server } = await setup(t, { principal: READER, gh });
  assert.equal((await server.call('github_pull_requests', { repo: 'memolabs-dev/drop' })).ok, true);
  assert.equal((await server.call('github_create_pr', { workspace_id: WS, worktree_id: WT, title: 't' })).error, 'forbidden');
  const [row] = await events(rt, 'github_create_pr');
  assert.equal(row.outcome, 'denied');
});

test('github_issues: GET only, bounded query, pull requests excluded, text cleaned', async t => {
  const long = 'x'.repeat(400);
  const { gh, calls } = fakeGh([route('GET', /^repos\/memolabs-dev\/drop\/issues\?/, ok([
    { number: 7, title: 'Fix\u202e evil\u0007 title\nsecond line', state: 'open', labels: [{ name: 'agent:ready' }, { name: 'priority:p1' }],
      user: { login: 'guillaume' }, updated_at: '2026-10-13T10:00:00Z', html_url: 'https://github.com/memolabs-dev/drop/issues/7',
      body: 'SECRET body that must not be returned', comments: 2 },
    { number: 8, title: 'a PR', state: 'open', pull_request: {}, labels: [], user: { login: 'x' } },
    { number: 9, title: long, state: 'open', labels: [], user: { login: 'y' } }
  ]))]);
  const { server } = await setup(t, { gh });
  const res = await server.call('github_issues', { repo: 'memolabs-dev/drop', labels: ['agent:ready', 'priority:p1'], limit: 5 });
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  assert.deepEqual(res.issues.map(i => i.number), [7, 9]);
  assert.equal(res.issues[0].title, 'Fix evil title second line');
  assert.deepEqual(res.issues[0].labels, ['agent:ready', 'priority:p1']);
  assert.equal(res.issues[0].author, 'guillaume');
  assert.equal(res.issues[1].title.length, 256);
  assert.ok(!JSON.stringify(res).includes('SECRET'));
  assert.deepEqual(Object.keys(res.issues[0]).sort(), ['author', 'comments', 'labels', 'number', 'state', 'title', 'updated_at', 'url']);

  const [call] = calls;
  assert.deepEqual(call.args.slice(0, 3), ['api', '-X', 'GET']);
  const url = new URL(`https://x/${call.endpoint}`);
  assert.equal(url.pathname, '/repos/memolabs-dev/drop/issues');
  assert.equal(url.searchParams.get('labels'), 'agent:ready,priority:p1');
  assert.equal(url.searchParams.get('per_page'), '5');
  assert.equal(url.searchParams.get('page'), '1');
  assert.ok(!call.args.includes('--paginate'));

  for (const bad of [{ labels: ['a,b'] }, { labels: ['x\u202e'] }, { labels: Array(11).fill('a') }, { limit: 0 }, { limit: 101 }, { state: 'merged' }]) {
    assert.equal((await server.call('github_issues', { repo: 'memolabs-dev/drop', ...bad })).error, 'invalid_input', JSON.stringify(bad));
  }
});

test('github_pull_requests: compact fields and bounded mergeable lookups', async t => {
  const pulls = Array.from({ length: 12 }, (_, i) => ({ number: i + 1, title: `PR ${i + 1}`, state: 'open', draft: i === 0,
    user: { login: 'g' }, head: { ref: `feat/${i}`, sha: SHA }, base: { ref: 'main' }, labels: [], html_url: `https://github.com/memolabs-dev/drop/pull/${i + 1}` }));
  pulls.push({ number: 99, title: 'merged', state: 'closed', merged_at: '2026-10-12T00:00:00Z', user: { login: 'g' },
    head: { ref: 'old', sha: SHA }, base: { ref: 'main' }, labels: [] });
  const { gh, calls } = fakeGh([
    route('GET', /^repos\/memolabs-dev\/drop\/pulls\?/, ok(pulls)),
    route('GET', /^repos\/memolabs-dev\/drop\/pulls\/\d+$/, call => ok({ mergeable: true, mergeable_state: 'clean',
      number: Number(call.endpoint.split('/').pop()) })())
  ]);
  const { server } = await setup(t, { gh });
  const res = await server.call('github_pull_requests', { repo: 'memolabs-dev/drop', state: 'all', limit: 100 });
  assert.equal(res.ok, true);
  assert.equal(res.count, 13);
  assert.equal(res.mergeable_checked, 10);
  assert.equal(calls.filter(c => /pulls\/\d+$/.test(c.endpoint)).length, 10);
  assert.ok(calls.every(c => c.method === 'GET'));
  assert.equal(res.pull_requests[0].draft, true);
  assert.equal(res.pull_requests[0].mergeable, true);
  assert.equal(res.pull_requests[0].head, 'feat/0');
  assert.equal(res.pull_requests[0].base, 'main');
  assert.equal(res.pull_requests[11].mergeable, null);
  assert.equal(res.pull_requests[12].state, 'merged');
});

test('github_workflows and github_checks', async t => {
  const { gh, calls } = fakeGh([
    route('GET', /^repos\/memolabs-dev\/drop\/actions\/runs\?/, ok({ total_count: 1000, workflow_runs: [
      { id: 1, name: 'CI', path: '.github/workflows/ci.yml', event: 'push', status: 'completed', conclusion: 'success',
        head_branch: 'main', head_sha: SHA, html_url: 'https://github.com/memolabs-dev/drop/actions/runs/1', created_at: 'x' }] })),
    route('GET', /\/check-runs\?/, ok({ total_count: 3, check_runs: [
      { name: 'test', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
      { name: 'lint', status: 'completed', conclusion: 'failure' },
      { name: 'e2e', status: 'in_progress', conclusion: null }] })),
    route('GET', /\/status\?/, ok({ state: 'failure', sha: SHA, statuses: [{ context: 'ci/legacy', state: 'failure', description: 'x\u0000y' }] }))
  ]);
  const { server } = await setup(t, { gh });
  const runs = await server.call('github_workflows', { repo: 'memolabs-dev/drop', branch: 'main', limit: 10 });
  assert.equal(runs.ok, true);
  assert.equal(runs.total, 1000);
  assert.deepEqual({ ...runs.runs[0], created_at: undefined, updated_at: undefined }, { id: 1, name: 'CI', workflow: '.github/workflows/ci.yml',
    event: 'push', status: 'completed', conclusion: 'success', branch: 'main', head_sha: SHA, run_attempt: null,
    created_at: undefined, updated_at: undefined, url: 'https://github.com/memolabs-dev/drop/actions/runs/1' });
  assert.match(calls[0].endpoint, /branch=main/);
  assert.equal((await server.call('github_workflows', { repo: 'memolabs-dev/drop', branch: '../x' })).error, 'invalid_input');

  const checks = await server.call('github_checks', { repo: 'memolabs-dev/drop', ref: 'feat/drop-7' });
  assert.equal(checks.ok, true);
  assert.deepEqual(checks.summary, { check_runs: 3, pending: 1, failing: 1, combined_status: 'failure' });
  assert.equal(checks.sha, SHA);
  assert.equal(checks.statuses[0].description, 'xy');
  assert.ok(calls.some(c => c.endpoint.startsWith('repos/memolabs-dev/drop/commits/feat%2Fdrop-7/check-runs')));
  assert.equal((await server.call('github_checks', { repo: 'memolabs-dev/drop', ref: SHA })).ok, true);
  for (const ref of ['', 'HEAD', '-x', 'a..b', 'refs/heads/main', 'abc def']) {
    assert.equal((await server.call('github_checks', { repo: 'memolabs-dev/drop', ref })).error, 'invalid_input', ref);
  }
});

test('gh failures map to short codes without leaking raw output', async t => {
  const { gh } = fakeGh([
    route('GET', /issues/, () => ({ code: 1, stdout: '{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)' })),
    route('GET', /pulls/, () => ({ code: -1, stdout: '', stderr: '', timedOut: true })),
    route('GET', /actions/, () => ({ code: 1, stdout: '{"message":"API rate limit exceeded for user"}', stderr: 'gh: API rate limit exceeded (HTTP 403)' })),
    route('GET', /check-runs/, () => ({ code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' })),
    route('GET', /status/, ok({}))
  ]);
  const { server } = await setup(t, { gh });
  assert.deepEqual(await server.call('github_issues', { repo: 'memolabs-dev/drop' }), { ok: false, error: 'github_not_found', detail: 'Not Found' });
  assert.deepEqual(await server.call('github_pull_requests', { repo: 'memolabs-dev/drop' }), { ok: false, error: 'github_unavailable', detail: 'timeout' });
  assert.equal((await server.call('github_workflows', { repo: 'memolabs-dev/drop' })).error, 'github_rate_limited');
  assert.deepEqual(await server.call('github_checks', { repo: 'memolabs-dev/drop', ref: 'main' }), { ok: false, error: 'github_auth_required' });
});

test('github_create_pr opens a PR from a claimed, pushed worktree branch', async t => {
  const fx = await gitFixture(t);
  const { gh, calls } = fakeGh(prRoutes());
  const { rt, server, ledger } = await setup(t, { gh });
  await seed(rt, { worktree: { path: fx.clone } });
  const res = await server.call('github_create_pr', { workspace_id: WS, worktree_id: WT, title: 'Drop: fix #7', body: 'Does the thing.' });
  assert.deepEqual(res, { ok: true, existing: false, repo: 'memolabs-dev/drop', number: 42,
    url: 'https://github.com/memolabs-dev/drop/pull/42', head: 'feat/drop-7', base: 'main', head_sha: fx.head, draft: false });

  const post = calls.find(c => c.method === 'POST');
  assert.deepEqual(post.args, ['api', '-X', 'POST', '-H', 'Accept: application/vnd.github+json', 'repos/memolabs-dev/drop/pulls', '--input', '-']);
  const payload = JSON.parse(post.input);
  assert.deepEqual(payload, { title: 'Drop: fix #7', head: 'feat/drop-7', base: 'main', body: 'Does the thing.\n\nCloses #7',
    draft: false, maintainer_can_modify: false });
  // Exactly one write, and never a merge or auto-merge.
  assert.equal(calls.filter(c => c.method !== 'GET').length, 1);
  assert.ok(!calls.some(c => c.args.some(a => /merge|graphql/i.test(a))));
  // The ledger verified the claim with the workspace worker, before the POST.
  const verify = ledger.calls.filter(c => c[0] === 'verify');
  assert.equal(verify.length, 1);
  assert.equal(verify[0][1].ref, 'memolabs-dev/drop#7');
  assert.equal(verify[0][2], `mb.mac.${WS}`);
  assert.equal(verify[0][3], CLAIM);
  assert.equal(verify[0][4], FENCE);
  const [row] = await events(rt, 'github_create_pr');
  assert.equal(row.outcome, 'ok');
  assert.equal(row.workspace_id, WS);
  assert.equal(row.issue_ref, 'memolabs-dev/drop#7');
});

test('github_create_pr keeps an existing closing keyword, skips it for another repository and supports drafts', async t => {
  const fx = await gitFixture(t);
  {
    const { gh, calls } = fakeGh(prRoutes());
    const { rt, server } = await setup(t, { gh });
    await seed(rt, { worktree: { path: fx.clone } });
    const res = await server.call('github_create_pr', { workspace_id: WS, worktree_id: WT, title: 'x', body: 'fixes #7 already', draft: true });
    assert.equal(res.ok, true);
    const payload = JSON.parse(calls.find(c => c.method === 'POST').input);
    assert.equal(payload.body, 'fixes #7 already');
    assert.equal(payload.draft, true);
  }
  {
    const { gh, calls } = fakeGh(prRoutes());
    const { rt, server } = await setup(t, { gh });
    await seed(rt, { worktree: { path: fx.clone, issue_ref: 'memolabs-dev/cuesheet#3' }, claim: { issue_ref: 'memolabs-dev/cuesheet#3' } });
    assert.equal((await server.call('github_create_pr', { workspace_id: WS, worktree_id: WT, title: 'x' })).ok, true);
    assert.equal(JSON.parse(calls.find(c => c.method === 'POST').input).body, '');
  }
  {
    // #70 is not #7: the closing reference must be appended.
    const { gh, calls } = fakeGh(prRoutes());
    const { rt, server } = await setup(t, { gh });
    await seed(rt, { worktree: { path: fx.clone } });
    await server.call('github_create_pr', { workspace_id: WS, worktree_id: WT, title: 'x', body: 'Closes #70' });
    assert.equal(JSON.parse(calls.find(c => c.method === 'POST').input).body, 'Closes #70\n\nCloses #7');
  }
});

test('github_create_pr is idempotent and recovers from a lost response', async t => {
  const fx = await gitFixture(t);
  const open = { number: 5, title: 'old', state: 'open', head: { ref: 'feat/drop-7', sha: SHA }, base: { ref: 'main' },
    user: { login: 'g' }, html_url: 'https://github.com/memolabs-dev/drop/pull/5' };
  {
    const { gh, calls } = fakeGh(prRoutes({ existing: open }));
    const { rt, server } = await setup(t, { gh });
    await seed(rt, { worktree: { path: fx.clone } });
    const res = await server.call('github_create_pr', { workspace_id: WS, worktree_id: WT, title: 'x' });
    assert.deepEqual(res, { ok: true, existing: true, repo: 'memolabs-dev/drop', number: 5,
      url: 'https://github.com/memolabs-dev/drop/pull/5', head: 'feat/drop-7', base: 'main' });
    assert.ok(!calls.some(c => c.method === 'POST'));
  }
  {
    // The POST times out after GitHub created the PR: adopt it.
    const { gh } = fakeGh(prRoutes({ create: () => ({ lands: true, result: { code: -1, stdout: '', stderr: '', timedOut: true } }) }));
    const { rt, server } = await setup(t, { gh });
    await seed(rt, { worktree: { path: fx.clone } });
    const res = await server.call('github_create_pr', { workspace_id: WS, worktree_id: WT, title: 'x' });
    assert.equal(res.ok, true);
    assert.equal(res.recovered, true);
    assert.equal(res.number, 42);
  }
  {
    // A concurrent call created it first: GitHub answers 422, the PR is adopted.
    const { gh } = fakeGh(prRoutes({ create: () => ({ lands: true, result: { code: 1, stdout: '{"message":"Validation Failed"}',
      stderr: 'gh: Validation Failed (HTTP 422)' } }) }));
    const { rt, server } = await setup(t, { gh });
    await seed(rt, { worktree: { path: fx.clone } });
    const res = await server.call('github_create_pr', { workspace_id: WS, worktree_id: WT, title: 'x' });
    assert.equal(res.ok, true);
    assert.equal(res.recovered, true);
  }
  {
    // The POST times out and nothing was created.
    const { gh } = fakeGh(prRoutes({ create: () => ({ lands: false, result: { code: -1, stdout: '', stderr: '', timedOut: true } }) }));
    const { rt, server } = await setup(t, { gh });
    await seed(rt, { worktree: { path: fx.clone } });
    assert.deepEqual(await server.call('github_create_pr', { workspace_id: WS, worktree_id: WT, title: 'x' }),
      { ok: false, error: 'github_unavailable', detail: 'no pull request was created' });
    const [row] = await events(rt, 'github_create_pr');
    assert.equal(row.outcome, 'error');
  }
});

test('github_create_pr refusals are enforced before any write and journaled', async t => {
  const fx = await gitFixture(t);
  const cases = [
    { name: 'unpushed branch', seed: { worktree: { path: fx.clone, branch: 'feat/unpushed' } }, error: 'branch_not_pushed' },
    { name: 'default branch', seed: { worktree: { path: fx.clone, branch: 'main' } }, error: 'default_branch_refused' },
    { name: 'no claim', seed: { worktree: { path: fx.clone }, claim: null }, error: 'claim_required' },
    { name: 'expired claim', seed: { worktree: { path: fx.clone }, claim: { expires_at: new Date(NOW - 1000).toISOString() } }, error: 'claim_required' },
    { name: 'released claim', seed: { worktree: { path: fx.clone } }, after: rt => rt.store().transaction(r => r.updateClaim(CLAIM, { state: 'released' }, FENCE)), error: 'claim_required' },
    { name: 'claim on another Issue', seed: { worktree: { path: fx.clone }, claim: { issue_ref: 'memolabs-dev/drop#8' } }, error: 'claim_required' },
    { name: 'worktree without Issue', seed: { worktree: { path: fx.clone, issue_ref: null } }, error: 'claim_required' },
    { name: 'stale lease', seed: { worktree: { path: fx.clone } }, ledger: stubLedger({ ok: false, error: 'stale_lease', detail: 'Lease expired' }), error: 'stale_lease' },
    { name: 'ledger down', seed: { worktree: { path: fx.clone } }, ledger: stubLedger({ ok: false, error: 'ledger_unavailable' }), error: 'ledger_unavailable', outcome: 'error' },
    { name: 'closed workspace', seed: { workspace: { status: 'closed' }, worktree: { path: fx.clone } }, error: 'workspace_closed' },
    { name: 'workspace of another principal', seed: { workspace: { principal: 'local:intruder' }, worktree: { path: fx.clone } }, error: 'forbidden' },
    { name: 'removed worktree', seed: { worktree: { path: fx.clone } },
      after: rt => rt.store().transaction(r => r.updateWorktree(WT, { status: 'removed', removed_at: NOW })), error: 'worktree_not_active' },
    { name: 'worktree of another workspace', seed: { otherWorkspace: true, worktree: { path: fx.clone, workspace_id: WS_OTHER } }, error: 'unknown_worktree' },
    { name: 'worktree on the VPS', seed: { worktree: { path: fx.clone, host: 'vps' } }, error: 'wrong_host' },
    { name: 'unregistered project', seed: { worktree: { path: fx.clone, project_id: 'stray' } }, error: 'repo_not_registered' },
    { name: 'missing worktree path', seed: { worktree: { path: join(fx.clone, 'gone') } }, error: 'worktree_missing', outcome: 'error' }
  ];
  for (const c of cases) {
    const { gh, calls } = fakeGh(prRoutes());
    const { rt, server, ledger } = await setup(t, { gh, ...(c.ledger ? { ledger: c.ledger } : {}) });
    await seed(rt, c.seed);
    if (c.after) await c.after(rt);
    const res = await server.call('github_create_pr', { workspace_id: WS, worktree_id: WT, title: 'x' });
    assert.equal(res.ok, false, c.name);
    assert.equal(res.error, c.error, c.name);
    assert.ok(!calls.some(call => call.method === 'POST'), `${c.name}: no POST`);
    if (c.error !== 'stale_lease' && c.error !== 'ledger_unavailable') assert.equal(ledger.calls.length, 0, `${c.name}: no ledger call`);
    const [row] = await events(rt, 'github_create_pr');
    assert.equal(row.outcome, c.outcome ?? 'denied', c.name);
    assert.equal(row.code, c.error, c.name);
  }
});

test('github_create_pr validates its input', async t => {
  const { gh, calls } = fakeGh(prRoutes());
  const { rt, server } = await setup(t, { gh });
  await seed(rt);
  const bad = [
    { workspace_id: 'ws_short', worktree_id: WT, title: 'x' },
    { workspace_id: WS, worktree_id: '../etc', title: 'x' },
    { workspace_id: WS, worktree_id: WT, title: '' },
    { workspace_id: WS, worktree_id: WT, title: '   ' },
    { workspace_id: WS, worktree_id: WT, title: 'two\nlines' },
    { workspace_id: WS, worktree_id: WT, title: 'bidi\u202e' },
    { workspace_id: WS, worktree_id: WT, title: 'x'.repeat(257) },
    { workspace_id: WS, worktree_id: WT, title: 'x', body: 'x'.repeat(20001) },
    { workspace_id: WS, worktree_id: WT, title: 'x', body: 'nul\u0000' },
    { workspace_id: WS, worktree_id: WT, title: 'x', draft: 'yes' },
    // Pull requests go out under the owner's name: no AI attribution (re-check P1).
    { workspace_id: WS, worktree_id: WT, title: 'Fix parser', body: 'Done.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)' },
    { workspace_id: WS, worktree_id: WT, title: 'Fix parser', body: 'Co-Authored-By: Claude <noreply@anthropic.com>' }
  ];
  for (const args of bad) assert.equal((await server.call('github_create_pr', args)).error, 'invalid_input', JSON.stringify(args).slice(0, 80));
  assert.equal((await server.call('github_create_pr', { workspace_id: 'ws_ZZZZZZZZZZZZZZZZ', worktree_id: WT, title: 'x' })).error, 'unknown_workspace');
  assert.equal((await server.call('github_create_pr', { workspace_id: WS, worktree_id: 'wt_ZZZZZZZZZZZZZZZZ', title: 'x' })).error, 'unknown_worktree');
  assert.equal(calls.length, 0);
  const rows = await events(rt, 'github_create_pr');
  assert.equal(rows.length, bad.length + 2);
});

test('default scope comes from PROJECTS.md and each project origin', async t => {
  const root = await tempDir(t, 'memo-github-catalog-');
  await writeFile(join(root, 'PROJECTS.md'), ['# Registry', '## Projets appartenant à Memo Labs',
    '| Name | Path | Kind | Status | Nature | Stack | Vault note |', '|---|---|---|---|---|---|---|',
    '| drop | drop | repo | active | app | Tauri | - |', '| notes | notes | dir | active | docs | - | - |',
    '| cuesheet | cuesheet | repo | active | app | TS | - |'].join('\n'));
  for (const name of ['drop', 'notes', 'cuesheet']) await mkdir(join(root, name));
  execFileSync('git', ['init', '-q', join(root, 'drop')]);
  execFileSync('git', ['-C', join(root, 'drop'), 'remote', 'add', 'origin', 'git@github.com:memolabs-dev/drop.git']);
  execFileSync('git', ['init', '-q', join(root, 'cuesheet')]);
  execFileSync('git', ['-C', join(root, 'cuesheet'), 'remote', 'add', 'origin', 'https://github.com/memolabs-dev/cuesheet']);
  let clock = NOW;
  const github = createGitHub({ catalogOptions: { projectsRoot: root, registryFile: join(root, 'PROJECTS.md') }, gh: fakeGh().gh, now: () => clock });
  assert.equal((await github.resolveRepo('memolabs-dev/drop')).repo.full, 'memolabs-dev/drop');
  assert.equal((await github.resolveRepo('memolabs-dev/cuesheet')).ok, true);
  assert.equal((await github.resolveRepo('memolabs-dev/notes')).error, 'repo_not_registered');
  assert.equal((await github.resolveRepo('memolabs-dev/.github')).ok, true);
  assert.equal(await github.projectRepo('drop'), 'memolabs-dev/drop');
  assert.equal(await github.projectRepo('notes'), null);
  assert.equal(await github.projectRepo('../x'), null);
  // A repository registered later becomes visible once the cache expires.
  execFileSync('git', ['-C', join(root, 'drop'), 'remote', 'set-url', 'origin', 'git@github.com:memolabs-dev/drop-v2.git']);
  assert.equal((await github.resolveRepo('memolabs-dev/drop-v2')).error, 'repo_not_registered');
  clock += 61_000;
  assert.equal((await github.resolveRepo('memolabs-dev/drop-v2')).ok, true);
});

test('default gh runner: fixed argv, stdin body, bounded output and timeout', async t => {
  const bin = await tempDir(t, 'memo-github-bin-');
  const ghScript = join(bin, 'gh');
  // Fake gh (test fixture): echoes argv and stdin, or misbehaves on request.
  await writeFile(ghScript, `#!/bin/sh
case "$*" in
  *slow*) sleep 5 ;;
  *huge*) head -c 300000 /dev/zero | tr '\\0' 'a' ;;
  *fail*) echo '{"message":"Validation Failed"}'; echo 'gh: Validation Failed (HTTP 422)' >&2; exit 1 ;;
  *) printf '%s\\n' "$@"; echo "--stdin--"; cat ;;
esac
`);
  await chmod(ghScript, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const echo = await runGh(['api', '-X', 'POST', 'repos/o/r/pulls', '--input', '-'], { input: '{"title":"$(rm -rf /)"}', env });
  assert.equal(echo.code, 0);
  assert.equal(echo.stdout, 'api\n-X\nPOST\nrepos/o/r/pulls\n--input\n-\n--stdin--\n{"title":"$(rm -rf /)"}');
  const huge = await runGh(['api', 'huge'], { env, maxBytes: 100_000 });
  assert.equal(huge.overflow, true);
  const started = Date.now();
  const slow = await runGh(['api', 'slow'], { env, timeoutMs: 200 });
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - started < 3000);
  const failed = await runGh(['api', 'fail'], { env });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /HTTP 422/);
  const missing = await runGh(['api'], { env: { ...process.env, PATH: bin.replace(/$/, '-nope') } });
  assert.ok(missing.spawnFailed || missing.code !== 0);
});

test('helpers: parseRepo and cleanText', () => {
  assert.deepEqual(parseRepo('memolabs-dev/.github'), { full: 'memolabs-dev/.github', owner: 'memolabs-dev', name: '.github' });
  assert.equal(parseRepo('a--b/c'), null);
  assert.equal(parseRepo('a/..'), null);
  assert.equal(parseRepo(`${'a'.repeat(40)}/x`), null);
  assert.equal(cleanText('a\u200fb\u2066c\u0085d', 10), 'abcd');
  assert.equal(cleanText('line1\r\nline2', 50, { multiline: true }), 'line1\nline2');
  assert.equal(cleanText('x'.repeat(20), 5), 'xxxx…');
});
