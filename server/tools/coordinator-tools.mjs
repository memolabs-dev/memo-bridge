// Coordinator MCP tools. Shared by every Memo Bridge entry point (local stdio today, the
// authenticated hub later), so all clients see the same contract. The entry point decides
// the principal; tool arguments never carry identity or permissions.
import { z } from 'zod/v4';
import { CLIENT_TYPES, HOSTS, TASK_STATUSES } from '../coordinator/index.mjs';
import { TTL_DEFAULT_SECONDS, TTL_MAX_SECONDS, TTL_MIN_SECONDS } from '../coordinator/leases.mjs';

export const COORDINATOR_TOOLS = Object.freeze(['workspace_open', 'workspace_status', 'workspace_list', 'workspace_close',
  'tasks_list', 'task_create', 'task_status', 'task_claim', 'task_renew', 'task_release', 'task_checkpoint',
  'task_complete', 'coordinator_events']);

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

const workspaceId = z.string().max(40).describe('Workspace id returned by workspace_open (ws_…).');
const taskId = z.string().max(40).describe('Task id returned by task_create (task_…).');
const project = z.string().max(80).describe('Project name from projects_list (canonical PROJECTS.md).');
const fencingToken = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
  .describe('Fencing token returned by task_claim. Writes with an outdated token are refused.');
const ttl = z.number().int().min(TTL_MIN_SECONDS).max(TTL_MAX_SECONDS).optional()
  .describe(`Lease duration in seconds (default ${TTL_DEFAULT_SECONDS}).`);

// getCoordinator() opens storage lazily so the read-only tools keep working when the
// private state directory is unavailable.
export function registerCoordinatorTools(server, getCoordinator) {
  const call = method => async args => {
    let coordinator;
    try { coordinator = await getCoordinator(); } catch (error) {
      return result({ ok: false, error: 'store_unavailable', detail: String(error?.message ?? 'unknown').slice(0, 80) });
    }
    return result(await coordinator[method](args ?? {}));
  };

  server.registerTool('workspace_open', {
    description: 'Open a work context for one project. Each conversation or session should open its own workspace and pass its id explicitly to later calls. Writes only to the private Coordinator store.',
    inputSchema: z.object({
      project,
      client_type: z.enum(CLIENT_TYPES).optional(),
      client_label: z.string().max(80).optional().describe('Free label to recognise this session, e.g. "Drop UI".'),
      host: z.enum(HOSTS).optional().describe('Machine this workspace works on; defaults to the machine running Memo Bridge.'),
      branch: z.string().max(200).optional()
    }),
    annotations: write
  }, call('workspaceOpen'));

  server.registerTool('workspace_status', {
    description: 'Show a workspace you own and the task leases it currently holds.',
    inputSchema: z.object({ workspace_id: workspaceId }),
    annotations: read
  }, call('workspaceStatus'));

  server.registerTool('workspace_list', {
    description: 'List your workspaces, newest first.',
    inputSchema: z.object({ status: z.enum(['active', 'closed']).optional(), limit: z.number().int().min(1).max(200).optional() }),
    annotations: read
  }, call('workspaceList'));

  server.registerTool('workspace_close', {
    description: 'Close a workspace you own and release every lease it holds. Idempotent.',
    inputSchema: z.object({ workspace_id: workspaceId }),
    annotations: { ...write, idempotentHint: true }
  }, call('workspaceClose'));

  server.registerTool('tasks_list', {
    description: 'List coordinated tasks, optionally by project and status (open, claimed, completed).',
    inputSchema: z.object({ project: project.optional(), status: z.enum(TASK_STATUSES).optional(),
      limit: z.number().int().min(1).max(200).optional() }),
    annotations: read
  }, call('tasksList'));

  server.registerTool('task_create', {
    description: 'Register a task for a project, optionally linked to a GitHub issue (owner/repo#123).',
    inputSchema: z.object({ project, title: z.string().min(1).max(200),
      issue_ref: z.string().max(160).optional().describe('GitHub reference, e.g. memolabs-dev/drop#84.') }),
    annotations: write
  }, call('taskCreate'));

  server.registerTool('task_status', {
    description: 'Show a task, its current lease and its latest checkpoints.',
    inputSchema: z.object({ task_id: taskId }),
    annotations: read
  }, call('taskStatus'));

  server.registerTool('task_claim', {
    description: 'Reserve a task for a workspace of the same project. Exactly one workspace can hold a task; the returned fencing_token must accompany every later write on it.',
    inputSchema: z.object({ workspace_id: workspaceId, task_id: taskId, ttl_seconds: ttl }),
    annotations: write
  }, call('taskClaim'));

  server.registerTool('task_renew', {
    description: 'Extend a lease you still hold. Fails with stale_lease once it has expired or been taken over.',
    inputSchema: z.object({ workspace_id: workspaceId, task_id: taskId, fencing_token: fencingToken, ttl_seconds: ttl }),
    annotations: write
  }, call('taskRenew'));

  server.registerTool('task_release', {
    description: 'Give a task back without completing it.',
    inputSchema: z.object({ workspace_id: workspaceId, task_id: taskId, fencing_token: fencingToken }),
    annotations: write
  }, call('taskRelease'));

  server.registerTool('task_checkpoint', {
    description: 'Record a durable checkpoint (branch + full commit SHA). Memo Bridge verifies the commit read-only in the project repository and reports durability: remote (resumable elsewhere), local_only, or unverified. Uncommitted files are never transferred.',
    inputSchema: z.object({ workspace_id: workspaceId, task_id: taskId, fencing_token: fencingToken,
      branch: z.string().max(200), commit: z.string().max(64), note: z.string().max(500).optional() }),
    annotations: write
  }, call('taskCheckpoint'));

  server.registerTool('task_complete', {
    description: 'Mark a task you hold as completed with an optional summary. A completed task cannot be claimed again.',
    inputSchema: z.object({ workspace_id: workspaceId, task_id: taskId, fencing_token: fencingToken,
      summary: z.string().max(2000).optional() }),
    annotations: write
  }, call('taskComplete'));

  server.registerTool('coordinator_events', {
    description: 'Read the Coordinator audit journal (newest first), optionally for one task or workspace.',
    inputSchema: z.object({ task_id: taskId.optional(), workspace_id: workspaceId.optional(),
      limit: z.number().int().min(1).max(200).optional() }),
    annotations: read
  }, call('events'));
}
