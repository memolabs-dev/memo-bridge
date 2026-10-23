// Preflight for an eventual OpenCode ACP runner. Admission is not a launch grant:
// no model can supply a host path, executable, argv, principal, repo or lease fence.
// Recheck all of these immediately before launch and throughout the process lifetime.
import { access, lstat, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { projectInfo } from '../catalog.mjs';
import { localOwnerId, ownsWorkspace, workerFor } from '../coordinator/policy.mjs';
import { inExpiryWindow, parseIssueRef } from '../coordinator/issue-lease.mjs';

const WT = /^wt_[A-Za-z0-9_-]{16}$/;
const fail = (error) => ({ ok: false, error });

export async function inspectManagedWorktree(row, { lookup = projectInfo } = {}) {
  if (!row?.project_id || typeof row.path !== 'string' || !isAbsolute(row.path) ||
      !row.branch || !row.issue_ref) return fail('invalid_worktree');
  try {
    const root = resolve(row.path);
    const dir = await lstat(root);
    if (!dir.isDirectory() || dir.isSymbolicLink() || await realpath(root) !== root)
      return fail('worktree_link_changed');
    const link = join(root, '.git');
    const linkStat = await lstat(link);
    if (!linkStat.isFile() || linkStat.isSymbolicLink()) return fail('worktree_link_changed');
    const raw = await readFile(link, 'utf8');
    if (raw.length > 4096) return fail('worktree_link_changed');
    const match = /^gitdir: (\/[^\r\n]+)\r?\n?$/.exec(raw);
    if (!match) return fail('worktree_link_changed');
    const gitdir = await realpath(match[1]);
    if (basename(dirname(gitdir)) !== 'worktrees' || !(await stat(gitdir)).isDirectory())
      return fail('worktree_link_changed');
    // Read the linked worktree's own HEAD, without invoking Git hooks/config helpers.
    const headFile = join(gitdir, 'HEAD');
    const headStat = await lstat(headFile);
    if (!headStat.isFile() || headStat.isSymbolicLink() ||
        (await readFile(headFile, 'utf8')).trim() !== 'ref: refs/heads/' + row.branch)
      return fail('branch_changed');
    const project = await lookup(row.project_id);
    if (!project?.ok || !isAbsolute(project.project?.local_path ?? '')) return fail('project_not_registered');
    const gitCommon = await realpath(join(project.project.local_path, '.git'));
    if (dirname(dirname(gitdir)) !== gitCommon) return fail('worktree_link_changed');
    return { ok: true }; // Host path never leaves the runner.
  } catch { return fail('worktree_link_changed'); }
}

export async function findOpenCode({
  home = homedir(), candidates = [join(home, '.opencode', 'bin', 'opencode'), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode']
} = {}) {
  for (const candidate of candidates) {
    try {
      const st = await lstat(candidate);
      if ((!st.isFile() && !st.isSymbolicLink()) || (st.mode & 0o002)) continue;
      await access(candidate, constants.X_OK);
      const real = await realpath(candidate);
      const target = await stat(real);
      if (!target.isFile() || (target.mode & 0o002)) continue;
      return { ok: true, binary: real };
    } catch { /* check next fixed location */ }
  }
  return fail('opencode_unavailable');
}

// Pure admission boundary (injectable state and filesystem for negative tests).
export async function checkAcpAdmission(rt, {
  worktree_id: worktreeId, workspace_id: workspaceId
} = {}, {
  inspect = inspectManagedWorktree, findBinary = findOpenCode
} = {}) {
  if (rt?.readOnly || rt?.host !== 'mac' || rt?.principal?.id !== localOwnerId())
    return fail('forbidden');
  if (!WT.test(worktreeId ?? '')) return fail('invalid_worktree');
  let found;
  try {
    found = await rt.store().transaction(repo => {
      const row = repo.getWorktree(worktreeId);
      if (!row) return null;
      return { row, workspace: repo.getWorkspace(row.workspace_id), claims: repo.claimsOf(row.workspace_id, 'claimed') };
    }, { write: false });
  } catch { return fail('store_unavailable'); }
  if (!found) return fail('unknown_worktree');
  const { row, workspace, claims } = found;
  if (workspaceId !== undefined && workspaceId !== row.workspace_id)
    return fail('workspace_other_session');
  if (!workspace || !ownsWorkspace(rt.principal, workspace)) return fail('forbidden');
  if (workspace.status !== 'active' || row.status !== 'active') return fail('workspace_closed');
  if (workspace.host !== 'mac' || row.host !== 'mac' || row.project_id !== workspace.project_id)
    return fail('wrong_host');
  const issue = parseIssueRef(row.issue_ref);
  if (!issue) return fail('no_live_claim');
  const claim = claims.find(c => c.issue_ref === issue.ref && Date.parse(c.expires_at) > rt.now());
  if (!claim) return fail('no_live_claim');
  if (inExpiryWindow(claim.expires_at, rt.now())) return fail('lease_expiring');

  const heldFence = claim.fence_sha;
  const heldExpiry = claim.expires_at;
  const before = await inspect(row, { lookup: (name) => projectInfo(name, rt.catalogOptions) });
  if (!before.ok) return before;
  const binary = await findBinary();
  if (!binary.ok) return binary;
  let verified;
  try {
    // Private owner leases require the trusted per-call owner marker, never an env flag.
    const ledger = rt.ledger.forOwner?.() ?? rt.ledger;
    verified = await ledger.verify(issue, workerFor(workspace), claim.claim_id, heldFence);
  } catch { return fail('ledger_unavailable'); }
  if (!verified?.ok) return fail(verified?.error ?? 'ledger_unavailable');
  // After asynchronous lease verification, recheck the filesystem and live local mirror:
  // this still is not authorization to spawn without another check at the launch boundary.
  const after = await inspect(row, { lookup: (name) => projectInfo(name, rt.catalogOptions) });
  if (!after.ok) return after;
  let live;
  try {
    live = await rt.store().transaction(repo => ({
      row: repo.getWorktree(row.id), workspace: repo.getWorkspace(row.workspace_id),
      claim: repo.claimsOf(row.workspace_id, 'claimed').find(c => c.claim_id === claim.claim_id)
    }), { write: false });
  } catch { return fail('store_unavailable'); }
  if (live.row?.status !== 'active' || live.workspace?.status !== 'active' ||
      live.claim?.fence_sha !== heldFence || live.claim?.expires_at !== heldExpiry || inExpiryWindow(live.claim?.expires_at, rt.now()))
    return fail('stale_lease');
  return {
    ok: true, worktree_id: row.id, workspace_id: workspace.id, issue: issue.ref,
    agent: 'opencode', lease_expires_at: claim.expires_at,
    launch: 'not_started' // Intentional: no process, no model permissions granted by this read.
  };
}
