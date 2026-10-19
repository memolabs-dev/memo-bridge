// Phase 5, TODO-P5-08 (AC-P5-09, REQ-P5-09, REQ-P5-10, D9): the remote write invariants hold in
// the runtime whatever the caller sends (EV-P5-01: ChatGPT asked for no confirmation before a
// write). U-P5-13, read on 2026-10-14 before adding anything: worktrees.mjs already pushed only
// the worktree's own branch (refspec without '+', never main, master or the default branch, case
// folded) and github_create_pr already took its head from the worktree row (no head argument).
// Added and tested here: protected CI paths (write, commit, push), the remote project allowlist,
// a remote pull request only on a head this workspace pushed, client_request_id on worktree_push
// and github_create_pr, and the D8 session binding on worktree and pull request writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../server/runtime.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { registerWorktreeTools } from '../server/tools/worktree-tools.mjs';
import { registerGithubTools } from '../server/tools/github-tools.mjs';
import { createWorktreeRunner, pushedCommits } from '../server/runners/worktrees.mjs';
import { createGitHub } from '../server/integrations/github.mjs';
import { collectTools } from '../bridge/ops.mjs';
import { isProtectedRepoPath, parseRemotePolicy } from '../bridge/write-gate.mjs';

// Git must never read the user's own configuration in these tests.
const SANDBOX = await mkdtemp(join(tmpdir(), 'memo-guard-gitconfig-'));
await writeFile(join(SANDBOX, 'gitconfig'), ['[user]', '\tname = Test Owner', '\temail = owner@example.test',
  '[init]', '\tdefaultBranch = main', '[commit]', '\tgpgsign = false', ''].join('\n'));
process.env.GIT_CONFIG_GLOBAL = join(SANDBOX, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE']) {
  delete process.env[name];
}
test.after(() => rm(SANDBOX, { recursive: true, force: true }));

const ALL = Object.values(CAPABILITIES);
const LOCAL = makePrincipal('local:owner', ALL);
const CHAT = makePrincipal('oidc:owner-sub', ALL, { client_type: 'chatgpt', via: 'hub' });
const ISSUE = 'memolabs-dev/demo#7';
const ORIGIN_REPO = 'memolabs-dev/demo';
const S1 = 'a'.repeat(32);
const S2 = 'b'.repeat(32);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const REGISTRY = `# Projects

## Projets appartenant a Memo Labs

| Name | Path | Kind | Status | Nature | Stack | Vault |
|---|---|---|---|---|---|---|
| demo | demo | repo | active | test project | node | - |
| other | other | repo | active | test project | node | - |
`;

// The remote policy is read from MEMO_BRIDGE_REMOTE_CONFIG and cached per path: a fresh file per test.
async function policyFile(t, base, policy) {
  const file = join(base, `remote-${randomBytes(4).toString('hex')}.json`);
  await writeFile(file, JSON.stringify(policy));
  const previous = process.env.MEMO_BRIDGE_REMOTE_CONFIG;
  process.env.MEMO_BRIDGE_REMOTE_CONFIG = file;
  t.after(() => { if (previous === undefined) delete process.env.MEMO_BRIDGE_REMOTE_CONFIG; else process.env.MEMO_BRIDGE_REMOTE_CONFIG = previous; });
}

async function fixture(t, { principal = LOCAL, policy = { projects: ['demo'] } } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'memo-guard-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  await policyFile(t, base, policy);
  const projectsRoot = join(base, 'projects');
  const repo = join(projectsRoot, 'demo');
  await mkdir(repo, { recursive: true });
  await mkdir(join(projectsRoot, 'other'));
  await writeFile(join(projectsRoot, 'PROJECTS.md'), REGISTRY);
  git(repo, 'init', '-q', '-b', 'main');
  await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
  await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  await writeFile(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  const origin = join(base, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  process.env.MEMO_BRIDGE_WORKTREES_ROOT = join(base, 'worktrees');

  const receipt = async () => ({ ok: true, receipt: {} });
  const ledger = { status: receipt, claim: receipt, heartbeat: receipt, release: receipt, verify: receipt };
  const rt = createRuntime({ stateDir: join(base, 'state'), principal, ledger, catalogOptions: { projectsRoot }, host: 'mac',
    projectRemote: async () => ORIGIN_REPO });
  t.after(() => rt.close());
  const tools = {};
  registerWorktreeTools({ registerTool(name, def, handler) { tools[name] = { def, handler }; } }, () => rt);
  const call = async (name, args = {}) => JSON.parse((await tools[name].handler(tools[name].def.inputSchema.parse(args))).content[0].text);

  const addWorkspace = async ({ project = 'demo', client_session = null } = {}) => {
    const id = `ws_${randomBytes(12).toString('base64url')}`;
    await rt.store().transaction(r => r.insertWorkspace({ id, principal: principal.id, client_type: 'chatgpt', project_id: project,
      host: 'mac', status: 'active', created_at: Date.now(), updated_at: Date.now(), client_session }));
    await rt.store().transaction(r => {
      // v9: one claimed row per Issue in the store; a newer holder supersedes the earlier mirror row.
      for (const c of r.claimsOfIssue(ISSUE)) if (c.state === 'claimed') r.updateClaim(c.claim_id, { state: 'released', outcome: 'expired', updated_at: Date.now() }, c.fence_sha);
      r.insertClaim({ claim_id: randomBytes(16).toString('hex'), workspace_id: id, issue_ref: ISSUE,
        fence_sha: randomBytes(20).toString('hex'), epoch: 1, expires_at: new Date(Date.now() + 600_000).toISOString(), updated_at: Date.now() });
    });
    return id;
  };
  const ready = async (options = {}) => {
    const ws = await addWorkspace(options);
    const created = await call('worktree_create', { workspace_id: ws, issue: ISSUE });
    assert.equal(created.ok, true, JSON.stringify(created));
    const row = await rt.store().transaction(r => r.getWorktree(created.worktree.worktree_id), { write: false });
    return { ws, id: created.worktree.worktree_id, path: row.path, branch: row.branch };
  };
  return { base, repo, origin, rt, call, tools, ready, addWorkspace };
}

test('protected paths: workflows, actions and Dependabot under the root .github, any case or trailing dot', () => {
  for (const path of ['.github/workflows/ci.yml', '.github/workflows', '.GitHub/Workflows/x.yaml', '.github./workflows /x',
    '.github/actions/setup/action.yml', '.github//actions/x', './.github/workflows/x.yml', '.github/dependabot.yml',
    '.github/DEPENDABOT.YAML']) {
    assert.equal(isProtectedRepoPath(path), true, path);
  }
  for (const path of ['.github/CODEOWNERS', '.github/ISSUE_TEMPLATE/bug.md', '.github/pull_request_template.md', 'docs/.github/workflows/x.yml',
    'workflows/ci.yml', 'src/.github', '.github', 'github/workflows/x.yml', '.github/dependabot.yml.bak']) {
    assert.equal(isProtectedRepoPath(path), false, path);
  }
  assert.equal(isProtectedRepoPath(undefined), true, 'a non-string is never written');
});

test('AC-P5-09 write: worktree_write_file refuses protected paths, also through a symlinked parent; other .github files are fine', async t => {
  const f = await fixture(t);
  const { id, path } = await f.ready();
  for (const p of ['.github/workflows/evil.yml', '.GITHUB/workflows/evil.yml', '.github/actions/a/action.yml', '.github/dependabot.yml']) {
    const res = await f.call('worktree_write_file', { worktree_id: id, path: p, content: 'on: push\n' });
    assert.equal(res.error, 'path_protected', p);
  }
  // A job (or anything else) planted a link to .github: writing through it is refused too.
  await symlink('.github', join(path, 'ci'));
  assert.equal((await f.call('worktree_write_file', { worktree_id: id, path: 'ci/workflows/evil.yml', content: 'x' })).error, 'path_protected');
  assert.equal(git(path, 'status', '--porcelain', '--', '.github'), '', 'nothing was written under .github');
  assert.equal((await f.call('worktree_write_file', { worktree_id: id, path: '.github/CODEOWNERS', content: '* @owner\n' })).ok, true);
});

test('AC-P5-09 commit: a protected change written outside the tools is never committed; the index is put back', async t => {
  const f = await fixture(t);
  const { id, path } = await f.ready();
  const head = git(path, 'rev-parse', 'HEAD');
  await writeFile(join(path, '.github', 'workflows', 'ci.yml'), 'on: push\njobs: { pwn: { runs-on: self-hosted } }\n');
  await writeFile(join(path, 'notes.txt'), 'ok\n');
  const res = await f.call('worktree_commit', { worktree_id: id, message: 'feat: notes' });
  assert.equal(res.error, 'path_protected');
  assert.match(res.detail, /\.github\/workflows\/ci\.yml/);
  assert.equal(git(path, 'rev-parse', 'HEAD'), head, 'no commit');
  assert.equal(git(path, 'diff', '--cached', '--name-only'), '', 'nothing left staged');
  assert.match(git(path, 'status', '--porcelain'), /ci\.yml/, 'the file itself is left as it is');
  // A deletion counts as well.
  git(path, 'checkout', '--', '.github/workflows/ci.yml');
  await rm(join(path, '.github', 'workflows', 'ci.yml'));
  assert.equal((await f.call('worktree_commit', { worktree_id: id, message: 'feat: notes' })).error, 'path_protected');
  git(path, 'checkout', '--', '.github/workflows/ci.yml');
  assert.equal((await f.call('worktree_commit', { worktree_id: id, message: 'feat: notes' })).ok, true);
});

test('AC-P5-09 push: history touching a protected path is never pushed, even when a later commit reverts it', async t => {
  const f = await fixture(t);
  const { id, path, branch } = await f.ready();
  await writeFile(join(path, '.github', 'workflows', 'ci.yml'), 'on: push\njobs: {}\n');
  git(path, 'commit', '-q', '-am', 'outside Memo Bridge');
  git(path, 'revert', '--no-edit', 'HEAD');
  assert.equal(git(path, 'diff', 'origin/main', 'HEAD', '--name-only'), '', 'the tip is identical to the base');
  const res = await f.call('worktree_push', { worktree_id: id });
  assert.equal(res.error, 'path_protected');
  assert.throws(() => git(f.origin, 'rev-parse', '--verify', `refs/heads/${branch}`), 'nothing reached origin');
});

test('AC-P5-09 branch and force: never the default branch, never a forced update (U-P5-13, already enforced, kept under test)', async t => {
  const f = await fixture(t);
  const ws = await f.addWorkspace();
  for (const branch of ['main', 'MAIN', 'master']) {
    assert.equal((await f.call('worktree_create', { workspace_id: ws, issue: ISSUE, branch })).error, 'protected_branch', branch);
  }
  // No force argument exists: a forged one is stripped by the schema before the runner sees it.
  assert.deepEqual(Object.keys(f.tools.worktree_push.def.inputSchema.parse({ worktree_id: 'wt_AAAAAAAAAAAAAAAA', force: true })),
    ['worktree_id']);
  const { id, path, branch } = await f.ready();
  await f.call('worktree_write_file', { worktree_id: id, path: 'a.txt', content: 'a\n' });
  const first = await f.call('worktree_commit', { worktree_id: id, message: 'feat: a' });
  assert.equal((await f.call('worktree_push', { worktree_id: id })).ok, true);
  // Rewrite the pushed commit locally: the next push would need a force, and is rejected.
  git(path, 'commit', '-q', '--amend', '-m', 'feat: a, rewritten');
  const res = await f.call('worktree_push', { worktree_id: id });
  assert.equal(res.error, 'push_rejected');
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${branch}`), first.commit, 'origin keeps the first commit');
});

test('AC-P5-09 allowlist: a remote principal creates worktrees only for allowlisted projects; a local one is not limited', async t => {
  {
    const f = await fixture(t, { principal: CHAT, policy: { projects: ['other'] } });
    const ws = await f.addWorkspace();
    assert.equal((await f.call('worktree_create', { workspace_id: ws, issue: ISSUE })).error, 'project_not_allowed');
  }
  {
    const f = await fixture(t, { principal: CHAT, policy: {} });
    const ws = await f.addWorkspace();
    const res = await f.call('worktree_create', { workspace_id: ws, issue: ISSUE });
    assert.equal(res.error, 'project_not_allowed', 'an empty allowlist allows nothing');
  }
  {
    const f = await fixture(t, { principal: CHAT, policy: { projects: ['demo'] } });
    assert.equal((await f.ready()).branch.startsWith('agent/7-'), true);
  }
  {
    const f = await fixture(t, { principal: LOCAL, policy: { projects: ['other'] } });
    await f.ready();
  }
});

test('#216 a project added to remote.json while the runtime runs gets worktrees without a restart', async t => {
  const f = await fixture(t, { principal: CHAT, policy: { projects: ['other'] } });
  const ws = await f.addWorkspace();
  assert.equal((await f.call('worktree_create', { workspace_id: ws, issue: ISSUE })).error, 'project_not_allowed');
  // What project_create's enrollment does (server/projects/mac-enroll.mjs): the same file, one more project.
  await writeFile(process.env.MEMO_BRIDGE_REMOTE_CONFIG, JSON.stringify({ projects: ['other', 'demo'] }));
  const created = await f.call('worktree_create', { workspace_id: ws, issue: ISSUE });
  assert.equal(created.ok, true, JSON.stringify(created));
});

test('worktree_push with client_request_id: a retry returns the first push and pushes nothing new', async t => {
  const f = await fixture(t);
  const { id, path, branch } = await f.ready();
  const runner = createWorktreeRunner(f.rt, { remotePolicy: parseRemotePolicy({ projects: ['demo'] }) });
  await f.call('worktree_write_file', { worktree_id: id, path: 'a.txt', content: 'a\n' });
  await f.call('worktree_commit', { worktree_id: id, message: 'feat: a' });
  const first = await runner.push({ worktree_id: id, client_request_id: 'push-retry-0001' }, { ids: {} });
  assert.equal(first.ok, true, JSON.stringify(first));
  // New local work after the first push: a retry with the same id must not push it.
  await f.call('worktree_write_file', { worktree_id: id, path: 'b.txt', content: 'b\n' });
  await f.call('worktree_commit', { worktree_id: id, message: 'feat: b' });
  const retry = await runner.push({ worktree_id: id, client_request_id: 'push-retry-0001' }, { ids: {} });
  assert.equal(retry.replayed, true);
  assert.equal(retry.commit, first.commit);
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${branch}`), first.commit);
  const fresh = await runner.push({ worktree_id: id, client_request_id: 'push-retry-0002' }, { ids: {} });
  assert.equal(fresh.ok, true);
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${branch}`), git(path, 'rev-parse', 'HEAD'));
  assert.deepEqual(await pushedCommits(f.rt, id), [first.commit, fresh.commit]);
  assert.deepEqual(await runner.push({ worktree_id: id, client_request_id: 'no spaces' }, { ids: {} }),
    { ok: false, error: 'invalid_input', detail: 'client_request_id' });
});

test('AC-P5-10 worktree writes: another conversation warns (default) or is refused (block); metadata only, never arguments', async t => {
  const f = await fixture(t, { principal: CHAT });
  const { id, path } = await f.ready({ client_session: S1 });
  const block = createWorktreeRunner(f.rt, { remotePolicy: parseRemotePolicy({ projects: ['demo'], session_binding: 'block' }) });
  const warn = createWorktreeRunner(f.rt, { remotePolicy: parseRemotePolicy({ projects: ['demo'] }) });
  const args = { worktree_id: id, path: 'a.txt', content: 'a\n' };
  assert.deepEqual(await block.writeFile(args, { ids: {}, meta: { client_session: S2 } }), { ok: false, error: 'session_mismatch' });
  assert.equal(git(path, 'status', '--porcelain'), '', 'nothing written');
  for (const method of ['commit', 'push']) {
    assert.equal((await block[method]({ worktree_id: id, message: 'x' }, { ids: {}, meta: { client_session: S2 } })).error, 'session_mismatch', method);
  }
  const warned = await warn.writeFile(args, { ids: {}, meta: { client_session: S2 } });
  assert.equal(warned.ok, true);
  assert.equal(warned.session_warning, 'session_mismatch');
  assert.equal((await block.writeFile({ ...args, client_session: S1 }, { ids: {}, meta: { client_session: S1 } })).session_warning, undefined);
  assert.equal((await block.writeFile(args, { ids: {} })).ok, true, 'no session presented: no check');
});

test('no merge tool exists on any surface, and the GitHub integration has no merge call', async () => {
  const tools = await collectTools(() => { throw new Error('no runtime'); });
  assert.ok(tools.size > 30);
  assert.deepEqual([...tools.keys()].filter(name => /merge|land|approve/i.test(name)), []);
  assert.deepEqual(Object.keys(createGitHub()).filter(name => /merge|approve|land/i.test(name)), []);
});

// ---------------------------------------------------------------------------------------------
// github_create_pr and the GitHub reads, with a recording gh stub and the real local origin.

function fakeGh(prNumber = 42) {
  const calls = [];
  let created = null;
  const gh = async (args, opts = {}) => {
    const method = args[args.indexOf('-X') + 1];
    const endpoint = args.find(a => /^repos\//.test(a)) ?? '';
    calls.push({ method, endpoint, input: opts.input });
    const ok = data => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
    if (method === 'GET' && endpoint === `repos/${ORIGIN_REPO}`) return ok({ default_branch: 'main' });
    if (method === 'GET' && endpoint.startsWith(`repos/${ORIGIN_REPO}/pulls?`)) return ok(created ? [created] : []);
    if (method === 'GET' && endpoint.startsWith(`repos/${ORIGIN_REPO}/issues`)) return ok([]);
    if (method === 'POST' && endpoint === `repos/${ORIGIN_REPO}/pulls`) {
      const payload = JSON.parse(opts.input);
      created = { number: prNumber, title: payload.title, state: 'open', head: { ref: payload.head, sha: 'c'.repeat(40) },
        base: { ref: payload.base }, user: { login: 'owner' }, html_url: `https://github.com/${ORIGIN_REPO}/pull/${prNumber}` };
      return ok(created);
    }
    return { code: 1, stdout: '{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)' };
  };
  return { gh, calls };
}

test('#60 worktree_push under enforce records its checkpoint with the caller\'s session', async t => {
  // Seen live on 2026-10-15 (PR #59): the push went through, its checkpoint failed with
  // session_required because the runner called the Coordinator without the request metadata.
  const policy = { projects: ['demo'], session_binding: 'enforce' };
  const f = await fixture(t, { principal: CHAT, policy });
  const runner = createWorktreeRunner(f.rt, { remotePolicy: parseRemotePolicy(policy) });
  const ctx = { ids: {}, meta: { client_session: S1 } };
  const ws = await f.addWorkspace({ client_session: S1 });
  const created = await runner.create({ workspace_id: ws, issue: ISSUE }, ctx);
  assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.worktree.worktree_id;
  const written = await runner.writeFile({ worktree_id: id, path: 'a.txt', content: 'a\n' }, ctx);
  assert.equal(written.ok, true, JSON.stringify(written));
  const committed = await runner.commit({ worktree_id: id, message: 'feat: a' }, ctx);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const pushed = await runner.push({ worktree_id: id }, ctx);
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  assert.deepEqual(pushed.checkpoint, { ok: true, durability: 'remote' }, JSON.stringify(pushed));
  assert.equal(pushed.warning, undefined);
});

function githubServer(f, gh, policy) {
  const tools = {};
  registerGithubTools({ registerTool(name, def, handler) { tools[name] = { def, handler }; } }, () => f.rt,
    { gh, registeredRepos: async () => [ORIGIN_REPO, 'memolabs-dev/other'], projectRepo: async name => (name === 'demo' ? ORIGIN_REPO : 'memolabs-dev/other'),
      remotePolicy: parseRemotePolicy(policy) });
  return async (name, args, extra) => JSON.parse((await tools[name].handler(tools[name].def.inputSchema.parse(args), extra)).content[0].text);
}

async function pushedWorktree(f, options) {
  const ready = await f.ready(options);
  await f.call('worktree_write_file', { worktree_id: ready.id, path: 'a.txt', content: 'a\n' });
  await f.call('worktree_commit', { worktree_id: ready.id, message: 'feat: a' });
  const pushed = await f.call('worktree_push', { worktree_id: ready.id });
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  return ready;
}

test('AC-P5-09 pull request: remotely, only on a head this workspace pushed; head is always the worktree branch', async t => {
  const f = await fixture(t, { principal: CHAT });
  const { ws, id, branch, path } = await pushedWorktree(f);
  const { gh, calls } = fakeGh();
  const call = githubServer(f, gh, { projects: ['demo'] });
  // A forged head or base argument does not exist in the schema: it is stripped.
  const opened = await call('github_create_pr', { workspace_id: ws, worktree_id: id, title: 'feat: a', head: 'main', base: 'release' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const payload = JSON.parse(calls.find(c => c.method === 'POST').input);
  assert.deepEqual([payload.head, payload.base], [branch, 'main']);

  // Someone else moves the branch on GitHub (another session, a terminal): refused remotely.
  const other = git(f.repo, 'commit-tree', '-p', git(path, 'rev-parse', 'HEAD'), '-m', 'elsewhere', 'HEAD^{tree}');
  git(f.repo, 'push', '-q', 'origin', `${other}:refs/heads/${branch}`);
  const { gh: gh2, calls: calls2 } = fakeGh(43);
  const refused = await githubServer(f, gh2, { projects: ['demo'] })('github_create_pr', { workspace_id: ws, worktree_id: id, title: 'x' });
  assert.equal(refused.error, 'head_not_pushed_by_workspace');
  assert.ok(!calls2.some(c => c.method === 'POST'));
  const journal = await f.rt.store().transaction(r => r.listEvents({ limit: 50 }), { write: false });
  assert.ok(journal.some(e => e.op === 'github_create_pr' && e.outcome === 'denied' && e.code === 'head_not_pushed_by_workspace'));
});

test('AC-P5-09 allowlist on GitHub: remote reads and pull requests outside the allowlist are refused and journaled', async t => {
  const f = await fixture(t, { principal: CHAT });
  const { ws, id } = await pushedWorktree(f);
  const { gh, calls } = fakeGh();
  const call = githubServer(f, gh, { projects: ['other'] });
  assert.equal((await call('github_issues', { repo: ORIGIN_REPO })).error, 'project_not_allowed');
  assert.equal((await call('github_issues', { repo: 'memolabs-dev/.github' })).error, 'project_not_allowed', 'governance is not a remote project');
  assert.equal((await call('github_create_pr', { workspace_id: ws, worktree_id: id, title: 'x' })).error, 'project_not_allowed');
  assert.ok(!calls.some(c => c.method === 'POST'));
  assert.equal((await githubServer(f, gh, { projects: ['demo'] })('github_issues', { repo: ORIGIN_REPO })).ok, true);
  const denied = (await f.rt.store().transaction(r => r.listEvents({ limit: 50 }), { write: false }))
    .filter(e => e.code === 'project_not_allowed').map(e => `${e.op}:${e.outcome}`);
  assert.deepEqual(denied.sort(), ['github_create_pr:denied', 'github_issues:denied', 'github_issues:denied']);
});

test('github_create_pr: client_request_id replays the first result, and the session binding applies', async t => {
  const f = await fixture(t, { principal: CHAT });
  const { ws, id } = await pushedWorktree(f, { client_session: S1 });
  const { gh, calls } = fakeGh();
  const block = githubServer(f, gh, { projects: ['demo'], session_binding: 'block' });
  const meta = session => ({ meta: { client_session: session } });
  assert.equal((await block('github_create_pr', { workspace_id: ws, worktree_id: id, title: 'x' }, meta(S2))).error, 'session_mismatch');
  const first = await block('github_create_pr', { workspace_id: ws, worktree_id: id, title: 'x', client_request_id: 'pr-retry-0001' }, meta(S1));
  assert.equal(first.ok, true, JSON.stringify(first));
  const again = await block('github_create_pr', { workspace_id: ws, worktree_id: id, title: 'x', client_request_id: 'pr-retry-0001' }, meta(S1));
  assert.equal(again.replayed, true);
  assert.equal(again.number, first.number);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  const warn = githubServer(f, fakeGh().gh, { projects: ['demo'] });
  assert.equal((await warn('github_create_pr', { workspace_id: ws, worktree_id: id, title: 'y' }, meta(S2))).session_warning, 'session_mismatch');
});

// ---------------------------------------------------------------------------------------------
// Phase 5 fix F1 (D9, REQ-P5-10): a workflow change carried by another branch never reaches
// origin or a pull request through the `base` argument.

function featureWithWorkflowChange(f) {
  git(f.repo, 'checkout', '-q', '-b', 'feature');
  execFileSync('sh', ['-c', 'printf "on: push\\njobs: {evil: {}}\\n" > .github/workflows/ci.yml'], { cwd: f.repo });
  git(f.repo, 'commit', '-q', '-am', 'ci: bump');
  git(f.repo, 'push', '-q', 'origin', 'feature');
  git(f.repo, 'checkout', '-q', 'main');
}

test('F1 create: a remote principal may start only from the default branch, never from another branch or commit', async t => {
  const f = await fixture(t, { principal: CHAT });
  featureWithWorkflowChange(f);
  const ws = await f.addWorkspace();
  for (const base of ['origin/feature', git(f.repo, 'rev-parse', 'feature')]) {
    assert.equal((await f.call('worktree_create', { workspace_id: ws, issue: ISSUE, base })).error, 'base_not_allowed', base);
  }
  const ok = await f.call('worktree_create', { workspace_id: ws, issue: ISSUE, base: 'origin/main' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test('F1 push: protected changes are measured from the merge-base with origin/<default>, not only from the recorded base', async t => {
  const f = await fixture(t, { principal: LOCAL });
  featureWithWorkflowChange(f);
  const ws = await f.addWorkspace();
  const created = await f.call('worktree_create', { workspace_id: ws, issue: ISSUE, base: 'origin/feature' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.worktree.worktree_id;
  await f.call('worktree_write_file', { worktree_id: id, path: 'notes.txt', content: 'n\n' });
  assert.equal((await f.call('worktree_commit', { worktree_id: id, message: 'docs: notes' })).ok, true);
  const res = await f.call('worktree_push', { worktree_id: id });
  assert.equal(res.error, 'path_protected', JSON.stringify(res));
  assert.throws(() => git(f.origin, 'rev-parse', '--verify', `refs/heads/${created.worktree.branch}`), 'nothing reached origin');
});

test('F1 pull request: a remote PR whose head carries a protected change since the default branch is refused', async t => {
  const f = await fixture(t, { principal: CHAT });
  const { ws, id, path, branch } = await f.ready();
  // A protected change reaches the pushed head outside the tools (simulated: pushed by hand and
  // recorded as pushed by this workspace); the PR check must still see it.
  execFileSync('sh', ['-c', 'printf "on: push\\njobs: {evil: {}}\\n" > .github/workflows/ci.yml'], { cwd: path });
  git(path, 'commit', '-q', '-am', 'ci: outside');
  git(path, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  const sha = git(path, 'rev-parse', 'HEAD');
  await writeFile(join(f.rt.stateDir, 'worktrees', `${id}.json`), JSON.stringify({ head: sha, written: {}, pushed: [sha] }));
  assert.deepEqual(await pushedCommits(f.rt, id), [sha]);
  const { gh, calls } = fakeGh();
  const res = await githubServer(f, gh, { projects: ['demo'] })('github_create_pr', { workspace_id: ws, worktree_id: id, title: 'feat: x' });
  assert.equal(res.error, 'path_protected', JSON.stringify(res));
  assert.ok(!calls.some(c => c.method === 'POST'), 'no pull request was created');
});
