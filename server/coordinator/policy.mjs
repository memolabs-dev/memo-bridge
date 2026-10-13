// Server-side authorization. The principal always comes from the transport or the
// authentication layer, never from tool arguments written by a model.
import { userInfo } from 'node:os';

export const CAPABILITIES = Object.freeze({
  READ: 'coordinator:read',
  WRITE: 'coordinator:write',
  AUDIT: 'coordinator:audit',
  // Phase 3, runners: separate capabilities so a remote principal can be granted reading
  // without execution or repository writes.
  EXECUTE: 'runner:execute',
  REPO_WRITE: 'repo:write',
  GITHUB_WRITE: 'github:write'
});

export const OPERATION_CAPABILITY = Object.freeze({
  // Workspaces
  workspace_open: CAPABILITIES.WRITE,
  workspace_close: CAPABILITIES.WRITE,
  workspace_status: CAPABILITIES.READ,
  workspace_list: CAPABILITIES.READ,
  workspace_recover: CAPABILITIES.READ,
  // Tasks (GitHub Issues + lease ledger)
  tasks_list: CAPABILITIES.READ,
  task_status: CAPABILITIES.READ,
  task_claim: CAPABILITIES.WRITE,
  task_renew: CAPABILITIES.WRITE,
  task_release: CAPABILITIES.WRITE,
  task_complete: CAPABILITIES.WRITE,
  task_checkpoint: CAPABILITIES.WRITE,
  // Worktrees and files inside them
  worktrees_list: CAPABILITIES.READ,
  worktree_status: CAPABILITIES.READ,
  worktree_read_file: CAPABILITIES.READ,
  worktree_list_files: CAPABILITIES.READ,
  worktree_diff: CAPABILITIES.READ,
  worktree_create: CAPABILITIES.REPO_WRITE,
  worktree_write_file: CAPABILITIES.REPO_WRITE,
  worktree_commit: CAPABILITIES.REPO_WRITE,
  worktree_push: CAPABILITIES.REPO_WRITE,
  worktree_remove: CAPABILITIES.REPO_WRITE,
  // Jobs
  jobs_list: CAPABILITIES.READ,
  job_status: CAPABILITIES.READ,
  job_events: CAPABILITIES.READ,
  job_results: CAPABILITIES.READ,
  jobs_submit: CAPABILITIES.EXECUTE,
  job_cancel: CAPABILITIES.EXECUTE,
  // Hosts
  host_capabilities: CAPABILITIES.READ,
  host_resources: CAPABILITIES.READ,
  // GitHub
  github_issues: CAPABILITIES.READ,
  github_pull_requests: CAPABILITIES.READ,
  github_workflows: CAPABILITIES.READ,
  github_checks: CAPABILITIES.READ,
  github_create_pr: CAPABILITIES.GITHUB_WRITE,
  // Audit
  audit_events: CAPABILITIES.READ,
  audit_operation: CAPABILITIES.READ
});

const PRINCIPAL_RE = /^[a-z]+:[A-Za-z0-9._@-]{1,120}$/;

export function makePrincipal(id, capabilities) {
  if (!PRINCIPAL_RE.test(id)) throw new Error('invalid_principal');
  return Object.freeze({ id, capabilities: Object.freeze(new Set(capabilities)) });
}

// The local stdio plugin runs as the trusted OS user that launched it (see SECURITY.md).
export function localOwnerPrincipal(env = process.env) {
  let raw;
  // userInfo() throws when the uid has no passwd entry (some containers); never let that
  // take the whole server down.
  try { raw = userInfo().username; } catch { raw = env.USER || env.LOGNAME || 'unknown'; }
  const name = String(raw).replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 120) || 'unknown';
  return makePrincipal(`local:${name}`, Object.values(CAPABILITIES));
}

export function authorize(principal, operation) {
  const required = OPERATION_CAPABILITY[operation];
  if (!required) return false;
  return Boolean(principal?.capabilities?.has(required));
}

export function ownsWorkspace(principal, workspace) {
  return Boolean(workspace) && workspace.principal === principal.id;
}
