// Fix pass of #258, finding 2: the owner namespaces (memolabs-dev, guillaume-flambard) are a
// pre-filter for the OWNER's principals only. Before the fix, hub:owner, hub:readonly and
// reader: on the Mac (and any principal where no private file is set) got them too, so
// tasks_list and task_next searched non-enrolled private repositories with the owner's gh token
// and returned their titles and bodies. docs/OWNER_SCOPE.md: reader:, hub: get none of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_NAMESPACES, allowedRepo, isOwnerPrincipal, withOwnerPrivateRepos } from '../server/coordinator/owner-private-repos.mjs';
import { CAPABILITIES, localOwnerPrincipal, makePrincipal, principalFromHub, readerPrincipal } from '../server/coordinator/policy.mjs';
import { createIssueLeaseClient } from '../server/coordinator/issue-lease.mjs';
import { coordinatorOn, stubLedger, tempStateDir } from './helpers/coordinator-fixture.mjs';

const SUB = 'owner-123';
const remotePolicy = { configured: true, owner_sub: SUB, projects: [] };
const file = '/Users/o/.local/share/memo-bridge/owner-policy/private-repos.json';
const fs = { lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 10, mode: 0o100600, uid: 501 }),
  realpath: async f => f,
  readFile: async () => JSON.stringify({ schema: 'memolabs.owner-private-repos.v1', owner_sub: SUB, repos: ['memolabs-dev/enrolled'] }) };
const ctx = { file, home: '/Users/o', uid: 501, remotePolicy, host: 'mac', fs };
const PUBLIC = { ok: true, repos: ['memolabs-dev/memo-bridge'] };

const NON_OWNERS = [
  ['hub:owner', principalFromHub('hub:owner', { 'hub:owner': 'owner' })],
  ['hub:readonly', principalFromHub('hub:readonly', { 'hub:readonly': 'read' })],
  ['reader:', readerPrincipal()],
  ['local:someone (a minted local principal that is not the OS user)', makePrincipal('local:someone-else', Object.values(CAPABILITIES))]
];

test('non-owner principals on the Mac keep the exact public literal: no namespaces, no private repository', async () => {
  for (const [label, p] of NON_OWNERS) {
    assert.equal(isOwnerPrincipal(p, SUB), false, label);
    const list = await withOwnerPrivateRepos(PUBLIC, { ...ctx, principal: p });
    assert.equal(list.ok, true, label);
    assert.equal(list.namespaces, undefined, `${label}: no namespaces`);
    assert.equal(allowedRepo(list, 'memolabs-dev/memo-bridge'), 'memolabs-dev/memo-bridge', label);
    for (const repo of ['memolabs-dev/enrolled', 'memolabs-dev/not-enrolled-private', 'guillaume-flambard/jobs']) {
      assert.equal(allowedRepo(list, repo), null, `${label} ${repo}`);
    }
  }
});

test('without a private file (VPS, stdio without env) a non-owner gets no namespaces either', async () => {
  const stranger = makePrincipal('oidc:someone-else', [CAPABILITIES.READ]);
  for (const host of ['vps', 'mac']) {
    const list = await withOwnerPrivateRepos({ ok: true, repos: [] }, { file: undefined, principal: stranger, remotePolicy, host });
    assert.equal(list.namespaces, undefined, host);
    assert.equal(allowedRepo(list, 'memolabs-dev/clinical-data-knowledge-foundation'), null, host);
  }
  for (const [label, p] of NON_OWNERS) {
    const list = await withOwnerPrivateRepos(PUBLIC, { file: undefined, principal: p, remotePolicy, host: 'mac' });
    assert.equal(list.namespaces, undefined, label);
  }
});

test('the owner keeps the namespaces: his remote principal anywhere, his local principal even without a remote policy', async () => {
  const remote = makePrincipal(`oidc:${SUB}`, Object.values(CAPABILITIES));
  assert.deepEqual((await withOwnerPrivateRepos(PUBLIC, { ...ctx, principal: remote })).namespaces, OWNER_NAMESPACES);
  assert.deepEqual((await withOwnerPrivateRepos(PUBLIC, { file: undefined, principal: remote, remotePolicy, host: 'vps' })).namespaces,
    OWNER_NAMESPACES);
  const local = localOwnerPrincipal();
  assert.equal(isOwnerPrincipal(local, null), true);
  assert.deepEqual((await withOwnerPrivateRepos(PUBLIC, { file: undefined, principal: local, remotePolicy: { configured: false }, host: 'mac' }))
    .namespaces, OWNER_NAMESPACES);
  // A plain object carrying the owner's local id is not the minted principal.
  assert.equal(isOwnerPrincipal({ id: local.id }, null), false);
});

// tasks_list on the Mac with a registered project whose origin is a private repository the
// owner never enrolled (and one he did).
const ORIGINS = { secret: 'memolabs-dev/not-enrolled-private', drop: 'memolabs-dev/drop', personal: 'guillaume-flambard/spec-guard' };
function tasksFixture(stateDir, principal) {
  const queries = [];
  const fx = coordinatorOn(stateDir, { principal, ledger: stubLedger(), tasks: {
    remotePolicy: { configured: false },
    resolveProject: async name => (ORIGINS[name] ? { ok: true, project: { name, repoPath: null } } : { ok: false, error: 'project_not_found' }),
    projectRemote: project => Promise.resolve(ORIGINS[project.name] ?? null),
    readAllowlist: async () => ({ ok: true, repos: ['memolabs-dev/drop'] }),
    listProjectRepos: async () => Object.keys(ORIGINS).map(name => ({ name })),
    searchIssues: async query => { queries.push(query); return { ok: true, total_count: 0, incomplete: false, items: [] }; }
  } });
  return { ...fx, queries };
}

test('tasks_list as hub:owner, hub:readonly or reader: on the Mac never searches a non-enrolled private origin', async t => {
  for (const [label, p] of NON_OWNERS.slice(0, 3)) {
    const fx = tasksFixture(await tempStateDir(t), p);
    t.after(() => fx.store.close());
    const listed = await fx.coordinator.tasksList({});
    assert.equal(listed.ok, true, label);
    assert.deepEqual(listed.repositories, ['memolabs-dev/drop'], label);
    assert.ok(listed.not_allowed.includes('secret') && listed.not_allowed.includes('personal'), label);
    assert.ok(fx.queries.every(q => !q.includes('not-enrolled-private') && !q.includes('guillaume-flambard')), `${label}: ${fx.queries}`);
    assert.equal((await fx.coordinator.tasksList({ project: 'secret' })).error, 'repo_not_allowed', label);
    // task_next reads the same list (backlogNext calls tasksList with the bodies): the hub:owner role
    // may open a workspace, and its task_next refuses the private project the same way.
    if (label === 'hub:owner') {
      const opened = await fx.coordinator.workspaceOpen({ project: 'secret', client_type: 'chatgpt' });
      assert.equal(opened.ok, true, JSON.stringify(opened));
      const next = await fx.coordinator.taskNext({ workspace_id: opened.workspace.workspace_id, project: 'secret' });
      assert.equal(next.ok, false, JSON.stringify(next));
      assert.equal(next.error, 'repo_not_allowed');
      assert.ok(fx.queries.every(q => !q.includes('not-enrolled-private')));
    }
  }
});

test('tasks_list as the owner: the exact list as is, a namespace-only repository only as public (is:public)', async t => {
  const fx = tasksFixture(await tempStateDir(t), localOwnerPrincipal());
  t.after(() => fx.store.close());
  const listed = await fx.coordinator.tasksList({});
  assert.equal(listed.ok, true);
  const byRepo = repo => fx.queries.filter(q => q.endsWith(`repo:${repo}`) || q.includes(`repo:${repo} `));
  assert.ok(byRepo('memolabs-dev/drop').every(q => !q.includes('is:public')), 'an exact entry is searched as is');
  for (const repo of ['memolabs-dev/not-enrolled-private', 'guillaume-flambard/spec-guard']) {
    assert.ok(byRepo(repo).length > 0, repo);
    assert.ok(byRepo(repo).every(q => q.includes('is:public')), `${repo}: ${fx.queries}`);
  }
  // Every query keeps its repository qualifiers last (the per-repository credential lookup reads them).
  assert.ok(fx.queries.every(q => /repo:\S+$/.test(q)));
});

// The ledger child learns that the caller is the owner only from the coordinator, per call.
test('the owner marker reaches the ledger child for the owner\'s claim only, and never from the server environment', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'memo-owner-marker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'scripts'));
  await writeFile(join(dir, 'scripts', 'issue_lease.py'), '# stub\n');
  const calls = [];
  const run = async (python, args, { env }) => {
    calls.push({ action: args[3], marker: env.MEMO_BRIDGE_LEDGER_OWNER_CALL ?? null });
    return { code: 0, stdout: JSON.stringify({ state: 'claimed', worker: 'w', claim_id: 'c'.repeat(32), fence_sha: 'f'.repeat(40), epoch: 1 }), stderr: '' };
  };
  // Even a server started with the marker in its environment does not pass it on by itself.
  const ledger = createIssueLeaseClient({ root: dir, env: { PATH: process.env.PATH, MEMO_BRIDGE_LEDGER_OWNER_CALL: '1' }, run });
  const issue = { repo: 'memolabs-dev/enrolled', number: 3 };
  await ledger.claim(issue, 'mb.mac.ws_abc', 300);
  await ledger.forOwner().claim(issue, 'mb.mac.ws_abc', 300);
  await ledger.forOwner().status(issue);
  assert.deepEqual(calls, [{ action: 'claim', marker: null }, { action: 'claim', marker: '1' }, { action: 'status', marker: '1' }]);
});

test('task_claim passes through forOwner() for the owner and through the plain ledger for anyone else', async t => {
  for (const [label, p, expected] of [['owner', localOwnerPrincipal(), 1], ['hub:owner', NON_OWNERS[0][1], 0]]) {
    const base = stubLedger();
    let owner = 0;
    const ledger = { ...base, forOwner: () => { owner++; return base; } };
    const fx = coordinatorOn(await tempStateDir(t), { principal: p, ledger });
    t.after(() => fx.store.close());
    const opened = await fx.coordinator.workspaceOpen({ project: 'drop', client_type: 'claude-code' });
    assert.equal(opened.ok, true, `${label} ${JSON.stringify(opened)}`);
    const claimed = await fx.coordinator.taskClaim({ workspace_id: opened.workspace.workspace_id, issue: 'memolabs-dev/drop#7' });
    assert.equal(claimed.ok, true, `${label} ${JSON.stringify(claimed)}`);
    assert.equal(owner, expected, label);
  }
});
