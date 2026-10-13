// Worktree MCP tools (Phase 3): isolated Git worktrees for workspaces, the files inside them,
// and the Git writes that leave them (commit, push). The logic lives in
// server/runners/worktrees.mjs; this module owns the contract: schemas, authorization first,
// and the audit journal. The principal comes from the runtime, never from tool arguments.
import { z } from 'zod/v4';
import { LIMITS, createWorktreeRunner } from '../runners/worktrees.mjs';

export const WORKTREE_TOOLS = Object.freeze(['worktrees_list', 'worktree_create', 'worktree_status', 'worktree_list_files',
  'worktree_read_file', 'worktree_write_file', 'worktree_diff', 'worktree_commit', 'worktree_push', 'worktree_remove']);

// Operations that change something: their outcome is always journaled. Reads journal refusals only.
const WRITES = new Set(['worktree_create', 'worktree_write_file', 'worktree_commit', 'worktree_push', 'worktree_remove']);
// Policy refusals are journaled as 'denied'; anything else that fails is an 'error'.
const DENIED = new Set(['forbidden', 'workspace_closed', 'no_live_claim', 'stale_lease', 'lease_held', 'issue_changed',
  'lease_denied', 'protected_branch', 'branch_changed', 'branch_exists', 'path_exists', 'path_not_allowed', 'wrong_host',
  'worktree_dirty', 'unpushed_commits', 'worktree_removed', 'push_rejected', 'job_active', 'ignored_files', 'worktree_link_changed']);

const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const local = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const workspaceId = z.string().max(40).describe('Workspace id returned by workspace_open (ws_...).');
const worktreeId = z.string().max(40).describe('Worktree id returned by worktree_create (wt_...).');
const relPath = z.string().max(LIMITS.pathChars)
  .describe('Path relative to the worktree root, e.g. "src/index.ts". No "..", no absolute path, nothing under .git.');

// The runner is created once per runtime; getRuntime() opens services lazily.
export function registerWorktreeTools(server, getRuntime) {
  const runners = new WeakMap();
  const runnerFor = rt => {
    if (!runners.has(rt)) runners.set(rt, createWorktreeRunner(rt));
    return runners.get(rt);
  };

  const call = (op, method) => async raw => {
    const args = raw ?? {};
    let rt;
    try { rt = await getRuntime(); } catch { return result({ ok: false, error: 'store_unavailable' }); }
    const ctx = { ids: {} };
    // Authorization first, before any validation, so every refusal is journaled.
    if (!rt.authorize(op)) {
      await rt.audit(op, 'denied', 'forbidden', idsFrom(args));
      return result({ ok: false, error: 'forbidden' });
    }
    let data;
    try {
      data = await runnerFor(rt)[method](args, ctx);
    } catch (error) {
      // Only our own short codes reach the model; filesystem paths and engine messages do not.
      data = { ok: false, error: /^state_|store_closed/.test(String(error?.message ?? '')) ? 'store_unavailable' : 'internal_error' };
    }
    const failed = data?.ok === false;
    const denied = failed && DENIED.has(data.error);
    if (WRITES.has(op) || denied) {
      await rt.audit(op, failed ? (denied ? 'denied' : 'error') : 'ok', failed ? data.error : null, { ...idsFrom(args), ...ctx.ids });
    }
    return result(data);
  };

  server.registerTool('worktrees_list', {
    description: 'List your worktrees (newest first), for one workspace or for all your workspaces. Read-only.',
    inputSchema: z.object({ workspace_id: workspaceId.optional() }),
    annotations: read
  }, call('worktrees_list', 'list'));

  server.registerTool('worktree_create', {
    description: 'Create an isolated Git worktree of the workspace project (a registered repository) on a new branch, under ~/projects/_worktrees/<project>/. Runs "git fetch origin" and "git ls-remote origin" first. Pass the claimed Issue to be able to write, commit and push later; branch defaults to agent/<issue number>-<workspace suffix>, base to origin/<default branch>. Refuses the default branch (local or as the remote reports it), main, master, an existing branch (local or remote), all compared without case, and an existing path.',
    inputSchema: z.object({
      workspace_id: workspaceId,
      issue: z.string().max(160).optional().describe('GitHub Issue the workspace holds a live claim on, e.g. memolabs-dev/drop#7.'),
      branch: z.string().max(200).optional().describe('New branch name; never the default branch.'),
      base: z.string().max(200).optional().describe('Start point (branch, origin/<branch> or full commit SHA). Default origin/<default branch>.')
    }),
    annotations: { ...local, openWorldHint: true }
  }, call('worktree_create', 'create'));

  server.registerTool('worktree_status', {
    description: 'Branch, HEAD, ahead/behind versus the base and origin/<branch>, uncommitted changes (bounded), the last 5 commits, and edits made outside Memo Bridge (external_edits). Read-only.',
    inputSchema: z.object({ worktree_id: worktreeId }),
    annotations: read
  }, call('worktree_status', 'status'));

  server.registerTool('worktree_list_files', {
    description: 'List tracked and untracked (not ignored) files of a worktree, optionally under a sub-path. Read-only.',
    inputSchema: z.object({
      worktree_id: worktreeId,
      path: relPath.optional(),
      limit: z.number().int().min(1).max(LIMITS.listMax).optional().describe(`Maximum files returned (default ${LIMITS.listDefault}).`)
    }),
    annotations: read
  }, call('worktree_list_files', 'listFiles'));

  server.registerTool('worktree_read_file', {
    description: `Read a UTF-8 text file of a worktree, at most ${LIMITS.readBytes / 1024} KiB per call; use next_offset to continue. Binary files are refused. Control and bidi characters are replaced with U+FFFD and counted. Read-only.`,
    inputSchema: z.object({
      worktree_id: worktreeId,
      path: relPath,
      offset: z.number().int().min(0).max(2 ** 31).optional().describe('Byte offset to start from (default 0).'),
      limit: z.number().int().min(1).max(LIMITS.readBytes).optional().describe('Maximum bytes to read.')
    }),
    annotations: read
  }, call('worktree_read_file', 'readFile'));

  server.registerTool('worktree_write_file', {
    description: `Create or replace a text file in a worktree (at most ${LIMITS.writeBytes / 1024} KiB), creating parent directories inside it. Atomic. Requires a live claim on the worktree's Issue and the worktree still on its own branch.`,
    inputSchema: z.object({
      worktree_id: worktreeId,
      path: relPath,
      content: z.string().max(LIMITS.writeBytes).describe('Full new content of the file (UTF-8).')
    }),
    annotations: { ...local, destructiveHint: true, idempotentHint: true }
  }, call('worktree_write_file', 'writeFile'));

  server.registerTool('worktree_diff', {
    description: `Diff of uncommitted changes (or of the staged ones) with a stat, bounded to ${LIMITS.diffBytes / 1024} KiB, plus the untracked files. Read-only.`,
    inputSchema: z.object({ worktree_id: worktreeId, staged: z.boolean().optional() }),
    annotations: read
  }, call('worktree_diff', 'diff'));

  server.registerTool('worktree_commit', {
    description: 'Stage every change of the worktree (git add -A) and commit it with your message under the user\'s own Git identity. The lease ledger re-verifies the claim first. Refuses empty commits, control characters and AI attribution trailers. Returns the commit SHA.',
    inputSchema: z.object({
      worktree_id: worktreeId,
      message: z.string().max(LIMITS.messageChars).describe('Commit message; first line is the subject.')
    }),
    annotations: local
  }, call('worktree_commit', 'commit'));

  server.registerTool('worktree_push', {
    description: 'Push the worktree branch to origin (--set-upstream, never --force, never the default branch as the remote reports it) after the lease ledger re-verifies the claim, then record a checkpoint so another machine can resume. The remote branch must not exist yet, or be at a commit this worktree pushed; otherwise push_rejected. Never merges.',
    inputSchema: z.object({ worktree_id: worktreeId }),
    annotations: { ...local, openWorldHint: true }
  }, call('worktree_push', 'push'));

  server.registerTool('worktree_remove', {
    description: 'Remove a worktree directory (git worktree remove, no --force). Refused while a job runs in it (job_active), while it has uncommitted or untracked files, or commits that are not on origin, and while it holds ignored files (.env, node_modules, build output: ignored_files lists them) unless discard_ignored is true. The branch is kept.',
    inputSchema: z.object({
      worktree_id: worktreeId,
      discard_ignored: z.boolean().optional().describe('Delete the ignored files listed by a previous ignored_files refusal along with the worktree.')
    }),
    annotations: { ...local, destructiveHint: true, idempotentHint: true }
  }, call('worktree_remove', 'remove'));
}

// Only well-formed identifiers reach the journal; arbitrary caller text never does.
function idsFrom(args) {
  const ids = {};
  if (typeof args.workspace_id === 'string' && /^ws_[A-Za-z0-9_-]{16}$/.test(args.workspace_id)) ids.workspace_id = args.workspace_id;
  if (typeof args.issue === 'string' && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}#[1-9][0-9]{0,7}$/.test(args.issue)) ids.issue = args.issue;
  return ids;
}
