// Memo Bridge local stdio entry point. Every tool module shares one runtime (server/runtime.mjs):
// the same private store, the same server-derived principal and the same lease ledger client.
// The principal is the OS user that launched this process; tool arguments never carry identity.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import { collectHost, listHosts } from './probe.mjs';
import { listProjects, projectInfo, projectGitStatus, auditProjectRegistry } from './catalog.mjs';
import { CAPABILITIES } from './coordinator/policy.mjs';
import { getRuntime } from './runtime.mjs';
import { runnerInfo } from './runners/hosts.mjs';
import { sandboxMode } from './runners/sandbox.mjs';
import { COORDINATOR_TOOLS, registerCoordinatorTools } from './tools/coordinator-tools.mjs';
import { WORKTREE_TOOLS, registerWorktreeTools } from './tools/worktree-tools.mjs';
import { JOB_TOOLS, registerJobTools } from './tools/job-tools.mjs';
import { HOST_TOOLS, registerHostTools } from './tools/host-tools.mjs';
import { GITHUB_TOOLS, registerGithubTools } from './tools/github-tools.mjs';
import { AUDIT_TOOLS, registerAuditTools } from './tools/audit-tools.mjs';
import { MEMORY_TOOLS, registerMemoryTools } from './tools/memory-tools.mjs';
import { agentsObserve, focusStatus, guardianReport, liveState } from './observers.mjs';
import { MULTI_SESSION_INSTRUCTIONS } from './instructions.mjs';

const VERSION = '0.6.0';

const BASE_TOOLS = ['list_hosts', 'host_status', 'bridge_info', 'projects_list', 'project_info', 'project_git_status',
  'projects_audit'];
const OBSERVER_TOOLS = ['observe_guardian', 'observe_agents', 'observe_live_state', 'observe_focus'];
// Every tool this server registers, grouped by phase. bridge_info reports it and the smoke test
// checks it against the tools the server actually lists.
const TOOL_GROUPS = {
  observe: [...BASE_TOOLS, ...OBSERVER_TOOLS],
  coordinate: [...COORDINATOR_TOOLS],
  run: [...WORKTREE_TOOLS, ...JOB_TOOLS, ...HOST_TOOLS],
  github: [...GITHUB_TOOLS],
  audit: [...AUDIT_TOOLS],
  memory: [...MEMORY_TOOLS]
};
const ALL_TOOLS = Object.values(TOOL_GROUPS).flat();

const server = new McpServer({
  name: 'memo-bridge',
  version: VERSION
}, {
  instructions: 'Memo Bridge observes registered local projects, the Mac running this plugin and a VPS reachable via SSH alias lab, ' +
    'coordinates work between AI sessions, and runs that work on this machine. Flow for one task: workspace_open (pass its id ' +
    'explicitly afterwards) -> sessions_overview -> task_next, or tasks_list -> task_claim (keep claim_id and the latest fence; renew with task_renew) -> ' +
    'worktree_create with the issue -> worktree_read_file / worktree_write_file -> jobs_submit test|build|lint, then ' +
    'job_status / job_results -> worktree_commit -> worktree_push (records a checkpoint) -> github_create_pr -> task_complete -> ' +
    'workspace_close. After losing context call workspace_recover. Stop writing as soon as a call returns stale_lease or ' +
    'no_live_claim. Memo Bridge\'s own tools use no shell, never write outside its worktrees, never write the default ' +
    'branch, never force-push, never merge and never deploy. Jobs run the repository\'s own test/build/lint scripts, which you ' +
    'can edit, so they are code you wrote: on macOS they run in a sandbox (writes to the worktree only, loopback network ' +
    'only, no private data or credentials) and stop when the claim ends; elsewhere they are refused unless the owner set ' +
    'MEMO_BRIDGE_JOB_SANDBOX=off, which makes them owner-equivalent. ' + MULTI_SESSION_INSTRUCTIONS
});

const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const result = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

server.registerTool('list_hosts', {
  description: 'List the two independently reachable machines (Mac and VPS) and whether each responds. Read-only.',
  inputSchema: z.object({}),
  annotations: readonly
}, async () => result(await listHosts()));

server.registerTool('host_status', {
  description: 'Read-only inventory for the Mac or VPS: OS, hostname, CPU count, load, disk availability, and VPS container count.',
  inputSchema: z.object({ host: z.enum(['mac', 'vps']) }),
  annotations: readonly
}, async ({ host }) => result(await collectHost(host)));

server.registerTool('bridge_info', {
  description: 'Describe Memo Bridge capabilities, safety limits and supported hosts. Read-only.',
  inputSchema: z.object({}),
  annotations: readonly
}, async () => {
  const rt = getRuntime();
  return result({
    version: VERSION,
    mode: 'observe+coordinate+run',
    transport: 'stdio',
    hosts: ['mac', 'vps'],
    this_host: rt.host,
    vps_connection: 'SSH through the Mac; no incoming connection to the Mac',
    allowed_tools: ALL_TOOLS,
    tool_groups: TOOL_GROUPS,
    principal: { id: rt.principal.id, capabilities: [...rt.principal.capabilities].sort() },
    capabilities: {
      [CAPABILITIES.READ]: 'observe, list and read: workspaces, tasks, worktrees, files inside worktrees, jobs, hosts, GitHub, audit',
      [CAPABILITIES.WRITE]: 'open and close workspaces, claim, renew, release, complete and checkpoint tasks',
      [CAPABILITIES.AUDIT]: 'read every principal\'s audit events (otherwise only your own)',
      [CAPABILITIES.REPO_WRITE]: 'create worktrees on new branches, write files inside them, commit, push the branch (never the default branch, never forced), remove clean worktrees; requires a live claim',
      [CAPABILITIES.EXECUTE]: 'run the repository\'s own detected test/build/lint recipe in a worktree, without a shell, inside the job sandbox (macOS; MEMO_BRIDGE_JOB_SANDBOX=off makes a job owner-equivalent); requires a live claim',
      [CAPABILITIES.GITHUB_WRITE]: 'open a pull request from a pushed worktree branch; requires a live claim; never merges'
    },
    observation: 'host_status checks reachability only; health comes from the existing observers (observe_*), never from new probes',
    coordinator: {
      work_items: 'GitHub Issues (tasks)',
      leases: 'Git-ref ledger in memolabs-dev/.github (scripts/issue_lease.py), shared by every machine',
      local_state: 'private SQLite store (workspaces, claim mirror, checkpoints, worktrees, jobs, audit), outside repositories and iCloud'
    },
    runner: {
      worktrees: 'isolated Git worktrees under ~/projects/_worktrees/<project>/ (or MEMO_BRIDGE_WORKTREES_ROOT); Git hooks disabled',
      jobs: 'detected recipes only (test, build, lint); at most MEMO_BRIDGE_MAX_JOBS (default 2) per host; logs in the private state directory',
      // Executor, queueing, concurrency limit and job statuses of this process (hosts.mjs, TODO-P4-16).
      ...runnerInfo({ ops: ALL_TOOLS, sandbox: (() => { const m = sandboxMode(); return m.ok ? m.mode : m.error; })() })
    },
    // What the tools themselves never do. Jobs run repository scripts a model can edit: they are
    // bounded by the job sandbox, and owner-equivalent when MEMO_BRIDGE_JOB_SANDBOX=off.
    excluded: ['arbitrary-shell', 'writes-outside-worktrees', 'default-branch-writes', 'force-push', 'merge', 'service-changes',
      'deployment'],
    excluded_scope: 'the tools themselves; jobs are bounded by job_sandbox, and owner-equivalent when it is off',
    vps_runner: 'Phase 4: the same tools run on the VPS through the hub (memo-bridge-runner.service, runtime for host vps), jobs ' +
      'queued one at a time as memo-job@<id>.service without credentials; hub write tools stay disabled until the root CI ' +
      'runners are isolated (docs/RUNNER_VPS.md, docs/HUB_SECURITY.md)',
    next: 'Hub write tools for the owner once the root CI runners are isolated; OIDC and public exposure (Phase 5).'
  });
});


server.registerTool('projects_list', {
  description: 'List/search registered Memo Labs projects from canonical PROJECTS.md. Read-only.',
  inputSchema: z.object({ search: z.string().max(80).optional(), status: z.string().max(40).optional() }),
  annotations: readonly
}, async (args) => result(await listProjects(args)));

server.registerTool('project_info', {
  description: 'Get metadata for a known registered Memo Labs project; cannot browse arbitrary paths.',
  inputSchema: z.object({ project: z.string().max(80) }),
  annotations: readonly
}, async ({ project }) => result(await projectInfo(project)));

server.registerTool('project_git_status', {
  description: 'Read live Git branch, changes count and worktree count of a known registered project. No writes.',
  inputSchema: z.object({ project: z.string().max(80) }),
  annotations: readonly
}, async ({ project }) => result(await projectGitStatus(project)));

server.registerTool('projects_audit', {
  description: 'Report repositories found in local inventory or Memo Labs aliases but absent from canonical PROJECTS.md. Read-only.',
  inputSchema: z.object({}),
  annotations: readonly
}, async () => result(await auditProjectRegistry()));

server.registerTool('observe_guardian', {
  description: 'Latest infrastructure-guardian audit of the Mac, the VPS, skills and owners: overall status, per-section status, finding counts and the most severe findings, with freshness. Read-only; no new probe.',
  inputSchema: z.object({}),
  annotations: readonly
}, async () => result(await guardianReport()));

server.registerTool('observe_agents', {
  description: 'State of the VPS agent workflows from agents-observe (status, uptime, restarts, alerts), with freshness. Read-only.',
  inputSchema: z.object({}),
  annotations: readonly
}, async () => result(await agentsObserve()));

server.registerTool('observe_live_state', {
  description: 'Operational sections of LIVE-STATE (CI failures, agent configuration health, unpublished Git work), with freshness. Other sections are withheld. Read-only.',
  inputSchema: z.object({}),
  annotations: readonly
}, async () => result(await liveState()));

server.registerTool('observe_focus', {
  description: 'Active Stasis focus (project, bet, kill criterion, review due) or the last closed bet. Read-only; Stasis decides, Memo Bridge only reports.',
  inputSchema: z.object({}),
  annotations: readonly
}, async () => result(await focusStatus()));

// Phase 2 and 3 modules. Each one calls getRuntime() lazily, so the read-only tools above keep
// working when the private state directory is unavailable.
registerCoordinatorTools(server, getRuntime);
registerWorktreeTools(server, getRuntime);
registerJobTools(server, getRuntime);
registerHostTools(server, getRuntime);
registerGithubTools(server, getRuntime);
registerAuditTools(server, getRuntime);
registerMemoryTools(server, getRuntime);

await server.connect(new StdioServerTransport());
