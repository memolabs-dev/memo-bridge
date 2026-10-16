import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPersonalRemoteFile, startPersonalRemote } from '../standalone/personal-entry.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'personal-mcp-auth-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const valid = {
  version: 1, enabled: true, issuer: 'https://identity.friend.example',
  resource: 'https://personal.friend.example/mcp', owner_sub: 'friend',
  allowed_client_ids: ['personal-client'], port: 4481
};

test('remote listener requires two explicit config paths, never picks the owner env', async () => {
  await assert.rejects(startPersonalRemote(), /explicit_configs_required/);
  await assert.rejects(startPersonalRemote({ configPath: '/tmp/example' }), /explicit_configs_required/);
});

test('remote config is opt-in and refuses nonexistent, invalid or symlinked files', async t => {
  const dir = await fixture(t);
  const file = join(dir, 'personal.json');
  await assert.rejects(loadPersonalRemoteFile(file), /remote_config_missing/);
  await assert.rejects(loadPersonalRemoteFile('relative.json'), /remote_config_requires_absolute_path/);
  await writeFile(file, JSON.stringify(valid));
  const config = await loadPersonalRemoteFile(file);
  assert.equal(config.ownerSub, 'friend');
  assert.equal(config.resource, valid.resource);
  assert.equal(config.port, 4481);
  await rm(file);
  const outside = join(dir, 'outside.json');
  await writeFile(outside, JSON.stringify(valid));
  await symlink(outside, file);
  await assert.rejects(loadPersonalRemoteFile(file), /remote_config_unsafe/);
  await rm(file);
  await writeFile(file, 'x'.repeat(17000));
  await assert.rejects(loadPersonalRemoteFile(file), /remote_config_unsafe/);
  await writeFile(file, '{bad');
  await assert.rejects(loadPersonalRemoteFile(file), /remote_config_invalid_json/);
});

test('inherited owner remote flags and credentials cannot be part of the standalone config', async t => {
  const dir = await fixture(t);
  const file = join(dir, 'personal.json');
  await writeFile(file, JSON.stringify({ ...valid, inherited_owner_token: 'secret' }));
  await assert.rejects(loadPersonalRemoteFile(file), /invalid_remote_config/);
});
