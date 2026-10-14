// Memo Bridge tool registry (Phase 5, spec D5): one list of the runtime tool modules, collected
// the same way for every surface, so stdio, the Phase 4 hub and the Phase 5 remote surface
// serve the same names, descriptions, input schemas and annotations.
//
//  - collectTools(getRuntime) registers every module against a collector and returns the tools
//    with their handlers (the runtime agent runs them, bridge/agent.mjs).
//  - collectToolDefinitions() does the same with a getRuntime that throws: definitions only, for
//    a surface that executes nothing itself (the hub, bridge/remote-surface.mjs).
//  - REMOTE_TOOLS_READ and REMOTE_TOOLS_WRITE are the fixed allowlists of the public ChatGPT
//    surface. toolsFor(principal, {remoteWrites}) is what one remote principal may list: the
//    write tools only when remote_writes is "enabled" (gate layer 1), and only the tools its
//    capabilities authorize (layer 2; the runtime authorizes again, layer 3).
//
// The modules are imported dynamically: importing this file loads nothing of the runtime stack,
// so the Mac probe agent (which imports bridge/ops.mjs) stays light.
import { CAPABILITIES, OPERATION_CAPABILITY, authorize } from './coordinator/policy.mjs';

// [module path relative to this file, register function]. Each register function takes
// (server, getRuntime) and calls getRuntime() lazily, inside its handlers.
export const TOOL_MODULES = Object.freeze([
  ['./tools/coordinator-tools.mjs', 'registerCoordinatorTools'],
  ['./tools/worktree-tools.mjs', 'registerWorktreeTools'],
  ['./tools/job-tools.mjs', 'registerJobTools'],
  ['./tools/host-tools.mjs', 'registerHostTools'],
  ['./tools/github-tools.mjs', 'registerGithubTools'],
  ['./tools/audit-tools.mjs', 'registerAuditTools'],
  ['./tools/catalog-tools.mjs', 'registerCatalogTools']
].map(Object.freeze));

// The public ChatGPT surface (spec §1 non-goals, D5). Excluded on purpose:
//  - observe_* (production and job data), host_resources, worktree_remove;
//  - list_hosts, host_status and bridge_info, answered from hub state the remote surface does
//    not hold; project_info, project_git_status and projects_audit (local paths, stdio only).
export const REMOTE_TOOLS_READ = Object.freeze([
  'projects_list',
  'workspace_status', 'workspace_list', 'workspace_recover',
  'tasks_list', 'task_status', 'batch_status',
  'worktrees_list', 'worktree_status', 'worktree_list_files', 'worktree_read_file', 'worktree_diff',
  'jobs_list', 'job_status', 'job_events', 'job_results',
  'host_capabilities',
  'github_issues', 'github_pull_requests', 'github_workflows', 'github_checks',
  'audit_events', 'audit_operation'
]);
export const REMOTE_TOOLS_WRITE = Object.freeze([
  'workspace_open', 'workspace_close',
  'task_claim', 'task_renew', 'task_release', 'task_complete', 'task_checkpoint',
  'batch_create', 'task_next',
  'worktree_create', 'worktree_write_file', 'worktree_commit', 'worktree_push',
  'jobs_submit', 'job_cancel',
  'github_create_pr'
]);
export const REMOTE_TOOLS = Object.freeze([...REMOTE_TOOLS_READ, ...REMOTE_TOOLS_WRITE]);
const REMOTE_WRITE_SET = new Set(REMOTE_TOOLS_WRITE);
export const isRemoteWriteTool = name => REMOTE_WRITE_SET.has(name);

// Gate layer 1: writes are listed remotely only with remote_writes exactly "enabled".
export const remoteWritesEnabled = config => config?.remote_writes === 'enabled';

// Tools one remote principal may list, sorted. remoteWrites false (the default) lists none of
// the write tools, whatever the principal holds.
export function toolsFor(principal, { remoteWrites = false } = {}) {
  const names = remoteWrites === true ? REMOTE_TOOLS : REMOTE_TOOLS_READ;
  return names.filter(name => authorize(principal, name)).sort();
}

// Register every runtime tool module against a collector. Returns a Map
// name -> {description, inputSchema, annotations, handler}, in registration order.
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

// Definitions only: the handlers are dropped and the runtime getter throws, so nothing collected
// here can run a tool. Cached: the modules register the same definitions every time.
let definitions;
export function collectToolDefinitions() {
  definitions ??= collectTools(() => { throw new Error('no_runtime_here'); }).then(tools => {
    const defs = new Map();
    for (const [name, tool] of tools) {
      defs.set(name, Object.freeze({ description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }));
    }
    return defs;
  });
  definitions.catch(() => { definitions = undefined; });
  // A fresh Map per caller: one surface can never change what another one lists.
  return definitions.then(defs => new Map(defs));
}

// Registry self-check, run by the remote surface before it serves anything: every remote tool is
// collected, has a policy entry, sits in the list that matches its capability (read tools need
// coordinator:read, write tools anything else) and states the three hints ChatGPT reads
// (readOnlyHint, destructiveHint, openWorldHint) explicitly. Returns the list of problems.
export function registryProblems(defs) {
  const problems = [];
  for (const name of REMOTE_TOOLS) {
    const def = defs.get(name);
    if (!def) { problems.push(`${name}: not collected`); continue; }
    const capability = OPERATION_CAPABILITY[name];
    if (!capability) problems.push(`${name}: no policy entry`);
    const isRead = capability === CAPABILITIES.READ;
    if (isRead === isRemoteWriteTool(name)) problems.push(`${name}: listed as ${isRead ? 'write' : 'read'}`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
      if (typeof def.annotations?.[hint] !== 'boolean') problems.push(`${name}: ${hint} not explicit`);
    }
    if (def.annotations?.readOnlyHint !== isRead) problems.push(`${name}: readOnlyHint disagrees with policy`);
  }
  return problems;
}
