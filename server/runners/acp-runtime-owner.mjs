// One ACP supervisor per trusted runtime principal, not per MCP transport.
// The Mac runtime agent (launchd, bridge/agent-cli.mjs) is process-lived and
// caches its principal-scoped runtime. All its connections therefore share
// the same supervisor. No new MCP operation or principal grant is created.
import { createMacSandboxedAcpSupervisor } from './acp-managed-supervisor.mjs';

export function createAcpRuntimeOwners({createSupervisor = createMacSandboxedAcpSupervisor} = {}) {
  if (typeof createSupervisor !== 'function') throw new TypeError('invalid_acp_owner_factory');
  const owners = new WeakMap();
  return Object.freeze({
    get(runtime) {
      if (!runtime || typeof runtime.onShutdown !== 'function')
        throw new Error('acp_runtime_lifecycle_unavailable');
      let current = owners.get(runtime);
      if (current) return current.supervisor;
      // Register shutdown BEFORE returning to callers. If another tool
      // collector re-registers on the same runtime, it gets this same owner.
      const supervisor = createSupervisor(runtime);
      if (!supervisor || typeof supervisor.close !== 'function' ||
          typeof supervisor.start !== 'function')
        throw new Error('invalid_acp_supervisor');
      const entry = {supervisor};
      // Runtime close may already be in flight; fail closed, never expose an
      // unowned child. Close a successfully constructed but unused supervisor.
      try {
        runtime.onShutdown(async () => {
          owners.delete(runtime);
          await supervisor.close();
        });
      } catch {
        void Promise.resolve().then(() => supervisor.close()).catch(() => {});
        throw new Error('acp_runtime_shutting_down');
      }
      owners.set(runtime, entry);
      return supervisor;
    }
  });
}

// Shared by all server/tool collectors within the same JS runtime process.
// It cannot claim or reconnect a child from a crashed previous process;
// the journal and worktree O_EXCL lock remain the fail-closed recovery gates.
export const acpRuntimeOwners = createAcpRuntimeOwners();
