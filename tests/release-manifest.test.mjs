// Release manifest (TODO-P4-15): the pinned sha plus one checksum lab-infra records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOYED, buildManifest } from '../scripts/release-manifest.mjs';

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { env: gitEnv, encoding: 'utf8' }).trim();

test('the manifest lists exactly the deployed files of HEAD, with one checksum over SHA256SUMS', t => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'mb-release-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  for (const dir of ['bridge', 'server/runners', 'deploy', 'tests', 'docs']) mkdirSync(join(repo, dir), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'memo-bridge', version: '0.5.0' }));
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n');
  writeFileSync(join(repo, 'bridge', 'hub.mjs'), 'hub');
  writeFileSync(join(repo, 'server', 'runners', 'jobs.mjs'), 'jobs');
  writeFileSync(join(repo, 'deploy', 'memo-runner-dispatch'), '#!/usr/bin/python3 -I\n');
  chmodSync(join(repo, 'deploy', 'memo-runner-dispatch'), 0o755);
  writeFileSync(join(repo, 'deploy', 'record-result'), '#!/usr/bin/python3 -I\n');
  chmodSync(join(repo, 'deploy', 'record-result'), 0o755);
  writeFileSync(join(repo, 'deploy', 'README.md'), 'not deployed');
  writeFileSync(join(repo, 'tests', 'x.test.mjs'), 'not deployed');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'release');
  const head = git(repo, 'rev-parse', 'HEAD');

  const { sums, manifest } = buildManifest(repo);
  assert.equal(manifest.commit, head);
  assert.equal(manifest.version, '0.5.0');
  assert.equal(manifest.dirty, false);
  assert.deepEqual(manifest.deployed_paths, [...DEPLOYED]);
  assert.deepEqual(manifest.files.map(f => f.path), ['bridge/hub.mjs', 'deploy/memo-runner-dispatch', 'deploy/record-result',
    'package.json', 'pnpm-lock.yaml', 'server/runners/jobs.mjs']);
  assert.deepEqual(manifest.executables, ['deploy/memo-runner-dispatch', 'deploy/record-result']);
  assert.match(sums, /^[0-9a-f]{64} {2}bridge\/hub\.mjs\n/);
  assert.equal(sums.split('\n').filter(Boolean).length, 6);
  assert.equal(manifest.sums_sha256, createHash('sha256').update(sums).digest('hex'));
  assert.equal(manifest.files[0].sha256, createHash('sha256').update('hub').digest('hex'));

  // A modified or untracked deployed file makes the tree dirty: refused unless explicitly allowed.
  writeFileSync(join(repo, 'server', 'runners', 'new.mjs'), 'untracked');
  assert.throws(() => buildManifest(repo), /dirty_tree/);
  assert.equal(buildManifest(repo, { allowDirty: true }).manifest.dirty, true);
  rmSync(join(repo, 'server', 'runners', 'new.mjs'));
  // Changes outside the deployed set do not matter.
  writeFileSync(join(repo, 'docs', 'note.md'), 'x');
  assert.equal(buildManifest(repo).manifest.sums_sha256, manifest.sums_sha256);
});
