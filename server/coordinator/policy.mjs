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
const KNOWN_CAPABILITIES = new Set(Object.values(CAPABILITIES));

// Principals minted here, and only here. runtime.as() accepts nothing else, so an object that
// merely looks like a principal (JSON from a request, a tool argument) can never act as one.
const minted = new WeakSet();
const sealed = () => { throw new Error('principal_frozen'); };

export function makePrincipal(id, capabilities) {
  if (typeof id !== 'string' || !PRINCIPAL_RE.test(id)) throw new Error('invalid_principal');
  // Object.freeze does not stop Set.prototype.add, so the mutators are replaced as well.
  const set = new Set(capabilities);
  for (const method of ['add', 'delete', 'clear']) Object.defineProperty(set, method, { value: sealed });
  const principal = Object.freeze({ id, capabilities: Object.freeze(set) });
  minted.add(principal);
  return principal;
}

export const isPrincipal = value => minted.has(value);

// The local stdio plugin runs as the trusted OS user that launched it (see SECURITY.md).
export function localOwnerPrincipal(env = process.env) {
  let raw;
  // userInfo() throws when the uid has no passwd entry (some containers); never let that
  // take the whole server down.
  try { raw = userInfo().username; } catch { raw = env.USER || env.LOGNAME || 'unknown'; }
  const name = String(raw).replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 120) || 'unknown';
  return makePrincipal(`local:${name}`, Object.values(CAPABILITIES));
}

// ---------------------------------------------------------------------------------------------
// Principals forwarded by the hub (Phase 4, D9). The hub authenticates the caller (owner bearer,
// read-only test bearer, OIDC in Phase 5) and forwards an identity claim with each request over
// the Ed25519-authenticated agent connection. The runtime does not take that claim at face
// value: the id must be listed in the runtime's own grants (MEMO_BRIDGE_HUB_PRINCIPALS), the
// grant's role sets the ceiling, and capabilities claimed by the hub can only narrow it. Tool
// arguments are never read here: the claim travels in the request envelope, set by the hub.
export const HUB_PRINCIPAL_RE = /^hub:[a-z0-9][a-z0-9._-]{0,63}$/;
export const HUB_ROLES = Object.freeze({
  owner: Object.freeze(Object.values(CAPABILITIES)),
  read: Object.freeze([CAPABILITIES.READ])
});
export const HUB_PRINCIPALS = Object.freeze({ OWNER: 'hub:owner', READ_ONLY: 'hub:readonly' });
export const DEFAULT_HUB_GRANTS = Object.freeze({ [HUB_PRINCIPALS.OWNER]: 'owner', [HUB_PRINCIPALS.READ_ONLY]: 'read' });
const MAX_HUB_GRANTS = 32;
const MAX_CLAIMED_CAPABILITIES = 16;

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

// Validate a grants map {"hub:<id>": "<role>"}; throws invalid_hub_grants on anything else.
export function parseHubGrants(value) {
  const grants = typeof value === 'string' ? JSON.parse(value) : value;
  if (!plainObject(grants)) throw new Error('invalid_hub_grants');
  const entries = Object.entries(grants);
  if (entries.length > MAX_HUB_GRANTS) throw new Error('invalid_hub_grants');
  for (const [id, role] of entries) {
    if (!HUB_PRINCIPAL_RE.test(id) || typeof role !== 'string' || !Object.hasOwn(HUB_ROLES, role)) throw new Error('invalid_hub_grants');
  }
  return Object.freeze(Object.fromEntries(entries));
}

// The runtime's grants: MEMO_BRIDGE_HUB_PRINCIPALS (JSON) when set, else DEFAULT_HUB_GRANTS.
// An invalid value throws; callers fail closed.
export function hubGrantsFromEnv(env = process.env) {
  const raw = env.MEMO_BRIDGE_HUB_PRINCIPALS;
  if (raw === undefined || raw === '') return DEFAULT_HUB_GRANTS;
  try { return parseHubGrants(raw); } catch { throw new Error('invalid_hub_grants'); }
}

// A principal for an identity claim forwarded by the hub, or null when the claim is refused.
// `claim` is the id ("hub:owner") or {id, capabilities?}; nothing else is accepted.
export function principalFromHub(claim, grants = DEFAULT_HUB_GRANTS) {
  let id; let claimed = null;
  if (typeof claim === 'string') {
    id = claim;
  } else if (plainObject(claim)) {
    if (Object.keys(claim).some(key => key !== 'id' && key !== 'capabilities')) return null;
    id = claim.id;
    if (claim.capabilities !== undefined) {
      if (!Array.isArray(claim.capabilities) || claim.capabilities.length > MAX_CLAIMED_CAPABILITIES ||
        claim.capabilities.some(c => typeof c !== 'string')) return null;
      claimed = new Set(claim.capabilities);
    }
  } else {
    return null;
  }
  if (typeof id !== 'string' || !HUB_PRINCIPAL_RE.test(id)) return null;
  if (!plainObject(grants) || !Object.hasOwn(grants, id)) return null;
  const role = grants[id];
  if (typeof role !== 'string' || !Object.hasOwn(HUB_ROLES, role)) return null;
  const capabilities = HUB_ROLES[role].filter(c => KNOWN_CAPABILITIES.has(c) && (!claimed || claimed.has(c)));
  return makePrincipal(id, capabilities);
}

export function authorize(principal, operation) {
  if (typeof operation !== 'string' || !Object.hasOwn(OPERATION_CAPABILITY, operation)) return false;
  const required = OPERATION_CAPABILITY[operation];
  return Boolean(principal?.capabilities?.has(required));
}

export function ownsWorkspace(principal, workspace) {
  return Boolean(workspace) && workspace.principal === principal.id;
}

// The worker identity recorded in the ledger. It is derived from the workspace, so another
// workspace, even of the same principal, can never act on this claim. (Re-exported by
// coordinator/index.mjs; it lives here so the job runner can use it without the Coordinator.)
export const workerFor = workspace => `mb.${workspace.host}.${workspace.id}`;
