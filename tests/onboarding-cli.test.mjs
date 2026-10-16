import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve('scripts/check-product-onboarding.mjs');

test('onboarding CLI outputs a newline-terminated help message', () => {
  const run = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Usage: node scripts\/check-product-onboarding/);
  assert.ok(run.stdout.endsWith('\n'));
});

test('onboarding CLI outputs machine-parseable JSON without authorizing missing gates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memo-onboard-cli-'));
  try {
    await mkdir(join(root, 'products', 'rebuild-radar'), { recursive: true });
    await writeFile(join(root, 'PROJECTS.md'),
      '# Test registry\n\n## Projets appartenant à Memo Labs\n' +
      '| Name | Path | Kind | Status | Nature | Stack | Vault note |\n' +
      '|---|---|---|---|---|---|---|\n' +
      '| rebuild-radar | products/rebuild-radar | repo | active | app | TypeScript | - |\n' +
      '\n## Dépôts de référence\n');
    const run = spawnSync(process.execPath, [cli, 'rebuild-radar'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, MEMO_BRIDGE_PROJECTS_ROOT: root, MEMOLABS_ROOT: root }
    });
    assert.equal(run.status, 1, run.stderr);
    assert.ok(run.stdout.endsWith('\n'));
    const result = JSON.parse(run.stdout);
    assert.equal(result.all_coordinator_ready, false);
    assert.equal(result.projects[0].name, 'rebuild-radar');
    assert.equal(result.projects[0].origin_verified, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('onboarding CLI emits parseable JSON for unavailable registry errors', () => {
  const root = join(tmpdir(), 'intentionally-unavailable-project-registry', String(process.pid));
  const run = spawnSync(process.execPath, [cli, 'rebuild-radar'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, MEMO_BRIDGE_PROJECTS_ROOT: root, MEMOLABS_ROOT: root }
  });
  assert.equal(run.status, 2);
  assert.ok(run.stdout.endsWith('\n'));
  assert.equal(JSON.parse(run.stdout).error, 'preflight_unavailable');
});
