// Mac root helper entry point: the LaunchDaemon dev.memolabs.memo-operator-root, as root, from
// the root-owned copy in /Library/Application Support/MemoBridge/operator-root (installed by
// deploy/mac/install-operator-root.sh). Every check is in bridge/operator-root-mac.mjs.
//   operator-root-mac-cli.mjs           serve the socket
//   operator-root-mac-cli.mjs --check   validate the installation, print one JSON line, exit
// Any problem stops the process before the socket exists (fail closed); launchd retries.
import { startMacRootHelper } from './operator-root-mac.mjs';

const log = (event, details = {}) => console.error(JSON.stringify({ at: new Date().toISOString(), event, host: 'operator-root-mac', ...details }));
const check = process.argv.includes('--check');
try {
  const started = await startMacRootHelper({ check, log });
  if (check) {
    console.log(JSON.stringify(started.summary));
    process.exit(0);
  }
  log('root_helper_ready', { socket: started.summary.socket });
  process.on('SIGTERM', async () => { await started.server.stop(); process.exit(0); });
} catch (error) {
  log('root_helper_refused_to_start', { error: String(error?.message ?? error).slice(0, 300) });
  process.exit(1);
}
