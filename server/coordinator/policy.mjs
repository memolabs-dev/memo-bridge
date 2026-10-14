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
  audit_operation: CAPABILITIES.READ,
  // Catalogue (Phase 5, FU-4): served by the runtime so a hub client can discover project names.
  projects_list: CAPABILITIES.READ
});

// Capabilities that change something. The remote write gate (Phase 5 D7) removes every one of
// them from a remote principal while remote_writes is not "enabled".
export const WRITE_CAPABILITIES = Object.freeze([CAPABILITIES.WRITE, CAPABILITIES.EXECUTE, CAPABILITIES.REPO_WRITE,
  CAPABILITIES.GITHUB_WRITE]);

// Client kinds a workspace records. Defined here so a principal can carry a server-derived one
// (Phase 5 D6); coordinator/index.mjs re-exports it.
export const CLIENT_TYPES = Object.freeze(['chatgpt', 'claude-code', 'codex', 'opencode', 'hermes', 'cuesheet', 'cli', 'other']);
export const PRINCIPAL_VIAS = Object.freeze(['stdio', 'hub']);

const PRINCIPAL_RE = /^[a-z]+:[A-Za-z0-9._@-]{1,120}$/;
const KNOWN_CAPABILITIES = new Set(Object.values(CAPABILITIES));

// Principals minted here, and only here. runtime.as() accepts nothing else, so an object that
// merely looks like a principal (JSON from a request, a tool argument) can never act as one.
const minted = new WeakSet();
const sealed = () => { throw new Error('principal_frozen'); };

// attributes: {client_type, via}, both optional and set by the server only. client_type is the
// kind of client the transport authenticated (Phase 5: derived from the token's client_id); it
// labels the principal, it never grants anything and it is never part of the id.
export function makePrincipal(id, capabilities, { client_type: clientType, via } = {}) {
  if (typeof id !== 'string' || !PRINCIPAL_RE.test(id)) throw new Error('invalid_principal');
  if (clientType !== undefined && !CLIENT_TYPES.includes(clientType)) throw new Error('invalid_principal');
  if (via !== undefined && !PRINCIPAL_VIAS.includes(via)) throw new Error('invalid_principal');
  // Object.freeze does not stop Set.prototype.add, so the mutators are replaced as well.
  const set = new Set(capabilities);
  for (const method of ['add', 'delete', 'clear']) Object.defineProperty(set, method, { value: sealed });
  const principal = Object.freeze({ id, capabilities: Object.freeze(set),
    ...(clientType !== undefined ? { client_type: clientType } : {}), ...(via !== undefined ? { via } : {}) });
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
//
// Phase 5 adds OIDC principals, `oidc:<sub>`, minted by the public listener for the owner's
// ChatGPT conversations (remotePrincipal below). They cross the hub like the hub: ones and the
// runtime grants them the same way: only an id listed in its own grants maps to a principal.
export const HUB_PRINCIPAL_RE = /^hub:[a-z0-9][a-z0-9._-]{0,63}$/;
export const OIDC_SUB_RE = /^[A-Za-z0-9._@-]{1,120}$/;
export const OIDC_PRINCIPAL_RE = /^oidc:[A-Za-z0-9._@-]{1,120}$/;
// Ids a grants map may name and a hub claim may carry.
const grantable = id => typeof id === 'string' && (HUB_PRINCIPAL_RE.test(id) || OIDC_PRINCIPAL_RE.test(id));
// A principal authenticated by the public OIDC listener (Phase 5), on either side of the hub.
export const isRemotePrincipal = principal => typeof principal?.id === 'string' && OIDC_PRINCIPAL_RE.test(principal.id);
export const HUB_ROLES = Object.freeze({
  owner: Object.freeze(Object.values(CAPABILITIES)),
  read: Object.freeze([CAPABILITIES.READ])
});
export const HUB_PRINCIPALS = Object.freeze({ OWNER: 'hub:owner', READ_ONLY: 'hub:readonly' });
export const DEFAULT_HUB_GRANTS = Object.freeze({ [HUB_PRINCIPALS.OWNER]: 'owner', [HUB_PRINCIPALS.READ_ONLY]: 'read' });
// The runtime's own default, until the owner enables hub writes (TODO-P4-40, AC-P4-14 gate):
// read for everyone. The hub's MEMO_BRIDGE_HUB_MUTATING_OPS gate is one side; this is the
// other, so whoever holds the hub's TLS key (the memo-bridge uid) cannot send mutating ops
// straight to the runner either (verifier finding 7). Enabling writes takes both
// MEMO_BRIDGE_HUB_MUTATING_OPS=owner on the hub and MEMO_BRIDGE_HUB_PRINCIPALS on the runner.
export const RUNTIME_DEFAULT_HUB_GRANTS = Object.freeze({ [HUB_PRINCIPALS.OWNER]: 'read', [HUB_PRINCIPALS.READ_ONLY]: 'read' });
const MAX_HUB_GRANTS = 32;
const MAX_CLAIMED_CAPABILITIES = 16;

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

// Validate a grants map {"hub:<id>" | "oidc:<sub>": "<role>"}; throws invalid_hub_grants on anything else.
export function parseHubGrants(value) {
  const grants = typeof value === 'string' ? JSON.parse(value) : value;
  if (!plainObject(grants)) throw new Error('invalid_hub_grants');
  const entries = Object.entries(grants);
  if (entries.length > MAX_HUB_GRANTS) throw new Error('invalid_hub_grants');
  for (const [id, role] of entries) {
    if (!grantable(id) || typeof role !== 'string' || !Object.hasOwn(HUB_ROLES, role)) throw new Error('invalid_hub_grants');
  }
  return Object.freeze(Object.fromEntries(entries));
}

// The runtime's grants: MEMO_BRIDGE_HUB_PRINCIPALS (JSON) when set, else
// RUNTIME_DEFAULT_HUB_GRANTS (read only). An invalid value throws; callers fail closed.
export function hubGrantsFromEnv(env = process.env) {
  const raw = env.MEMO_BRIDGE_HUB_PRINCIPALS;
  if (raw === undefined || raw === '') return RUNTIME_DEFAULT_HUB_GRANTS;
  try { return parseHubGrants(raw); } catch { throw new Error('invalid_hub_grants'); }
}

// A principal for an identity claim forwarded by the hub, or null when the claim is refused.
// `claim` is the id ("hub:owner", "oidc:<sub>") or {id, capabilities?, client_type?}; nothing
// else is accepted. client_type, when present, must be a known client kind; it labels the
// principal and grants nothing.
export function principalFromHub(claim, grants = DEFAULT_HUB_GRANTS) {
  let id; let claimed = null; let clientType;
  if (typeof claim === 'string') {
    id = claim;
  } else if (plainObject(claim)) {
    if (Object.keys(claim).some(key => key !== 'id' && key !== 'capabilities' && key !== 'client_type')) return null;
    id = claim.id;
    if (claim.capabilities !== undefined) {
      if (!Array.isArray(claim.capabilities) || claim.capabilities.length > MAX_CLAIMED_CAPABILITIES ||
        claim.capabilities.some(c => typeof c !== 'string')) return null;
      claimed = new Set(claim.capabilities);
    }
    if (claim.client_type !== undefined) {
      if (!CLIENT_TYPES.includes(claim.client_type)) return null;
      clientType = claim.client_type;
    }
  } else {
    return null;
  }
  if (!grantable(id)) return null;
  if (!plainObject(grants) || !Object.hasOwn(grants, id)) return null;
  const role = grants[id];
  if (typeof role !== 'string' || !Object.hasOwn(HUB_ROLES, role)) return null;
  const capabilities = HUB_ROLES[role].filter(c => KNOWN_CAPABILITIES.has(c) && (!claimed || claimed.has(c)));
  return makePrincipal(id, capabilities, { via: 'hub', ...(clientType !== undefined ? { client_type: clientType } : {}) });
}

// ---------------------------------------------------------------------------------------------
// Remote principals (Phase 5, spec D6 and D7). The public listener verifies the access token
// (bridge/oidc.mjs) and hands its claims here; this decides who the caller is and what it may
// do, from server configuration only:
//  - the id is oidc:<sub>, and sub must equal the configured owner sub (single owner);
//  - client_type comes from the token's client_id through the configured allowlist, never from
//    a tool argument; an unlisted client is refused;
//  - capabilities = token scopes, intersected with the server ceiling, minus every write
//    capability while the write gate is closed (remote_writes != "enabled");
//  - the baseline scope coordinator:read is required.
// remote: {ownerSub, clientTypes: Map(client_id -> client_type), ceiling: [capability],
// remoteWrites: boolean}. Returns {ok:true, principal} or {ok:false, error}.
export const REMOTE_BASELINE_SCOPE = CAPABILITIES.READ;
// Default ceiling: every capability, the same default as the verifier (bridge/oidc.mjs), so the
// two layers agree; the write gate removes the write capabilities on its own.
export const REMOTE_DEFAULT_CEILING = Object.freeze(Object.values(CAPABILITIES));
const MAX_SCOPES = 32;

export function remotePrincipal(claims, remote) {
  if (!plainObject(remote) || typeof remote.ownerSub !== 'string' || !OIDC_SUB_RE.test(remote.ownerSub) ||
    !(remote.clientTypes instanceof Map) || !Array.isArray(remote.ceiling) || typeof remote.remoteWrites !== 'boolean') {
    return { ok: false, error: 'remote_misconfigured' };
  }
  const sub = claims?.sub;
  const clientId = claims?.client_id;
  const scopes = claims?.scopes;
  if (typeof sub !== 'string' || !OIDC_SUB_RE.test(sub) || typeof clientId !== 'string' || clientId.length === 0 ||
    !Array.isArray(scopes) || scopes.length > MAX_SCOPES || scopes.some(s => typeof s !== 'string')) {
    return { ok: false, error: 'invalid_token' };
  }
  if (sub !== remote.ownerSub) return { ok: false, error: 'not_owner' };
  const clientType = remote.clientTypes.get(clientId);
  if (clientType === undefined) return { ok: false, error: 'client_not_allowed' };
  if (!CLIENT_TYPES.includes(clientType)) return { ok: false, error: 'remote_misconfigured' };
  const granted = new Set(scopes);
  if (!granted.has(REMOTE_BASELINE_SCOPE)) return { ok: false, error: 'insufficient_scope' };
  const ceiling = new Set(remote.ceiling);
  const capabilities = Object.values(CAPABILITIES).filter(c => granted.has(c) && ceiling.has(c) &&
    (remote.remoteWrites || !WRITE_CAPABILITIES.includes(c)));
  return { ok: true, principal: makePrincipal(`oidc:${sub}`, capabilities, { client_type: clientType, via: 'hub' }) };
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
