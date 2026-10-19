// #216: a private project created by project_create is served by the running Mac runtime without
// a reinstall. Three pieces: the enrollment writer (server/projects/mac-enroll.mjs), the remote
// policy reread on file change (bridge/write-gate.mjs remotePolicyFromEnv), and the coordinator
// reading the policy through a getter, so a coordinator built before the enrollment sees it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoordinator } from '../server/coordinator/index.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { openSqliteStore } from '../server/coordinator/store.mjs';
import { remotePolicyFromEnv } from '../bridge/write-gate.mjs';
import { enrollOnMac } from '../server/projects/mac-enroll.mjs';
import { tempStateDir, stubProjects, stubLedger, stubRemote } from './helpers/coordinator-fixture.mjs';

const OWNER_SUB = '0b6c1f4e-1111-4222-8333-944445555666';
const PRIVATE_SCHEMA = 'memolabs.owner-private-repos.v1';

async function home(t, { repos = ['memolabs-dev/alpha'], projects = ['alpha'], ownerSub = OWNER_SUB } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'mb-enroll-home-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const policyDir = join(dir, '.local', 'share', 'memo-bridge', 'owner-policy');
  await mkdir(policyDir, { recursive: true, mode: 0o700 });
  const privateFile = join(policyDir, 'private-repos.json');
  const remoteFile = join(policyDir, 'remote.json');
  await writeFile(privateFile, `${JSON.stringify({ schema: PRIVATE_SCHEMA, owner_sub: ownerSub, repos })}\n`, { mode: 0o600 });
  await writeFile(remoteFile, `${JSON.stringify({ version: 1, managed_by: 'memo-bridge deploy/mac/install-runtime-agent.sh',
    oidc: { owner_sub: ownerSub }, projects, remote_writes: 'enabled', session_binding: 'enforce', mac_runtime_routing: 'enabled' }, null, 2)}\n`,
  { mode: 0o600 });
  return { home: dir, policyDir, privateFile, remoteFile };
}
const args = (h, extra = {}) => ({ home: h.home, ownerSub: OWNER_SUB, name: 'relay-v2', repo: 'memolabs-dev/relay-v2',
  remoteConfigPath: h.remoteFile, privatePolicyPath: h.privateFile, ...extra });
const json = async file => JSON.parse(await readFile(file, 'utf8'));

test('#216 enrollOnMac adds the repository and the project name once, keeping every other key', async t => {
  const h = await home(t);
  const first = await enrollOnMac(args(h));
  assert.deepEqual(first, { ok: true, enrolled: true });
  assert.deepEqual((await json(h.privateFile)).repos, ['memolabs-dev/alpha', 'memolabs-dev/relay-v2']);
  const remote = await json(h.remoteFile);
  assert.deepEqual(remote.projects, ['alpha', 'relay-v2']);
  assert.equal(remote.mac_runtime_routing, 'enabled');
  assert.equal(remote.session_binding, 'enforce');
  assert.equal(remote.oidc.owner_sub, OWNER_SUB);
  const again = await enrollOnMac(args(h));
  assert.deepEqual(again, { ok: true, enrolled: false });
  assert.deepEqual((await json(h.privateFile)).repos, ['memolabs-dev/alpha', 'memolabs-dev/relay-v2']);
  assert.deepEqual((await json(h.remoteFile)).projects, ['alpha', 'relay-v2']);
  // Both files keep the owner-only mode the readers demand.
  for (const file of [h.privateFile, h.remoteFile]) {
    const { mode } = await import('node:fs').then(fs => fs.statSync(file));
    assert.equal(mode & 0o777, 0o600, file);
  }
  // Half enrolled (one file only) is finished, not duplicated.
  const half = await home(t, { repos: ['memolabs-dev/alpha', 'memolabs-dev/relay-v2'] });
  assert.deepEqual(await enrollOnMac(args(half)), { ok: true, enrolled: true });
  assert.deepEqual((await json(half.privateFile)).repos, ['memolabs-dev/alpha', 'memolabs-dev/relay-v2']);
  assert.deepEqual((await json(half.remoteFile)).projects, ['alpha', 'relay-v2']);
});

test('#216 enrollOnMac never writes outside the owner-policy files or into an untrusted one', async t => {
  const h = await home(t);
  const before = [await readFile(h.privateFile, 'utf8'), await readFile(h.remoteFile, 'utf8')];
  const untouched = async () => assert.deepEqual([await readFile(h.privateFile, 'utf8'), await readFile(h.remoteFile, 'utf8')], before);
  // Another path (the VPS /etc file, a file in a repository) is not the Mac owner-policy file.
  assert.equal((await enrollOnMac(args(h, { remoteConfigPath: '/etc/memo-bridge/remote.json' }))).error, 'enroll_unsupported');
  assert.equal((await enrollOnMac(args(h, { remoteConfigPath: null }))).error, 'enroll_unsupported');
  assert.equal((await enrollOnMac(args(h, { privatePolicyPath: join(h.home, 'private-repos.json') }))).error, 'enroll_unsupported');
  // Only memolabs-dev/<name> for a valid name.
  assert.equal((await enrollOnMac(args(h, { repo: 'someone/relay-v2' }))).error, 'enroll_invalid');
  assert.equal((await enrollOnMac(args(h, { repo: 'memolabs-dev/other' }))).error, 'enroll_invalid');
  assert.equal((await enrollOnMac(args(h, { name: 'Bad Name', repo: 'memolabs-dev/Bad Name' }))).error, 'enroll_invalid');
  // Another owner in the files.
  assert.equal((await enrollOnMac(args(h, { ownerSub: '11111111-2222-4333-8444-555555555555' }))).error, 'enroll_policy_untrusted');
  await untouched();
  // Group-readable, symlinked or invalid files are never rewritten.
  await chmod(h.remoteFile, 0o644);
  assert.equal((await enrollOnMac(args(h))).error, 'enroll_policy_untrusted');
  await chmod(h.remoteFile, 0o600);
  await untouched();
  const s = await home(t);
  const real = join(s.home, 'elsewhere.json');
  await writeFile(real, await readFile(s.privateFile, 'utf8'), { mode: 0o600 });
  await rm(s.privateFile);
  await symlink(real, s.privateFile);
  assert.equal((await enrollOnMac(args(s))).error, 'enroll_policy_untrusted');
  assert.deepEqual((await json(real)).repos, ['memolabs-dev/alpha']);
  const bad = await home(t);
  await writeFile(bad.remoteFile, '{"projects": "alpha"}', { mode: 0o600 });
  assert.equal((await enrollOnMac(args(bad))).error, 'enroll_policy_untrusted');
  assert.deepEqual((await json(bad.privateFile)).repos, ['memolabs-dev/alpha']);
  // No owner-policy folder at all: refused as untrusted, nothing created.
  const none = await home(t);
  await rm(none.policyDir, { recursive: true });
  assert.equal((await enrollOnMac(args(none))).error, 'enroll_policy_untrusted');
});

test('#216 enrollOnMac refuses past 50 projects and serializes concurrent enrollments', async t => {
  const names = Array.from({ length: 50 }, (_, i) => `p${i}`);
  const full = await home(t, { repos: names.map(n => `memolabs-dev/${n}`), projects: names });
  assert.equal((await enrollOnMac(args(full))).error, 'enroll_limit');
  assert.equal((await json(full.privateFile)).repos.length, 50);
  const h = await home(t);
  const many = ['a1', 'b2', 'c3', 'd4', 'e5'];
  const results = await Promise.all(many.map(n => enrollOnMac(args(h, { name: n, repo: `memolabs-dev/${n}` }))));
  assert.ok(results.every(r => r.ok === true && r.enrolled === true), JSON.stringify(results));
  assert.deepEqual([...(await json(h.privateFile)).repos].sort(), ['memolabs-dev/alpha', ...many.map(n => `memolabs-dev/${n}`)].sort());
  assert.deepEqual([...(await json(h.remoteFile)).projects].sort(), ['alpha', ...many].sort());
});

test('#216 remotePolicyFromEnv rereads remote.json when the file changes, not once per process', async t => {
  const h = await home(t);
  const env = { MEMO_BRIDGE_REMOTE_CONFIG: h.remoteFile };
  const first = remotePolicyFromEnv(env);
  assert.deepEqual(first.projects, ['alpha']);
  assert.equal(remotePolicyFromEnv(env), first, 'unchanged file: the same frozen policy');
  assert.equal((await enrollOnMac(args(h))).ok, true);
  assert.deepEqual(remotePolicyFromEnv(env).projects, ['alpha', 'relay-v2']);
});

test('#216 a coordinator built before the enrollment opens the new project (policy getter)', async t => {
  const owner = makePrincipal('oidc:owner123', Object.values(CAPABILITIES), { client_type: 'chatgpt' });
  let projects = ['drop'];
  const remotePolicy = () => ({ configured: true, projects, remote_writes: 'enabled', session_binding: 'warn', allow_mac_runtime: true });
  const store = openSqliteStore({ dir: await tempStateDir(t) });
  t.after(() => store.close());
  const coordinator = createCoordinator({ store, principal: owner, host: 'mac', ledger: stubLedger(), resolveProject: stubProjects(),
    projectRemote: stubRemote, remotePolicy });
  assert.equal((await coordinator.workspaceOpen({ project: 'cuesheet', client_type: 'chatgpt', host: 'mac' })).error, 'project_not_allowed');
  projects = ['drop', 'cuesheet'];
  const opened = await coordinator.workspaceOpen({ project: 'cuesheet', client_type: 'chatgpt', host: 'mac' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
});
