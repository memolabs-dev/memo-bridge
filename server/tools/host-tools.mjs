// Phase 3 tool module (host). What each machine can run and how busy it is, for choosing
// where a job goes. Read-only: local facts come from fixed probes (cached five minutes),
// remote facts only from the existing host_status probe. Services come from getRuntime().
import { z } from 'zod/v4';
import { createHostService, defaultProjectsRoot, HOST_IDS } from '../runners/hosts.mjs';

export const HOST_TOOLS = Object.freeze(['host_capabilities', 'host_resources']);

const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail } : {}) });

let sharedHosts;

// deps.hosts lets tests inject a host service with stubbed probes.
export function registerHostTools(server, getRuntime, deps = {}) {
  const hosts = () => deps.hosts ?? (sharedHosts ??= createHostService());
  const input = z.object({ host: z.enum(HOST_IDS).describe('mac or vps.') });

  // Authorization first; a refusal is journaled and nothing else runs.
  const guarded = (op, fn) => async (args = {}) => {
    let rt;
    try { rt = await getRuntime(); } catch { return result(fail('runtime_unavailable')); }
    if (!rt.authorize(op)) {
      await rt.audit(op, 'denied', 'forbidden');
      return result(fail('forbidden'));
    }
    try { return result(await fn(rt, args ?? {})); } catch { return result(fail('host_unavailable')); }
  };

  server.registerTool('host_capabilities', {
    description: 'What a machine can run: OS and architecture, versions of node, python3, git, gh (plus whether gh is authenticated, as a boolean), Swift/Xcode presence on macOS, Docker presence, which job recipe kinds (test/build/lint per toolchain) it is equipped for, and its declared roles. The machine running Memo Bridge is observed (cached 5 minutes); the other one reports declared roles plus host_status reachability only. Read-only.',
    inputSchema: input,
    annotations: readonly
  }, guarded('host_capabilities', async (rt, { host }) => hosts().capabilities(host, { localHost: rt.host })));

  server.registerTool('host_resources', {
    description: 'How busy a machine is: load averages, CPU count, free/total memory, free disk of the private state directory and of the projects volume, running and queued runner jobs from the local store, and the job concurrency limit. For the remote machine only the host_status figures are reported. The VPS follows a production-first rule. Read-only.',
    inputSchema: input,
    annotations: readonly
  }, guarded('host_resources', async (rt, { host }) => {
    let jobs = null;
    if (host === rt.host) {
      // Counts only; a store that cannot be opened leaves the rest of the answer intact.
      try {
        jobs = await rt.store().transaction(repo => ({
          running: repo.listJobs({ host, status: 'running', limit: 1000 }).length,
          queued: repo.listJobs({ host, status: 'queued', limit: 1000 }).length,
          // Phase 4 (VPS queue): waiting for admission, and handed to the dispatcher.
          deferred: repo.listJobs({ host, status: 'deferred', limit: 1000 }).length,
          dispatched: repo.listJobs({ host, status: 'dispatched', limit: 1000 }).length
        }), { write: false });
      } catch { jobs = null; }
    }
    return hosts().resources(host, { localHost: rt.host, stateDir: rt.stateDir,
      projectsRoot: rt.catalogOptions?.projectsRoot ?? defaultProjectsRoot(), jobs });
  }));
}
