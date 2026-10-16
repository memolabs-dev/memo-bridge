// Standalone local-only MCP: an independent user's device, not the Memo Labs owner runtime.
// Deliberately no imported hub, coordinator, GitHub integration, operators or job runner.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { createLocalProjectService, loadStandaloneConfig, standalonePaths } from './config.mjs';
import { probeGpus } from '../server/runners/gpu-inventory.mjs';

export const STANDALONE_TOOLS = Object.freeze([
  'bridge_info', 'host_capabilities', 'gpu_inventory', 'projects_list', 'project_inspect'
]);
const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const trim = x => String(x).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/g, '').slice(0, 48);

export function createStandaloneServer({ config, gpuProbe = probeGpus, system = {
  platform, arch, release, cpus, totalmem
}, projectService = createLocalProjectService(config) } = {}) {
  if (!config || !Array.isArray(config.projects)) throw new Error('config_required');
  const server = new McpServer({ name: 'memo-bridge-standalone', version: '0.1.0' }, {
    instructions: 'This is an independent local, read-only MCP server owned by the OS user who started it. ' +
      'It can report host capabilities, local GPUs and explicitly registered projects. ' +
      'No arbitrary commands, file contents, GitHub access, remote endpoints, enrollment or GPU jobs are provided. ' +
      'A detected GPU does not imply CUDA/DirectML/Vulkan/ROCm compatibility.'
  });
  server.registerTool('bridge_info', {
    description: 'Read-only independent local MCP capabilities and safety limits. Never lists owner or remote systems.',
    inputSchema: z.object({}), annotations: readonly
  }, async () => result({
    mode: 'standalone-readonly',
    transport: 'stdio',
    local_only: true,
    shared_owner_hub: false,
    tools: [...STANDALONE_TOOLS],
    writes_supported: false,
    jobs_supported: false,
    remote_control_supported: false
  }));
  server.registerTool('host_capabilities', {
    description: 'Read-only local OS, architecture, CPU count, system memory. No hostname, username or credentials.',
    inputSchema: z.object({}), annotations: readonly
  }, async () => result({
    source: 'observed', os: trim(system.platform()), architecture: trim(system.arch()),
    release: trim(system.release()),
    cpu_count: Array.isArray(system.cpus()) ? Math.min(system.cpus().length, 4096) : null,
    memory_total_mib: Math.floor(system.totalmem() / (1024 * 1024))
  }));
  server.registerTool('gpu_inventory', {
    description: 'Read-only GPU inventory for the current device. Vendor-agnostic: AMD, Intel, NVIDIA or unknown. ' +
      'Hardware detection does not promise compute support. No GPU workloads are executed.',
    inputSchema: z.object({}), annotations: readonly
  }, async () => {
    try { return result(await gpuProbe()); }
    catch { return result({ source: 'observed', status: 'unknown', reason: 'probe_failed', gpus: [] }); }
  });
  server.registerTool('projects_list', {
    description: 'Names of projects explicitly configured by this OS user. No path enumeration or automatic discovery.',
    inputSchema: z.object({}), annotations: readonly
  }, async () => result(projectService.list()));
  server.registerTool('project_inspect', {
    description: 'Read-only existence and Git marker for one explicitly configured project. No file contents or path output.',
    inputSchema: z.object({ project: z.string().min(1).max(80) }), annotations: readonly
  }, async ({ project }) => result(await projectService.inspect(project)));
  return server;
}

export async function startStandalone({ configPath = standalonePaths().config, transport = null } = {}) {
  const config = await loadStandaloneConfig(configPath);
  const server = createStandaloneServer({ config });
  await server.connect(transport ?? new StdioServerTransport());
  return server;
}
