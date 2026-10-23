#!/usr/bin/env node
// Cooperative local-agent checkout lease wrapper (macOS, opt-in).
// Usage: node scripts/with-checkout-lease.mjs --repo /abs/git/repo
//          --state-dir /abs/private/memo-operator-state -- claude [args]
// Both Claude Code and OpenCode can be run under this wrapper. It does not
// sandbox arbitrary shell access, nor authenticate distinct same-UID processes.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { createMacCheckoutAuthority, checkoutRootFor } from '../bridge/mac-checkout-authority.mjs';

const options = process.argv.slice(2);
const sep = options.indexOf('--');
const settings = sep >= 0 ? options.slice(0, sep) : options;
const argv = sep >= 0 ? options.slice(sep + 1) : [];
const get = key => { const i = settings.indexOf(key); return i < 0 ? null : settings[i + 1]; };
const repo = get('--repo');
const stateDir = get('--state-dir');
function stop(message, exitCode = 2) { console.error(message); process.exit(exitCode); }
if (process.platform !== 'darwin') stop('Mac-only checkout wrapper');
if (!repo || !stateDir || !isAbsolute(repo) || !isAbsolute(stateDir) || argv.length === 0) {
  stop('Usage: --repo /absolute/git/repo --state-dir /absolute/private/state -- <program> [args]');
}
if (settings.length !== 4 || !settings.includes('--repo') || !settings.includes('--state-dir')) stop('Unknown checkout-wrapper options');

const found = checkoutRootFor(repo);
if (!found.ok || !found.root) stop('Refusing a non-Git or unverified checkout');
const authority = createMacCheckoutAuthority({ stateDir });
const input = { root: found.root, principal: 'local:mac-supervised', session: randomBytes(16).toString('hex') };
const first = authority.acquire(input);
if (!first.ok) stop('Checkout is unavailable: ' + first.error, 73);

let child;
let finished = false;
// A descendant may remain in the detached process group after the direct
// child exits. Always target the group, including during that interval.
const groupAlive = () => {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
};
const signalChild = sig => {
  if (!child) return;
  try {
    if (groupAlive()) process.kill(-child.pid, sig);
    else if (child.exitCode === null) child.kill(sig);
  } catch {
    if (child.exitCode === null) try { child.kill(sig); } catch { /* exited */ }
  }
};
const heartbeat = setInterval(() => {
  if (finished) return;
  const renewed = authority.acquire(input);
  if (!renewed.ok) {
    console.error('Checkout lease lost (' + renewed.error + '); terminating supervised process');
    signalChild('SIGTERM');
    clearInterval(heartbeat);
  }
}, 15_000);
heartbeat.unref();

try {
  child = spawn(argv[0], argv.slice(1), { cwd: found.root, stdio: 'inherit', shell: false, detached: true });
} catch (error) {
  clearInterval(heartbeat);
  authority.release(input);
  stop('Cannot launch command: ' + (error?.code || 'spawn_failed'));
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => signalChild(sig));
const exit = (code, signal) => {
  if (finished) return;
  finished = true;
  clearInterval(heartbeat);
  const released = authority.release(input);
  if (!released.ok) console.error('Checkout lease release requires review: ' + released.error);
  process.exitCode = released.ok ? (code ?? (signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : 1)) : 74;
};
// Child "exit" does NOT mean all members of its process group have stopped.
 // Keep the lease and heartbeat until the entire group has drained; an
 // orphaned descendant must not silently hand the checkout to another agent.
child.once('exit', (code, signal) => {
  const inspectGroup = () => {
    if (finished) return;
    if (groupAlive()) {
      setTimeout(inspectGroup, 200);
      return;
    }
    exit(code, signal);
  };
  inspectGroup();
});
child.once('error', error => {
  console.error('Supervised agent failed to launch: ' + (error?.code || 'spawn_failed'));
  exit(1, null);
});
