#!/usr/bin/env node
// GIT_ASKPASS helper for the VPS runner's own Git network calls (fetch, ls-remote, push).
// worktrees.mjs sets GIT_ASKPASS to this file and MEMO_BRIDGE_ASKPASS_CREDENTIAL to the
// absolute path of the push-gh credential ($CREDENTIALS_DIRECTORY/push-gh, systemd
// LoadCredential=). Git runs it without a shell, with the prompt as its only argument, and reads
// the answer from stdout (git prompt.c do_askpass; checked with git 2.54: GIT_ASKPASS is still
// used when GIT_TERMINAL_PROMPT=0). The token is never in an environment variable or argv.
//
// It answers only GitHub over HTTPS:
//   Username for 'https://github.com':                  -> x-access-token
//   Password for 'https://x-access-token@github.com':   -> the token
// Any other prompt (another host, http, a port, an SSH passphrase) gets no answer and exit 1,
// so Git fails instead of sending the token elsewhere. Jobs never see this variable: they run
// as memo-job with a clean environment (spec D2, REQ-P4-12).
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const PROMPT_RE = /^(Username|Password) for 'https:\/\/(?:[A-Za-z0-9._%+-]{1,100}@)?github\.com(?:\/[^']*)?': ?$/;
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const MAX_BYTES = 4096;

function token(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    const value = readFileSync(fd, 'utf8').trim();
    return TOKEN_RE.test(value) ? value : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const match = PROMPT_RE.exec(process.argv[2] ?? '');
if (!match) process.exit(1);
if (match[1] === 'Username') {
  process.stdout.write('x-access-token\n');
} else {
  const value = token(process.env.MEMO_BRIDGE_ASKPASS_CREDENTIAL);
  if (!value) process.exit(1);
  process.stdout.write(`${value}\n`);
}
