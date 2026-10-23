// Experimental macOS Seatbelt containment for supervised checkout writers.
// Deliberately a WRITE boundary, not secret-read or network isolation.
// All paths are passed with sandbox-exec -D arguments, never interpolated.
import { realpathSync, existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const MAC_SANDBOX_EXEC = '/usr/bin/sandbox-exec';

const STRICT_WRITE_PROFILE = `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath (param "ROOT")) (subpath (param "TMP"))
  (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/"))
(deny file-write* (subpath (param "STATE")))
`;

// Seatbelt compares resolved paths and applies the deny for STATE after allows.
// The return value is only an argv array; caller provides its own cwd and env.
export function isolatedCheckoutCommand(argv, { root, temporary, stateDir, exists = existsSync } = {}) {
  if (process.platform !== 'darwin' || !exists(MAC_SANDBOX_EXEC)) return { ok: false, error: 'sandbox_unavailable' };
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(s => typeof s !== 'string' || !s)) {
    return { ok: false, error: 'invalid_command' };
  }
  if (![root, temporary, stateDir].every(s => typeof s === 'string' && isAbsolute(s) && !s.includes('\0'))) {
    return { ok: false, error: 'invalid_sandbox_path' };
  }
  try {
    const repo = realpathSync.native(root);
    const temp = realpathSync.native(temporary);
    const state = realpathSync.native(stateDir);
    if (repo === state || repo.startsWith(state + '/') || state.startsWith(repo + '/') ||
        repo === temp || repo.startsWith(temp + '/') || temp.startsWith(repo + '/')) {
      return { ok: false, error: 'unsafe_sandbox_overlap' };
    }
    return { ok: true, program: MAC_SANDBOX_EXEC, argv: [
      '-p', STRICT_WRITE_PROFILE, '-D', `ROOT=${repo}`, '-D', `TMP=${temp}`,
      '-D', `STATE=${state}`, ...argv
    ], tmp: temp };
  } catch {
    return { ok: false, error: 'invalid_sandbox_path' };
  }
}
