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
// Mac root (spec §13 Mac root follow-up, R-MR-08): disk, firmware, encryption, user, firewall
// and privacy tools anywhere in argv (diskutil, csrutil, nvram, fdesetup, sysadminctl,
// dseditgroup, pfctl, tccutil, bless, kextload...), dscl with a writing verb (-create, -delete,
// -passwd...; -read and -list stay free), and any path under /Library/LaunchDaemons, the root
// helper's own files (/Library/Application Support/MemoBridge, /var/log/memo-operator,
// /var/db/memo-operator-root, /var/run/memo-operator) or the local user database
// (/var/db/dslocal). `rm` was already on the list, recursive or not; launchctl was already a
// wrapper (bootout system included). /private/etc, /private/var and /private/tmp are read as
// /etc, /var and /tmp first: on macOS /etc is a symlink to /private/etc (DEV-P6-39).
// approval_mode: off (never), dangerous (this list), all_root (this list plus every T3 call).
import { basename } from 'node:path';

export const APPROVAL_TTL_MS = 10 * 60_000;
// Standing approvals (operator-grants.mjs) carry ids with this prefix; single-use ones never do.
export const STANDING_ID_PREFIX = 'ap_st_';
export const isStandingApproval = id => typeof id === 'string' && id.startsWith(STANDING_ID_PREFIX);
// May a signed approval id stand for this call (spec D-R5)? A standing id only for a grantable
// operator_run or operator_script below T3; any single-use id as before.
export function approvalInScope(approval, op, args, tier) {
  if (!isStandingApproval(approval)) return true;
  if (tier === 3 || !['operator_run', 'operator_script'].includes(op)) return false;
  const danger = classifyCall(op, args);
  return danger === null || danger.hard === false;
}
export const STANDING_APPROVAL_MS = 15 * 60_000;

const DESTRUCTIVE = new Set(['rm', 'dd', 'wipefs', 'parted', 'fdisk', 'sfdisk', 'gdisk', 'ufw', 'nft', 'iptables', 'ip6tables',
  'iptables-restore', 'nft-restore', 'userdel', 'usermod', 'passwd', 'chpasswd', 'reboot', 'shutdown', 'poweroff', 'halt',
  'shred', 'truncate', 'visudo', 'deluser', 'kill', 'pkill', 'killall',
  // macOS (Mac root): disks, firmware and boot, FileVault, users and groups, firewall, privacy.
  'diskutil', 'asr', 'hdiutil', 'gpt', 'newfs_apfs', 'newfs_hfs', 'csrutil', 'nvram', 'bless', 'fdesetup', 'sysadminctl',
  'dseditgroup', 'createhomedir', 'pfctl', 'socketfilterfw', 'tccutil', 'spctl', 'kextload', 'kextunload', 'kmutil', 'systemsetup',
  'softwareupdate', 'pmset']);
// dscl verbs that change the directory (users, groups, passwords); -read, -list, -search do not.
const DSCL_WRITES = new Set(['-create', '-createpl', '-createpli', '-append', '-appendpl', '-appendpli', '-merge', '-mergepl', '-mergepli',
  '-delete', '-deletepl', '-deletepli', '-change', '-changei', '-passwd', '-mcxset', '-mcxdelete', '-mcximport', '-auth', '-authonly']);
const WRAPPERS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh', 'fish', 'busybox', 'python', 'python3', 'perl', 'ruby', 'node', 'php',
  'env', 'xargs', 'find', 'sudo', 'doas', 'su', 'nice', 'ionice', 'timeout', 'nohup', 'setsid', 'chroot', 'nsenter', 'unshare',
  'systemd-run', 'runuser', 'flock', 'watch', 'stdbuf', 'awk', 'gawk', 'mawk', 'sed', 'crontab', 'at', 'docker', 'make',
  'git', 'npm', 'npx', 'pnpm', 'pip', 'pip3', 'apt', 'apt-get', 'dpkg', 'osascript', 'launchctl', 'open', 'security']);
const CRITICAL_UNIT_RE = /^(ssh|sshd|traefik|memo-bridge-[A-Za-z0-9@._-]*|memo-operator[A-Za-z0-9@._-]*)(\.service|\.socket)?$/;
const SENSITIVE_PATH_RE = /^\/etc\/(ssh(\/|$)|sudoers|pam\.d(\/|$)|passwd-?$|shadow-?$|group-?$|gshadow-?$)/;
// Anywhere in the value, any letter case (APFS): the operator's own control files and launchd jobs.
const AGENT_CONTROL_RE = /(^|\/)\.memo-operator(\/|$)|^\/etc\/memo-operator(\/|$)|\/Library\/LaunchAgents(\/|$)/i;
// Mac root: launchd daemons, the root helper's files, the local user database (any case).
const MAC_ROOT_CONTROL_RE = /\/Library\/LaunchDaemons(\/|$)|\/Library\/Application Support\/MemoBridge(\/|$)|^\/var\/(log\/memo-operator|db\/memo-operator-root|run\/memo-operator|db\/dslocal)(\/|$)/i;

export const DESTRUCTIVE_PROGRAMS = DESTRUCTIVE;
const isDestructiveName = name => DESTRUCTIVE.has(name) || /^mkfs(\.|$)/.test(name);
// One spelling per path: repeated slashes folded, /private/{etc,var,tmp} read as /{etc,var,tmp}.
const fold = value => value.replace(/\/{2,}/g, '/').replace(/^\/private\/(etc|var|tmp)(?=\/|$)/i, '/$1');
const sensitivePath = value => typeof value === 'string'
  && [SENSITIVE_PATH_RE, AGENT_CONTROL_RE, MAC_ROOT_CONTROL_RE].some(re => re.test(fold(value)));

// Repatriation (spec .agent/project/repatriate D-R1 to D-R3, D-R9, D-R11): every danger is either
// HARD (asks every time; no standing approval covers it) or GRANTABLE (a standing approval that
// names every wrapper or remote program of the call covers it, operator-grants.mjs). Hard
// reasons are looked for first, over the whole argv, so `ssh lab rm -rf /x` is command:rm, not
// wrapper:ssh. git, gh, docker and rsync rules apply wherever the program appears in argv
// (`env git push -f`), and inside the strings of shell-like programs (`ssh lab "git push -f"`,
// `bash -c "gh pr merge 1"`), where every word is checked too. Scripts, make targets and package
// scripts stay opaque: an argv classifier cannot see what they run (SECURITY.md).
//   gh (D-R2): reads free; merge, repository deletion and settings, releases deletion, secrets,
//     variables, auth, keys, extensions, aliases, workflow dispatch, deletions, and `gh api` with a
//     DELETE, or a POST, PUT or PATCH on a protected endpoint, or a GraphQL mutation: hard.
//   git (D-R3): force or deleting pushes, pushes to main or master, reset --hard, clean -f,
//     branch -D, history rewrites, reflog expire, update-ref -d, stash clear: hard.
//   ssh, scp, sftp, mosh, and rsync to a remote (D-R9): remote:<program>, grantable. `ssh lab` is
//     root on lab, so it is T3 equivalent: an approval or a standing grant naming ssh, every time.
//   rsync --delete*, --remove-source-files: hard. Local rsync: free.
//   docker rm, rmi, prune, volume rm, compose down -v (D-R11): hard.
export const REMOTE_PROGRAMS = Object.freeze(new Set(['ssh', 'scp', 'sftp', 'mosh', 'slogin']));
// Programs whose string arguments are shell lines: their words are scanned for hard reasons.
const SHELL_STRING = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh', 'fish', 'busybox', 'ssh', 'mosh', 'slogin', 'su', 'sudo', 'doas',
  'osascript', 'watch', 'xargs', 'nohup', 'setsid', 'timeout', 'env']);
// Programs whose arguments start another program.
const PREFIX_WRAPPERS = new Set(['env', 'timeout', 'nice', 'ionice', 'nohup', 'setsid', 'stdbuf', 'xargs', 'flock', 'watch', 'time',
  'chrt', 'taskset', 'caffeinate', 'sudo', 'doas', 'su', 'runuser', 'chroot', 'nsenter', 'unshare', 'systemd-run', 'busybox']);
const WORD_SPLIT = /[\s;&|()`<>"']+/;
const isWrapperName = name => WRAPPERS.has(name) || /^python3?(\.\d+)?$/.test(name);

const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);
const GH_HARD_TOP = new Set(['auth', 'secret', 'ssh-key', 'gpg-key', 'extension', 'alias']);
const GH_HARD_SUB = Object.freeze({
  pr: ['merge'], repo: ['delete', 'archive', 'unarchive', 'rename', 'edit', 'deploy-key'], release: ['delete', 'delete-asset'],
  variable: ['set', 'delete'], workflow: ['run', 'enable', 'disable'], run: ['delete'], cache: ['delete'],
  issue: ['delete', 'transfer'], label: ['delete'], project: ['delete'], codespace: ['delete'], ruleset: ['delete']
});
const GH_API_VALUE_FLAGS = new Set(['-X', '--method', '-H', '--header', '-f', '-F', '--field', '--raw-field', '--input', '-q', '--jq',
  '-t', '--template', '--hostname', '-p', '--preview', '--cache']);
const GH_FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field']);
// Endpoints whose writes change access, history, code or deployments (D-R2).
const GH_PROTECTED = [/^repos\/[^/]+\/[^/]+\/?$/, /(^|\/)merges?(\/|$)/, /\/pulls\/[^/]+\/merge/, /\/git\/refs/, /\/branches\//,
  /\/rulesets/, /\/collaborators/, /\/hooks/, /\/keys/, /\/secrets/, /\/variables/, /\/environments/, /\/transfer/, /\/deployments/,
  /\/actions\/(permissions|workflows\/[^/]+\/dispatches|runs)/, /\/dispatches/, /\/invitations/, /\/pages/, /^orgs\//, /^user(\/|$)/,
  /^admin\//, /^teams\//, /\/teams\//, /^authorizations/, /^applications\//];

function ghHard(argv) {
  const rest = argv.slice(1);
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') { pos.push(...rest.slice(i + 1)); break; }
    if (GH_VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  const [top, sub] = pos;
  if (!top) return null;
  if (GH_HARD_TOP.has(top)) return `gh:${top}`;
  if (GH_HARD_SUB[top]?.includes(sub)) return `gh:${top}-${sub}`;
  if (top === 'repo' && sub === 'sync' && rest.includes('--force')) return 'gh:repo-sync-force';
  if (top !== 'api') return null;
  // gh api: the method is -X/--method, else POST as soon as a field or an input is given.
  let method = null; let fields = false; let input = false; let endpoint = null; const values = [];
  const after = rest.slice(rest.indexOf('api') + 1);
  for (let i = 0; i < after.length; i++) {
    const a = after[i];
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : null;
    if (/^-X./.test(a)) { method = a.slice(2); continue; }
    if (GH_API_VALUE_FLAGS.has(flag)) {
      const value = inline ?? after[++i] ?? '';
      if (flag === '-X' || flag === '--method') method = value;
      if (GH_FIELD_FLAGS.has(flag)) { fields = true; values.push(value); }
      if (flag === '--input') input = true;
      continue;
    }
    if (a.startsWith('-')) continue;
    if (endpoint === null) endpoint = a;
  }
  const verb = String(method ?? (fields || input ? 'POST' : 'GET')).toUpperCase();
  const path = String(endpoint ?? '').replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+/, '').replace(/\?.*$/, '').toLowerCase();
  if (path === 'graphql') return input || values.some(v => /\bmutation\b/i.test(v)) ? 'gh:api-graphql-mutation' : null;
  if (verb === 'GET' || verb === 'HEAD') return null;
  if (verb === 'DELETE') return 'gh:api-delete';
  return GH_PROTECTED.some(re => re.test(path)) ? `gh:api-${verb.toLowerCase()}` : null;
}

const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']);
const shortHas = (a, letter) => /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(letter);
const DEFAULT_BRANCHES = new Set(['main', 'master']);

function gitHard(argv) {
  const rest = argv.slice(1);
  let i = 0;
  for (; i < rest.length; i++) {
    const a = rest[i];
    if (GIT_VALUE_OPTS.has(a)) { i++; continue; }
    if (!a.startsWith('-')) break;
  }
  const sub = rest[i];
  const args = rest.slice(i + 1);
  if (!sub) return null;
  const has = (...names) => args.some(a => names.includes(a));
  switch (sub) {
    case 'push': {
      if (args.some(a => a === '--force' || a.startsWith('--force-with-lease') || a === '--force-if-includes' || a === '--mirror'
        || a === '--prune' || a === '--delete' || a === '--all' || shortHas(a, 'f') || shortHas(a, 'd'))) return 'git:push-force-or-delete';
      const refs = args.filter(a => !a.startsWith('-'));
      for (const ref of refs.slice(1)) {
        if (ref.startsWith('+')) return 'git:push-force-or-delete';
        if (ref.startsWith(':')) return 'git:push-force-or-delete';
        const dst = (ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref).replace(/^refs\/heads\//, '');
        if (DEFAULT_BRANCHES.has(dst)) return 'git:push-default-branch';
      }
      return null;
    }
    case 'reset': return has('--hard') ? 'git:reset-hard' : null;
    case 'clean': return args.some(a => a === '--force' || shortHas(a, 'f')) ? 'git:clean-force' : null;
    case 'branch': return args.some(a => a === '-D' || shortHas(a, 'D')) || (has('--delete', '-d') && has('--force', '-f'))
      ? 'git:branch-force-delete' : null;
    case 'filter-branch': case 'filter-repo': return `git:${sub}`;
    case 'reflog': return ['expire', 'delete'].includes(args[0]) ? 'git:reflog-expire' : null;
    case 'update-ref': return has('-d', '--delete') ? 'git:update-ref-delete' : null;
    case 'stash': return args[0] === 'clear' ? 'git:stash-clear' : null;
    default: return null;
  }
}

const DOCKER_VALUE_OPTS = new Set(['-H', '--host', '--context', '-c', '--config', '-l', '--log-level']);
function dockerHard(argv) {
  const rest = argv.slice(1);
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (DOCKER_VALUE_OPTS.has(rest[i])) { i++; continue; }
    if (!rest[i].startsWith('-')) pos.push(rest[i]);
  }
  const [sub, next] = pos;
  if (['rm', 'rmi'].includes(sub)) return `docker:${sub}`;
  if (['system', 'container', 'image', 'volume', 'network', 'builder', 'buildx'].includes(sub) && ['prune', 'rm'].includes(next)) return `docker:${sub}-${next}`;
  if (sub === 'compose' && pos.includes('down') && rest.some(a => ['-v', '--volumes', '--rmi'].includes(a) || a.startsWith('--rmi='))) return 'docker:compose-down-volumes';
  return null;
}

function rsyncHard(argv) {
  return argv.slice(1).some(a => a.startsWith('--delete') || a === '--remove-source-files') ? 'rsync:delete' : null;
}
// rsync reaches another host: host:path, rsync://, or a remote shell option.
function rsyncRemote(argv) {
  return argv.slice(1).some(a => a === '-e' || a.startsWith('--rsh') || a.startsWith('--rsync-path') || (/^-[A-Za-z]+$/.test(a) && a.includes('e'))
    || a.startsWith('rsync://') || (!a.startsWith('-') && !a.startsWith('/') && !a.startsWith('.') && /^[^/]*[A-Za-z0-9_.\]-]:/.test(a)));
}

const PROGRAM_RULES = Object.freeze({ gh: ghHard, git: gitHard, docker: dockerHard, rsync: rsyncHard });

// Hard reason of one word list (argv, or the words of a shell string), or null.
function hardOfWords(words) {
  for (const item of words) {
    const name = basename(item);
    if (isDestructiveName(name)) return `command:${name}`;
    // "--file=/etc/shadow" style arguments are checked on their value too.
    const value = item.includes('=') ? item.slice(item.indexOf('=') + 1) : item;
    if (sensitivePath(item) || sensitivePath(value)) return 'sensitive_path';
  }
  for (let i = 0; i < words.length; i++) {
    const rule = PROGRAM_RULES[basename(words[i])];
    const reason = rule ? rule(words.slice(i)) : null;
    if (reason) return reason;
  }
  if (words.some(a => basename(a) === 'dscl')) {
    const verb = words.find(a => DSCL_WRITES.has(a.toLowerCase()));
    if (verb) return `dscl:${verb.toLowerCase()}`;
  }
  const i = words.findIndex(a => basename(a) === 'systemctl');
  if (i >= 0) {
    const rest = words.slice(i + 1).filter(a => !a.startsWith('-'));
    const verb = rest[0];
    if (['reboot', 'poweroff', 'halt', 'kexec', 'emergency', 'rescue', 'isolate', 'kill'].includes(verb)) return `systemctl:${verb}`;
    if (['stop', 'disable', 'mask'].includes(verb) && rest.slice(1).some(u => CRITICAL_UNIT_RE.test(u))) return `systemctl:${verb}`;
  }
  return null;
}

// Read-only commands (repatriation D-R13, live bench 2026-10-14 19:57): a fixed list of programs
// with argv that cannot write, start a program or change the system. They need no workspace, no
// lock and no approval; they stay T2 for the signature, the rate limit and both journals, and
// the agent checks every path-like argument against the read roots and the secret denylist
// before running them (operator-exec.mjs readOnlyPaths). Anything outside these shapes is a
// normal command again: sed -i, find -delete or -exec, git with a mutating verb, ss -K...
// readOnlyCommand(argv) -> {program, paths: [argument strings to check]} or null.
const ANY_ARGS = new Set(['ps', 'uptime', 'vm_stat', 'df', 'uname', 'sw_vers', 'free', 'whoami', 'id', 'nproc', 'pwd', 'which', 'whereis',
  'pgrep', 'lsof', 'netstat', 'iostat', 'w', 'who', 'last', 'getconf', 'arch', 'locale', 'tty']);
const FILE_READERS = new Set(['du', 'ls', 'stat', 'file', 'wc', 'head', 'tail', 'cat', 'grep', 'egrep', 'fgrep', 'rg', 'tree', 'jq', 'md5', 'md5sum',
  'shasum', 'sha256sum', 'realpath', 'readlink', 'diff', 'cmp', 'column', 'sort', 'cut', 'nl', 'strings', 'hexdump', 'od']);
// Options whose value is a file the program opens for writing, or a program it runs.
const READER_BAD_OPTS = /^(-o|--output(=.*)?|--pre(=.*)?|--pre-glob(=.*)?|--from-file(=.*)?|-C|--compile|-O|--open-files-in-pager(=.*)?)$/;
const FIND_BAD = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'cat-file', 'ls-tree',
  'rev-list', 'merge-base', 'whatchanged', 'reflog', 'branch', 'remote', 'tag', 'stash', 'worktree', 'config']);
const GH_READ = Object.freeze({ pr: ['view', 'list', 'checks', 'diff', 'status'], issue: ['view', 'list', 'status'], run: ['view', 'list'],
  repo: ['view', 'list'], release: ['view', 'list'], workflow: ['view', 'list'], search: null, label: ['list'], cache: ['list'] });
const SYSTEMCTL_READ = new Set(['status', 'show', 'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'is-active', 'is-enabled',
  'is-failed', 'cat', 'list-dependencies']);
const JOURNAL_BAD = /^--(rotate|vacuum|flush|sync|relinquish-var|smart-relinquish-var|setup-keys|update-catalog)/;
const positional = list => list.filter(a => !a.startsWith('-'));

function gitReadOnly(argv) {
  const rest = argv.slice(1);
  let i = 0; const paths = [];
  for (; i < rest.length; i++) {
    const a = rest[i];
    // -c can name programs (core.pager, core.fsmonitor, diff.external): never on the read path.
    if (a === '-c' || a.startsWith('--exec-path') || a.startsWith('--config-env')) return null;
    if (a === '-C' || a === '--git-dir' || a === '--work-tree') { paths.push(rest[++i] ?? ''); continue; }
    if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) { paths.push(a.slice(a.indexOf('=') + 1)); continue; }
    if (a === '--no-pager' || a === '-P' || a === '--no-optional-locks' || a === '--literal-pathspecs') continue;
    if (a.startsWith('-')) return null;
    break;
  }
  const sub = rest[i];
  const args = rest.slice(i + 1);
  if (!GIT_READ.has(sub)) return null;
  if (args.some(a => ['--ext-diff', '--textconv', '--filters', '--output', '-O'].includes(a) || a.startsWith('--output=') || a.startsWith('--exec')
    || a.startsWith('--open-files-in-pager'))) return null;
  const pos = positional(args);
  switch (sub) {
    case 'branch': if (args.some(a => /^-[a-zA-Z]*[dDmMcCfu]/.test(a) && !a.startsWith('--') || ['--delete', '--move', '--copy', '--force', '--set-upstream-to',
      '--unset-upstream', '--edit-description', '--create-reflog', '--track', '--no-track'].some(f => a.startsWith(f)))) return null;
      if (pos.length && !args.some(a => ['--list', '-l', '--contains', '--merged', '--no-merged', '--points-at'].includes(a))) return null;
      break;
    case 'remote': if (pos.length && !['show', 'get-url'].includes(pos[0])) return null; break;
    case 'tag': if (!args.some(a => ['-l', '--list', '-n', '--contains', '--points-at', '--merged'].includes(a) || /^-n\d*$/.test(a)) && pos.length) return null;
      if (args.some(a => ['-d', '--delete', '-a', '-s', '-f', '--force', '-m', '-F'].includes(a))) return null; break;
    case 'stash': if (!['list', 'show'].includes(pos[0])) return null; break;
    case 'worktree': if (pos[0] !== 'list') return null; break;
    case 'reflog': if (pos.length && !['show'].includes(pos[0])) return null; break;
    case 'config': if (!args.some(a => ['--get', '--get-all', '--list', '-l', '--get-regexp', '--show-origin'].includes(a))) return null;
      if (args.some(a => ['--add', '--unset', '--unset-all', '--replace-all', '--edit', '-e', '--rename-section', '--remove-section'].includes(a))) return null; break;
    default: break;
  }
  return { program: 'git', paths };
}

export function readOnlyCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(a => typeof a !== 'string')) return null;
  const program = basename(argv[0]);
  const args = argv.slice(1);
  if (ANY_ARGS.has(program)) return program === 'lsof' && args.some(a => a.startsWith('+')) ? null : { program, paths: [] };
  if (FILE_READERS.has(program)) {
    if (args.some(a => READER_BAD_OPTS.test(a))) return null;
    if (program === 'sort' && args.some(a => a === '-o' || a.startsWith('--output'))) return null;
    return { program, paths: args.filter(a => !a.startsWith('-')).concat(args.filter(a => /^--?[A-Za-z-]+=/.test(a)).map(a => a.slice(a.indexOf('=') + 1))) };
  }
  if (program === 'find') return args.some(a => FIND_BAD.has(a)) ? null : { program, paths: args.filter(a => !a.startsWith('-')).slice(0, 1) };
  if (program === 'top') return args.includes('-l') || args.includes('-b') ? { program, paths: [] } : null;
  if (program === 'hostname') return args.every(a => ['-s', '-f', '-d', '-i', '-I', '--short', '--fqdn'].includes(a)) ? { program, paths: [] } : null;
  if (program === 'date') return args.every(a => a.startsWith('+') || ['-u', '-R', '--utc', '--iso-8601'].includes(a)) ? { program, paths: [] } : null;
  if (program === 'sysctl') return args.some(a => a.includes('=') || ['-w', '-p', '--load', '--system', '-f'].includes(a)) ? null : { program, paths: [] };
  if (program === 'system_profiler') return positional(args).some(a => /DataType$/.test(a)) ? { program, paths: [] } : null;
  if (program === 'git') return gitReadOnly(argv);
  if (program === 'gh') {
    const pos = positional(args.filter((a, i) => !GH_VALUE_FLAGS.has(args[i - 1])));
    if (pos[0] === 'api') {
      const r = ghHard(argv);
      if (r) return null;
      const fieldy = args.some(a => GH_FIELD_FLAGS.has(a) || a === '--input' || a.startsWith('--field=') || a.startsWith('--raw-field=') || a.startsWith('--input='));
      const method = args.find((a, i) => args[i - 1] === '-X' || args[i - 1] === '--method') ?? (args.find(a => /^-X./.test(a))?.slice(2))
        ?? args.find(a => a.startsWith('--method='))?.slice(9);
      return !fieldy && (!method || method.toUpperCase() === 'GET') ? { program, paths: [] } : null;
    }
    if (args.some(a => a === '--web' || a === '-w')) return null; // opens a browser: starts a program
    if (!Object.hasOwn(GH_READ, pos[0] ?? '')) return null;
    const verbs = GH_READ[pos[0]];
    return verbs === null || verbs.includes(pos[1]) ? { program, paths: [] } : null;
  }
  if (program === 'launchctl') return ['list', 'print', 'print-disabled', 'blame', 'procinfo'].includes(args[0]) ? { program, paths: [] } : null;
  if (program === 'systemctl') {
    const pos = positional(args);
    return (pos.length === 0 || SYSTEMCTL_READ.has(pos[0])) && !args.some(a => a === '--now') ? { program, paths: [] } : null;
  }
  if (program === 'journalctl') return args.some(a => JOURNAL_BAD.test(a)) ? null : { program, paths: [] };
  if (program === 'docker') {
    const pos = positional(args);
    const ok = ['ps', 'logs', 'inspect', 'images', 'version', 'info', 'top', 'port', 'df'].includes(pos[0]) || (pos[0] === 'stats' && args.includes('--no-stream'))
      || (pos[0] === 'compose' && ['ps', 'ls', 'logs', 'config', 'images'].includes(pos[1])) || (pos[0] === 'system' && pos[1] === 'df');
    return ok && !args.some(a => ['-H', '--host', '-c', '--context', '--config'].includes(a)) ? { program, paths: [] } : null;
  }
  if (program === 'ip') {
    const pos = positional(args);
    return ['addr', 'a', 'address', 'route', 'r', 'link', 'l', 'neigh', 'rule'].includes(pos[0]) && (pos.length === 1 || ['show', 'list', 'ls'].includes(pos[1]))
      && !args.includes('-batch') ? { program, paths: [] } : null;
  }
  if (program === 'ss') return args.some(a => a === '-K' || a === '--kill' || /^-[a-zA-Z]*K/.test(a) || a.startsWith('-F') || a.startsWith('--filter')) ? null : { program, paths: [] };
  if (program === 'ifconfig') return args.length <= 1 || (args.length === 1 && !args[0].startsWith('-')) ? { program, paths: [] } : null;
  return null;
}

// Containers whose stop or restart cuts the owner off (D-R11): the proxy, the bridge, OAuth.
export const CRITICAL_CONTAINER_RE = /^(traefik|memo-.*|pocket-id.*)$/i;

// {reason, hard, programs} for one call, or null when it is not dangerous. programs: the wrapper
// and remote programs of a grantable call, every one of which a standing approval must name.
export function classifyCall(op, args = {}) {
  if (op === 'operator_script') {
    if (args.as_root === true) return { reason: 'script', hard: true, programs: [] };
    return { reason: 'script', hard: false, programs: [String(args.interpreter ?? '')] };
  }
  if (op === 'operator_run') {
    const argv = Array.isArray(args.argv) ? args.argv.filter(a => typeof a === 'string') : [];
    const shellish = argv.some(a => SHELL_STRING.has(basename(a)));
    const hard = hardOfWords(argv) ?? (shellish ? hardOfWords(argv.flatMap(a => a.split(WORD_SPLIT).filter(Boolean))) : null);
    if (hard) return { reason: hard, hard: true, programs: [] };
    // A read-only command (D-R13) is not dangerous, even when its program is a wrapper (git).
    if (args.as_root !== true && readOnlyCommand(argv)) return null;
    // The program itself; behind a command prefix (env, timeout, nice, xargs...) every later
    // wrapper or remote name too, conservatively (`timeout 5 ssh lab id` needs timeout and ssh).
    const programs = [];
    const scan = PREFIX_WRAPPERS.has(basename(argv[0] ?? '')) ? argv.length : Math.min(argv.length, 1);
    for (let i = 0; i < scan; i++) {
      const name = basename(argv[i]);
      if ((isWrapperName(name) || REMOTE_PROGRAMS.has(name) || (name === 'rsync' && rsyncRemote(argv.slice(i)))) && !programs.includes(name)) programs.push(name);
    }
    if (programs.length === 0) return null;
    // The reason names the program itself when it is one, else the first one found.
    const program = basename(argv[0] ?? '');
    const first = programs.includes(program) ? program : programs[0];
    const remote = REMOTE_PROGRAMS.has(first) || first === 'rsync';
    return { reason: `${remote ? 'remote' : 'wrapper'}:${first}`, hard: false, programs };
  }
  const reason = otherReason(op, args);
  return reason ? { reason, hard: true, programs: [] } : null;
}

function otherReason(op, args) {
  if (op === 'operator_service') {
    return ['stop'].includes(args.action) && CRITICAL_UNIT_RE.test(String(args.unit)) ? `service:${args.action}` : null;
  }
  if (op === 'operator_docker') {
    return ['stop', 'restart'].includes(args.action) && CRITICAL_CONTAINER_RE.test(String(args.container ?? '')) ? `docker:${args.action}` : null;
  }
  if (op === 'operator_delete') {
    if (args.recursive === true) return 'delete_directory';
    return sensitivePath(args.path) ? 'sensitive_path' : null;
  }
  if (['operator_edit', 'operator_chmod', 'operator_upload_init'].includes(op)) return sensitivePath(args.path) ? 'sensitive_path' : null;
  if (['operator_move', 'operator_copy'].includes(op)) return sensitivePath(args.src) || sensitivePath(args.dst) ? 'sensitive_path' : null;
  return null;
}

// Why this call is dangerous, or null. op and args as the tool receives them.
export function dangerReason(op, args = {}) {
  return classifyCall(op, args)?.reason ?? null;
}

// Does this call need an approval under `mode`? tier is the call's tier (0..3).
export function needsApproval(mode, op, args, tier) {
  if (mode === 'off') return false;
  if (mode === 'all_root' && tier === 3) return true;
  if (mode === 'dangerous' || mode === 'all_root') return dangerReason(op, args) !== null;
  return true; // unknown mode: fail closed
}
