// Phase 3 tool module (jobs): predefined test/build/lint recipes run on the local host.
// Services come from getRuntime() (server/runtime.mjs); the logic lives in server/runners/jobs.mjs.
import { z } from 'zod/v4';
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
  const call = method => async args => {
    try {
      const rt = await getRuntime();
      if (!service || serviceRuntime !== rt) { service = createJobService(rt, options); serviceRuntime = rt; }
      return result(await service[method](args ?? {}));
    } catch (error) {
      // Only our own short codes reach the model; paths and engine messages do not.
      const code = String(error?.message ?? '');
      return result({ ok: false, error: 'store_unavailable', ...(/^state_[a-z_]{1,40}$/.test(code) ? { detail: code } : {}) });
    }
  };

  server.registerTool('jobs_submit', {
    description: 'Run a predefined recipe (test, build or lint) in a worktree of your workspace, on this machine. ' +
      'The command is detected from the worktree (package.json scripts, Package.swift, pyproject.toml/pytest.ini, Cargo.toml, ' +
      'go.mod, Makefile), never given by you. It runs the repository\'s own scripts on the owner\'s machine as the owner, ' +
      'at lower priority, without a shell and without secret environment variables; it is not a sandbox. Requires an active ' +
      'workspace you own, an active worktree of that workspace and a live claim on the worktree\'s Issue. The job keeps ' +
      `running after this session ends. Timeout default ${TIMEOUT_SECONDS.default / 60} min, max ${TIMEOUT_SECONDS.max / 60} min. ` +
      'At most MEMO_BRIDGE_MAX_JOBS (default 2) jobs run per host; beyond that the call fails with host_busy (no queue yet). ' +
      'Follow it with job_status, job_events and job_results.',
    inputSchema: z.object({
      workspace_id: workspaceId,
      worktree_id: z.string().max(64).describe('Worktree id of this workspace (worktree_create / worktrees_list).'),
      recipe: z.enum(RECIPE_NAMES).describe('Recipe name; unknown or undetected recipes are refused.'),
      timeout_seconds: z.number().int().min(TIMEOUT_SECONDS.min).max(TIMEOUT_SECONDS.max).optional()
        .describe(`Kill the job after this many seconds (default ${TIMEOUT_SECONDS.default}).`)
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
    description: 'Status of one of your jobs: queued, running, succeeded, failed, cancelled, timed_out or interrupted, with exit code, times and a short summary of the last output lines.',
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
    description: 'Cancel one of your jobs: a queued job never starts; a running job gets SIGTERM, then SIGKILL after 5 s, for all its processes. A finished job returns job_finished.',
    inputSchema: z.object({ job_id: jobId }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, call('cancel'));
}
