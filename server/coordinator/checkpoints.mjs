// Read-only Git verification of a checkpoint. Never fetches, never writes to the repository.
// A checkpoint is "remote" only when the commit is already reachable from the
// remote-tracking branch known locally; otherwise the handoff risk is reported explicitly.
import { execFile } from 'node:child_process';

export const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function validBranch(branch) {
  return typeof branch === 'string' && BRANCH_RE.test(branch) && !branch.includes('..') && !branch.includes('//') &&
    !branch.endsWith('/') && !branch.endsWith('.') && !branch.endsWith('.lock') && !branch.includes('/.') &&
    !branch.includes('@{');
}

function git(path, args) {
  return new Promise(resolve => {
    execFile('git', ['-C', path, ...args], {
      timeout: 6000, maxBuffer: 20000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    }, (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout }));
  });
}

export async function verifyCheckpoint({ repoPath, branch, commit }) {
  if (!repoPath) return { ok: true, durability: 'unverified' };
  const exists = await git(repoPath, ['cat-file', '-e', `${commit}^{commit}`]);
  if (exists.code !== 0) return { ok: false, error: 'commit_not_found' };
  const remoteRef = `refs/remotes/origin/${branch}`;
  const ref = await git(repoPath, ['rev-parse', '--verify', '--quiet', remoteRef]);
  if (ref.code !== 0) return { ok: true, durability: 'local_only' };
  const ancestor = await git(repoPath, ['merge-base', '--is-ancestor', commit, remoteRef]);
  return { ok: true, durability: ancestor.code === 0 ? 'remote' : 'local_only' };
}
