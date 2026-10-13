// Coordinator MCP tools. Shared by every Memo Bridge entry point (local stdio today, the
// authenticated hub later), so all clients see the same contract. The entry point decides
// the principal; tool arguments never carry identity or permissions.
import { z } from 'zod/v4';
import { CLIENT_TYPES, HOSTS } from '../coordinator/index.mjs';
import { LEASE_TTL, OUTCOMES } from '../coordinator/issue-lease.mjs';

export const COORDINATOR_TOOLS = Object.freeze(['workspace_open', 'workspace_status', 'workspace_list', 'workspace_close',
  'issue_status', 'issue_claim', 'issue_heartbeat', 'issue_release', 'issue_checkpoint', 'coordinator_events']);

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

const workspaceId = z.string().max(40).describe('Workspace id returned by workspace_open (ws_…).');
const issue = z.string().max(160).describe('GitHub Issue reference, e.g. memolabs-dev/cuesheet#42.');
const claimId = z.string().max(32).describe('claim_id returned by issue_claim.');
const fence = z.string().max(40).describe('Latest fence returned by issue_claim or issue_heartbeat. Writes with an outdated fence are refused.');
const ttl = z.number().int().min(LEASE_TTL.min).max(LEASE_TTL.max).optional()
  .describe(`Lease duration in seconds (default ${LEASE_TTL.default}). Renew with issue_heartbeat before it expires.`);

// getCoordinator() opens storage lazily so the read-only tools keep working when the
// private state directory is unavailable.
export function registerCoordinatorTools(server, getCoordinator) {
  const call = method => async args => {
    let coordinator;
    try { coordinator = await getCoordinator(); } catch (error) {
      // Only our own short codes reach the model; filesystem paths and engine messages do not.
      const code = String(error?.message ?? '');
      return result({ ok: false, error: 'store_unavailable', ...(/^state_[a-z_]{1,40}$/.test(code) ? { detail: code } : {}) });
    }
    return result(await coordinator[method](args ?? {}));
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
    description: 'Show a workspace you own, its worker identity and the Issue claims it holds.',
    inputSchema: z.object({ workspace_id: workspaceId }),
    annotations: { ...read, openWorldHint: false }
  }, call('workspaceStatus'));

  server.registerTool('workspace_list', {
    description: 'List your workspaces, newest first.',
    inputSchema: z.object({ status: z.enum(['active', 'closed']).optional(), limit: z.number().int().min(1).max(200).optional() }),
    annotations: { ...read, openWorldHint: false }
  }, call('workspaceList'));

  server.registerTool('workspace_close', {
    description: 'Close a workspace you own and release its Issue claims (outcome cancelled). Idempotent.',
    inputSchema: z.object({ workspace_id: workspaceId }),
    annotations: { ...write, idempotentHint: true }
  }, call('workspaceClose'));

  server.registerTool('issue_status', {
    description: 'Show the shared lease state of a GitHub Issue (claimed or not, by whom, until when) and its recorded checkpoints.',
    inputSchema: z.object({ issue }),
    annotations: read
  }, call('issueStatus'));

  server.registerTool('issue_claim', {
    description: 'Reserve a GitHub Issue for a workspace through the Memo Labs lease ledger (a Git ref in memolabs-dev/.github, visible to every machine). The Issue must be open, labelled agent:ready with one priority label, and belong to the workspace project. Exactly one worker can hold it.',
    inputSchema: z.object({ workspace_id: workspaceId, issue, ttl_seconds: ttl }),
    annotations: write
  }, call('issueClaim'));

  server.registerTool('issue_heartbeat', {
    description: 'Extend a claim you hold. Returns a new fence; use it for every later call. Fails with stale_lease once the claim expired or was taken over: stop writing then.',
    inputSchema: z.object({ workspace_id: workspaceId, issue, claim_id: claimId, fence, ttl_seconds: ttl }),
    annotations: write
  }, call('issueHeartbeat'));

  server.registerTool('issue_release', {
    description: 'Release a claim with an outcome. Never closes the Issue and never deploys.',
    inputSchema: z.object({ workspace_id: workspaceId, issue, claim_id: claimId, fence, outcome: z.enum(OUTCOMES) }),
    annotations: write
  }, call('issueRelease'));

  server.registerTool('issue_checkpoint', {
    description: 'Record a durable checkpoint (branch + full commit SHA) under a claim you hold. The ledger re-verifies the claim first; the commit is checked read-only in the project repository and reported as remote (resumable on another machine), local_only, or unverified. Uncommitted files are never transferred.',
    inputSchema: z.object({ workspace_id: workspaceId, issue, claim_id: claimId, fence,
      branch: z.string().max(200), commit: z.string().max(64), note: z.string().max(500).optional() }),
    annotations: write
  }, call('issueCheckpoint'));

  server.registerTool('coordinator_events', {
    description: 'Read the Coordinator audit journal (newest first), optionally for one Issue or workspace.',
    inputSchema: z.object({ issue: issue.optional(), workspace_id: workspaceId.optional(),
      limit: z.number().int().min(1).max(200).optional() }),
    annotations: { ...read, openWorldHint: false }
  }, call('events'));
}
