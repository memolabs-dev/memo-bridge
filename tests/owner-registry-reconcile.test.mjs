import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, chmod, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileOwnerRegistry, startOwnerRegistryReconciler } from '../server/projects/reconcile-owner-registry.mjs';

const SUB = '7f0c2a51-3b8e-4d7a-9c11-2f4e5a6b7c8d';
async function fixture(t, optIn = true) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'owner-registry-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, '.local/share/memo-bridge/owner-policy');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const remoteConfigPath = join(dir, 'remote.json'), privatePolicyPath = join(dir, 'private-repos.json');
  const remote = { version: 1, oidc: { owner_sub: SUB }, projects: ['existing'], remote_writes: 'disabled',
    session_binding: 'enforce', ...(optIn ? { registry_enrollment: 'all-owner-projects' } : {}) };
  await writeFile(remoteConfigPath, JSON.stringify(remote), { mode: 0o600 });
  await writeFile(privatePolicyPath, JSON.stringify({ schema: 'memolabs.owner-private-repos.v1', owner_sub: SUB, repos: ['memolabs-dev/existing'] }), { mode: 0o600 });
  const projects = ['private-app', 'public-app'].map(name => ({ name, kind: 'repo', available: true, path: `/fake/${name}` }));
  return { home, host: 'mac', ownerSub: SUB, remoteConfigPath, privatePolicyPath,
    readRegistry: async () => ({ projects }), origin: async path => `memolabs-dev/${path.split('/').at(-1)}`,
    visibility: async repo => ({ private: repo.endsWith('private-app'), archived: false }) };
}

test('explicit global opt-in reconciles public/private and removals; preserves other gates and backups', async t => {
  const opts = await fixture(t);
  const old = await readFile(opts.remoteConfigPath, 'utf8');
  const result = await reconcileOwnerRegistry(opts);
  assert.equal(result.ok, true); assert.equal(result.changed, true);
  const remote = JSON.parse(await readFile(opts.remoteConfigPath, 'utf8'));
  assert.deepEqual(remote.projects, ['private-app', 'public-app']);
  assert.equal(remote.remote_writes, 'disabled'); assert.equal(remote.session_binding, 'enforce');
  assert.equal(await readFile(`${opts.remoteConfigPath}.registry-backup`, 'utf8'), old);
  assert.deepEqual(JSON.parse(await readFile(opts.privatePolicyPath, 'utf8')).repos, ['memolabs-dev/private-app']);
  assert.equal((await reconcileOwnerRegistry(opts)).changed, false);
});
test('legacy opt-out, wrong owner, VPS and foreign config cannot reconcile', async t => {
  const opts = await fixture(t, false);
  const before = await readFile(opts.remoteConfigPath, 'utf8');
  assert.equal((await reconcileOwnerRegistry(opts)).enabled, false);
  assert.equal((await reconcileOwnerRegistry({ ...opts, host: 'vps' })).error, 'reconcile_unsupported');
  assert.equal((await reconcileOwnerRegistry({ ...opts, ownerSub: 'other' })).error, 'reconcile_policy_untrusted');
  assert.equal((await reconcileOwnerRegistry({ ...opts, remoteConfigPath: '/tmp/remote.json' })).error, 'reconcile_unsupported');
  assert.equal(await readFile(opts.remoteConfigPath, 'utf8'), before);
});
test('GitHub failure and untrusted modes leave both live files unchanged', async t => {
  const opts = await fixture(t);
  const before = await readFile(opts.remoteConfigPath, 'utf8');
  const privateBefore = await readFile(opts.privatePolicyPath, 'utf8');
  assert.equal((await reconcileOwnerRegistry({ ...opts, visibility: async () => null })).error, 'reconcile_github_unverified');
  await chmod(opts.remoteConfigPath, 0o644);
  assert.equal((await reconcileOwnerRegistry(opts)).error, 'reconcile_policy_untrusted');
  assert.equal(await readFile(opts.remoteConfigPath, 'utf8'), before);
  assert.equal(await readFile(opts.privatePolicyPath, 'utf8'), privateBefore);
});
test('concurrent policy change during GitHub attestation is detected rather than overwritten', async t => {
  const opts = await fixture(t);
  const changed = { ...JSON.parse(await readFile(opts.remoteConfigPath, 'utf8')), projects: ['other'] };
  assert.equal((await reconcileOwnerRegistry({ ...opts, visibility: async () => {
    await writeFile(opts.remoteConfigPath, JSON.stringify(changed)); return { private: true, archived: false };
  } })).error, 'reconcile_policy_changed');
  assert.deepEqual(JSON.parse(await readFile(opts.remoteConfigPath, 'utf8')).projects, ['other']);
});
test('scheduler shares one in-flight reconciliation and stops on shutdown', async () => {
  let finish, calls = 0;
  const worker = startOwnerRegistryReconciler({ reconcile: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const first = worker.run(), second = worker.run();
  assert.equal(first, second);
  await Promise.resolve(); assert.equal(calls, 1);
  finish({ ok: true }); await first; await worker.close(); await worker.run();
  assert.equal(calls, 1);
});


test('transient origin or checkout failure cannot revoke enrolled projects', async t => {
  const opts = await fixture(t);
  const before = await readFile(opts.remoteConfigPath, 'utf8');
  const privateBefore = await readFile(opts.privatePolicyPath, 'utf8');
  assert.equal((await reconcileOwnerRegistry({ ...opts, origin: async () => null })).error, 'reconcile_registry_unverified');
  assert.equal((await reconcileOwnerRegistry({ ...opts, readRegistry: async () => ({ projects: [
    { name: 'existing', kind: 'repo', available: false, path: null }
  ] }) })).error, 'reconcile_registry_unverified');
  assert.equal(await readFile(opts.remoteConfigPath, 'utf8'), before);
  assert.equal(await readFile(opts.privatePolicyPath, 'utf8'), privateBefore);
});


test('a crashed writer lock expires but a fresh lock stays exclusive', async t => {
  const opts = await fixture(t);
  const lock = join(opts.home, '.local/share/memo-bridge/owner-policy/.enroll.lock');
  await mkdir(lock);
  assert.equal((await reconcileOwnerRegistry({ ...opts, lockWaitMs: 0 })).error, 'reconcile_locked');
  await utimes(lock, new Date(0), new Date(0));
  assert.equal((await reconcileOwnerRegistry({ ...opts, lockWaitMs: 0 })).ok, true);
});
