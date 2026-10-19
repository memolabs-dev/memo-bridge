// The project template (owner console D-A2-3): templates/project/ agrees with memo-bridge's own
// gate files and runs its one required check offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { TEMPLATE_DIR, checkTemplate, filesPattern } from '../scripts/project-template.mjs';

test('A2: the template has the fleet Mergify policy, the sensitive-paths workflow and one check named check', () => {
  assert.deepEqual(checkTemplate(), []);
  assert.equal(filesPattern('    - "-files ~= ^(\\\\.github/|AGENTS\\\\.md$)"'), '^(\\.github/|AGENTS\\.md$)');
  assert.equal(filesPattern('    - -files ~= ^(\\.github/|AGENTS\\.md$)'), '^(\\.github/|AGENTS\\.md$)');
});

test('A2: the template\'s own test passes with no dependency installed', () => {
  const run = spawnSync(process.execPath, ['--test'], { cwd: TEMPLATE_DIR, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
