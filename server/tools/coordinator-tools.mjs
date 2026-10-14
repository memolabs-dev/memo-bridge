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
import { HANDOFF_LIMITS } from '../coordinator/handoff.mjs';

export const COORDINATOR_TOOLS = Object.freeze(['workspace_open', 'workspace_status', 'workspace_list', 'workspace_close',
  'workspace_recover', 'tasks_list', 'task_status', 'task_claim', 'task_renew', 'task_release', 'task_complete',
  'task_checkpoint', 'batch_create', 'task_next', 'batch_status', 'sessions_overview']);

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

  // Structured handoff (#39): bounded lists, checked for secrets and injection, read back by
  // workspace_recover, task_status and the task_next brief of whichever conversation picks the task up.
  const item = z.string().max(HANDOFF_LIMITS.item);
  const items = z.array(item).max(HANDOFF_LIMITS.items);
  const handoff = z.object({
    goal: z.string().max(HANDOFF_LIMITS.goal).optional().describe('What the task is for, one line.'),
    constraints: items.optional().describe('Constraints and owner preferences that hold for this task.'),
    done: items.optional(), in_progress: items.optional(), blocked: items.optional().describe('What blocks, and on whom.'),
    decisions: items.optional().describe('Decisions taken, with the reason.'),
    files: z.array(z.string().max(HANDOFF_LIMITS.file)).max(HANDOFF_LIMITS.files).optional().describe('Paths that matter.'),
    next_steps: items.optional().describe('What the next conversation does first.')
  }).describe(`Where the task stands, for the conversation that picks it up: one line per item, ${HANDOFF_LIMITS.total} characters in all, no secrets.`);

  server.registerTool('task_checkpoint', {
    description: 'Record a durable checkpoint (branch + full commit SHA) and/or a structured handoff (goal, constraints, done, in_progress, blocked, decisions, files, next_steps) under a claim you hold. The ledger re-verifies the claim first; the commit is checked read-only in the project repository and reported as remote (resumable on another machine), local_only, or unverified. With a handoff, branch and commit are optional. Record a handoff before you stop, lose context or hand the task over. Uncommitted files are never transferred.',
    inputSchema: z.object({ workspace_id: workspaceId, issue, claim_id: claimId, fence,
      branch: z.string().max(200).optional().describe('Required with commit; optional when you only record a handoff.'),
      commit: z.string().max(64).optional(), note: z.string().max(500).optional().describe('Free text, with a commit only.'),
      handoff: handoff.optional() }),
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
    description: 'Take the next task nobody holds and claim it for your workspace through the lease ledger. Without batch: the agent:ready backlog of every allowed project (or of project), p0 first, then oldest; if the task is in another project, your workspace moves there (only while it holds no task and no worktree). With batch: the next task of that batch, in the workspace project. If another conversation wins a task first, the next one is tried. Returns the task (Issue, title, scope, acceptance), claim_id, fence, expiry, the steps, and brief: your task, the other conversations on the project and the rules. A workspace that already holds a task gets it back (already_held). {done:true} when nothing is left. The only way to take work besides task_claim on an Issue the owner named.',
    inputSchema: z.object({ workspace_id: workspaceId, batch: batchId.optional(),
      project: z.string().max(80).optional().describe('Without batch: only this project (projects_list).'),
      ttl_seconds: ttl, client_request_id: clientRequestId }),
    annotations: { ...write, idempotentHint: true }
  }, call('taskNext'));

  server.registerTool('sessions_overview', {
    description: 'Call at the start of every conversation and before taking work. Lists every active workspace of this owner across all conversations (at most 20, newest first): workspace id, client, session tag (a short label of the conversation, you: true for yours), project, held task and its lease (held or expired, local view), last activity, and the operator locks each one holds. Read-only and cheap.',
    inputSchema: z.object({ workspace_id: workspaceId.optional().describe('Your workspace, to mark it as you when the conversation has no session tag.') }),
    annotations: { ...read, openWorldHint: false }
  }, call('sessionsOverview'));

  server.registerTool('batch_status', {
    description: 'Progress of a batch: for each task its state (ready, claimed, stale, blocked, done, closed, not_ready, unknown), who holds it (worker, workspace, client) and until when, linked pull requests, then counts per state and the stale leases (claimed but expired). Read-only for Memo Bridge; when the GitHub Projects view is on (MEMO_BRIDGE_PROJECT), also returns project_url and shows stale tasks as Prêt there.',
    inputSchema: z.object({
      project: z.string().max(80).describe('Project the batch was created in.'),
      batch: batchId
    }),
    annotations: read
  }, call('batchStatus'));
}
