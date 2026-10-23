// No credentials are issued or stored. Checks a personally owned authorization
// server BEFORE the owner explicitly enables a remote HTTPS edge.
import { loadPersonalRemoteFile } from '../standalone/personal-entry.mjs';
import { preflightPersonalIssuer } from '../standalone/personal-preflight.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--remote-config') {
  process.stderr.write('personal-preflight: --remote-config ABSOLUTE_PATH required\n');
  process.exitCode = 2;
} else {
  try {
    const settings = await loadPersonalRemoteFile(args[1]);
    const result = await preflightPersonalIssuer(settings);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
  } catch {
    // Never dump paths, OAuth material, private infrastructure or provider bodies.
    process.stderr.write('personal-preflight: invalid_personal_configuration\n');
    process.exitCode = 1;
  }
}
