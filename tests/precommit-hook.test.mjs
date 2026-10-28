import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const run = (cwd, command, args) =>
  spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, CI: '' } });

test('git hook checks the exact staged snapshot, including invalid JS', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-git-hook-'));
  try {
    mkdirSync(join(cwd, '.githooks'));
    mkdirSync(join(cwd, 'scripts'));
    for (const path of ['.githooks/pre-commit', 'scripts/install-git-hooks.sh',
      'scripts/check-staged-syntax.mjs']) {
      copyFileSync(join(project, path), join(cwd, path));
    }
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      private: true, type: 'module',
      scripts: { 'check:staged': 'node scripts/check-staged-syntax.mjs' },
    }));
    assert.equal(run(cwd, 'git', ['init', '-q']).status, 0);
    assert.equal(run(cwd, 'sh', ['scripts/install-git-hooks.sh']).status, 0);
    assert.equal(run(cwd, 'git', ['config', '--local', '--get', 'core.hooksPath']).stdout.trim(), '.githooks');

    writeFileSync(join(cwd, 'notes.txt'), 'bad trailing whitespace  \n');
    assert.equal(run(cwd, 'git', ['add', 'notes.txt']).status, 0);
    assert.notEqual(run(cwd, 'sh', ['.githooks/pre-commit']).status, 0);

    writeFileSync(join(cwd, 'notes.txt'), 'clean\n');
    assert.equal(run(cwd, 'git', ['add', 'notes.txt']).status, 0);
    assert.equal(run(cwd, 'sh', ['.githooks/pre-commit']).status, 0);

    writeFileSync(join(cwd, 'broken.mjs'), 'export const = ;\n');
    assert.equal(run(cwd, 'git', ['add', 'broken.mjs']).status, 0);
    // The syntax gate is also directly runnable in an isolated repo with Node only.
    assert.notEqual(run(cwd, 'node', ['scripts/check-staged-syntax.mjs']).status, 0);
    writeFileSync(join(cwd, 'broken.mjs'), 'export const ok = true;\n');
    assert.equal(run(cwd, 'git', ['add', 'broken.mjs']).status, 0);
    assert.equal(run(cwd, 'node', ['scripts/check-staged-syntax.mjs']).status, 0);

    writeFileSync(join(cwd, '.env'), 'EXAMPLE=fake\n');
    assert.equal(run(cwd, 'git', ['add', '.env']).status, 0);
    assert.notEqual(run(cwd, 'sh', ['.githooks/pre-commit']).status, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
