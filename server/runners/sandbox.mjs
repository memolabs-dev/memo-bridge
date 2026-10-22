// Job isolation (Phase 3 fix for "a job is arbitrary code execution as the owner").
//
// A recipe runs the repository's own scripts, and a model can write those scripts with
// worktree_write_file. So every job runs inside a macOS Seatbelt profile (/usr/bin/sandbox-exec)
// that keeps it to the worktree:
// - writes: only the worktree (never its `.git` link) and a private per-job temporary folder;
// - reads: nothing under the owner's home except the worktree, the repository's Git data, the
//   job folder, the toolchain roots derived from PATH (toolRoots) and a few read-only toolchain
//   caches (HOME_TOOL_READ); the private-data denylist (HOME_DENY_READ: notes, agent state,
//   credential stores, shell startup files) applies on top, so no tool root re-opens it, and
//   the state directory, other worktrees and other repositories stay closed. Outside the home a
//   toolchain reads what it needs. File metadata (names a job already knows, sizes, dates) stays
//   readable. (Until the fix pass of #258 the recipe read every home file the denylist did not
//   name, ~/.zshrc and its exported tokens included.);
// - network: loopback only (tests may start local servers); no DNS, no remote hosts;
// - no launchd jobs, no Launch Services, no Apple Events, no keychain or pasteboard services,
//   so nothing can be started outside the sandbox;
// - the environment is an allow-list; HOME and TMPDIR point at the per-job folder, and Git runs
//   without the owner's global or system configuration (no credential helper, no identity).
//
// A job may first run a dependency install (job-runner.mjs, recipes.mjs planLocalInstall), in a
// second profile, 'install', that differs from the recipe's in three places:
// - network: outbound to port 443 only (package registries are HTTPS), DNS through
//   mDNSResponder, never loopback;
// - reads: the same closed home, without the repository's Git data and without the toolchain
//   caches of HOME_TOOL_READ: only the worktree, the job folder and the PATH tool roots. The
//   install has the network and may run repository-controlled code (.pnpmfile.cjs is not a
//   script, so --ignore-scripts does not stop it).
// Writes, services, signals, the state directory and the .git link are as for the recipe.
//
// The profile text depends only on how many paths it names; every path is passed with -D, so
// no path is ever spliced into the profile.
//
// MEMO_BRIDGE_JOB_SANDBOX=off runs jobs without the sandbox (the owner's explicit choice:
// a job is then owner-equivalent). There is no sandbox on other platforms yet, so jobs are
// refused there unless that switch is set.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { platform, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const SANDBOX_PHASES = Object.freeze(['recipe', 'install']);
// getaddrinfo talks to mDNSResponder through this socket (/var/run is a link to /private/var/run);
// without it the install phase resolves nothing (checked with sandbox-exec on macOS 27).
export const MDNS_SOCKET = '/private/var/run/mDNSResponder';

// Folders and files under the owner's home that a job never reads.
export const HOME_DENY_READ = Object.freeze([
  '.agent', 'Vault', 'projects', 'memolabs', 'jobs', '.home', 'sentinelx', 'Documents', 'Desktop', 'Downloads',
  '.ssh', '.gnupg', '.aws', '.azure', '.config/gh', '.config/gcloud', '.config/op', '.docker', '.kube',
  '.netrc', '.git-credentials', '.gitconfig', '.config/git', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc',
  '.claude', '.claude.json', '.codex', '.cursor', '.local/share/memo-bridge', '.local/state/memo-bridge',
  'Library/Keychains', 'Library/Application Support', 'Library/Cookies', 'Library/Mail', 'Library/Messages',
  // Other credential stores and shell history (review of 2026-10-14).
  '.config/configstore', '.config/rclone', '.config/stripe', '.cloudflared', '.wrangler', '.vercel', '.netlify',
  '.fly', '.railway', '.terraform.d', '.cargo/credentials', '.cargo/credentials.toml', '.gem/credentials',
  '.zsh_history', '.bash_history', '.python_history', '.node_repl_history',
  // The owner's mail export in the home root (~/AGENTS.md: never read; review of #257).
  'gmail.json',
  'Library/Mobile Documents', 'Library/CloudStorage', 'Library/Containers', 'Library/Group Containers', 'Library/Safari',
  // Shell startup files (they export tokens) and the .config secrets measured on the owner's Mac
  // (fix pass of #258). The closed home already keeps them out; naming them here keeps them out
  // even when a PATH entry makes a tool root of a folder around them.
  '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.bashrc', '.bash_profile', '.profile',
  '.config/opencode', '.config/memo-bridge', '.config/dify-dataset-key', '.config/resend', '.config/neonctl', '.config/jobs'
]);

// Read-only toolchain caches under the home a recipe may read besides its PATH tool roots
// (fix pass of #258): Rust toolchains and the crates already downloaded (no install phase
// fetches them), Playwright's browsers and SwiftPM's repository cache. None holds a credential.
export const HOME_TOOL_READ = Object.freeze([
  '.rustup', '.cargo/registry', '.cargo/git', 'Library/Caches/ms-playwright', 'Library/Caches/org.swift.swiftpm'
]);

// Variables a recipe may inherit; everything else is dropped (names like DATABASE_URL carry
// secrets without looking like it).
export const ENV_ALLOW = Object.freeze([
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_NUMERIC', 'LC_TIME', 'TZ', 'TERM', 'USER', 'LOGNAME', 'SHELL',
  'NVM_DIR', 'NVM_BIN', 'VOLTA_HOME', 'PNPM_HOME', 'BUN_INSTALL', 'JAVA_HOME', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME',
  'PYENV_ROOT', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'DEVELOPER_DIR', 'SDKROOT', 'ANDROID_HOME'
]);

const real = path => { try { return realpathSync(path); } catch { return resolve(path); } };

// { ok: true, mode: 'seatbelt' | 'off' } or a refusal the caller returns as is.
export function sandboxMode(env = process.env, { os = platform(), exists = existsSync } = {}) {
  const setting = env.MEMO_BRIDGE_JOB_SANDBOX ?? '';
  if (setting === 'off') return { ok: true, mode: 'off' };
  if (setting !== '' && setting !== 'on') return { ok: false, error: 'invalid_configuration', detail: 'MEMO_BRIDGE_JOB_SANDBOX must be on or off' };
  if (os === 'darwin' && exists(SANDBOX_EXEC)) return { ok: true, mode: 'seatbelt' };
  return { ok: false, error: 'sandbox_unavailable',
    detail: 'jobs run only inside a sandbox, which is available on macOS only; the owner can set MEMO_BRIDGE_JOB_SANDBOX=off to run them unsandboxed' };
}

// The Git directory shared by a linked worktree (<repo>/.git), read from its `.git` file
// ("gitdir: <repo>/.git/worktrees/<name>"), or null for a plain folder.
export function worktreeCommonDir(worktree) {
  try {
    const text = readFileSync(join(worktree, '.git'), 'utf8').slice(0, 4096);
    const match = /^gitdir: (.+)$/m.exec(text);
    if (!match || !isAbsolute(match[1].trim())) return null;
    const gitdir = real(match[1].trim());
    return basename(dirname(gitdir)) === 'worktrees' ? dirname(dirname(gitdir)) : null;
  } catch {
    return null;
  }
}

// Folders under the owner's home the install phase may read: for each PATH folder under home,
// its parent when that parent is at least two levels below home (~/.nvm/versions/node/v24/bin
// gives ~/.nvm/versions/node/v24, ~/Library/pnpm/bin gives ~/Library/pnpm), otherwise the
// folder itself (~/.local/bin stays ~/.local/bin, never ~/.local; ~/bin stays ~/bin). Folders
// outside home need nothing: only home is closed. Real paths, sorted, without duplicates.
export function toolRoots(pathVar, home) {
  const h = real(home);
  const under = p => p.startsWith(`${h}/`);
  const roots = new Set();
  for (const entry of String(pathVar ?? '').split(':')) {
    if (!isAbsolute(entry)) continue;
    const dir = real(entry);
    if (!under(dir)) continue;
    const parent = dirname(dir);
    roots.add(under(parent) && relative(h, parent).split(sep).length >= 2 ? parent : dir);
  }
  return [...roots].sort();
}

// Paths of the sandbox for one job. All of them are real paths (Seatbelt matches resolved paths).
// `path` (the job's PATH) only matters to the install phase (toolRoots).
export function sandboxPaths({ worktree, stateDir, jobTmp, worktreesRoot, home = userInfo().homedir, path = '' }) {
  const wt = real(worktree);
  const common = worktreeCommonDir(wt);
  const denyRead = new Set();
  for (const rel of HOME_DENY_READ) {
    denyRead.add(resolve(home, rel));
    denyRead.add(real(join(home, rel))); // ~/Vault may be a symlink into iCloud
  }
  if (worktreesRoot) denyRead.add(real(worktreesRoot));
  // The folder holding the repository itself (the projects root): other repositories and
  // their .env files stay out of reach. An owner external checkout sits directly in the home
  // (#257, server/projects/external-projects.mjs): its folder is the home itself, and closing it
  // would close every toolchain. Then the checkout itself is closed (its .env and the owner's
  // working files); the worktree and the Git data are opened again after it, and the rest of
  // the home is covered by HOME_DENY_READ and, while installing, by the closed home.
  if (common) {
    const holder = dirname(dirname(common));
    const homeReal = real(home);
    denyRead.add(holder === homeReal || homeReal.startsWith(`${holder}/`) ? dirname(common) : holder);
  }
  return {
    worktree: wt,
    worktreeGit: join(wt, '.git'),
    jobTmp: real(jobTmp),
    gitCommon: common,
    stateDir: real(stateDir),
    home: real(home),
    toolRoots: toolRoots(path, home),
    // Only those that exist: a missing folder needs no rule.
    toolCaches: HOME_TOOL_READ.map(rel => join(home, rel)).filter(p => existsSync(p)).map(real).sort(),
    // A denied folder that contains the worktree is fine: the worktree is allowed again after it.
    denyRead: [...denyRead].filter(p => p !== '/' && p !== wt).sort()
  };
}

// Seatbelt rules are matched last-rule-wins: broad denials first, then the exceptions, then the
// denials no exception may override (the state directory, the .git link).
//
// Both phases need the HOME parameter and toolRootCount TOOL_ROOT_<i> parameters; 'install'
// also needs MDNS_SOCKET (see the header).
export function sandboxProfile({ denyReadCount, gitCommon, phase = 'recipe', toolRootCount = 0 }) {
  if (!SANDBOX_PHASES.includes(phase)) throw new Error('sandbox_phase_invalid');
  const install = phase === 'install';
  const denyRead = Array.from({ length: denyReadCount }, (_, i) => `(subpath (param "DENY_READ_${i}"))`).join(' ');
  const tools = Array.from({ length: toolRootCount }, (_, i) => `(subpath (param "TOOL_ROOT_${i}"))`).join(' ');
  const network = install ? [
    // Network: HTTPS to remote hosts (package registries), DNS through mDNSResponder, never
    // loopback (the owner's local services). Seatbelt filters hosts only as * or localhost.
    '(deny network-outbound)',
    '(allow network-outbound (remote ip "*:443"))',
    '(deny network-outbound (remote ip "localhost:*"))',
    '(allow network-outbound (remote unix-socket (subpath (param "WORKTREE"))) (remote unix-socket (subpath (param "JOB_TMP"))) ' +
      '(remote unix-socket (literal (param "MDNS_SOCKET"))))'
  ] : [
    // Network: loopback only. No remote IP, no DNS, no Unix socket outside the job's folders.
    '(deny network-outbound)',
    '(allow network-outbound (remote ip "localhost:*"))',
    '(allow network-outbound (remote unix-socket (subpath (param "WORKTREE"))) (remote unix-socket (subpath (param "JOB_TMP"))))',
    '(deny mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.mDNSResponder"))'
  ];
  // Reads: nothing under the owner's home, except the toolchains on PATH (and, for the recipe, a
  // few read-only toolchain caches); then the private-data denylist, which no tool root re-opens;
  // then the worktree, the job folder and, for the recipe, the repository's Git data (the install
  // does not need it). Only contents, listings and extended attributes are denied: metadata
  // (lstat) stays allowed, because toolchains resolve real paths through these folders (the
  // worktree lives under the worktrees root, itself under ~/memolabs). Seatbelt does not let a
  // wildcard allow override these operations, so every rule names the same ones.
  const reads = [
    '(deny file-read-data file-read-xattr (subpath (param "HOME")))',
    ...(tools ? [`(allow file-read-data file-read-xattr ${tools})`] : []),
    ...(denyReadCount ? [`(deny file-read-data file-read-xattr ${denyRead})`] : []),
    `(allow file-read-data file-read-xattr (subpath (param "WORKTREE")) (subpath (param "JOB_TMP"))${gitCommon && !install ? ' (subpath (param "GIT_COMMON"))' : ''})`
  ];
  return [
    '(version 1)',
    '(allow default)',
    ...network,
    // Nothing started outside the sandbox: no launchd job, no Launch Services, no Apple Events.
    '(deny job-creation)',
    // Signals only inside the sandbox: a job can stop its own children, never the owner's other
    // processes (the MCP server, other sessions, editors, its own runner). The unsandboxed
    // server can still signal into the sandbox to stop a job.
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    '(deny lsopen)',
    '(deny appleevent-send)',
    // No keychain (Git and gh credentials) and no pasteboard.
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") ' +
      '(global-name "com.apple.security.agent") (global-name "com.apple.pasteboard.1"))',
    // Writes: the worktree and the job folder only.
    '(deny file-write*)',
    '(allow file-write* (subpath (param "WORKTREE")) (subpath (param "JOB_TMP")) (literal "/dev/null") (literal "/dev/zero") ' +
      '(literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    ...reads,
    // Never: the state directory (store, journal, logs), and the worktree's .git link, which
    // decides which repository and configuration the server's own Git commands use.
    '(deny file-read-data file-read-xattr file-write* (subpath (param "STATE_DIR")))',
    '(deny file-write* (literal (param "WORKTREE_GIT")) (subpath (param "WORKTREE_GIT")))',
    ''
  ].join('\n');
}

// [command, args] that runs `argv` inside the sandbox of `phase` ('recipe' or 'install').
export function sandboxCommand(argv, paths, { phase = 'recipe' } = {}) {
  if (!SANDBOX_PHASES.includes(phase)) throw new Error('sandbox_phase_invalid');
  const install = phase === 'install';
  // Both phases close the owner's home: they need a real one, never the root.
  if (!isAbsolute(paths.home ?? '') || paths.home === '/') throw new Error('sandbox_home_invalid');
  const params = ['-D', `WORKTREE=${paths.worktree}`, '-D', `WORKTREE_GIT=${paths.worktreeGit}`, '-D', `JOB_TMP=${paths.jobTmp}`,
    '-D', `STATE_DIR=${paths.stateDir}`];
  if (paths.gitCommon && !install) params.push('-D', `GIT_COMMON=${paths.gitCommon}`);
  paths.denyRead.forEach((path, i) => params.push('-D', `DENY_READ_${i}=${path}`));
  const tools = [...(paths.toolRoots ?? []), ...(install ? [] : paths.toolCaches ?? [])];
  params.push('-D', `HOME=${paths.home}`);
  if (install) params.push('-D', `MDNS_SOCKET=${MDNS_SOCKET}`);
  tools.forEach((path, i) => params.push('-D', `TOOL_ROOT_${i}=${path}`));
  const profile = sandboxProfile({ denyReadCount: paths.denyRead.length, gitCommon: Boolean(paths.gitCommon) && !install, phase,
    toolRootCount: tools.length });
  return [SANDBOX_EXEC, ['-p', profile, ...params, ...argv]];
}

// The environment of a recipe: allow-listed variables, then fixed values. HOME and TMPDIR point
// at the job's own folder; Git reads neither the owner's global nor system configuration.
export function jobEnvironment(base, { jobId, home, tmp }) {
  const env = {};
  for (const key of ENV_ALLOW) if (typeof base[key] === 'string') env[key] = base[key];
  return Object.assign(env, {
    HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    CI: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    npm_config_update_notifier: 'false', MEMO_BRIDGE_JOB_ID: jobId
  });
}

// Go's module proxy for the install phase. No `direct` fallback: no version control tool runs
// during an install, and a module the proxy does not serve fails. GOSUMDB stays Go's default.
export const GO_INSTALL_PROXY = 'https://proxy.golang.org';

// The environment of each phase of a local job: jobEnvironment, plus where corepack, pnpm, npm
// and Go keep their files, all in the job's own cache folder (deleted with the job, never
// shared). The same variables as the VPS (job-unit.mjs phaseEnvironment), plus Go's. The
// install writes the caches with the network; the recipe reads the same corepack folder and
// module cache with downloads turned off. GOTOOLCHAIN=local: never fetch and run another Go.
// -modcacherw: Go leaves the module cache writable, so the job folder can be deleted.
// XDG_RUNTIME_DIR: pnpm 12.8.2 and later keep their store operation locks there when it is a
// folder only the user can write to (the caller creates it 0700), otherwise in a fixed
// /tmp/pnpm-store-operation-locks-<uid> the sandbox does not let them write (pnpm CHANGELOG,
// 12.8.2, #16390; seen as ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK in the install profile).
export const RUNTIME_DIR_NAME = 'xdg-runtime';
export function localPhaseEnvironment(phase, base, { jobId, home, tmp, cache }) {
  if (!SANDBOX_PHASES.includes(phase)) throw new Error('sandbox_phase_invalid');
  const env = Object.assign(jobEnvironment(base, { jobId, home, tmp }), {
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', COREPACK_ENABLE_AUTO_PIN: '0', COREPACK_HOME: join(cache, 'corepack'),
    XDG_RUNTIME_DIR: join(cache, RUNTIME_DIR_NAME),
    GOMODCACHE: join(cache, 'gomod'), GOFLAGS: '-modcacherw', GOTOOLCHAIN: 'local'
  });
  if (phase === 'install') {
    return Object.assign(env, {
      XDG_CACHE_HOME: join(cache, 'xdg-cache'), XDG_DATA_HOME: join(cache, 'xdg-data'), XDG_STATE_HOME: join(cache, 'xdg-state'),
      pnpm_config_store_dir: join(cache, 'pnpm-store'), npm_config_cache: join(cache, 'npm'),
      npm_config_audit: 'false', npm_config_fund: 'false',
      GOPROXY: GO_INSTALL_PROXY
    });
  }
  return Object.assign(env, { COREPACK_ENABLE_NETWORK: '0', GOPROXY: 'off' });
}
