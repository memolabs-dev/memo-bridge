import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import { collectHost, listHosts } from './probe.mjs';
import { listProjects, projectInfo, projectGitStatus, auditProjectRegistry } from './catalog.mjs';
import { createCoordinator } from './coordinator/index.mjs';
import { createIssueLeaseClient } from './coordinator/issue-lease.mjs';
import { localOwnerPrincipal } from './coordinator/policy.mjs';
import { openSqliteStore } from './coordinator/store.mjs';
import { COORDINATOR_TOOLS, registerCoordinatorTools } from './tools/coordinator-tools.mjs';
import { agentsObserve, focusStatus, guardianReport, liveState } from './observers.mjs';

const OBSERVER_TOOLS = ['observe_guardian', 'observe_agents', 'observe_live_state', 'observe_focus'];

const VERSION = '0.3.0';

const server = new McpServer({
  name: 'memo-bridge',
  version: VERSION
}, {
  instructions: 'Memo Bridge observes registered local projects, the Mac running this plugin, and a VPS reachable via SSH alias lab, and coordinates work between AI sessions. Open one workspace per session with workspace_open and pass its id explicitly. Work items are GitHub Issues: claim one with issue_claim before working on it, keep the returned claim_id and latest fence, renew with issue_heartbeat, record pushed commits with issue_checkpoint so another machine can resume, then issue_release. Stop writing as soon as a call returns stale_lease. Memo Bridge cannot run arbitrary commands, read arbitrary files, write project files, change services, merge, or deploy.'
});

const principal = localOwnerPrincipal();
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
}, async () => result({
  version: VERSION,
  mode: 'observe+coordinate',
  transport: 'stdio',
  hosts: ['mac', 'vps'],
  vps_connection: 'SSH through the Mac; no incoming connection to the Mac',
  allowed_tools: ['list_hosts', 'host_status', 'bridge_info', 'projects_list', 'project_info', 'project_git_status', 'projects_audit',
    ...OBSERVER_TOOLS, ...COORDINATOR_TOOLS],
  observation: 'host_status checks reachability only; health comes from the existing observers (observe_*), never from new probes',
  coordinator: {
    principal: principal.id,
    work_items: 'GitHub Issues',
    leases: 'Git-ref ledger in memolabs-dev/.github (scripts/issue_lease.py), shared by every machine',
    local_state: 'private SQLite store (workspaces, claim mirror, checkpoints, audit), outside repositories and iCloud'
  },
  excluded: ['arbitrary-shell', 'project-file-writes', 'service-changes', 'merge', 'deployment'],
  next: 'Hub exposure of these tools once the root CI runners are isolated; Mac and VPS runners.'
}));


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

let coordinator;
registerCoordinatorTools(server, () => {
  coordinator ??= createCoordinator({ store: openSqliteStore(), principal, ledger: createIssueLeaseClient() });
  return coordinator;
});

await server.connect(new StdioServerTransport());
