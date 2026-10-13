// Worktree tools end to end: a temporary registered repository with a bare origin, a private
// state directory per test, a stub lease ledger, and workspace/claim rows inserted directly.
// Nothing here touches the user's real state, ~/projects or GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../server/runtime.mjs';
import { CAPABILITIES, OPERATION_CAPABILITY, makePrincipal } from '../server/coordinator/policy.mjs';
import { WORKTREE_TOOLS, registerWorktreeTools } from '../server/tools/worktree-tools.mjs';
import { AI_ATTRIBUTION, LIMITS, insideWorktree, isProtectedBranch, normalizeRelPath, parseLsRemote } from '../server/runners/worktrees.mjs';

// Git must never read the user's own configuration (identity, signing, hooks) in these tests.
const SANDBOX = await mkdtemp(join(tmpdir(), 'memo-wt-gitconfig-'));
await writeFile(join(SANDBOX, 'gitconfig'), [
  '[user]', '\tname = Test Owner', '\temail = owner@example.test',
  '[init]', '\tdefaultBranch = main',
  '[commit]', '\tgpgsign = false',
  '[tag]', '\tgpgsign = false', ''
].join('\n'));
process.env.GIT_CONFIG_GLOBAL = join(SANDBOX, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE']) {
  delete process.env[name];
}
test.after(() => rm(SANDBOX, { recursive: true, force: true }));

const OWNER = makePrincipal('local:owner', Object.values(CAPABILITIES));
const STRANGER = 'local:stranger';
const READER = makePrincipal('local:reader', [CAPABILITIES.READ]);
const ISSUE = 'memolabs-dev/demo#7';
const RLO = String.fromCharCode(0x202e);
const REPLACEMENT = String.fromCharCode(0xfffd);

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const REGISTRY = `# Projects

## Projets appartenant a Memo Labs

| Name | Path | Kind | Status | Nature | Stack | Vault |
|---|---|---|---|---|---|---|
| demo | demo | repo | active | test project | node | - |
| notes | notes | folder | active | documents | - | - |
`;

// A registered repository `demo` with a bare origin, a worktrees root, a runtime with a private
// state directory and a stub ledger, and the worktree tools registered on a fake MCP server.
async function fixture(t, { principal = OWNER } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'memo-wt-')));
  const projectsRoot = join(base, 'projects');
  const repo = join(projectsRoot, 'demo');
  await mkdir(repo, { recursive: true });
  await mkdir(join(projectsRoot, 'notes'));
  await writeFile(join(projectsRoot, 'PROJECTS.md'), REGISTRY);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# demo\n');
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  const origin = join(base, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');

  const worktrees = join(base, 'worktrees');
  process.env.MEMO_BRIDGE_WORKTREES_ROOT = worktrees;

  const ledgerCalls = [];
  const state = { verify: { ok: true, receipt: {} } };
  const receipt = async () => ({ ok: true, receipt: {} });
  const ledger = {
    status: receipt, claim: receipt, heartbeat: receipt, release: receipt,
    verify: async (...args) => { ledgerCalls.push(args); return state.verify; }
  };
  const rt = createRuntime({ stateDir: join(base, 'state'), principal, ledger, catalogOptions: { projectsRoot }, host: 'mac' });
  t.after(async () => { await rt.close(); await rm(base, { recursive: true, force: true }); });

  const tools = {};
  registerWorktreeTools({ registerTool(name, def, handler) { tools[name] = { def, handler }; } }, () => rt);
  const call = async (name, args = {}) => {
    const parsed = tools[name].def.inputSchema.parse(args);
    const response = await tools[name].handler(parsed);
    return JSON.parse(response.content[0].text);
  };

  const addWorkspace = async ({ owner = principal.id, status = 'active', host = 'mac', project = 'demo' } = {}) => {
    const id = `ws_${randomBytes(12).toString('base64url')}`;
    const at = Date.now();
    await rt.store().transaction(r => r.insertWorkspace({ id, principal: owner, client_type: 'claude-code', client_label: null,
      project_id: project, host, branch: null, status, created_at: at, updated_at: at }));
    return id;
  };
  const addClaim = async (workspaceId, { issue = ISSUE, expiresInMs = 10 * 60 * 1000 } = {}) => {
    const claim = { claim_id: randomBytes(16).toString('hex'), workspace_id: workspaceId, issue_ref: issue,
      fence_sha: randomBytes(20).toString('hex'), epoch: 1, expires_at: new Date(Date.now() + expiresInMs).toISOString(),
      updated_at: Date.now() };
    await rt.store().transaction(r => r.insertClaim(claim));
    return claim;
  };
  const events = () => rt.store().transaction(r => r.listEvents({ limit: 500 }), { write: false })
    .then(rows => rows.reverse().map(e => `${e.op}:${e.outcome}${e.code ? `:${e.code}` : ''}`));
  const row = id => rt.store().transaction(r => r.getWorktree(id), { write: false });

  // Workspace + live claim + worktree on the claimed Issue.
  const ready = async (extra = {}) => {
    const ws = await addWorkspace();
    const claim = await addClaim(ws);
    const created = await call('worktree_create', { workspace_id: ws, issue: ISSUE, ...extra });
    assert.equal(created.ok, true, JSON.stringify(created));
    const wt = created.worktree;
    const path = (await row(wt.worktree_id)).path;
    return { ws, claim, wt, id: wt.worktree_id, path };
  };

  return { base, repo, origin, worktrees, rt, call, tools, ledgerCalls, state, addWorkspace, addClaim, events, row, ready, projectsRoot };
}

test('registers the ten worktree tools, each mapped to a capability', async t => {
  const f = await fixture(t);
  assert.deepEqual(Object.keys(f.tools).sort(), [...WORKTREE_TOOLS].sort());
  assert.equal(WORKTREE_TOOLS.length, 10);
  for (const name of WORKTREE_TOOLS) assert.ok(OPERATION_CAPABILITY[name], `${name} has a capability`);
  for (const name of ['worktree_create', 'worktree_write_file', 'worktree_commit', 'worktree_push', 'worktree_remove']) {
    assert.equal(OPERATION_CAPABILITY[name], CAPABILITIES.REPO_WRITE);
  }
  // No identity in any schema.
  for (const { def } of Object.values(f.tools)) {
    const keys = Object.keys(def.inputSchema.shape);
    assert.ok(!keys.some(k => /principal|worker|owner/.test(k)), keys.join(','));
  }
});

test('full cycle: create, write, read, list, diff, commit, push with checkpoint, remove', async t => {
  const f = await fixture(t);
  const ws = await f.addWorkspace();
  const claim = await f.addClaim(ws);
  const baseCommit = git(f.repo, 'rev-parse', 'HEAD');

  const created = await f.call('worktree_create', { workspace_id: ws, issue: ISSUE });
  assert.equal(created.ok, true, JSON.stringify(created));
  const wt = created.worktree;
  const branch = `agent/7-${ws.slice(3, 11).toLowerCase()}`;
  assert.match(wt.worktree_id, /^wt_[A-Za-z0-9_-]{16}$/);
  assert.equal(wt.branch, branch);
  assert.equal(wt.base_ref, 'origin/main');
  assert.equal(wt.base_commit, baseCommit);
  assert.equal(wt.issue, ISSUE);
  assert.equal(wt.host, 'mac');
  assert.equal(wt.path, undefined, 'local paths never leave the server');
  const path = join(f.worktrees, 'demo', branch.replaceAll('/', '-'));
  assert.equal((await f.row(wt.worktree_id)).path, path);
  assert.equal(git(path, 'symbolic-ref', '--short', 'HEAD'), branch);
  const id = wt.worktree_id;

  assert.equal((await f.call('worktrees_list')).count, 1);
  assert.equal((await f.call('worktrees_list', { workspace_id: ws })).worktrees[0].worktree_id, id);

  let status = await f.call('worktree_status', { worktree_id: id });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.clean, true);
  assert.equal(status.head, baseCommit);
  assert.deepEqual([status.base.ahead, status.base.behind], [0, 0]);
  assert.equal(status.remote, null);
  assert.equal(status.external_edits.detected, false);
  assert.equal(status.last_commits.length, 1);
  assert.equal(status.last_commits[0].subject, 'initial');

  const written = await f.call('worktree_write_file', { worktree_id: id, path: 'src/app/main.txt', content: 'hello\n' });
  assert.deepEqual(written, { ok: true, path: 'src/app/main.txt', bytes: 6, created: true });
  const readBack = await f.call('worktree_read_file', { worktree_id: id, path: 'src/app/main.txt' });
  assert.equal(readBack.content, 'hello\n');
  assert.equal(readBack.truncated, false);
  assert.equal((await f.call('worktree_write_file', { worktree_id: id, path: 'README.md', content: '# demo\nmore\n' })).created, false);

  const files = await f.call('worktree_list_files', { worktree_id: id });
  assert.deepEqual(files.files.sort(), ['.gitignore', 'README.md', 'src/app/main.txt']);
  assert.deepEqual((await f.call('worktree_list_files', { worktree_id: id, path: 'src' })).files, ['src/app/main.txt']);

  const diff = await f.call('worktree_diff', { worktree_id: id });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assert.match(diff.diff, /\+more/);
  assert.match(diff.stat, /README\.md/);
  assert.deepEqual(diff.untracked, ['src/app/main.txt']);

  status = await f.call('worktree_status', { worktree_id: id });
  assert.equal(status.changes_count, 2);
  assert.equal(status.external_edits.detected, false, JSON.stringify(status.external_edits));

  const committed = await f.call('worktree_commit', { worktree_id: id, message: 'feat: add main\n\nBody line.' });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.match(committed.commit, /^[0-9a-f]{40}$/);
  assert.equal(git(path, 'log', '-1', '--format=%an <%ae>'), 'Test Owner <owner@example.test>');
  assert.equal(git(path, 'log', '-1', '--format=%B'), 'feat: add main\n\nBody line.', 'nothing is added to the message');
  assert.deepEqual(f.ledgerCalls[0].slice(1), [`mb.mac.${ws}`, claim.claim_id, claim.fence_sha]);
  assert.equal(f.ledgerCalls[0][0].ref, ISSUE);

  const pushed = await f.call('worktree_push', { worktree_id: id });
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  assert.equal(pushed.remote_ref, `refs/heads/${branch}`);
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${branch}`), committed.commit);
  assert.deepEqual(pushed.checkpoint, { ok: true, durability: 'remote' });
  const checkpoints = await f.rt.store().transaction(r => r.listCheckpoints(ISSUE, 10), { write: false });
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].commit_sha, committed.commit);
  assert.equal(checkpoints[0].branch, branch);
  assert.equal(git(path, 'rev-parse', '--abbrev-ref', '@{upstream}'), `origin/${branch}`);

  status = await f.call('worktree_status', { worktree_id: id });
  assert.equal(status.clean, true);
  assert.equal(status.base.ahead, 1);
  assert.deepEqual(status.remote, { ref: `origin/${branch}`, ahead: 0, behind: 0 });
  assert.equal(status.external_edits.detected, false, JSON.stringify(status.external_edits));

  const removed = await f.call('worktree_remove', { worktree_id: id });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.worktree.status, 'removed');
  assert.equal(existsSync(path), false);
  assert.equal(git(f.repo, 'rev-parse', `refs/heads/${branch}`), committed.commit, 'the branch is kept');
  assert.equal((await f.call('worktree_remove', { worktree_id: id })).already_removed, true);
  assert.equal((await f.call('worktree_status', { worktree_id: id })).error, 'worktree_removed');

  const ops = await f.events();
  for (const op of ['worktree_create:ok', 'worktree_write_file:ok', 'worktree_commit:ok', 'worktree_push:ok', 'worktree_remove:ok']) {
    assert.ok(ops.includes(op), `${op} in ${ops.join(', ')}`);
  }
  assert.ok(!ops.some(op => /^(worktrees_list|worktree_(status|read_file|list_files|diff)):ok/.test(op)), 'successful reads are not journaled');
  assert.ok(ops.includes('worktree_status:denied:worktree_removed'), 'read refusals are');
});

test('worktree_create refusals: claim, branch, existing branch or path, ownership, host, project', async t => {
  const f = await fixture(t);
  const ws = await f.addWorkspace();
  const create = args => f.call('worktree_create', { workspace_id: ws, ...args });

  assert.equal((await create({ issue: ISSUE })).error, 'no_live_claim', 'no claim at all');
  await f.addClaim(ws, { expiresInMs: -1000 });
  assert.equal((await create({ issue: ISSUE })).error, 'no_live_claim', 'expired claim');
  await f.addClaim(ws);
  assert.equal((await create({ issue: 'memolabs-dev/demo#8' })).error, 'no_live_claim', 'claim on another issue');
  assert.equal((await create({ issue: 'not an issue' })).error, 'invalid_input');

  assert.equal((await create({ issue: ISSUE, branch: 'main' })).error, 'protected_branch');
  assert.equal((await create({ issue: ISSUE, branch: 'master' })).error, 'protected_branch');
  assert.equal((await create({ issue: ISSUE, branch: '../escape' })).error, 'invalid_input');
  assert.equal((await create({ issue: ISSUE, branch: 'refs/heads/x' })).error, 'invalid_input');
  assert.equal((await create({ issue: ISSUE, base: '--upload-pack=x' })).error, 'invalid_input');

  git(f.repo, 'branch', 'taken');
  assert.deepEqual(await create({ issue: ISSUE, branch: 'taken' }), { ok: false, error: 'branch_exists', detail: 'local' });
  // A branch that exists only on the remote, not yet fetched: create fetches first.
  git(f.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/remote-only');
  git(f.repo, 'update-ref', '-d', 'refs/remotes/origin/remote-only');
  assert.deepEqual(await create({ issue: ISSUE, branch: 'remote-only' }), { ok: false, error: 'branch_exists', detail: 'remote' });

  await mkdir(join(f.worktrees, 'demo', 'agent-occupied'), { recursive: true });
  assert.equal((await create({ issue: ISSUE, branch: 'agent/occupied' })).error, 'path_exists');
  assert.equal(git(f.repo, 'branch', '--list', 'agent/occupied'), '', 'nothing was created');

  assert.equal((await create({ issue: ISSUE, base: 'origin/does-not-exist' })).error, 'unknown_base');

  const closed = await f.addWorkspace({ status: 'closed' });
  assert.equal((await f.call('worktree_create', { workspace_id: closed })).error, 'workspace_closed');
  const foreign = await f.addWorkspace({ owner: STRANGER });
  assert.equal((await f.call('worktree_create', { workspace_id: foreign })).error, 'forbidden');
  const vps = await f.addWorkspace({ host: 'vps' });
  assert.equal((await f.call('worktree_create', { workspace_id: vps })).error, 'wrong_host');
  const notes = await f.addWorkspace({ project: 'notes' });
  assert.equal((await f.call('worktree_create', { workspace_id: notes })).error, 'project_not_a_repo');
  assert.equal((await f.call('worktree_create', { workspace_id: 'ws_AAAAAAAAAAAAAAAA' })).error, 'unknown_workspace');

  assert.equal((await f.call('worktrees_list')).count, 0);
  assert.equal((await f.call('worktrees_list', { workspace_id: foreign })).error, 'forbidden');
  const ops = await f.events();
  assert.ok(ops.includes('worktree_create:denied:forbidden'));
  assert.ok(ops.includes('worktree_create:denied:no_live_claim'));
  assert.ok(ops.includes('worktree_create:denied:protected_branch'));
  assert.ok(ops.includes('worktrees_list:denied:forbidden'), 'read refusals are journaled');

  // Without an issue the worktree is created (read-only use), on a workspace branch.
  const plain = await create({});
  assert.equal(plain.ok, true, JSON.stringify(plain));
  assert.equal(plain.worktree.branch, `agent/ws-${ws.slice(3, 11).toLowerCase()}`);
  assert.equal(plain.worktree.issue, null);
});

test('authorization runs first and every refusal is journaled', async t => {
  const f = await fixture(t, { principal: READER });
  const ws = await f.addWorkspace();
  assert.deepEqual(await f.call('worktree_create', { workspace_id: ws, issue: ISSUE }), { ok: false, error: 'forbidden' });
  // Even with an id that does not exist: authorization comes before validation.
  assert.deepEqual(await f.call('worktree_write_file', { worktree_id: 'wt_doesnotexist0000', path: 'x', content: '' }),
    { ok: false, error: 'forbidden' });
  assert.equal((await f.call('worktrees_list')).ok, true, 'reading is allowed');
  const ops = await f.events();
  assert.deepEqual(ops, ['worktree_create:denied:forbidden', 'worktree_write_file:denied:forbidden']);
});

test('paths stay inside the worktree: traversal, absolute, .git, symlinks', async t => {
  const f = await fixture(t);
  const { id, path } = await f.ready();
  await writeFile(join(f.base, 'secret.txt'), 'outside\n');
  await symlink(f.base, join(path, 'link-dir'));
  await symlink(join(f.base, 'secret.txt'), join(path, 'link-file.txt'));
  await symlink(join(path, '.git'), join(path, 'link-git'));

  for (const bad of ['../secret.txt', '/etc/passwd', '.git/config', '.git', 'a/.GIT/x', 'a/../../x', '~/x', 'a\\b',
    `a${String.fromCharCode(0x200c)}b`, `.git${String.fromCharCode(0)}`]) {
    assert.equal((await f.call('worktree_read_file', { worktree_id: id, path: bad })).error, 'invalid_input', bad);
    assert.equal((await f.call('worktree_write_file', { worktree_id: id, path: bad, content: 'x' })).error, 'invalid_input', bad);
  }
  assert.equal((await f.call('worktree_read_file', { worktree_id: id, path: 'link-dir/secret.txt' })).error, 'path_not_allowed');
  assert.equal((await f.call('worktree_read_file', { worktree_id: id, path: 'link-file.txt' })).error, 'path_not_allowed');
  assert.equal((await f.call('worktree_read_file', { worktree_id: id, path: 'link-git' })).error, 'path_not_allowed');
  assert.equal((await f.call('worktree_list_files', { worktree_id: id, path: 'link-dir' })).error, 'path_not_allowed');
  assert.equal((await f.call('worktree_write_file', { worktree_id: id, path: 'link-dir/new.txt', content: 'x' })).error, 'path_not_allowed');
  assert.equal((await f.call('worktree_write_file', { worktree_id: id, path: 'link-dir/deep/new.txt', content: 'x' })).error, 'path_not_allowed');
  assert.equal((await f.call('worktree_write_file', { worktree_id: id, path: 'link-file.txt', content: 'x' })).error, 'path_not_allowed');
  assert.equal(existsSync(join(f.base, 'new.txt')), false);
  assert.equal(existsSync(join(f.base, 'deep')), false);
  assert.equal(await readFile(join(f.base, 'secret.txt'), 'utf8'), 'outside\n');
  assert.equal((await f.call('worktree_read_file', { worktree_id: id, path: 'missing.txt' })).error, 'not_found');
  assert.equal((await f.call('worktree_read_file', { worktree_id: id, path: 'link-dir' })).error, 'path_not_allowed');
  await mkdir(join(path, 'folder'));
  assert.equal((await f.call('worktree_read_file', { worktree_id: id, path: 'folder' })).error, 'not_a_file');
  assert.equal((await f.call('worktree_write_file', { worktree_id: id, path: 'folder', content: 'x' })).error, 'not_a_file');
});

test('reads are bounded, text only, and sanitized; writes are bounded and need a live claim', async t => {
  const f = await fixture(t);
  const { ws, id, path } = await f.ready();

  await writeFile(join(path, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  assert.equal((await f.call('worktree_read_file', { worktree_id: id, path: 'image.bin' })).error, 'binary_file');
  await writeFile(join(path, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  assert.equal((await f.call('worktree_read_file', { worktree_id: id, path: 'latin1.txt' })).error, 'binary_file');

  // 300 KiB of two-byte characters with an odd prefix, so the 256 KiB window cuts a character.
  const big = `x${'é'.repeat(150 * 1024)}\n`;
  await writeFile(join(path, 'big.txt'), big);
  const first = await f.call('worktree_read_file', { worktree_id: id, path: 'big.txt' });
  assert.equal(first.truncated, true);
  assert.ok(first.bytes <= LIMITS.readBytes);
  assert.ok(!first.content.includes(REPLACEMENT));
  const rest = await f.call('worktree_read_file', { worktree_id: id, path: 'big.txt', offset: first.next_offset });
  assert.equal(rest.truncated, false);
  assert.equal(first.content + rest.content, big);
  // A window that starts inside a character skips to the next one.
  const odd = await f.call('worktree_read_file', { worktree_id: id, path: 'big.txt', offset: 2, limit: 10 });
  assert.equal(odd.offset, 3);
  assert.equal(odd.content, 'é'.repeat(4));

  await writeFile(join(path, 'tricky.txt'), `ok ${RLO}evil${String.fromCharCode(7)}\tend\n`);
  const tricky = await f.call('worktree_read_file', { worktree_id: id, path: 'tricky.txt' });
  assert.equal(tricky.content, `ok ${REPLACEMENT}evil${REPLACEMENT}\tend\n`);
  assert.equal(tricky.replaced_characters, 2);

  const tooBig = 'é'.repeat(300 * 1024); // 600 KiB once encoded
  assert.equal((await f.call('worktree_write_file', { worktree_id: id, path: 'huge.txt', content: tooBig })).error, 'invalid_input');
  assert.equal(existsSync(join(path, 'huge.txt')), false);

  // No claim on the worktree's issue: reading works, writing does not.
  const plain = await f.call('worktree_create', { workspace_id: ws, branch: 'agent/readonly' });
  assert.equal(plain.ok, true, JSON.stringify(plain));
  const readonly = plain.worktree.worktree_id;
  assert.equal((await f.call('worktree_read_file', { worktree_id: readonly, path: 'README.md' })).content, '# demo\n');
  assert.equal((await f.call('worktree_write_file', { worktree_id: readonly, path: 'a.txt', content: 'x' })).error, 'no_live_claim');

  // Expired claim: writes stop.
  await f.rt.store().transaction(r => {
    for (const c of r.claimsOf(ws, 'claimed')) r.updateClaim(c.claim_id, { expires_at: new Date(Date.now() - 1000).toISOString() }, c.fence_sha);
  });
  assert.equal((await f.call('worktree_write_file', { worktree_id: id, path: 'a.txt', content: 'x' })).error, 'no_live_claim');
  // A closed workspace cannot write either.
  await f.rt.store().transaction(r => r.updateWorkspace(ws, { status: 'closed', closed_at: Date.now(), updated_at: Date.now() }));
  assert.equal((await f.call('worktree_write_file', { worktree_id: id, path: 'a.txt', content: 'x' })).error, 'workspace_closed');
  assert.ok((await f.events()).includes('worktree_write_file:denied:no_live_claim'));
});

test('commit and push: ledger verification, message rules, empty commits, branch switches, no force', async t => {
  const f = await fixture(t);
  const { id, path, wt } = await f.ready();

  assert.equal((await f.call('worktree_commit', { worktree_id: id, message: 'empty' })).error, 'nothing_to_commit');
  assert.equal((await f.call('worktree_commit', { worktree_id: id, message: `bad ${String.fromCharCode(27)}[31m` })).error, 'invalid_input');
  assert.equal((await f.call('worktree_commit', { worktree_id: id, message: `subject ${RLO}` })).error, 'invalid_input');
  assert.equal((await f.call('worktree_commit', { worktree_id: id, message: '   ' })).error, 'invalid_input');
  assert.equal((await f.call('worktree_commit', { worktree_id: id,
    message: 'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>' })).error, 'invalid_input');

  await f.call('worktree_write_file', { worktree_id: id, path: 'a.txt', content: 'a\n' });
  const head = git(path, 'rev-parse', 'HEAD');
  f.state.verify = { ok: false, error: 'stale_lease', detail: 'Missing or superseded lease' };
  assert.equal((await f.call('worktree_commit', { worktree_id: id, message: 'feat: a' })).error, 'stale_lease');
  assert.equal(git(path, 'rev-parse', 'HEAD'), head, 'nothing was committed');
  assert.equal(git(path, 'diff', '--cached', '--name-only'), '', 'nothing was staged');
  f.state.verify = { ok: true, receipt: {} };
  const first = await f.call('worktree_commit', { worktree_id: id, message: 'feat: a' });
  assert.equal(first.ok, true, JSON.stringify(first));

  f.state.verify = { ok: false, error: 'stale_lease' };
  assert.equal((await f.call('worktree_push', { worktree_id: id })).error, 'stale_lease');
  assert.throws(() => git(f.origin, 'rev-parse', '--verify', `refs/heads/${wt.branch}`), 'nothing was pushed');
  f.state.verify = { ok: true, receipt: {} };
  assert.equal((await f.call('worktree_push', { worktree_id: id })).ok, true);

  // Another machine moves the remote branch: our next push is rejected, never forced.
  const other = git(f.repo, 'commit-tree', '-p', first.commit, '-m', 'from elsewhere', `${first.commit}^{tree}`);
  git(f.repo, 'push', '-q', 'origin', `${other}:refs/heads/${wt.branch}`);
  await f.call('worktree_write_file', { worktree_id: id, path: 'b.txt', content: 'b\n' });
  const second = await f.call('worktree_commit', { worktree_id: id, message: 'feat: b' });
  assert.equal(second.ok, true);
  assert.equal((await f.call('worktree_push', { worktree_id: id })).error, 'push_rejected');
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${wt.branch}`), other, 'the remote branch is untouched');

  // Someone switched the worktree to another branch outside Memo Bridge.
  git(path, 'switch', '-q', '-c', 'elsewhere');
  assert.equal((await f.call('worktree_write_file', { worktree_id: id, path: 'c.txt', content: 'c' })).error, 'branch_changed');
  assert.equal((await f.call('worktree_commit', { worktree_id: id, message: 'feat: c' })).error, 'branch_changed');
  assert.equal((await f.call('worktree_push', { worktree_id: id })).error, 'branch_changed');
  const status = await f.call('worktree_status', { worktree_id: id });
  assert.equal(status.external_edits.branch_switched, true);

  const ops = await f.events();
  assert.ok(ops.includes('worktree_commit:denied:stale_lease'));
  assert.ok(ops.includes('worktree_push:denied:stale_lease'));
  assert.ok(ops.includes('worktree_push:denied:push_rejected'));
  assert.ok(ops.includes('worktree_commit:error:nothing_to_commit'));
});

test('worktree_status detects edits made outside Memo Bridge', async t => {
  const f = await fixture(t);
  const { id, path } = await f.ready();
  await f.call('worktree_write_file', { worktree_id: id, path: 'mine.txt', content: 'mine\n' });
  let status = await f.call('worktree_status', { worktree_id: id });
  assert.equal(status.external_edits.detected, false, JSON.stringify(status.external_edits));

  await writeFile(join(path, 'mine.txt'), 'changed by an IDE\n');
  await writeFile(join(path, 'theirs.txt'), 'new\n');
  await writeFile(join(path, 'README.md'), 'edited\n');
  status = await f.call('worktree_status', { worktree_id: id });
  assert.equal(status.external_edits.detected, true);
  assert.deepEqual(status.external_edits.modified_after_write, ['mine.txt']);
  assert.deepEqual(status.external_edits.unknown_changes.sort(), ['README.md', 'theirs.txt']);
  assert.equal(status.external_edits.head_moved, false);

  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'outside commit');
  status = await f.call('worktree_status', { worktree_id: id });
  assert.equal(status.external_edits.head_moved, true);
  assert.equal(status.last_commits[0].subject, 'outside commit');
});

test('worktree_remove refuses dirty, untracked and unpushed work, then removes without force', async t => {
  const f = await fixture(t);
  const { ws, id, path } = await f.ready();

  await writeFile(join(path, 'README.md'), 'modified\n');
  assert.deepEqual(await f.call('worktree_remove', { worktree_id: id }),
    { ok: false, error: 'worktree_dirty', detail: '1 modified, 0 untracked' });
  git(path, 'checkout', '--', 'README.md');
  await writeFile(join(path, 'new.txt'), 'x');
  assert.equal((await f.call('worktree_remove', { worktree_id: id })).error, 'worktree_dirty');

  assert.equal((await f.call('worktree_commit', { worktree_id: id, message: 'feat: new' })).ok, true);
  assert.deepEqual(await f.call('worktree_remove', { worktree_id: id }),
    { ok: false, error: 'unpushed_commits', detail: '1 commit(s) not on origin' });
  assert.ok(existsSync(path));

  assert.equal((await f.call('worktree_push', { worktree_id: id })).ok, true);
  // Cleanup stays possible after the workspace is closed.
  await f.rt.store().transaction(r => r.updateWorkspace(ws, { status: 'closed', closed_at: Date.now(), updated_at: Date.now() }));
  const removed = await f.call('worktree_remove', { worktree_id: id });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(existsSync(path), false);
  assert.ok(!git(f.repo, 'worktree', 'list').includes(path));
  const ops = await f.events();
  assert.ok(ops.includes('worktree_remove:denied:worktree_dirty'));
  assert.ok(ops.includes('worktree_remove:denied:unpushed_commits'));
  assert.ok(ops.includes('worktree_remove:ok'));
});

test('another principal can neither see nor use a worktree', async t => {
  const f = await fixture(t);
  const { id } = await f.ready();
  const stranger = createRuntime({ stateDir: f.rt.stateDir, principal: makePrincipal(STRANGER, Object.values(CAPABILITIES)),
    ledger: f.rt.ledger, catalogOptions: f.rt.catalogOptions, host: 'mac' });
  t.after(() => stranger.close());
  const tools = {};
  registerWorktreeTools({ registerTool(name, def, handler) { tools[name] = handler; } }, () => stranger);
  const call = async (name, args) => JSON.parse((await tools[name](args)).content[0].text);
  for (const name of ['worktree_status', 'worktree_diff', 'worktree_push', 'worktree_remove']) {
    assert.equal((await call(name, { worktree_id: id })).error, 'forbidden', name);
  }
  assert.equal((await call('worktree_read_file', { worktree_id: id, path: 'README.md' })).error, 'forbidden');
  assert.equal((await call('worktree_write_file', { worktree_id: id, path: 'x.txt', content: 'x' })).error, 'forbidden');
  assert.equal((await call('worktrees_list', {})).count, 0);
});

test('no repository hook ever runs, even one a model could write', async t => {
  const f = await fixture(t);
  // The repository points core.hooksPath at a tracked directory: anything written there by a
  // model would run on checkout, commit and push if hooks were enabled.
  const markers = join(f.base, 'markers');
  await mkdir(markers);
  await mkdir(join(f.repo, '.hooks'));
  for (const hook of ['post-checkout', 'pre-commit', 'commit-msg', 'post-commit', 'pre-push', 'reference-transaction']) {
    await writeFile(join(f.repo, '.hooks', hook), `#!/bin/sh\ntouch "${markers}/${hook}"\n`, { mode: 0o755 });
  }
  git(f.repo, 'add', '.hooks');
  git(f.repo, 'commit', '-q', '-m', 'hooks');
  git(f.repo, 'push', '-q', 'origin', 'main');
  git(f.repo, 'config', 'core.hooksPath', '.hooks');
  // Sanity check: plain git does run them.
  git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'probe');
  assert.ok(existsSync(join(markers, 'pre-commit')), 'the hooks are live for plain git');
  git(f.repo, 'reset', '-q', '--soft', 'HEAD~1');
  await rm(markers, { recursive: true });
  await mkdir(markers);

  const { id } = await f.ready();
  assert.equal((await f.call('worktree_write_file', { worktree_id: id, path: '.hooks/pre-commit',
    content: `#!/bin/sh\ntouch "${markers}/model"\n` })).ok, true);
  assert.equal((await f.call('worktree_commit', { worktree_id: id, message: 'feat: hooks' })).ok, true);
  assert.equal((await f.call('worktree_push', { worktree_id: id })).ok, true);
  assert.equal((await f.call('worktree_remove', { worktree_id: id })).ok, true);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(markers), [], 'no hook ran');
});

test('path helpers', () => {
  assert.equal(normalizeRelPath('a//b/./c/'), 'a/b/c');
  assert.equal(normalizeRelPath('', { allowRoot: true }), '');
  assert.equal(normalizeRelPath('.', { allowRoot: true }), '');
  assert.equal(normalizeRelPath(''), null);
  for (const bad of ['..', 'a/..', '/a', '.git', '.Git/x', 'x/.git', '.git.', 'a\\b', 'x'.repeat(2000)]) {
    assert.equal(normalizeRelPath(bad), null, bad);
  }
  assert.equal(normalizeRelPath('.github/workflows/ci.yml'), '.github/workflows/ci.yml');
  assert.equal(normalizeRelPath('.gitignore'), '.gitignore');
  assert.equal(insideWorktree('/w/t', '/w/t'), true);
  assert.equal(insideWorktree('/w/t', '/w/t/a/b'), true);
  assert.equal(insideWorktree('/w/t', '/w/tx'), false);
  assert.equal(insideWorktree('/w/t', '/w'), false);
  assert.equal(insideWorktree('/w/t', '/w/t/.git'), false);
  assert.equal(insideWorktree('/w/t', '/w/t/sub/.git/config'), false);
});

// ---------------------------------------------------------------------------------------------
// Regressions from the adversarial review of 933e759 (finding numbers in the test names).

test('finding 1: a case variant of the default branch or of an existing branch is refused (APFS)', async t => {
  const f = await fixture(t);
  const ws = await f.addWorkspace();
  await f.addClaim(ws);
  const create = args => f.call('worktree_create', { workspace_id: ws, issue: ISSUE, ...args });
  // Auto-gc packs refs: refs/heads/main then exists only in packed-refs, and a loose
  // refs/heads/Main would be the very same file on a case-insensitive volume.
  git(f.repo, 'pack-refs', '--all');
  const main = git(f.repo, 'rev-parse', 'refs/heads/main');
  for (const branch of ['Main', 'MAIN', 'mAsTeR']) {
    assert.deepEqual(await create({ branch }), { ok: false, error: 'protected_branch' }, branch);
  }
  git(f.repo, 'branch', 'taken');
  assert.deepEqual(await create({ branch: 'Taken' }), { ok: false, error: 'branch_exists', detail: 'local' });
  git(f.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/Remote-Only');
  assert.deepEqual(await create({ branch: 'remote-only' }), { ok: false, error: 'branch_exists', detail: 'remote' });
  assert.equal(git(f.repo, 'rev-parse', 'refs/heads/main'), main, 'the default branch never moved');
  assert.equal(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').filter(r => /main/i.test(r)).length, 1);
  assert.equal(isProtectedBranch('Develop', ['develop']), true);
  assert.equal(isProtectedBranch('agent/7-x', ['develop']), false);
});

test('finding 2: the remote default branch and remote branches are read with ls-remote, before create and push', async t => {
  const f = await fixture(t);
  // The origin's default branch is develop; the local clone only fetches main (a
  // --single-branch clone), so neither origin/HEAD nor origin/develop exist locally.
  git(f.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/develop');
  execFileSync('git', ['--git-dir', f.origin, 'symbolic-ref', 'HEAD', 'refs/heads/develop']);
  git(f.repo, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  git(f.repo, 'update-ref', '-d', 'refs/remotes/origin/develop');
  const ws = await f.addWorkspace();
  await f.addClaim(ws);
  assert.deepEqual(await f.call('worktree_create', { workspace_id: ws, issue: ISSUE, branch: 'develop' }),
    { ok: false, error: 'protected_branch' });
  const developBefore = git(f.origin, 'rev-parse', 'refs/heads/develop');

  // A branch someone else creates on the remote after our worktree exists: our first push
  // would fast-forward it; it is refused instead, and the remote is untouched.
  const { id, path, wt } = await f.ready({ branch: 'agent/feature' });
  await f.call('worktree_write_file', { worktree_id: id, path: 'x.txt', content: 'x\n' });
  assert.equal((await f.call('worktree_commit', { worktree_id: id, message: 'feat: x' })).ok, true);
  git(f.repo, 'push', '-q', 'origin', `${wt.base_commit}:refs/heads/agent/feature`);
  assert.deepEqual(await f.call('worktree_push', { worktree_id: id }), { ok: false, error: 'push_rejected', detail: 'remote_branch_not_ours' });
  assert.equal(git(f.origin, 'rev-parse', 'refs/heads/agent/feature'), wt.base_commit);
  execFileSync('git', ['--git-dir', f.origin, 'update-ref', '-d', 'refs/heads/agent/feature']);

  // A case variant on the remote is refused as well.
  git(f.repo, 'push', '-q', 'origin', `${wt.base_commit}:refs/heads/Agent/Feature`);
  assert.deepEqual(await f.call('worktree_push', { worktree_id: id }), { ok: false, error: 'push_rejected', detail: 'remote_case_variant' });
  execFileSync('git', ['--git-dir', f.origin, 'update-ref', '-d', 'refs/heads/Agent/Feature']);

  // Our own branch: first push creates it, the next one moves it from the commit we pushed.
  assert.equal((await f.call('worktree_push', { worktree_id: id })).ok, true);
  await f.call('worktree_write_file', { worktree_id: id, path: 'y.txt', content: 'y\n' });
  assert.equal((await f.call('worktree_commit', { worktree_id: id, message: 'feat: y' })).ok, true);
  const again = await f.call('worktree_push', { worktree_id: id });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(git(f.origin, 'rev-parse', 'refs/heads/agent/feature'), git(path, 'rev-parse', 'HEAD'));

  // The remote's default branch becomes ours (renamed on the forge): pushing it is refused.
  execFileSync('git', ['--git-dir', f.origin, 'symbolic-ref', 'HEAD', 'refs/heads/agent/feature']);
  assert.deepEqual(await f.call('worktree_push', { worktree_id: id }), { ok: false, error: 'protected_branch' });
  assert.equal(git(f.origin, 'rev-parse', 'refs/heads/develop'), developBefore, 'develop never moved');

  assert.deepEqual(parseLsRemote(`ref: refs/heads/develop\tHEAD\n${'a'.repeat(40)}\tHEAD\n${'b'.repeat(40)}\trefs/heads/x/y\n`),
    { head: 'develop', heads: new Map([['x/y', 'b'.repeat(40)]]) });
});

test('finding 7: worktree_remove is refused while a job is queued or running in the worktree', async t => {
  const f = await fixture(t);
  const { ws, id, path } = await f.ready();
  const jobId = `job_${randomBytes(12).toString('base64url')}`;
  await f.rt.store().transaction(r => r.insertJob({ id: jobId, workspace_id: ws, worktree_id: id, project_id: 'demo', host: 'mac',
    recipe: 'test', argv_json: '["npm","test"]', timeout_ms: 60000, log_path: join(f.base, 'x.log'), created_at: Date.now() }));
  const refused = await f.call('worktree_remove', { worktree_id: id });
  assert.equal(refused.error, 'job_active', JSON.stringify(refused));
  assert.ok(existsSync(path));
  await f.rt.store().transaction(r => r.updateJob(jobId, { status: 'cancelled', ended_at: Date.now() }, 'queued'));
  assert.equal((await f.call('worktree_remove', { worktree_id: id })).ok, true);
  assert.ok((await f.events()).includes('worktree_remove:denied:job_active'));
});

test('finding 8: worktree_remove never deletes ignored files silently', async t => {
  const f = await fixture(t);
  const { id, path } = await f.ready();
  assert.equal((await f.call('worktree_write_file', { worktree_id: id, path: 'node_modules/notes.txt', content: 'keep me\n' })).ok, true);
  const status = await f.call('worktree_status', { worktree_id: id });
  assert.equal(status.clean, true, 'ignored files are not changes');
  const refused = await f.call('worktree_remove', { worktree_id: id });
  assert.equal(refused.error, 'ignored_files', JSON.stringify(refused));
  assert.match(refused.detail, /1 ignored entry would be deleted \(node_modules\/\); pass discard_ignored: true/);
  assert.ok(existsSync(join(path, 'node_modules', 'notes.txt')), 'nothing was deleted');
  const removed = await f.call('worktree_remove', { worktree_id: id, discard_ignored: true });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.detail, '1 ignored entry deleted');
  assert.equal(existsSync(path), false);
  assert.ok((await f.events()).includes('worktree_remove:denied:ignored_files'));
});

test('finding 9: AI attribution is refused as a trailer or as prose, ordinary messages are not', async t => {
  const f = await fixture(t);
  const { id } = await f.ready();
  await f.call('worktree_write_file', { worktree_id: id, path: 'a.txt', content: 'a\n' });
  for (const message of ['feat: x\n\nWritten by Claude', 'feat: x\n\nMade with Claude Code', 'feat: x\n\nAI-generated change',
    'feat: x\n\nAssisted-by: GPT-4o', 'feat: x\n\nSigned-off-by: Claude <noreply@anthropic.com>', 'Generated using ChatGPT',
    'feat: x\n\nCreated with the help of an AI']) {
    assert.deepEqual(await f.call('worktree_commit', { worktree_id: id, message }),
      { ok: false, error: 'invalid_input', detail: 'message carries an AI attribution' }, message);
  }
  for (const message of ['fix: claude adapter timeout', 'docs: written by the maintainers', 'feat: made with love', 'feat: AI provider list']) {
    assert.ok(!AI_ATTRIBUTION.some(rx => rx.test(message)), message);
  }
  assert.equal((await f.call('worktree_commit', { worktree_id: id, message: 'fix: claude adapter timeout' })).ok, true);
});

test('a FIFO in place of a written file never hangs worktree_status or worktree_read_file', async t => {
  const f = await fixture(t);
  const { id, path } = await f.ready();
  // A tracked file Memo Bridge wrote, then replaced by a FIFO (git reports it as modified).
  await f.call('worktree_write_file', { worktree_id: id, path: 'README.md', content: 'edited\n' });
  await rm(join(path, 'README.md'));
  execFileSync('mkfifo', [join(path, 'README.md')]);
  const started = Date.now();
  const status = await f.call('worktree_status', { worktree_id: id });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.deepEqual(status.external_edits.modified_after_write, ['README.md']);
  assert.equal((await f.call('worktree_read_file', { worktree_id: id, path: 'README.md' })).error, 'not_a_file');
  assert.ok(Date.now() - started < 10000, 'returned promptly');
});

test('a redirected .git link is refused before any Git command runs in the worktree', async t => {
  const f = await fixture(t);
  const { id, path } = await f.ready();
  // A job could write a .git file pointing at a repository it prepared (with a config that
  // runs commands); the server must not run Git there.
  const evil = join(path, 'evil');
  execFileSync('git', ['init', '-q', '-b', 'agent/x', evil]);
  await writeFile(join(path, '.git'), `gitdir: ${join(evil, '.git')}\n`);
  for (const name of ['worktree_status', 'worktree_diff', 'worktree_push', 'worktree_remove']) {
    assert.equal((await f.call(name, { worktree_id: id })).error, 'worktree_link_changed', name);
  }
  assert.equal((await f.call('worktree_commit', { worktree_id: id, message: 'feat: x' })).error, 'worktree_link_changed');
  assert.equal((await f.call('worktree_write_file', { worktree_id: id, path: 'a.txt', content: 'a' })).error, 'worktree_link_changed');
  assert.ok(existsSync(path), 'not removed');
  // Same shape as a real link, but into another repository's worktree administration.
  const other = join(f.base, 'other');
  execFileSync('git', ['init', '-q', '-b', 'main', other]);
  execFileSync('git', ['-C', other, 'commit', '-q', '--allow-empty', '-m', 'other']);
  execFileSync('git', ['-C', other, 'worktree', 'add', '-q', '-b', 'agent/x', join(f.base, 'other-wt')]);
  await writeFile(join(path, '.git'), `gitdir: ${join(other, '.git', 'worktrees', 'other-wt')}\n`);
  assert.equal((await f.call('worktree_status', { worktree_id: id })).error, 'worktree_link_changed');
});
