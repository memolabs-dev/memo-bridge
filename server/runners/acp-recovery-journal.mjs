// Private, crash-consistent evidence of supervised ACP sessions.
// Deliberately NOT an execution owner: a post-restart active receipt means
// recovery_required, NEVER running or permission to restart/kill a process.
import {
  constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE = /^ws_[A-Za-z0-9_-]{16}$/;
const WORKTREE = /^wt_[A-Za-z0-9_-]{16}$/;
const STATES = new Set(['starting', 'running', 'stopping', 'stopped']);
const fail = error => new Error(error);
const normalize = row => {
  if (!row || typeof row !== 'object' || !ID.test(row.session_id ?? '') ||
      !WORKSPACE.test(row.workspace_id ?? '') ||
      !WORKTREE.test(row.worktree_id ?? '') || !STATES.has(row.state) ||
      !Number.isSafeInteger(row.started_at) || row.started_at <= 0 ||
      !(row.ended_at === null || Number.isSafeInteger(row.ended_at)) ||
      !(row.issue === null || (typeof row.issue === 'string' &&
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(row.issue))) ||
      !(row.reason === null || (typeof row.reason === 'string' &&
        /^[a-z0-9_-]{1,80}$/.test(row.reason))))
    throw fail('acp_recovery_invalid_record');
  return {
    session_id: row.session_id, workspace_id: row.workspace_id,
    worktree_id: row.worktree_id, issue: row.issue, state: row.state,
    reason: row.reason, started_at: row.started_at, ended_at: row.ended_at
  };
};

export function createAcpRecoveryJournal(stateDir) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir))
    throw fail('acp_recovery_invalid_directory');
  const folder = join(stateDir, 'acp-session-receipts');
  const secure = () => {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const st = lstatSync(folder);
    if (!st.isDirectory() || st.isSymbolicLink() ||
        (st.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && st.uid !== process.getuid()))
      throw fail('acp_recovery_unsafe_directory');
  };
  const pathFor = id => {
    if (!ID.test(id ?? '')) throw fail('acp_recovery_invalid_id');
    return join(folder, id + '.json');
  };
  return Object.freeze({
    save(row) {
      const safe = normalize(row);
      secure();
      const pathname = pathFor(safe.session_id);
      const content = Buffer.from(JSON.stringify(safe) + '\n', 'utf8');
      if (content.length > 2048) throw fail('acp_recovery_oversized');
      const temp = join(folder, safe.session_id + '-' + randomUUID() + '.tmp');
      let fd;
      try {
        fd = openSync(temp, constants.O_CREAT | constants.O_EXCL |
          constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
        writeSync(fd, content);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temp, pathname);
        const dfd = openSync(folder, constants.O_RDONLY |
          (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
        try { fsyncSync(dfd); } finally { closeSync(dfd); }
      } catch {
        if (fd !== undefined) try { closeSync(fd); } catch {}
        try { unlinkSync(temp); } catch {}
        throw fail('acp_recovery_write_failed');
      }
    },
    read(id) {
      const pathname = pathFor(id);
      secure();
      let fd;
      try {
        fd = openSync(pathname, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw fail('acp_recovery_unavailable');
      }
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > 2048 || st.size < 2 ||
            (st.mode & 0o077) !== 0 ||
            (typeof process.getuid === 'function' && st.uid !== process.getuid()))
          throw fail('acp_recovery_unsafe_record');
        const row = normalize(JSON.parse(readFileSync(fd, 'utf8')));
        if (row.session_id !== id) throw fail('acp_recovery_id_mismatch');
        return row.state === 'stopped'
          ? Object.freeze({ ok: true, ...row })
          : Object.freeze({
              ok: false, error: 'acp_recovery_required',
              session_id: row.session_id, workspace_id: row.workspace_id,
              worktree_id: row.worktree_id, issue: row.issue,
              state: 'recovery_required', reason: 'supervisor_restarted',
              started_at: row.started_at, ended_at: null
            });
      } catch {
        throw fail('acp_recovery_unavailable');
      } finally { closeSync(fd); }
    }
  });
}
