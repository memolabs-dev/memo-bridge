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
import { DELEGATION_LIMITS, DELEGATION_TTL, SCOPE_MODES } from '../coordinator/delegation.mjs';

export const COORDINATOR_TOOLS = Object.freeze(['workspace_open', 'workspace_status', 'workspace_list', 'workspace_close',
  'workspace_recover', 'tasks_list', 'task_status', 'task_claim', 'task_renew', 'task_release', 'task_complete',
  'task_checkpoint', 'batch_create', 'task_next', 'batch_status', 'sessions_overview',
  'workspace_delegate', 'delegation_join', 'delegation_status', 'delegation_report', 'delegation_end']);

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

const workspaceId = z.string().max(40).describe('Workspace id returned by workspace_open (ws_…).');
const issue = z.string().max(160).describe('GitHub Issue, owner/repo#n, e.g. "memolabs-dev/stasis#12".');
const claimId = z.string().max(32).describe('claim_id from task_claim or task_next.');
const fence = z.string().max(40).describe('Latest fence from task_claim, task_next or task_renew.');
const batchId = z.string().max(20).describe('Batch id from batch_create or the pasted sentence, e.g. "3fa9c1d2e4".');
const clientRequestId = z.string().regex(CLIENT_REQUEST_ID_RE).optional()
  .describe('Optional retry key (8 to 128 of A-Z a-z 0-9 _ -): a retry with the same key returns the first result.');
const ttl = z.number().int().min(LEASE_TTL.min).max(LEASE_TTL.max).optional()
  .describe(`Lease seconds, default ${LEASE_TTL.default}.`);

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
    description: 'Use this only when the owner wants to start on a project before any task, or on a given host («ouvre stasis sur le Mac»): task_claim and task_next open this conversation\'s workspace themselves. Returns workspace_id and memory_snapshot.',
    inputSchema: z.object({
      project: z.string().max(80).describe('Project name from projects_list, e.g. "stasis".'),
      client_type: z.enum(CLIENT_TYPES).optional().describe('Ignored remotely: the server sets it.'),
      client_label: z.string().max(80).optional().describe('Free label, e.g. "login fix".'),
      host: z.enum(HOSTS).optional().describe('"mac" or "vps"; default: the machine running Memo Bridge.'),
      branch: z.string().max(200).optional().describe('Branch to record, e.g. "feat/login".')
    }),
    annotations: { ...write, openWorldHint: false }
  }, call('workspaceOpen'));

  server.registerTool('workspace_status', {
    description: 'Use this when the owner asks what this conversation holds («où en est-on ?»): workspace, worker identity, held claims (local view; ledger view: task_status). Read-only.',
    inputSchema: z.object({ workspace_id: workspaceId }),
    annotations: { ...read, openWorldHint: false }
  }, call('workspaceStatus'));

  server.registerTool('workspace_list', {
    description: 'Use this when the owner asks for his work contexts, open or closed, newest first. Other live conversations: sessions_overview. Read-only.',
    inputSchema: z.object({ status: z.enum(['active', 'closed']).optional().describe('"active" or "closed"; omit for both.'),
      limit: z.number().int().min(1).max(200).optional().describe('At most 200, e.g. 10.') }),
    annotations: { ...read, openWorldHint: false }
  }, call('workspaceList'));

  server.registerTool('workspace_close', {
    description: 'Use this when the owner says the work of this conversation is over or dropped («on arrête là»): closes its workspace, releasing claims as cancelled. Safe to repeat.',
    inputSchema: z.object({ workspace_id: workspaceId }),
    annotations: { ...write, idempotentHint: true }
  }, call('workspaceClose'));

  server.registerTool('workspace_recover', {
    description: 'Use this when you lost track mid-task («reprends où on en était»): held claims checked against the ledger, worktrees, last checkpoints and handoff, recent jobs, next safe actions. Changes no file or branch; rebinds the workspace to this conversation, journaled.',
    inputSchema: z.object({ workspace_id: workspaceId }),
    annotations: read
  }, call('workspaceRecover'));

  server.registerTool('tasks_list', {
    description: 'Use this when the owner asks what there is to do («qu\'est-ce qu\'il reste à faire sur stasis ?», "show the backlog"): open agent:ready Issues with one priority, ranked p0, p1, p2, oldest first, for one project or all allowed ones. Do not use to take one (task_next, task_claim). Read-only.',
    inputSchema: z.object({
      project: z.string().max(80).optional().describe('One project from projects_list, e.g. "cuesheet"; omit for every allowed one.'),
      limit: z.number().int().min(1).max(TASKS_LIMIT.max).optional().describe(`At most this many (default ${TASKS_LIMIT.default}).`)
    }),
    annotations: read
  }, call('tasksList'));

  server.registerTool('task_status', {
    description: 'Use this when the owner asks whether an Issue is free or who works on it: lease holder, expiry, fence, checkpoints. Read-only.',
    inputSchema: z.object({ issue }),
    annotations: read
  }, call('taskStatus'));

  server.registerTool('task_claim', {
    description: 'Use this when the owner names an Issue to work on («travaille sur l\'issue 12 de stasis», «corrige memolabs-dev/kollio-mac#4»): reserves it through the lease ledger, one holder at a time, opening this conversation\'s workspace if needed. Next: worktree_create with the issue. The Issue must be open, agent:ready, with one priority:p0|p1|p2; otherwise create the task with batch_create. Not for unnamed work (task_next).',
    inputSchema: z.object({ workspace_id: workspaceId, issue, ttl_seconds: ttl,
      client_request_id: clientRequestId }),
    annotations: write
  }, call('taskClaim'));

  server.registerTool('task_renew', {
    description: 'Use this before a lease expires during long work: returns a new fence for every later call. On stale_lease stop writing and tell the owner.',
    inputSchema: z.object({ workspace_id: workspaceId, issue, claim_id: claimId, fence, ttl_seconds: ttl }),
    annotations: write
  }, call('taskRenew'));

  server.registerTool('task_release', {
    description: 'Use this when you stop a task without finishing it (outcome blocked, failed or cancelled). Never closes the Issue, merges or deploys.',
    inputSchema: z.object({ workspace_id: workspaceId, issue, claim_id: claimId, fence,
      outcome: z.enum(OUTCOMES).describe('blocked, failed or cancelled; completed is task_complete.') }),
    annotations: write
  }, call('taskRelease'));

  server.registerTool('task_complete', {
    description: 'Use this right after github_create_pr succeeded: releases the claim as completed, with a summary. Never closes the Issue, merges or deploys: Mergify lands green PRs.',
    inputSchema: z.object({ workspace_id: workspaceId, issue, claim_id: claimId, fence,
      summary: z.string().max(SUMMARY_MAX).optional().describe('What was done, plain text, e.g. "Fixed expired-token login, PR #31".') }),
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
    description: 'Use this before you stop, lose context or hand a task over: records a handoff (goal, done, next_steps...) and/or a pushed commit so another conversation can resume. worktree_push already records its commit.',
    inputSchema: z.object({ workspace_id: workspaceId, issue, claim_id: claimId, fence,
      branch: z.string().max(200).optional().describe('Required with commit, e.g. "agent/12-a1b2".'),
      commit: z.string().max(64).optional().describe('Full 40-character commit SHA.'), note: z.string().max(500).optional().describe('Free text, with a commit only.'),
      handoff: handoff.optional() }),
    annotations: write
  }, call('taskCheckpoint'));

  // Conductor workflow (TODO-P5-50 to 52): one conversation splits the work with batch_create,
  // the owner opens one conversation per task and pastes the same sentence in each, each one
  // takes a different task with task_next, and the conductor follows with batch_status.
  server.registerTool('batch_create', {
    description: `Use this when the owner asks for a change that has no Issue yet («corrige le bug de login dans kollio-mac», «ajoute un export CSV à stasis»): creates 1 to ${BATCH_MAX} agent:ready Issues with scope and acceptance, then claim yours with task_claim. Also to split work across conversations: returns the sentence to paste in each. Creates Issues only. Not when the owner named an existing Issue (task_claim).`,
    inputSchema: z.object({
      project: z.string().max(80).describe('Project from projects_list, e.g. "kollio-mac".'),
      name: z.string().max(TASK_TEXT.label).optional().describe('Short batch name, e.g. "login fix".'),
      tasks: z.array(z.object({
        title: z.string().max(TASK_TEXT.title).describe('One line, e.g. "Login fails with an expired token".'),
        scope: z.string().max(TASK_TEXT.scope).describe('What to change and where; what is out of scope.'),
        acceptance: z.string().max(TASK_TEXT.acceptance).describe('Checkable criteria, e.g. "an expired token shows the sign-in page".'),
        priority: z.enum(BATCH_PRIORITIES).optional().describe('Default p1; p0 is taken first.')
      })).min(1).max(BATCH_MAX).describe(`1 to ${BATCH_MAX} tasks; one for a single change.`),
      client_request_id: clientRequestId
    }),
    annotations: write
  }, call('batchCreate'));

  server.registerTool('task_next', {
    description: 'Use this when the owner asks for work without naming an Issue («prends la prochaine tâche», «avance sur le backlog de cuesheet») or pastes a batch sentence: claims the highest-priority free task (p0 first, then oldest) of a project, a batch or every allowed project, and returns its brief and steps. Already holding one: returns it. done: true when nothing is left.',
    inputSchema: z.object({ workspace_id: workspaceId, batch: batchId.optional(),
      project: z.string().max(80).optional().describe('Without batch: only this project, e.g. "cuesheet".'),
      ttl_seconds: ttl, client_request_id: clientRequestId }),
    annotations: { ...write, idempotentHint: true }
  }, call('taskNext'));

  server.registerTool('sessions_overview', {
    description: 'Use this when the owner asks what his other conversations are doing («qui bosse sur quoi ?») or before touching a project another one may hold: every active workspace (at most 20), its project, task, lease and operator locks; you: true marks this one. Read-only.',
    inputSchema: z.object({ workspace_id: workspaceId.optional().describe('Rarely needed: marks this workspace as you when the conversation has no session tag.') }),
    annotations: { ...read, openWorldHint: false }
  }, call('sessionsOverview'));

  server.registerTool('batch_status', {
    description: 'Use this when the owner asks how a batch is going («où en est le lot ?»): each task\'s state and holder, linked PRs, counts, stale leases. Read-only.',
    inputSchema: z.object({
      project: z.string().max(80).describe('Project of the batch, e.g. "cuesheet".'),
      batch: batchId
    }),
    annotations: read
  }, call('batchStatus'));

  // Delegation (#47): a conversation that holds a task hands part of it to a chat the owner opens
  // by hand. Memo Bridge never launches a chat and calls no model.
  const delegationId = z.string().max(20).describe('Delegation id from workspace_delegate (d_ and 12 hexadecimal characters).');
  const handoffShape = z.object({
    goal: z.string().max(HANDOFF_LIMITS.goal).optional(),
    constraints: z.array(z.string().max(HANDOFF_LIMITS.item)).max(HANDOFF_LIMITS.items).optional(),
    done: z.array(z.string().max(HANDOFF_LIMITS.item)).max(HANDOFF_LIMITS.items).optional(),
    in_progress: z.array(z.string().max(HANDOFF_LIMITS.item)).max(HANDOFF_LIMITS.items).optional(),
    blocked: z.array(z.string().max(HANDOFF_LIMITS.item)).max(HANDOFF_LIMITS.items).optional(),
    decisions: z.array(z.string().max(HANDOFF_LIMITS.item)).max(HANDOFF_LIMITS.items).optional(),
    files: z.array(z.string().max(HANDOFF_LIMITS.file)).max(HANDOFF_LIMITS.files).optional(),
    next_steps: z.array(z.string().max(HANDOFF_LIMITS.item)).max(HANDOFF_LIMITS.items).optional()
  });

  server.registerTool('workspace_delegate', {
    description: 'Use this when the owner asks to hand part of the task you hold to another chat («fais travailler une autre conversation sur la doc»): returns the sentence he pastes there. The child works under your lease, inside scope read_only, paths or your worktree, and never claims or pushes.',
    inputSchema: z.object({
      workspace_id: workspaceId,
      scope: z.enum(SCOPE_MODES).describe('read_only (reads only), paths (only the listed paths) or worktree (the whole worktree_id).'),
      paths: z.array(z.string().max(DELEGATION_LIMITS.path)).max(DELEGATION_LIMITS.paths).optional()
        .describe('With scope paths: worktree-relative prefixes (e.g. "docs/") and/or absolute host paths (e.g. "/Users/memo/notes").'),
      worktree_id: z.string().max(40).optional().describe('Your worktree on this task, for scope worktree and worktree-relative paths (and reads).'),
      issue: issue.optional().describe('The held task to delegate, when this workspace holds several.'),
      brief: z.string().max(DELEGATION_LIMITS.brief).optional().describe('What the child must do, in a few lines. No secrets.'),
      ttl_seconds: z.number().int().min(DELEGATION_TTL.min).max(DELEGATION_TTL.max).optional()
        .describe(`Lifetime of the delegation in seconds (default ${DELEGATION_TTL.default}).`),
      client_request_id: clientRequestId
    }),
    annotations: write
  }, call('workspaceDelegate'));

  server.registerTool('delegation_join', {
    description: 'Use this when the owner pastes «rejoins la délégation d_...»: makes this conversation that delegation\'s child. Then work only inside its scope and end with delegation_report final: true.',
    inputSchema: z.object({ delegation_id: delegationId,
      client_label: z.string().max(80).optional().describe('Free label for this conversation.') }),
    annotations: { ...write, openWorldHint: false }
  }, call('delegationJoin'));

  server.registerTool('delegation_status', {
    description: 'Use this to read what delegated chats reported (parent) or your own delegation and rules (child). Read-only.',
    inputSchema: z.object({ workspace_id: workspaceId, delegation_id: delegationId.optional() }),
    annotations: { ...read, openWorldHint: false }
  }, call('delegationStatus'));

  server.registerTool('delegation_report', {
    description: 'Use this, as a delegated child, to report your part to the parent (done, blocked, next_steps...); final: true when it is done.',
    inputSchema: z.object({ workspace_id: workspaceId, report: handoffShape.describe('One line per item, no secrets.'),
      final: z.boolean().optional().describe('true when your part is done.') }),
    annotations: { ...write, openWorldHint: false }
  }, call('delegationReport'));

  server.registerTool('delegation_end', {
    description: 'Use this, as the parent, when the owner asks to stop a delegated chat now.',
    inputSchema: z.object({ workspace_id: workspaceId, delegation_id: delegationId }),
    annotations: { ...write, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, call('delegationEnd'));
}
