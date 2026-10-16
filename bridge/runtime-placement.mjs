// Decide whether an agent may serve coordinator/runtime operations.
// Host enrollment, credential checks and project authorization remain independent gates.
// Mac runtime is opt-in: a discovery snapshot never switches a probe into a runtime.
export function executableRuntimeHost(host, env = {}) {
  if (host === 'vps') return 'vps';
  if (host === 'mac' && env?.MEMO_BRIDGE_MAC_RUNTIME_ENABLED === 'enabled') return 'mac';
  throw new Error('runtime_host_not_enabled');
}
