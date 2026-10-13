// Server-side authorization. The principal always comes from the transport or the
// authentication layer, never from tool arguments written by a model.
import { userInfo } from 'node:os';

export const CAPABILITIES = Object.freeze({
  READ: 'coordinator:read',
  WRITE: 'coordinator:write',
  AUDIT: 'coordinator:audit'
});

export const OPERATION_CAPABILITY = Object.freeze({
  workspace_open: CAPABILITIES.WRITE,
  workspace_close: CAPABILITIES.WRITE,
  workspace_status: CAPABILITIES.READ,
  workspace_list: CAPABILITIES.READ,
  task_create: CAPABILITIES.WRITE,
  task_claim: CAPABILITIES.WRITE,
  task_renew: CAPABILITIES.WRITE,
  task_release: CAPABILITIES.WRITE,
  task_checkpoint: CAPABILITIES.WRITE,
  task_complete: CAPABILITIES.WRITE,
  task_status: CAPABILITIES.READ,
  tasks_list: CAPABILITIES.READ,
  coordinator_events: CAPABILITIES.READ
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
