// Op registry shared by the hub and the agents (Phase 4, TODO-P4-03).
//
// One table says, for every operation that can cross the hub: where it runs (the agent's
// fixed host probe, or the runtime hosted by memo-bridge-runner), the capability it needs
// (server/coordinator/policy.mjs is the single source), whether it mutates, how long the hub
// waits for it, and how the hub checks the agent's answer. An op outside this table is never
// forwarded, even when an agent advertises it.
//
// Input schemas are not copied here: collectTools() registers the same server/tools modules
// the local stdio entry point uses against a collector, so the hub lists, and the agent
// validates, exactly the schemas of the runtime that executes them.
import { CAPABILITIES, DEFAULT_HUB_GRANTS, HUB_PRINCIPALS as HUB_IDS, OPERATION_CAPABILITY, authorize, principalFromHub }
  from '../server/coordinator/policy.mjs';
import { CODE_RE, MAX_RESULT_BYTES } from './protocol.mjs';

// Hub timeouts (ms). The ledger client kills a ledger call after 120 s
// (server/coordinator/issue-lease.mjs), so a single-call ledger op waits at least 130 s and an
// op that may chain several ledger calls (status, claim or release, retry) waits longer. The
// timeout only bounds the hub's wait: the runtime finishes the op either way.
export const TIMEOUTS = Object.freeze({ probe: 6_000, default: 30_000, github: 60_000, ledger: 130_000, ledgerChain: 250_000 });

const LEDGER_OPS = new Set(['tasks_list', 'task_status', 'task_renew', 'task_checkpoint', 'jobs_submit',
  'worktree_create', 'worktree_write_file', 'worktree_commit', 'worktree_push', 'worktree_remove', 'github_create_pr']);
const LEDGER_CHAIN_OPS = new Set(['task_claim', 'task_release', 'task_complete', 'workspace_close', 'workspace_recover']);
const GITHUB_READ_OPS = new Set(['github_issues', 'github_pull_requests', 'github_workflows', 'github_checks']);

// Ops answered by the hub itself (no agent, no capability beyond authentication).
export const HUB_LOCAL_OPS = Object.freeze(['list_hosts', 'bridge_info']);
export const HOSTS = Object.freeze(['mac', 'vps']);

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Every result is a JSON object; a refusal is {ok:false, error:<short code>}.
function genericResult(data) {
  if (!isPlainObject(data)) return false;
  if (data.ok === false && (typeof data.error !== 'string' || !CODE_RE.test(data.error))) return false;
  return true;
}
function hostStatusResult(data, host) {
  return isPlainObject(data) && data.host === host && typeof data.online === 'boolean';
}

function timeoutFor(op) {
  if (LEDGER_CHAIN_OPS.has(op)) return TIMEOUTS.ledgerChain;
  if (LEDGER_OPS.has(op)) return TIMEOUTS.ledger;
  if (GITHUB_READ_OPS.has(op)) return TIMEOUTS.github;
  return TIMEOUTS.default;
}

function entry(name, fields) { return Object.freeze({ name, maxResultBytes: MAX_RESULT_BYTES, ...fields }); }

export const OPS = Object.freeze(Object.fromEntries([
  ['host_status', entry('host_status', { kind: 'probe', capability: null, mutating: false, timeoutMs: TIMEOUTS.probe,
    checkResult: hostStatusResult })],
  ...Object.entries(OPERATION_CAPABILITY).map(([name, capability]) => [name, entry(name, {
    kind: 'runtime', capability, mutating: capability !== CAPABILITIES.READ, timeoutMs: timeoutFor(name),
    checkResult: genericResult })])
]));
export const RUNTIME_OPS = Object.freeze(Object.values(OPS).filter(o => o.kind === 'runtime').map(o => o.name));
export const MUTATING_OPS = Object.freeze(Object.values(OPS).filter(o => o.mutating).map(o => o.name));
export const isForwardable = op => Object.hasOwn(OPS, op);

// Phase 4 hub principals (spec D9). Capabilities are decided on each side from the principal
// id and that side's grants (server/coordinator/policy.mjs principalFromHub, TODO-P4-06); they
// never travel on the wire. The hub maps credentials with the default grants (owner bearer ->
// hub:owner, read-only bearer -> hub:readonly); the runtime maps the forwarded id again with
// its own grants (MEMO_BRIDGE_HUB_PRINCIPALS). OIDC principals arrive in Phase 5.
export const PRINCIPAL_IDS = Object.freeze({ owner: HUB_IDS.OWNER, readonly: HUB_IDS.READ_ONLY });
export const HUB_PRINCIPALS = Object.freeze({
  [PRINCIPAL_IDS.owner]: principalFromHub(PRINCIPAL_IDS.owner, DEFAULT_HUB_GRANTS),
  [PRINCIPAL_IDS.readonly]: principalFromHub(PRINCIPAL_IDS.readonly, DEFAULT_HUB_GRANTS)
});
// The wire carries {id} only; any other field (claimed capabilities included) is ignored.
// Unknown ids map to null and are refused.
export function principalFromWire(wire, grants = DEFAULT_HUB_GRANTS) {
  const id = wire?.id;
  return typeof id === 'string' ? principalFromHub({ id }, grants) : null;
}

// Why `principal` may not call `op` through the hub, or null when it may.
//  mutatingOps: false (default) or 'owner' (TODO-P4-40: only after the AC-14 gate passes).
export function denialReason(principal, op, { runtimeEnabled = false, mutatingOps = false } = {}) {
  if (HUB_LOCAL_OPS.includes(op) || op === 'host_status') return null;
  if (!isForwardable(op)) return 'unsupported_op';
  if (!runtimeEnabled) return 'runtime_disabled';
  if (!principal || !Object.hasOwn(HUB_PRINCIPALS, principal.id)) return 'forbidden';
  if (!authorize(principal, op)) return 'forbidden';
  if (OPS[op].mutating && !(mutatingOps === 'owner' && principal.id === PRINCIPAL_IDS.owner)) return 'mutating_disabled';
  return null;
}

// The tool modules served by the runtime (server/index.mjs registers the same ones).
const TOOL_MODULES = [
  ['../server/tools/coordinator-tools.mjs', 'registerCoordinatorTools'],
  ['../server/tools/worktree-tools.mjs', 'registerWorktreeTools'],
  ['../server/tools/job-tools.mjs', 'registerJobTools'],
  ['../server/tools/host-tools.mjs', 'registerHostTools'],
  ['../server/tools/github-tools.mjs', 'registerGithubTools'],
  ['../server/tools/audit-tools.mjs', 'registerAuditTools']
];

// Register every runtime tool module against a collector. Returns
// Map name -> {description, inputSchema, annotations, handler}. The modules call
// getRuntime() lazily, inside handlers, so the hub can collect definitions with a getRuntime
// that throws. Imported dynamically: the Mac probe agent never loads the runtime stack.
export async function collectTools(getRuntime) {
  const tools = new Map();
  const collector = {
    registerTool(name, config, handler) {
      if (tools.has(name)) throw new Error('duplicate_tool');
      tools.set(name, Object.freeze({ description: config.description, inputSchema: config.inputSchema,
        annotations: config.annotations, handler }));
    }
  };
  for (const [path, fn] of TOOL_MODULES) {
    const mod = await import(path);
    mod[fn](collector, getRuntime);
  }
  return tools;
}

// Tool definitions for the hub: schemas only, never a runtime.
export async function collectToolDefinitions() {
  const tools = await collectTools(() => { throw new Error('hub_has_no_runtime'); });
  for (const name of tools.keys()) if (!isForwardable(name)) throw new Error('tool_not_in_registry');
  return tools;
}
