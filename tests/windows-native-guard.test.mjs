import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Windows acceptance command refuses non-Windows hosts instead of accepting simulated results',
  { skip: process.platform === 'win32' }, () => {
    const script = fileURLToPath(new URL('../scripts/windows-native-check.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /requires a real Windows host/);
    assert.ok(!result.stdout.includes('"ok":true'));
  });
