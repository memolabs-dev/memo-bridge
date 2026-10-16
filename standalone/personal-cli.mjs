// Explicit opt-in local listener: --config and --remote-config are both mandatory.
// The installer must supply their own OIDC issuer and their own HTTPS reverse proxy/tunnel.
import { startPersonalRemote } from './personal-entry.mjs';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--remote-config') {
  process.stderr.write('memo-bridge-personal: requires --config ABS_PATH --remote-config ABS_PATH\n');
  process.exitCode = 2;
} else {
  try {
    const { address } = await startPersonalRemote({ configPath: args[1], remoteConfigPath: args[3] });
    process.stderr.write('memo-bridge-personal: loopback_ready port=' + address.port + '\n');
  } catch (error) {
    const codes = new Set(['remote_config_missing', 'remote_config_invalid_json', 'remote_config_unsafe',
      'remote_config_unreadable', 'remote_config_requires_absolute_path', 'explicit_configs_required',
      'config_not_initialized', 'config_unsafe_file', 'config_invalid_project', 'config_invalid_schema',
      'config_invalid_json']);
    process.stderr.write('memo-bridge-personal: ' +
      (codes.has(error.message) ? error.message : 'startup_refused') + '\n');
    process.exitCode = 1;
  }
}
