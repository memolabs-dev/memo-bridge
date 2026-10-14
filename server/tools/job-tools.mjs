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

const workspaceId = z.string().max(40).describe('Workspace id returned by workspace_open (ws_…).');
const jobId = z.string().max(40).describe('Job id returned by jobs_submit (job_…).');

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
    description: 'Run a predefined recipe (test, build or lint) in a worktree of your workspace, on the machine that holds it. ' +
      'The command is detected from the worktree (package.json scripts, Package.swift, pyproject.toml/pytest.ini, Cargo.toml, ' +
      'go.mod, Makefile), never given by you. It runs the repository\'s own scripts on the owner\'s machine, at lower ' +
      'priority and without a shell, inside the job sandbox: writes only to the worktree, loopback network only, no access ' +
      'to private data or credentials, an allow-listed environment (refused with sandbox_unavailable where there is none; ' +
      'with MEMO_BRIDGE_JOB_SANDBOX=off the owner runs jobs unsandboxed, owner-equivalent). Requires an active workspace you ' +
      'own, an active worktree of that workspace and a live claim on the worktree\'s Issue, which the ledger confirms. The ' +
      'job keeps running after this session ends, and stops when the claim is released or expires or the workspace closes. ' +
      `Timeout default ${TIMEOUT_SECONDS.default / 60} min, max ${TIMEOUT_SECONDS.max / 60} min. ` +
      'On the Mac at most MEMO_BRIDGE_MAX_JOBS (default 2) jobs run at once; beyond that the call fails with host_busy. ' +
      'On the VPS runner jobs queue (FIFO, one at a time, as an unprivileged systemd unit without credentials): the call ' +
      'returns queued, the job may wait as deferred while the host is busy, and the runner keeps the claim\'s lease alive ' +
      'while it waits or runs. Pass client_request_id to make a retry safe: the same id returns the same job. ' +
      'Follow it with job_status, job_events and job_results.',
    inputSchema: z.object({
      workspace_id: workspaceId,
      worktree_id: z.string().max(64).describe('Worktree id of this workspace (worktree_create / worktrees_list).'),
      recipe: z.enum(RECIPE_NAMES).describe('Recipe name; unknown or undetected recipes are refused.'),
      timeout_seconds: z.number().int().min(TIMEOUT_SECONDS.min).max(TIMEOUT_SECONDS.max).optional()
        .describe(`Kill the job after this many seconds (default ${TIMEOUT_SECONDS.default}).`),
      client_request_id: z.string().regex(CLIENT_REQUEST_ID_RE).optional()
        .describe('Your own id for this request (8 to 128 letters, digits, - or _). A retry with the same id returns the job the first call created and starts nothing.'),
      release_on_finish: z.boolean().optional()
        .describe('VPS runner only: release the claim when the job ends (completed on success, otherwise cancelled or failed).'),
      notify: z.boolean().optional()
        .describe('Through the hub (remote chats): when the job ends, one Telegram message to the owner and a notification in your inbox (notifications_check). Ignored elsewhere.')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, call('submit'));

  server.registerTool('jobs_list', {
    description: 'List your jobs, newest first, optionally for one workspace or one status. A running job whose processes are gone is reported as interrupted.',
    inputSchema: z.object({
      workspace_id: workspaceId.optional(),
      status: z.enum(JOB_STATUSES).optional(),
      limit: z.number().int().min(1).max(200).optional()
    }),
    annotations: read
  }, call('list'));

  server.registerTool('job_status', {
    description: 'Status of one of your jobs: queued, deferred (VPS, waiting for room on the host), dispatched (VPS, handed to systemd), running, succeeded, failed, cancelled, timed_out, oom, budget_exceeded or interrupted, with exit code, times, the reason when there is one, and a short summary of the last output lines.',
    inputSchema: z.object({ job_id: jobId }),
    annotations: read
  }, call('status'));

  server.registerTool('job_events', {
    description: 'Lifecycle events of one of your jobs (submitted, started, timeout, cancelled, exit, interrupted…). Pass next_after_seq back as after_seq to read only new events.',
    inputSchema: z.object({ job_id: jobId, after_seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }),
    annotations: read
  }, call('events'));

  server.registerTool('job_results', {
    description: `Last lines of a job's combined stdout/stderr log (default ${RESULTS.defaultLines}, max ${RESULTS.maxLines} lines, at most ${RESULTS.maxBytes / 1024} KiB), control characters removed. The log itself is capped at 5 MiB.`,
    inputSchema: z.object({ job_id: jobId, tail_lines: z.number().int().min(1).max(RESULTS.maxLines).optional() }),
    annotations: read
  }, call('results'));

  server.registerTool('job_cancel', {
    description: 'Cancel one of your jobs: a queued or deferred job never starts; a running job is stopped with all its processes (Mac: SIGTERM, then SIGKILL after 5 s; VPS: the dispatcher stops its unit). A finished job returns job_finished.',
    inputSchema: z.object({ job_id: jobId,
      workspace_id: workspaceId.optional().describe('Your own workspace when you are a delegated child.') }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, call('cancel'));
}
