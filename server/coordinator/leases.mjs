// Pure lease decisions. They take rows and a clock value and return either an error code or
// the patch to apply. The fencing token is the task's lease_generation: every claim
// increments it, so a writer holding an older token is rejected forever.

export const TTL_MIN_SECONDS = 60;
export const TTL_MAX_SECONDS = 3600;
export const TTL_DEFAULT_SECONDS = 900;

export function ttlMs(ttlSeconds = TTL_DEFAULT_SECONDS) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < TTL_MIN_SECONDS || ttlSeconds > TTL_MAX_SECONDS) return null;
  return ttlSeconds * 1000;
}

export function leaseActive(task, now) {
  return Boolean(task.lease_workspace) && task.lease_expires_at !== null && task.lease_expires_at > now;
}

export function decideClaim(task, workspace, now, durationMs) {
  if (task.status === 'completed') return { error: 'task_closed' };
  if (leaseActive(task, now)) return { error: 'lease_held' };
  const generation = task.lease_generation + 1;
  return {
    generation,
    patch: {
      lease_workspace: workspace.id,
      lease_principal: workspace.principal,
      lease_generation: generation,
      lease_expires_at: now + durationMs,
      updated_at: now
    }
  };
}

// Every task write goes through this fence: same workspace, same generation, not expired.
export function checkFence(task, workspaceId, token, now) {
  if (task.status === 'completed') return { error: 'task_closed' };
  if (task.lease_workspace !== workspaceId || task.lease_generation !== token || !leaseActive(task, now)) {
    return { error: 'stale_lease' };
  }
  return { ok: true };
}

export function releasePatch(now) {
  return { lease_workspace: null, lease_principal: null, lease_expires_at: null, updated_at: now };
}

export function publicLease(task, now) {
  if (!task.lease_workspace) return null;
  return {
    workspace_id: task.lease_workspace,
    principal: task.lease_principal,
    generation: task.lease_generation,
    expires_at: new Date(task.lease_expires_at).toISOString(),
    active: leaseActive(task, now)
  };
}

export function effectiveStatus(task, now) {
  if (task.status === 'completed') return 'completed';
  return leaseActive(task, now) ? 'claimed' : 'open';
}
