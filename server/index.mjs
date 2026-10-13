import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import { collectHost, listHosts } from './probe.mjs';

const server = new McpServer({
  name: 'memo-bridge',
  version: '0.1.0'
}, {
  instructions: 'Memo Bridge operates in observation-only mode. It can inspect the Mac running this plugin and a VPS reachable via SSH alias lab. It cannot run arbitrary commands, read arbitrary files, change services, deploy, or modify projects.'
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
  allowed_tools: ['list_hosts', 'host_status', 'bridge_info'],
  excluded: ['arbitrary-shell', 'file-writes', 'service-changes', 'deployment', 'github-actions'],
  next: 'Separate always-on HTTPS hub on VPS with OAuth; dedicated outbound agents; GitHub adapter.'
}));

await server.connect(new StdioServerTransport());
