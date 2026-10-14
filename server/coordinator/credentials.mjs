// Credential files of the VPS runner (Phase 4, D6), shared by the ledger client, the worktree
// runner and the GitHub App token provider (server/integrations/github-app.mjs).
//
// On the VPS the runner runs as memo-runner with LoadCredential= (systemd.exec(5), systemd 257,
// LoadCredential= and $CREDENTIALS_DIRECTORY): the data is copied into a read-only per-unit
// directory exported as $CREDENTIALS_DIRECTORY, readable only by the unit's User= and root; a
// credential searched in /etc/credstore by name "is not considered fatal" when missing, so a
// missing file must be refused here. When $CREDENTIALS_DIRECTORY is set, a credential is
// required: there is no fallback to an ambient gh login. On the Mac it is unset, and the
// operator's own gh login and Git setup are used as in Phase 3.
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const LEDGER_CREDENTIAL = 'ledger-gh';
export const PUSH_CREDENTIAL = 'push-gh';
export const APP_KEY_CREDENTIAL = 'app-key';
const CREDENTIAL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
// One GitHub token on one line: fine-grained PATs (github_pat_...), classic (ghp_...) and
// installation tokens (ghs_...). Since 2026-04-27 GitHub mints stateless installation tokens,
// "a ghs_-prefixed JWT" with two dots of about 520 characters; GitHub's suggested pattern is
// ghs_[A-Za-z0-9\.\-_]{36,} (https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header).
// Dots and dashes are therefore accepted; whitespace, ':' and '@' never are.
export const TOKEN_RE = /^[A-Za-z0-9_.-]{20,2048}$/;
const CREDENTIAL_MAX_BYTES = 4096;
// Variables that carry or redirect a GitHub credential; never inherited by a gh child.
export const CREDENTIAL_VARS = Object.freeze(['CREDENTIALS_DIRECTORY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'GIT_ASKPASS', 'SSH_ASKPASS']);

// The absolute path of credential `name` when this process runs with systemd credentials,
// else null. `name` is one of ours, never caller input.
export function credentialPath(env, name) {
  const dir = env?.CREDENTIALS_DIRECTORY;
  if (typeof dir !== 'string' || dir === '' || !CREDENTIAL_NAME_RE.test(name)) return null;
  return isAbsolute(dir) ? join(dir, name) : null;
}
export const credentialsRequired = env => typeof env?.CREDENTIALS_DIRECTORY === 'string' && env.CREDENTIALS_DIRECTORY !== '';

// Read a small credential file: a regular file (no symlink, no FIFO), at most `maxBytes`.
// Returns {text} or {error}; the error never contains the file content.
export async function readCredentialFile(path, { maxBytes = CREDENTIAL_MAX_BYTES } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) return { error: 'credential_missing' };
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return { error: 'credential_invalid' };
    return { text: await handle.readFile('utf8') };
  } catch (error) {
    return { error: error?.code === 'ENOENT' ? 'credential_missing' : 'credential_unreadable' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Read a token file: one bounded token. Returns {token} or {error}.
export async function readTokenFile(path) {
  const read = await readCredentialFile(path);
  if (read.error) return read;
  const token = read.text.trim();
  return TOKEN_RE.test(token) ? { token } : { error: 'credential_invalid' };
}

// A private directory for gh's configuration, created for one call and removed after it. The
// parent must be ours and closed to others (0700): it holds nothing secret, since the token
// stays in the environment, but gh must not read or write a shared configuration.
export async function privateConfigDir(parent) {
  if (parent) {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const info = await lstat(parent);
    const uid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) throw new Error('scratch_not_private');
  }
  return mkdtemp(join(parent ?? tmpdir(), 'gh-'));
}

// A gh child's environment with a token: inherited variables minus every credential carrier,
// then GH_TOKEN, a private GH_CONFIG_DIR (and HOME/XDG dirs inside it, so gh writes nothing
// elsewhere), prompts and update checks disabled. Built per call and passed only to that child;
// the runner's own process.env is never modified. gh help environment (gh 2.102): GH_TOKEN
// takes precedence over stored credentials for github.com; GH_CONFIG_DIR is where gh stores
// configuration.
export function ghChildEnv(env, token, configDir) {
  const child = { ...env };
  for (const name of CREDENTIAL_VARS) delete child[name];
  return {
    ...child,
    GH_TOKEN: token,
    GH_CONFIG_DIR: configDir,
    HOME: configDir,
    XDG_CONFIG_HOME: join(configDir, 'config'),
    XDG_STATE_HOME: join(configDir, 'state'),
    XDG_DATA_HOME: join(configDir, 'data'),
    XDG_CACHE_HOME: join(configDir, 'cache'),
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1'
  };
}
