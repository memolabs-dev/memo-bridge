// Local installer; no network, no admin privilege, no owner or user enrollment.
import { fileURLToPath } from 'node:url';
import { installStandalone } from '../standalone/install.mjs';
import { standalonePaths } from '../standalone/config.mjs';

try {
  const file = fileURLToPath(new URL('../dist/standalone/index.mjs', import.meta.url));
  const paths = standalonePaths();
  const status = await installStandalone({ builtFile: file, paths });
  process.stdout.write(JSON.stringify({ ...status, ...paths }, null, 2) + '\n');
} catch (error) {
  const allowed = new Set(['build_required', 'unsafe_config_target', 'unsafe_install_target', 'invalid_install_arguments']);
  process.stderr.write('memo-bridge-standalone install: ' +
    (allowed.has(error.message) ? error.message : 'install_failed') + '\n');
  process.exitCode = 1;
}
