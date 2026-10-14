// Coordinator MCP tools. Shared by every Memo Bridge entry point (local stdio today, the
// authenticated hub later), so all clients see the same contract. The entry point decides
// the principal; tool arguments never carry identity or permissions.
//
// A task is a GitHub Issue. Tools say "task"; the argument stays `issue`, written owner/repo#n.
// Authorization and the audit journal are applied inside the coordinator API, before any
// argument is looked at (server/coordinator/index.mjs).
import { z } from 'zod/v4';
import { CLIENT_TYPES, HOSTS, SUMMARY_MAX, TASKS_LIMIT } from '../coordinator/index.mjs';
import { LEASE_TTL, OUTCOMES } from '../coordinator/issue-lease.mjs';
import { CLIENT_REQUEST_ID_RE } from '../coordinator/store.mjs';
import { BATCH_MAX, BATCH_PRIORITIES, TASK_TEXT } from '../coordinator/batches.mjs';

export const COORDINATOR_TOOLS = Object.freeze(['workspace_open', 'workspace_status', 'workspace_list', 'workspace_close',
  'workspace_recover', 'tasks_list', 'task_status', 'task_claim', 'task_renew', 'task_release', 'task_complete',
  'task_checkpoint', 'batch_create', 'task_next', 'batch_status']);

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

const workspaceId = z.string().max(40).describe('Workspace id returned by workspace_open (ws_…).');
const issue = z.string().max(160).describe('The task: a GitHub Issue reference, owner/repo#n, e.g. memolabs-dev/cuesheet#42.');
const claimId = z.string().max(32).describe('claim_id returned by task_claim.');
const fence = z.string().max(40).describe('Latest fence returned by task_claim or task_renew. Writes with an outdated fence are refused.');
const batchId = z.string().max(20).describe('Batch id returned by batch_create (10 hexadecimal characters).');
const clientRequestId = z.string().regex(CLIENT_REQUEST_ID_RE).optional()
  .describe('Your own id for this call (8 to 128 of A-Z a-z 0-9 _ -). A retry with the same id returns the first result instead of acting again.');
const ttl = z.number().int().min(LEASE_TTL.min).max(LEASE_TTL.max).optional()
  .describe(`Lease duration in seconds (default ${LEASE_TTL.default}). Renew with task_renew before it expires.`);

// getService() returns either the shared runtime (server/runtime.mjs, whose coordinator() is
// opened lazily) or a coordinator directly. Storage opens lazily so the read-only tools of
// other modules keep working when the private state directory is unavailable.
export function registerCoordinatorTools(server, getService) {
  // extra.meta is the hub's per-request metadata (request id, session hash) when the runtime
  // serves a forwarded call (bridge/agent.mjs); stdio calls have none. Never tool arguments.
  const call = method => async (args, extra) => {
    let coordinator;
    try {
      const service = await getService();
      coordinator = typeof service?.coordinator === 'function' ? service.coordinator() : service;
    } catch (error) {
      // Only our own short codes reach the model; filesystem paths and engine messages do not.
      const code = String(error?.message ?? '');
      return result({ ok: false, error: 'store_unavailable', ...(/^state_[a-z_]{1,40}$/.test(code) ? { detail: code } : {}) });
    }
    return result(await coordinator[method](args ?? {}, extra?.meta ?? null));
  };

  server.registerTool('workspace_open', {
    description: 'Open a work context for one project. Each conversation or session opens its own workspace and passes its id explicitly to later calls. Writes only to the private local store.',
    inputSchema: z.object({
      project: z.string().max(80).describe('Project name from projects_list (canonical PROJECTS.md).'),
      client_type: z.enum(CLIENT_TYPES).optional(),
      client_label: z.string().max(80).optional().describe('Free label to recognise this session, e.g. "Drop UI".'),
      host: z.enum(HOSTS).optional().describe('Machine this workspace works on; defaults to the machine running Memo Bridge.'),
      branch: z.string().max(200).optional()
    }),
    annotations: { ...write, openWorldHint: false }
  }, call('workspaceOpen'));

  server.registerTool('workspace_status', {
    description: 'Show a workspace you own, its worker identity and the task claims its local mirror records as held. Use task_status or workspace_recover for the shared ledger view.',
    inputSchema: z.object({ workspace_id: workspaceId }),
    annotations: { ...read, openWorldHint: false }
  }, call('workspaceStatus'));

  server.registerTool('workspace_list', {
    description: 'List your workspaces, newest first.',
    inputSchema: z.object({ status: z.enum(['active', 'closed']).optional(), limit: z.number().int().min(1).max(200).optional() }),
    annotations: { ...read, openWorldHint: false }
  }, call('workspaceList'));

  server.registerTool('workspace_close', {
    description: 'Close a workspace you own and release its task claims (outcome cancelled). Safe to repeat: claims the ledger could not release yet are listed as unreleased and retried on the next call.',
    inputSchema: z.object({ workspace_id: workspaceId }),
    annotations: { ...write, idempotentHint: true }
  }, call('workspaceClose'));

  server.registerTool('workspace_recover', {
    description: 'Resume a workspace after losing context. Snapshot: the workspace, each held claim reconciled with the shared ledger (still_held with the current fence, expired, lost or unknown), active worktrees, the last 10 checkpoints of its tasks, recent jobs, and the next safe actions. Changes no task, file or branch; for a remote conversation it binds the workspace to the recovering conversation, and that rebind is journaled.',
    inputSchema: z.object({ workspace_id: workspaceId }),
    annotations: read
  }, call('workspaceRecover'));

  server.registerTool('tasks_list', {
    description: 'List claimable tasks: open GitHub Issues labelled agent:ready with exactly one priority:p0|p1|p2 and none of status:blocked, needs:human, type:epic, agent:working. Only repositories that are the GitHub origin of a registered project and in the lease ledger allowlist. Ranked p0, p1, p2, then oldest first. Lease state is not included: task_claim and task_status are authoritative.',
    inputSchema: z.object({
      project: z.string().max(80).optional().describe('Restrict to one registered project (projects_list).'),
      limit: z.number().int().min(1).max(TASKS_LIMIT.max).optional().describe(`At most this many tasks (default ${TASKS_LIMIT.default}).`)
    }),
    annotations: read
  }, call('tasksList'));

  server.registerTool('task_status', {
    description: 'Show the shared lease state of a task (claimed or not, by which worker, until when, current fence) and its recorded checkpoints.',
    inputSchema: z.object({ issue }),
    annotations: read
  }, call('taskStatus'));

  server.registerTool('task_claim', {
    description: 'Reserve a task for a workspace through the Memo Labs lease ledger (a Git ref in memolabs-dev/.github, visible to every machine). The Issue must be open and labelled agent:ready with one priority label, and it must belong to the workspace project when the project Git origin is known. Exactly one worker can hold it.',
    inputSchema: z.object({ workspace_id: workspaceId, issue, ttl_seconds: ttl,
      client_request_id: z.string().regex(CLIENT_REQUEST_ID_RE).optional()
        .describe('Your own id for this claim attempt (8 to 128 of A-Z a-z 0-9 _ -). A retry with the same id returns the first result instead of claiming again.') }),
    annotations: write
  }, call('taskClaim'));

  server.registerTool('task_renew', {
    description: 'Extend a claim you hold. Returns a new fence; use it for every later call. Fails with stale_lease once the claim expired or was taken over: stop writing then.',
    inputSchema: z.object({ workspace_id: workspaceId, issue, claim_id: claimId, fence, ttl_seconds: ttl }),
    annotations: write
  }, call('taskRenew'));

  server.registerTool('task_release', {
    description: 'Release a claim with an outcome (completed, blocked, failed, cancelled), also from a closed workspace. Never closes the Issue, never merges, never deploys.',
    inputSchema: z.object({ workspace_id: workspaceId, issue, claim_id: claimId, fence, outcome: z.enum(OUTCOMES) }),
    annotations: write
  }, call('taskRelease'));

  server.registerTool('task_complete', {
    description: 'Release a claim with outcome completed and an optional summary of what was done, kept with the claim. Same rules as task_release: never closes the Issue, never merges, never deploys.',
    inputSchema: z.object({ workspace_id: workspaceId, issue, claim_id: claimId, fence,
      summary: z.string().max(SUMMARY_MAX).optional().describe('What was done, for the next session and the audit (plain text).') }),
    annotations: write
  }, call('taskComplete'));

  server.registerTool('task_checkpoint', {
    description: 'Record a durable checkpoint (branch + full commit SHA) under a claim you hold. The ledger re-verifies the claim first; the commit is checked read-only in the project repository and reported as remote (resumable on another machine), local_only, or unverified. Uncommitted files are never transferred.',
    inputSchema: z.object({ workspace_id: workspaceId, issue, claim_id: claimId, fence,
      branch: z.string().max(200), commit: z.string().max(64), note: z.string().max(500).optional() }),
    annotations: write
  }, call('taskCheckpoint'));

  // Conductor workflow (TODO-P5-50 to 52): one conversation splits the work with batch_create,
  // the owner opens one conversation per task and pastes the same sentence in each, each one
  // takes a different task with task_next, and the conductor follows with batch_status.
  server.registerTool('batch_create', {
    description: `Split work into a batch of 1 to ${BATCH_MAX} tasks: creates one GitHub Issue per task in the project repository, labelled agent:ready, priority:<p> and agent:batch-<id>, with its scope and acceptance criteria in the body. Returns the batch id and the one sentence the owner pastes in each worker conversation. Creates Issues only: never claims, assigns, merges or deploys. On a partial failure it reports what was created.`,
    inputSchema: z.object({
      project: z.string().max(80).describe('Project name from projects_list; its GitHub origin must be in the lease ledger allowlist.'),
      name: z.string().max(TASK_TEXT.label).optional().describe('Short name of the batch, shown in each Issue.'),
      tasks: z.array(z.object({
        title: z.string().max(TASK_TEXT.title).describe('Issue title, one line.'),
        scope: z.string().max(TASK_TEXT.scope).describe('What to change and where, and what is out of scope.'),
        acceptance: z.string().max(TASK_TEXT.acceptance).describe('Checkable acceptance criteria.'),
        priority: z.enum(BATCH_PRIORITIES).optional().describe('Default p1. p0 tasks are taken first.')
      })).min(1).max(BATCH_MAX),
      client_request_id: clientRequestId
    }),
    annotations: write
  }, call('batchCreate'));

  server.registerTool('task_next', {
    description: 'Take the next task of a batch: claims, through the lease ledger, the first ready task of the batch that nobody holds, for your workspace (opened with workspace_open on the batch project). If another conversation wins a task first, the next one is tried. Returns the task (Issue, title, scope, acceptance), claim_id, fence, expiry and the steps to follow; a workspace that already holds a task of the batch gets that task back. {done:true} when no task is left.',
    inputSchema: z.object({ workspace_id: workspaceId, batch: batchId, ttl_seconds: ttl, client_request_id: clientRequestId }),
    annotations: { ...write, idempotentHint: true }
  }, call('taskNext'));

  server.registerTool('batch_status', {
    description: 'Progress of a batch: for each task its state (ready, claimed, stale, blocked, done, closed, not_ready, unknown), who holds it (worker, workspace, client) and until when, linked pull requests, then counts per state and the stale leases (claimed but expired). Read-only for Memo Bridge; when the GitHub Projects view is on (MEMO_BRIDGE_PROJECT), also returns project_url and shows stale tasks as Prêt there.',
    inputSchema: z.object({
      project: z.string().max(80).describe('Project the batch was created in.'),
      batch: batchId
    }),
    annotations: read
  }, call('batchStatus'));
}
