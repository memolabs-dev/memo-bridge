// Which operator calls need the owner's approval (Phase 6, TODO-P6-11, spec D5).
//
// One pure classifier, used by the hub (to park the call and ask Telegram), by the operator
// agent and by the root helper (to refuse a call whose signature carries no approval when
// their own local policy says it needs one). It reads the tool arguments only; a caller can
// add arguments but never remove the ones that matched, since the approval and the signature
// both bind the SHA-256 of the exact arguments.
//
// Dangerous list v1 (spec D5), and the reading of each entry here:
//  - any operator_script;
//  - operator_run whose argv names, at any position, rm, dd, mkfs*, wipefs, parted, fdisk,
//    sfdisk, ufw, nft, iptables, ip6tables, userdel, passwd, chpasswd, reboot, shutdown,
//    poweroff, halt; or whose program is a shell, interpreter or command wrapper (bash, python3, env, xargs,
//    find, sudo, sed, awk, docker, git, package managers...) since an argv classifier cannot see
//    what they will run (DEV-P6-19);
//  - systemctl stop, disable or mask (through operator_run or operator_service) of ssh,
//    traefik or memo-bridge-* units; reboot, poweroff, halt through systemctl;
//  - any argument or write path under /etc/ssh, /etc/sudoers*, /etc/pam.d, /etc/passwd,
//    /etc/shadow (and /etc/group, /etc/gshadow);
//  - operator_delete of a directory (recursive). "More than 20 files" cannot be known from
//    the arguments alone, so every recursive delete asks.
// Lot 3, the Mac (DEV-P6-25): osascript, launchctl, open and security are wrappers too (AppleScript
// runs shell lines, launchctl and open start programs outside the call, security reads the
// keychain); and any argument or write path naming the agent's own control files
// (.memo-operator, /etc/memo-operator) or ~/Library/LaunchAgents asks, since T2 on the Mac runs
// as the owner and could otherwise rewrite its policy or plant a launchd job without a word.
// approval_mode: off (never), dangerous (this list), all_root (this list plus every T3 call).
import { basename } from 'node:path';

export const APPROVAL_TTL_MS = 10 * 60_000;
export const STANDING_APPROVAL_MS = 15 * 60_000;

const DESTRUCTIVE = new Set(['rm', 'dd', 'wipefs', 'parted', 'fdisk', 'sfdisk', 'gdisk', 'ufw', 'nft', 'iptables', 'ip6tables',
  'iptables-restore', 'nft-restore', 'userdel', 'usermod', 'passwd', 'chpasswd', 'reboot', 'shutdown', 'poweroff', 'halt',
  'shred', 'truncate', 'visudo', 'deluser', 'kill', 'pkill', 'killall']);
const WRAPPERS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh', 'fish', 'busybox', 'python', 'python3', 'perl', 'ruby', 'node', 'php',
  'env', 'xargs', 'find', 'sudo', 'doas', 'su', 'nice', 'ionice', 'timeout', 'nohup', 'setsid', 'chroot', 'nsenter', 'unshare',
  'systemd-run', 'runuser', 'flock', 'watch', 'stdbuf', 'ssh', 'awk', 'gawk', 'mawk', 'sed', 'crontab', 'at', 'docker', 'make',
  'git', 'npm', 'npx', 'pnpm', 'pip', 'pip3', 'apt', 'apt-get', 'dpkg', 'osascript', 'launchctl', 'open', 'security']);
const CRITICAL_UNIT_RE = /^(ssh|sshd|traefik|memo-bridge-[A-Za-z0-9@._-]*|memo-operator[A-Za-z0-9@._-]*)(\.service|\.socket)?$/;
const SENSITIVE_PATH_RE = /^\/etc\/(ssh(\/|$)|sudoers|pam\.d(\/|$)|passwd-?$|shadow-?$|group-?$|gshadow-?$)/;
// Anywhere in the value, any letter case (APFS): the operator's own control files and launchd jobs.
const AGENT_CONTROL_RE = /(^|\/)\.memo-operator(\/|$)|^\/etc\/memo-operator(\/|$)|\/Library\/LaunchAgents(\/|$)/i;

const isDestructiveName = name => DESTRUCTIVE.has(name) || /^mkfs(\.|$)/.test(name);
const sensitivePath = value => typeof value === 'string'
  && [SENSITIVE_PATH_RE, AGENT_CONTROL_RE].some(re => re.test(value.replace(/\/{2,}/g, '/')));

// Why this call is dangerous, or null. op and args as the tool receives them.
export function dangerReason(op, args = {}) {
  if (op === 'operator_script') return 'script';
  if (op === 'operator_run') {
    const argv = Array.isArray(args.argv) ? args.argv.filter(a => typeof a === 'string') : [];
    // A wrapper only matters as the program itself: whatever it runs is then out of sight.
    const program = basename(argv[0] ?? '');
    if (WRAPPERS.has(program) || /^python3?(\.\d+)?$/.test(program)) return `wrapper:${program}`;
    for (const item of argv) {
      const name = basename(item);
      if (isDestructiveName(name)) return `command:${name}`;
      // "--file=/etc/shadow" style arguments are checked on their value too.
      const value = item.includes('=') ? item.slice(item.indexOf('=') + 1) : item;
      if (sensitivePath(item) || sensitivePath(value)) return 'sensitive_path';
    }
    const i = argv.findIndex(a => basename(a) === 'systemctl');
    if (i >= 0) {
      const rest = argv.slice(i + 1).filter(a => !a.startsWith('-'));
      const verb = rest[0];
      if (['reboot', 'poweroff', 'halt', 'kexec', 'emergency', 'rescue', 'isolate', 'kill'].includes(verb)) return `systemctl:${verb}`;
      if (['stop', 'disable', 'mask'].includes(verb) && rest.slice(1).some(u => CRITICAL_UNIT_RE.test(u))) return `systemctl:${verb}`;
    }
    return null;
  }
  if (op === 'operator_service') {
    return ['stop'].includes(args.action) && CRITICAL_UNIT_RE.test(String(args.unit)) ? `service:${args.action}` : null;
  }
  if (op === 'operator_delete') {
    if (args.recursive === true) return 'delete_directory';
    return sensitivePath(args.path) ? 'sensitive_path' : null;
  }
  if (['operator_edit', 'operator_chmod', 'operator_upload_init'].includes(op)) return sensitivePath(args.path) ? 'sensitive_path' : null;
  if (['operator_move', 'operator_copy'].includes(op)) return sensitivePath(args.src) || sensitivePath(args.dst) ? 'sensitive_path' : null;
  return null;
}

// Does this call need an approval under `mode`? tier is the call's tier (0..3).
export function needsApproval(mode, op, args, tier) {
  if (mode === 'off') return false;
  if (mode === 'all_root' && tier === 3) return true;
  if (mode === 'dangerous' || mode === 'all_root') return dangerReason(op, args) !== null;
  return true; // unknown mode: fail closed
}
