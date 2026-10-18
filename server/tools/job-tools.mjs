// Phase 3 tool module (jobs): predefined test/build/lint recipes run on the local host.
// Phase 4: on the VPS runner (MEMO_BRIDGE_JOB_EXECUTOR=systemd) jobs queue FIFO, one at a time,
// and run as memo-job@<id>.service; jobs_submit takes client_request_id and release_on_finish.
// Services come from getRuntime() (server/runtime.mjs); the logic lives in server/runners/jobs.mjs.
import { z } from 'zod/v4';
import { CLIENT_REQUEST_ID_RE } from '../coordinator/store.mjs';
import { JOB_STATUSES, RESULTS, TIMEOUT_SECONDS, createJobService } from '../runners/jobs.mjs';
import { RECIPE_NAMES } from '../runners/recipes.mjs';

export const JOB_TOOLS = Object.freeze(['jobs_submit', 'jobs_list', 'job_status', 'job_events', 'job_results', 'job_cancel']);

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

const workspaceId = z.string().max(40).describe('One ws_... workspace id.');
const jobId = z.string().max(40).describe('job_... id from jobs_submit.');

// `options` is passed to createJobService (runnerPath, maxJobs…); the entry point normally omits it.
export function registerJobTools(server, getRuntime, options = {}) {
  let service; let serviceRuntime;
  // extra.meta: the hub's per-request metadata ({request_id, client_session}) for a forwarded
  // call; absent on stdio. jobs_submit and job_cancel check the D8 session binding with it.
  const call = method => async (args, extra) => {
    try {
      const rt = await getRuntime();
      if (!service || serviceRuntime !== rt) { service = createJobService(rt, options); serviceRuntime = rt; }
      const ctx = { meta: extra?.meta && typeof extra.meta === 'object' ? extra.meta : null };
      const out = await service[method](args ?? {}, ctx);
      return result(out?.ok && ctx.sessionWarning ? { ...out, session_warning: ctx.sessionWarning } : out);
    } catch (error) {
      // Only our own short codes reach the model; paths and engine messages do not.
      const code = String(error?.message ?? '');
      return result({ ok: false, error: 'store_unavailable', ...(/^state_[a-z_]{1,40}$/.test(code) ? { detail: code } : {}) });
    }
  };

  server.registerTool('jobs_submit', {
    description: 'Use this to run a project\'s own test, build or lint in your worktree («lance les tests»), always before worktree_commit. The command is detected from the repository, never given by you: it runs the repository\'s own scripts on the owner\'s machine, sandboxed (writes to the worktree only, loopback network only, no credentials). Needs a live claim; on the VPS jobs queue. ' +
      'Follow with job_status and job_results; notify: true pings the owner when it ends. Not for other commands (operator_run).',
    inputSchema: z.object({
      workspace_id: workspaceId,
      worktree_id: z.string().max(64).describe('wt_... id from worktree_create or worktrees_list.'),
      recipe: z.enum(RECIPE_NAMES).describe('"test", "build" or "lint"; one the repository does not define is refused.'),
      timeout_seconds: z.number().int().min(TIMEOUT_SECONDS.min).max(TIMEOUT_SECONDS.max).optional()
        .describe(`Seconds, default ${TIMEOUT_SECONDS.default}, at most ${TIMEOUT_SECONDS.max}.`),
      client_request_id: z.string().regex(CLIENT_REQUEST_ID_RE).optional()
        .describe('Optional retry key (8 to 128 of A-Z a-z 0-9 _ -): a retry returns the same job.'),
      release_on_finish: z.boolean().optional()
        .describe('VPS only: release the claim when the job ends.'),
      notify: z.boolean().optional()
        .describe('Remote chats: one Telegram message to the owner and an inbox notice when it ends.')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, call('submit'));

  server.registerTool('jobs_list', {
    description: 'Use this when the owner asks which jobs ran or are running, newest first, per workspace or status. Read-only.',
    inputSchema: z.object({
      workspace_id: workspaceId.optional(),
      status: z.enum(JOB_STATUSES).optional().describe('Only this status, e.g. "running".'),
      limit: z.number().int().min(1).max(200).optional().describe('At most 200, e.g. 10.')
    }),
    annotations: read
  }, call('list'));

  server.registerTool('job_status', {
    description: 'Use this to follow a job from jobs_submit: queued, running, succeeded, failed, timed_out..., exit code, last lines. Read-only.',
    inputSchema: z.object({ job_id: jobId }),
    annotations: read
  }, call('status'));

  server.registerTool('job_events', {
    description: 'Use this for the lifecycle events of a job; pass next_after_seq back as after_seq. Read-only.',
    inputSchema: z.object({ job_id: jobId, after_seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('next_after_seq of the previous answer.') }),
    annotations: read
  }, call('events'));

  server.registerTool('job_results', {
    description: `Use this when a job ended, to see why it failed: last lines of its output (default ${RESULTS.defaultLines}, at most ${RESULTS.maxLines}). Read-only.`,
    inputSchema: z.object({ job_id: jobId, tail_lines: z.number().int().min(1).max(RESULTS.maxLines).optional().describe('Last lines, e.g. 200.') }),
    annotations: read
  }, call('results'));

  server.registerTool('job_cancel', {
    description: 'Use this when the owner asks to stop a job («arrête les tests»): a queued job never starts, a running one is killed.',
    inputSchema: z.object({ job_id: jobId,
      workspace_id: workspaceId.optional().describe('Your own workspace when you are a delegated child.') }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, call('cancel'));
}
