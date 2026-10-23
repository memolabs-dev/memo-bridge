// Phase 6, TODO-P6-02 (R-P6-08, R-P6-13; AC-P6-02 git config part, AC-P6-06 path part,
// AC-P6-13): realpath before every prefix check, read and write roots, the secret denylist on
// both the requested and the canonical path, .git internals and the repository guard D11 through
// the catalog (server/catalog.mjs), the registry Memo Bridge already uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDenylist, globToRegExp, resolveOperatorPath } from '../bridge/operator-paths.mjs';
import { parseOperatorPolicy } from '../bridge/operator-policy.mjs';
import { makeHost } from './helpers/operator-fixture.mjs';

test('denylist: D8 globs match the directory itself, everything below, any case', () => {
  const deny = createDenylist({ home: '/Users/owner', denylist: ['/srv/private/**'] });
  for (const path of ['/home/op/.ssh', '/home/op/.ssh/id_ed25519', '/root/.SSH/authorized_keys', '/srv/app/.env', '/srv/app/.env.production',
    '/srv/x/server.pem', '/etc/ssl/private/site.key', '/home/op/id_rsa', '/srv/app/client_secret.json', '/etc/shadow', '/etc/gshadow',
    '/Users/owner/Library/Keychains/login.keychain-db', '/etc/memo-operator/policy.json', '/etc/memo-bridge/operator-signing.key',
    '/home/op/.gnupg/pubring.kbx', '/etc/ssh/ssh_host_ed25519_key', '/srv/private/anything', '/home/op/.memo-operator/policy.json']) {
    assert.equal(deny.denied(path), true, path);
  }
  for (const path of ['/srv/app/config.txt', '/var/log/syslog', '/etc/hostname', '/etc/ssh/sshd_config', '/srv/environment.md']) {
    assert.equal(deny.denied(path), false, path);
  }
  assert.equal(globToRegExp('**/*.pem', '/h').test('/a.pem'), true, 'a ** prefix matches at the root too');
});

test('resolve: realpath first, then roots and denylist on the canonical path (AC-P6-06 path part)', async t => {
  const { p, policy } = makeHost(t);
  const ok = await resolveOperatorPath(policy, p('srv/app/config.txt'));
  assert.deepEqual([ok.ok, ok.path], [true, p('srv/app/config.txt')]);
  // ".." is resolved before the root check: the result is outside every root.
  assert.equal((await resolveOperatorPath(policy, p('srv/app/../../outside/plain.txt'))).error, 'path_not_allowed');
  // A symlink inside a root that points outside: refused on its target.
  assert.equal((await resolveOperatorPath(policy, p('srv/app/escape-link'))).error, 'path_not_allowed');
  // A harmless name that is a symlink into ~/.ssh: refused as a secret on its canonical path.
  assert.equal((await resolveOperatorPath(policy, p('home/op/innocent'))).error, 'path_secret');
  for (const secret of ['srv/app/.env', 'home/op/.ssh/id_ed25519', 'home/op/.ssh', 'home/op/keys/server.pem']) {
    assert.equal((await resolveOperatorPath(policy, p(secret))).error, 'path_secret', secret);
  }
  // Shape: relative, NUL, "~" on lab, too long.
  for (const raw of ['srv/app/config.txt', `${p('srv')}\0x`, '~/x', 'x'.repeat(5000), '', 42]) {
    assert.equal((await resolveOperatorPath(policy, raw)).error, 'invalid_path', String(raw).slice(0, 20));
  }
  assert.equal((await resolveOperatorPath(policy, p('srv/app/missing.txt'))).error, 'not_found');
  // rw needs a write root; r accepts both.
  assert.equal((await resolveOperatorPath(policy, p('srv/app/config.txt'), { access: 'rw' })).error, 'path_not_allowed');
  assert.equal((await resolveOperatorPath(policy, p('srv/rw/new.txt'), { access: 'rw', mustExist: false })).ok, true);
  assert.equal((await resolveOperatorPath(policy, p('srv/rw/new.txt'))).error, 'not_found', 'a read needs an existing file');
});

test('resolve on the Mac: "~/" expands to the agent home, Keychains stay denied', async t => {
  const { p } = makeHost(t);
  const policy = parseOperatorPolicy({ version: 1, host: 'mac', max_tier: 'read', roots: { read: ['~'], write: [] },
    frozen_file: '~/.memo-operator/FROZEN', audit_file: '~/.memo-operator/audit.jsonl' }, { home: p('home/op') });
  assert.equal((await resolveOperatorPath(policy, '~/keys')).ok, true);
  mkdirSync(p('home/op/Library/Keychains'), { recursive: true });
  writeFileSync(p('home/op/Library/Keychains/login.keychain-db'), 'x');
  assert.equal((await resolveOperatorPath(policy, '~/Library/Keychains/login.keychain-db')).error, 'path_secret');
});

// A registered checkout: PROJECTS.md under a projects root, the checkout under the write root.
function registeredCheckout(t, host, branch) {
  const { p } = host;
  const checkout = p('srv/rw/project');
  mkdirSync(join(checkout, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  writeFileSync(join(checkout, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  writeFileSync(join(checkout, '.git', 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/main\n');
  writeFileSync(join(checkout, '.git', 'config'), '[core]\n');
  writeFileSync(join(checkout, 'README.md'), '# project\n');
  symlinkSync(checkout, p('srv/rw/projects-link'));
  writeFileSync(p('srv/rw/PROJECTS.md'), ['# registry', '## Projets appartenant à Memo Labs', '| Name | Path | Kind | Status | Nature | Stack | Vault note |',
    '|---|---|---|---|---|---|---|', '| project | project | repo | active | infra | Node.js | - |', '## Dépôts de référence'].join('\n'));
  return checkout;
}

// Owner decision 2026-10-23: the agent works in the canonical checkout, on whatever branch it is
// on; no tool sends it to a worktree. The default branch is protected on GitHub, not here.
test('AC-P6-13: a write inside a registered checkout is allowed on its default branch and on a detached HEAD', async t => {
  const host = makeHost(t);
  const checkout = registeredCheckout(t, host, 'main');
  const policy = parseOperatorPolicy({ ...host.raw, repositories: { projects_root: host.p('srv/rw'), layout_root: host.p('srv/rw') } });
  assert.equal((await resolveOperatorPath(policy, join(checkout, 'README.md'), { access: 'rw' })).ok, true);
  assert.equal((await resolveOperatorPath(policy, host.p('srv/rw/projects-link/README.md'), { access: 'rw' })).ok, true);
  writeFileSync(join(checkout, '.git', 'HEAD'), 'a'.repeat(40) + '\n');
  assert.equal((await resolveOperatorPath(policy, join(checkout, 'README.md'), { access: 'rw' })).ok, true);
});

test('AC-P6-02 (git part): .git internals are never writable, whatever the branch', async t => {
  const host = makeHost(t);
  const checkout = registeredCheckout(t, host, 'feature/x');
  const policy = parseOperatorPolicy({ ...host.raw, repositories: { projects_root: host.p('srv/rw'), layout_root: host.p('srv/rw') } });
  for (const inside of ['.git/config', '.git/HEAD']) {
    assert.equal((await resolveOperatorPath(policy, join(checkout, inside), { access: 'rw' })).error, 'git_internal', inside);
  }
  assert.equal((await resolveOperatorPath(policy, join(checkout, '.git', 'hooks', 'pre-commit'), { access: 'rw', mustExist: false })).error, 'git_internal');
});
