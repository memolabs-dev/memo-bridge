// Fail-closed Windows acceptance runner; intentionally refuses Linux/macOS.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  process.stderr.write('windows-native-check: requires a real Windows host (not a Linux simulation)\n');
  process.exitCode = 2;
} else {
  const bundle = fileURLToPath(new URL('../dist/standalone/index.mjs', import.meta.url));
  const personal = fileURLToPath(new URL('../dist/standalone/personal-cli.mjs', import.meta.url));
  if (!existsSync(bundle) || !existsSync(personal)) {
    process.stderr.write('windows-native-check: build:standalone and build:personal-remote required\n');
    process.exitCode = 2;
  } else {
    const suites = [
      'tests/windows-native.test.mjs',
      'tests/standalone-mcp.test.mjs',
      'tests/personal-auth.test.mjs',
      'tests/personal-http.test.mjs',
      'tests/gpu-inventory.test.mjs',
      'tests/gpu.test.mjs'
    ];
    const run = spawnSync(process.execPath, ['--test', '--test-timeout=180000', ...suites],
      { stdio: 'inherit', shell: false, windowsHide: true, timeout: 300000 });
    if (run.error) {
      process.stderr.write('windows-native-check: runner unavailable\n');
      process.exitCode = 1;
    } else if (run.status !== 0) {
      process.stderr.write('windows-native-check: validation failed\n');
      process.exitCode = run.status || 1;
    } else {
      process.stdout.write(JSON.stringify({
        ok: true, platform: process.platform,
        scope: 'native-windows-local-mcp',
        fixture: 'temporary-user-only',
        remote_chatgpt_e2e: false,
        gpu_execution: false
      }) + '\n');
    }
  }
}
