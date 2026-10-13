import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import { collectHost, listHosts } from './probe.mjs';
import { listProjects, projectInfo, projectGitStatus, auditProjectRegistry } from './catalog.mjs';

const server = new McpServer({
  name: 'memo-bridge',
  version: '0.1.0'
}, {
  instructions: 'Memo Bridge operates in observation-only mode. It can inspect registered local projects, the Mac running this plugin, and a VPS reachable via SSH alias lab. It cannot run arbitrary commands, read arbitrary files, change services, deploy, or modify projects.'
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
}, async () => result({
  version: '0.1.0',
  mode: 'read-only',
  transport: 'stdio',
  hosts: ['mac', 'vps'],
  vps_connection: 'SSH through the Mac; no incoming connection to the Mac',
  allowed_tools: ['list_hosts', 'host_status', 'bridge_info', 'projects_list', 'project_info', 'project_git_status', 'projects_audit'],
  excluded: ['arbitrary-shell', 'file-writes', 'service-changes', 'deployment', 'github-actions'],
  next: 'Separate always-on HTTPS hub on VPS with OAuth; dedicated outbound agents; GitHub adapter.'
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

await server.connect(new StdioServerTransport());
