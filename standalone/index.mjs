// Executable local stdio entry. Do not import the owner-only server/index.mjs.
import { startStandalone } from './server.mjs';

const args = process.argv.slice(2);
if (args.length !== 0 && !(args.length === 2 && args[0] === '--config')) {
  process.stderr.write('memo-bridge-standalone: invalid_arguments\n');
  process.exitCode = 2;
} else {
  try {
    await startStandalone(args.length === 2 ? { configPath: args[1] } : {});
  } catch (error) {
    // No paths, secrets or exception stacks on stderr; stdout is reserved for JSON-RPC.
    const allowed = new Set(['config_not_initialized', 'config_invalid_json', 'config_invalid_schema',
      'config_invalid_project', 'config_path_invalid', 'config_unsafe_file', 'config_unreadable',
      'invalid_profile', 'invalid_windows_profile']);
    const code = allowed.has(error.message) ? error.message : 'startup_failed';
    process.stderr.write('memo-bridge-standalone: ' + code + '\n');
    process.exitCode = 1;
  }
}
