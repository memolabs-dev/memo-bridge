// project_create (owner console REQ-A2, spec section 09): a new project from ChatGPT. Driven
// through the tool handler the runtime serves, with GitHub replaced by a recording fake gh, App
// tokens by a stub provider, and a temporary MEMOLABS_ROOT with its own registry lock. Offline:
// nothing reaches GitHub, the real registry or the real /tmp/proj-registry.lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { parseRemotePolicy, remotePolicyFromEnv } from '../bridge/write-gate.mjs';
import { isProjectOwner, registerProjectTools } from '../server/tools/project-tools.mjs';
import { validateProjectArgs } from '../server/projects/create.mjs';
import { addRegistryRow, insertRow, registryRows } from '../server/projects/registry-writer.mjs';
import { collectToolDefinitions, registryProblems, REMOTE_TOOLS_WRITE } from '../server/registry.mjs';
import { OPS } from '../bridge/ops.mjs';

const OWNER_SUB = '0b6c1f4e-1111-4222-8333-944445555666';
const ALL = Object.values(CAPABILITIES);
const CHAT = makePrincipal(`oidc:${OWNER_SUB}`, ALL, { client_type: 'chatgpt', via: 'hub' });
const STRANGER = makePrincipal('oidc:someone-else', ALL, { client_type: 'chatgpt', via: 'hub' });
const READER = makePrincipal('hub:readonly', [CAPABILITIES.READ], { via: 'hub' });
const LOCAL = makePrincipal('local:memo', ALL);
const TEMPLATE = 'memolabs-dev/project-template';

const REGISTRY = `# Registre

## Projets appartenant à Memo Labs

| Name | Path | Kind | Status | Nature | Stack | Vault note |
|---|---|---|---|---|---|---|
| alpha | products/alpha | repo | lab | app | Go | - |
| zulu | products/zulu | repo | lab | app | Go | - |

## Dépôts de référence

| Name | Path |
|---|---|
| other | workspace/external/other |
`;

async function temp(t, prefix) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

// A fake GitHub behind gh: repositories by full name, generation that needs `pending` polls
// before its first commit, and every call recorded with its method, path, body and token.
function fakeGh({ template = { is_template: true, private: false }, pending = 1, existing = {} } = {}) {
  const repos = new Map(Object.entries(existing));
  if (template) repos.set(TEMPLATE, { archived: false, ...template });
  const calls = [];
  const ok = data => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
  const http = (status, message) => ({ code: 1, stdout: JSON.stringify({ message }), stderr: `gh: ${message} (HTTP ${status})` });
  const gh = async (args, { env, input } = {}) => {
    const method = args[args.indexOf('-X') + 1];
    const path = args.find(a => a.startsWith('repos/'));
    const body = input ? JSON.parse(input) : null;
    calls.push({ method, path, body, token: env?.GH_TOKEN ?? null });
    let m;
    if (method === 'GET' && (m = /^repos\/([^/]+\/[^/?]+)$/.exec(path))) {
      const repo = repos.get(m[1]);
      return repo ? ok({ full_name: m[1], ...repo }) : http(404, 'Not Found');
    }
    if (method === 'POST' && path === `repos/${TEMPLATE}/generate`) {
      const full = `${body.owner}/${body.name}`;
      if (repos.has(full)) return http(422, 'Name already exists on this account');
      repos.set(full, { private: body.private, archived: false, template_repository: { full_name: TEMPLATE }, polls: pending });
      return ok({ full_name: full });
    }
    if (method === 'GET' && (m = /^repos\/([^/]+\/[^/]+)\/commits\?per_page=1$/.exec(path))) {
      const repo = repos.get(m[1]);
      if (!repo) return http(404, 'Not Found');
      if (repo.polls > 0) { repo.polls -= 1; return http(409, 'Git Repository is empty.'); }
      return ok([{ sha: 'a'.repeat(40) }]);
    }
    if (method === 'PATCH' && (m = /^repos\/([^/]+\/[^/]+)$/.exec(path))) {
      const repo = repos.get(m[1]);
      if (!repo) return http(404, 'Not Found');
      Object.assign(repo, body);
      return ok({ full_name: m[1], ...repo });
    }
    return http(404, 'Not Found');
  };
  return { gh, calls, repos };
}

function stubCredentials({ error = null } = {}) {
  const asked = [];
  return { asked, token: async (purpose, repo) => {
    asked.push([purpose, repo ?? null]);
    return error ? { error, credential: 'app-key' } : { token: `ghs_test_${purpose}_token_0000000000`, source: 'app' };
  } };
}

async function setup(t, { principal = CHAT, host = 'mac', policy = { projects: ['alpha'] }, gh = fakeGh(), credentials = stubCredentials(),
  enrolled = [], remoteFile = false } = {}) {
  const root = await temp(t, 'mb-project-root-');
  const home = await temp(t, 'mb-project-home-');
  await writeFile(join(root, 'PROJECTS.md'), REGISTRY);
  for (const area of ['products', 'research']) await mkdir(join(root, area), { recursive: true });
  const lock = join(home, 'proj-registry.lock');
  const remotePolicy = parseRemotePolicy({ oidc: { owner_sub: OWNER_SUB }, remote_writes: 'enabled', ...policy });
  // The owner's private policy, where loadOwnerPrivatePolicy accepts it (0600, owner-policy/).
  const policyFile = join(home, '.local', 'share', 'memo-bridge', 'owner-policy', 'private-repos.json');
  await mkdir(join(home, '.local', 'share', 'memo-bridge', 'owner-policy'), { recursive: true, mode: 0o700 });
  await writeFile(policyFile, JSON.stringify({ schema: 'memolabs.owner-private-repos.v1', owner_sub: OWNER_SUB, repos: enrolled }));
  await chmod(policyFile, 0o600);
  // #216: with the Mac runtime's own remote.json, project_create enrolls and the runtime rereads it.
  const remoteConfig = join(home, '.local', 'share', 'memo-bridge', 'owner-policy', 'remote.json');
  if (remoteFile) {
    await writeFile(remoteConfig, JSON.stringify({ version: 1, oidc: { owner_sub: OWNER_SUB }, remote_writes: 'enabled',
      session_binding: 'enforce', mac_runtime_routing: 'enabled', ...policy }), { mode: 0o600 });
  }
  const env = { PATH: process.env.PATH, HOME: home, MEMO_BRIDGE_GOVERNANCE_ROOT: `/x/governance/${'f'.repeat(40)}`,
    ...(remoteFile ? { MEMO_BRIDGE_REMOTE_CONFIG: remoteConfig } : {}) };
  const journal = [];
  const clones = [];
  const runtime = { principal, host, stateDir: home, githubCredentials: credentials, remotePolicy: () => (remoteFile ? remotePolicyFromEnv(env) : remotePolicy),
    authorize: op => principal.capabilities.has(CAPABILITIES.GITHUB_WRITE) && op === 'project_create',
    audit: async (op, outcome, code, ids = {}) => { journal.push({ op, outcome, code, issue: ids.issue ?? null }); } };
  let handler;
  registerProjectTools({ registerTool: (name, config, fn) => { handler = fn; } }, () => runtime, {
    root, gh: gh.gh, env,
    privatePolicyFile: policyFile, waitRepoMs: 200, pollMs: 1, wait: async () => {},
    addRow: (r, row) => addRegistryRow(r, row, { lock, backupDir: join(home, 'backups'), waitMs: 200 }),
    clone: async (spec, path) => {
      clones.push(path);
      await mkdir(path, { recursive: true });
      git(path, 'init', '-q');
      git(path, 'remote', 'add', 'origin', `https://github.com/${spec.repo}.git`);
      return { ok: true };
    } });
  const call = async args => JSON.parse((await handler(args)).content[0].text);
  const registry = async () => registryRows(await readFile(join(root, 'PROJECTS.md'), 'utf8')).rows.map(r => `${r.name}:${r.path}`);
  return { root, home, lock, call, journal, clones, gh, credentials, registry, policyFile, remoteConfig };
}

test('A2: creates the repository from the template, settings, Mac clone, one registry row in order, owner steps', async t => {
  const f = await setup(t);
  const out = await f.call({ name: 'relay-v2', description: 'Relay, second version' });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.repo, 'memolabs-dev/relay-v2');
  assert.equal(out.existing, false);
  assert.equal(out.host, 'mac');
  assert.deepEqual(out.steps, ['repo_created', 'settings_applied', 'cloned', 'registry_row_added']);
  assert.equal(out.local_path, join(f.root, 'products', 'relay-v2'));
  const generate = f.gh.calls.find(c => c.method === 'POST');
  assert.equal(generate.path, `repos/${TEMPLATE}/generate`);
  assert.deepEqual(generate.body, { owner: 'memolabs-dev', name: 'relay-v2', description: 'Relay, second version', private: true,
    include_all_branches: false });
  const patch = f.gh.calls.find(c => c.method === 'PATCH');
  assert.deepEqual(patch.body, { delete_branch_on_merge: true });
  assert.equal(patch.token, 'ghs_test_repo_admin_token_0000000000', 'settings with the token of the one new repository');
  assert.ok(f.gh.calls.filter(c => c.method !== 'PATCH').every(c => c.token === 'ghs_test_repo_create_token_0000000000'));
  assert.deepEqual([...new Set(f.credentials.asked.map(a => a.join(' ')))], ['repo_create ', 'repo_admin memolabs-dev/relay-v2']);
  assert.equal(f.gh.calls.some(c => c.method === 'DELETE'), false);
  assert.deepEqual(await f.registry(), ['alpha:products/alpha', 'relay-v2:products/relay-v2', 'zulu:products/zulu']);
  assert.match(await readFile(join(f.root, 'PROJECTS.md'), 'utf8'), /\| relay-v2 \| products\/relay-v2 \| repo \| lab \| à qualifier \| Node\.js \| - \|/);
  // Not enrolled yet: the one owner step that makes it workable from ChatGPT.
  assert.equal(out.ready_for_batch_create, false);
  assert.deepEqual(out.owner_steps.map(s => s.step), ['enroll_on_mac']);
  assert.match(out.owner_steps[0].command, new RegExp(`--owner-sub ${OWNER_SUB} --governance-ref f{40} --from-registry --app-key "\\$HOME/\\.config/memolabs/secrets/github-app/memo-labs-automation\\.private-key\\.pem" --install$`));
  assert.deepEqual(f.journal, [
    { op: 'project_repo_created', outcome: 'ok', code: 'created', issue: 'memolabs-dev/relay-v2' },
    { op: 'project_create', outcome: 'ok', code: 'created', issue: 'memolabs-dev/relay-v2' }]);
});

test('A2: the same name again returns the same project, never a second repository or row', async t => {
  const f = await setup(t);
  const first = await f.call({ name: 'relay-v2' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await f.call({ name: 'relay-v2' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.existing, true);
  assert.equal(second.local_path, first.local_path);
  assert.deepEqual(second.steps, ['repo_found', 'settings_applied', 'clone_found', 'registry_row_found']);
  assert.equal(f.gh.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(f.clones.length, 1);
  assert.equal((await f.registry()).filter(r => r.startsWith('relay-v2:')).length, 1);
  assert.equal(f.journal.at(-1).code, 'existing');
  // The same name without its visibility is still the same project (a public one here).
  const v = await setup(t);
  assert.equal((await v.call({ name: 'open-relay', visibility: 'public' })).ok, true);
  const bare = await v.call({ name: 'open-relay' });
  assert.equal(bare.ok, true, JSON.stringify(bare));
  assert.equal(bare.existing, true);
  assert.equal(bare.visibility, 'public');
  assert.equal(bare.host, 'mac');
  assert.equal((await v.call({ name: 'open-relay', visibility: 'private' })).error, 'visibility_mismatch');
  // A first call that stopped after the repository (no clone, no row) is finished by the next one.
  const g = await setup(t);
  g.gh.repos.set('memolabs-dev/half-done', { private: true, archived: false, template_repository: { full_name: TEMPLATE } });
  const resumed = await g.call({ name: 'half-done', area: 'research' });
  assert.deepEqual(resumed.steps, ['repo_found', 'settings_applied', 'cloned', 'registry_row_added']);
  assert.ok((await g.registry()).includes('half-done:research/half-done'));
});

test('A2: ready for batch_create once enrolled on the Mac; a public VPS project lists the lab-infra and ledger steps', async t => {
  const f = await setup(t, { policy: { projects: ['alpha', 'relay-v2'] }, enrolled: ['memolabs-dev/relay-v2'] });
  const out = await f.call({ name: 'relay-v2' });
  assert.equal(out.ready_for_batch_create, true, JSON.stringify(out));
  assert.equal(out.owner_steps, undefined);
  assert.match(out.next, /batch_create with project "relay-v2"/);
  const v = await setup(t);
  const pub = await v.call({ name: 'open-relay', visibility: 'public' });
  assert.equal(pub.ok, true, JSON.stringify(pub));
  assert.equal(pub.host, 'mac', 'the Mac serves public projects too (#312)');
  assert.equal(v.gh.calls.find(c => c.method === 'POST').body.private, false);
  assert.equal(pub.ready_for_batch_create, true, 'a public project needs no enrollment file: the owner scope covers it');
  // On the VPS the only remaining step is the clone at the next deploy: no list, no literal.
  const vps = await setup(t);
  const onVps = await vps.call({ name: 'open-relay', visibility: 'public', host: 'vps' });
  assert.equal(onVps.ok, true, JSON.stringify(onVps));
  assert.deepEqual(onVps.owner_steps.map(s => s.step), ['vps_clone_on_next_deploy']);
});

test('#216: a private Mac project is enrolled by project_create itself and ready at once; never a public or untrusted one', async t => {
  const f = await setup(t, { remoteFile: true });
  const out = await f.call({ name: 'relay-v2' });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.steps, ['repo_created', 'settings_applied', 'cloned', 'registry_row_added', 'enrolled_on_mac']);
  assert.equal(out.ready_for_batch_create, true, JSON.stringify(out));
  assert.equal(out.owner_steps, undefined);
  assert.deepEqual(JSON.parse(await readFile(f.policyFile, 'utf8')).repos, ['memolabs-dev/relay-v2']);
  assert.deepEqual(JSON.parse(await readFile(f.remoteConfig, 'utf8')).projects, ['alpha', 'relay-v2']);
  assert.ok(f.journal.some(e => e.op === 'project_enrolled' && e.outcome === 'ok' && e.issue === 'memolabs-dev/relay-v2'),
    JSON.stringify(f.journal));
  // Again: already enrolled, nothing rewritten.
  const again = await f.call({ name: 'relay-v2' });
  assert.equal(again.ready_for_batch_create, true);
  assert.equal(again.steps.at(-1), 'enrollment_found');
  // A public VPS project is never enrolled on the Mac.
  const p = await setup(t, { remoteFile: true });
  const pub = await p.call({ name: 'open-relay', visibility: 'public' });
  assert.equal(pub.ok, true, JSON.stringify(pub));
  assert.equal(pub.steps.includes('enrolled_on_mac'), false);
  assert.deepEqual(JSON.parse(await readFile(p.remoteConfig, 'utf8')).projects, ['alpha']);
  // An untrusted policy file is left alone, and the owner step stays.
  const u = await setup(t, { remoteFile: true });
  await chmod(u.remoteConfig, 0o644);
  const refused = await u.call({ name: 'relay-v2' });
  assert.equal(refused.ok, true, JSON.stringify(refused));
  assert.equal(refused.ready_for_batch_create, false);
  assert.equal(refused.enrollment_error, 'enroll_policy_untrusted');
  assert.deepEqual(refused.owner_steps.map(s => s.step), ['enroll_on_mac']);
  assert.deepEqual(JSON.parse(await readFile(u.remoteConfig, 'utf8')).projects, ['alpha']);
});

test('A2: owner only, on the Mac only; every refusal is journaled and touches nothing', async t => {
  for (const [principal, error] of [[STRANGER, 'owner_only'], [READER, 'forbidden']]) {
    const f = await setup(t, { principal });
    const out = await f.call({ name: 'relay-v2' });
    assert.equal(out.error, error);
    assert.equal(f.gh.calls.length, 0);
    assert.deepEqual(f.journal, [{ op: 'project_create', outcome: 'denied', code: error, issue: 'memolabs-dev/relay-v2' }]);
  }
  const vps = await setup(t, { host: 'vps' });
  const out = await vps.call({ name: 'relay-v2' });
  assert.equal(out.error, 'project_create_mac_only');
  assert.ok(out.next_step);
  assert.equal(vps.gh.calls.length, 0);
  const local = await setup(t, { principal: LOCAL });
  assert.equal((await local.call({ name: 'relay-v2' })).ok, true);
  const policy = parseRemotePolicy({ oidc: { owner_sub: OWNER_SUB }, projects: ['x'] });
  assert.equal(isProjectOwner(CHAT, policy), true);
  assert.equal(isProjectOwner(STRANGER, policy), false);
  assert.equal(isProjectOwner(CHAT, parseRemotePolicy({ projects: ['x'] })), false, 'no owner sub configured: no remote owner');
  assert.equal(isProjectOwner(makePrincipal('hub:owner', ALL, { via: 'hub' }), policy), true);
  assert.equal(isProjectOwner(makePrincipal('local:memo', ALL, { via: 'hub' }), policy), false);
});

test('A2: names are kebab-case and not reserved; private never on the VPS; a public project may run on the Mac (#312)', async t => {
  for (const name of ['Relay', 'relay_v2', 'r', '-relay', 'relay-', 'relay--v2', '2relay', 'project-template', 'github', 'x'.repeat(51),
    'relay.v2', '../relay', 'memolabs-dev']) {
    assert.equal(validateProjectArgs({ name }).error, 'invalid_name', name);
  }
  assert.equal(validateProjectArgs({ name: 'relay-v2' }).spec.host, 'mac');
  assert.equal(validateProjectArgs({ name: 'relay-v2', visibility: 'public' }).spec.host, 'mac');
  assert.equal(validateProjectArgs({ name: 'relay-v2', area: 'tmp' }).detail, 'area');
  assert.equal(validateProjectArgs({ name: 'relay-v2', template: 'rust' }).detail, 'template');
  assert.equal(validateProjectArgs({ name: 'relay-v2', description: 'a\nb' }).detail, 'description');
  const f = await setup(t);
  assert.equal((await f.call({ name: 'relay-v2', host: 'vps' })).error, 'private_on_vps_refused');
  assert.equal(validateProjectArgs({ name: 'relay-v2', visibility: 'public', host: 'mac' }).ok, true, 'the Mac serves public projects too');
  assert.equal((await f.call({ name: 'Relay' })).error, 'invalid_name');
  assert.equal(f.gh.calls.length, 0);
  assert.ok(f.journal.every(e => e.outcome === 'denied'));
});

test('A2: an existing repository that is not ours, or another visibility, or archived, is never touched', async t => {
  const cases = [
    [{ private: true, archived: false }, 'repo_exists'],
    [{ private: true, archived: false, template_repository: { full_name: 'someone/else' } }, 'repo_exists'],
    [{ private: false, archived: false, template_repository: { full_name: TEMPLATE } }, 'visibility_mismatch'],
    [{ private: true, archived: true, template_repository: { full_name: TEMPLATE } }, 'repo_archived']];
  for (const [repo, error] of cases) {
    const f = await setup(t, { gh: fakeGh({ existing: { 'memolabs-dev/relay-v2': repo } }) });
    const out = await f.call({ name: 'relay-v2', visibility: 'private' });
    assert.equal(out.error, error);
    assert.deepEqual(f.gh.calls.map(c => c.method), ['GET']);
    assert.equal(f.clones.length, 0);
    assert.equal((await f.registry()).length, 2);
  }
});

test('A2: personal GitHub same-name repository or fork prevents organization creation without touching anything', async t => {
  for (const [archived, fork] of [[false, true], [true, false]]) {
    const f = await setup(t, { gh: fakeGh({ existing: {
      'guillaume-flambard/relay-v2': { private: false, archived, fork },
    } }) });
    const out = await f.call({ name: 'relay-v2' });
    assert.equal(out.error, 'possible_duplicate', JSON.stringify(out));
    assert.equal(out.existing_repo, 'guillaume-flambard/relay-v2');
    assert.match(out.next_step, /review both owners/);
    assert.deepEqual(f.gh.calls.map(c => [c.method, c.path]), [
      ['GET', 'repos/memolabs-dev/relay-v2'],
      ['GET', 'repos/guillaume-flambard/relay-v2'],
    ]);
    assert.deepEqual(await f.registry(), ['alpha:products/alpha', 'zulu:products/zulu']);
    assert.equal(f.clones.length, 0);
    assert.deepEqual(f.journal, [
      { op: 'project_create', outcome: 'denied', code: 'possible_duplicate', issue: 'memolabs-dev/relay-v2' },
    ]);
  }
});

test('A2: unverified personal repository lookup stops creation instead of assuming an empty account', async t => {
  const fake = fakeGh();
  const original = fake.gh;
  fake.gh = async (args, opts) => args.includes('repos/guillaume-flambard/relay-v2')
    ? { code: 1, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)' }
    : original(args, opts);
  const f = await setup(t, { gh: fake });
  const out = await f.call({ name: 'relay-v2' });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.notEqual(out.error, 'possible_duplicate');
  assert.equal(f.gh.calls.some(c => c.method === 'POST'), false);
  assert.equal(f.clones.length, 0);
  assert.deepEqual(await f.registry(), ['alpha:products/alpha', 'zulu:products/zulu']);
});

test('A2: registry and folder conflicts, the registry lock, a missing template and App errors refuse cleanly', async t => {
  // A row with that name for another checkout.
  const taken = await setup(t);
  await mkdir(join(taken.root, 'products', 'alpha'));
  git(join(taken.root, 'products', 'alpha'), 'init', '-q');
  git(join(taken.root, 'products', 'alpha'), 'remote', 'add', 'origin', 'https://github.com/memolabs-dev/alpha-old.git');
  assert.equal((await taken.call({ name: 'alpha' })).error, 'name_taken');
  assert.equal(taken.gh.calls.length, 0);
  // A folder already there that is not a checkout of the repository.
  const occupied = await setup(t);
  await mkdir(join(occupied.root, 'products', 'relay-v2'));
  const out = await occupied.call({ name: 'relay-v2' });
  assert.equal(out.error, 'path_occupied');
  assert.equal((await occupied.registry()).length, 2);
  // The registry lock held by someone else: nothing written, the lock left in place.
  const locked = await setup(t);
  await mkdir(locked.lock);
  const busy = await locked.call({ name: 'relay-v2' });
  assert.equal(busy.error, 'registry_locked');
  assert.deepEqual(busy.steps, ['repo_created', 'settings_applied', 'cloned']);
  assert.equal((await locked.registry()).length, 2);
  await rm(locked.lock, { recursive: true });
  assert.deepEqual((await locked.call({ name: 'relay-v2' })).steps, ['repo_found', 'settings_applied', 'clone_found', 'registry_row_added']);
  // No template repository published yet.
  const bare = await setup(t, { gh: fakeGh({ template: null }) });
  const missing = await bare.call({ name: 'relay-v2' });
  assert.equal(missing.error, 'template_unavailable');
  assert.match(missing.next_step, /project-template\.mjs publish/);
  assert.equal(bare.gh.calls.some(c => c.method === 'POST'), false);
  // No App on this runtime: refused, never the owner's own login.
  const noApp = await setup(t, { credentials: stubCredentials({ error: 'app_key_missing' }) });
  const refused = await noApp.call({ name: 'relay-v2' });
  assert.equal(refused.error, 'github_app_unavailable');
  assert.equal(noApp.gh.calls.length, 0);
  // Generation that never produces a commit: repo_not_ready, and the next call goes on.
  const slow = await setup(t, { gh: fakeGh({ pending: Infinity }) });
  assert.equal((await slow.call({ name: 'relay-v2' })).error, 'repo_not_ready');
  assert.equal(slow.journal[0].op, 'project_repo_created');
});

test('A2: a concurrent creation between the read and the generate converges on the same repository', async t => {
  const fake = fakeGh();
  const inner = fake.gh;
  let raced = false;
  fake.gh = async (args, opts) => {
    if (!raced && args.includes(`repos/${TEMPLATE}/generate`)) {
      raced = true;
      fake.repos.set('memolabs-dev/relay-v2', { private: true, archived: false, template_repository: { full_name: TEMPLATE } });
    }
    return inner(args, opts);
  };
  const f = await setup(t, { gh: fake });
  const out = await f.call({ name: 'relay-v2' });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.existing, true);
  assert.equal(f.journal.some(e => e.op === 'project_repo_created'), false);
});

test('registry writer: alphabetical insertion in the main table only, existing rows untouched, bad cells refused', async t => {
  const row = n => ({ name: n, path: `products/${n}`, kind: 'repo', status: 'lab', nature: 'à qualifier', stack: '-', note: '-' });
  const inserted = insertRow(REGISTRY, row('mike')).text;
  assert.deepEqual(registryRows(inserted).rows.map(r => r.name), ['alpha', 'mike', 'zulu']);
  assert.deepEqual(registryRows(insertRow(REGISTRY, row('zz')).text).rows.map(r => r.name), ['alpha', 'zulu', 'zz']);
  assert.ok(insertRow(REGISTRY, row('zz')).text.includes('| zz | products/zz |'));
  assert.equal(insertRow(REGISTRY, row('zz')).text.split('\n').filter(l => l.includes('| other |')).length, 1);
  assert.equal(insertRow(REGISTRY, row('alpha')).exists, true);
  assert.equal(insertRow(REGISTRY, { ...row('bad'), stack: 'a|b' }).error, 'invalid_row');
  assert.equal(insertRow('# nothing\n', row('x')).error, 'projects_section_missing');
  const root = await temp(t, 'mb-registry-');
  await writeFile(join(root, 'PROJECTS.md'), REGISTRY);
  const lock = join(root, 'lock');
  const results = await Promise.all(['bravo', 'charlie', 'delta'].map(n => addRegistryRow(root, row(n), { lock, backupDir: join(root, 'b'), waitMs: 5000 })));
  assert.ok(results.every(r => r.ok && r.added));
  assert.deepEqual(registryRows(await readFile(join(root, 'PROJECTS.md'), 'utf8')).rows.map(r => r.name), ['alpha', 'bravo', 'charlie', 'delta', 'zulu']);
});

test('A2: project_create is a remote write tool with a policy entry, honest hints and a long timeout', async () => {
  assert.ok(REMOTE_TOOLS_WRITE.includes('project_create'));
  const defs = await collectToolDefinitions();
  assert.deepEqual(registryProblems(defs), []);
  const def = defs.get('project_create');
  assert.equal(def.annotations.destructiveHint, false);
  assert.equal(def.annotations.idempotentHint, true);
  assert.equal(OPS.project_create.mutating, true);
  assert.ok(OPS.project_create.timeoutMs >= 120_000);
});
