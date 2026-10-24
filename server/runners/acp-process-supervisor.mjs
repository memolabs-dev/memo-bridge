// Lease-bound ACP process owner. No process is started without an explicit,
// injected, trusted transport factory; MCP callers never supply commands/paths.
// Intended to be used by the Mac executor after admission and sandbox checks.
import { randomUUID } from 'node:crypto';
import { createAcpLeaseMonitor } from './acp-lease-monitor.mjs';

const fail = error => ({ ok: false, error });
const live = new Set(['starting', 'running', 'stopping']);

export function createAcpProcessSupervisor({
  admit, launch, renew, now = Date.now,
  intervalMs = 10_000, createMonitor = createAcpLeaseMonitor,
  stopTimeoutMs = 5_000, wait = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (typeof admit !== 'function' || typeof launch !== 'function' ||
      typeof renew !== 'function' || typeof createMonitor !== 'function') {
    throw new TypeError('invalid_acp_supervisor');
  }
  const sessions = new Map();
  const byWorktree = new Map();

  const view = s => ({
    session_id: s.id, workspace_id: s.workspaceId, worktree_id: s.worktreeId,
    issue: s.issue, state: s.state, reason: s.reason,
    started_at: s.startedAt, ended_at: s.endedAt
  });

  async function end(s, reason = 'user_cancelled') {
    if (!s || !live.has(s.state) || s.cleaned || s.state === 'stopping') return;
    s.state = 'stopping';
    s.reason = reason;
    try { await s.monitor?.stop(reason); }
    catch { /* monitor termination must never prevent final cleanup */ }
    await stopProcess(s);
  }

  async function stopProcess(s) {
    if (s.cleaned) return;
    s.cleaned = true;
    const child = s.child;
    if (child) {
      try { child.stop('SIGTERM'); } catch {}
      const ended = child.exited ?? Promise.resolve();
      await Promise.race([Promise.resolve(ended).catch(() => {}), wait(stopTimeoutMs)]);
      try { if (child.alive?.()) child.stop('SIGKILL'); } catch {}
    }
    s.state = 'stopped';
    s.endedAt = now();
    if (byWorktree.get(s.worktreeId) === s.id) byWorktree.delete(s.worktreeId);
  }

  return Object.freeze({
    async start({ workspace_id: workspaceId, worktree_id: worktreeId } = {}) {
      if (!/^wt_[A-Za-z0-9_-]{16}$/.test(worktreeId ?? '') ||
          !/^ws_[A-Za-z0-9_-]{16}$/.test(workspaceId ?? '')) return fail('invalid_input');
      // Reserve synchronously before the first await: two concurrent requests
      // must never spawn twice for the same worktree.
      if (byWorktree.has(worktreeId)) return fail('agent_already_running');
      // Bounded memory and concurrency, across all worktrees in this runtime.
      if ([...sessions.values()].filter(row => live.has(row.state)).length >= 4)
        return fail('agent_capacity_reached');
      while (sessions.size >= 64) {
        const oldest = [...sessions.values()].find(row => !live.has(row.state));
        if (!oldest) return fail('agent_capacity_reached');
        sessions.delete(oldest.id);
      }
      const id = randomUUID();
      const s = { id, workspaceId, worktreeId, issue: null, child: null,
        state: 'starting', reason: null, startedAt: now(), endedAt: null,
        monitor: null, cleaned: false };
      byWorktree.set(worktreeId, id);
      sessions.set(id, s);
      try {
        const admission = await admit({ workspace_id: workspaceId, worktree_id: worktreeId });
        if (!admission?.ok || admission.workspace_id !== workspaceId ||
            admission.worktree_id !== worktreeId) {
          s.reason = admission?.error ?? 'admission_mismatch';
          await stopProcess(s);
          return fail(s.reason);
        }
        if (s.cleaned) return fail(s.reason ?? 'agent_cancelled');
        s.issue = admission.issue;
        // The first renew happens BEFORE launch; it also rechecks remote lease
        // authority. Fail closed on lost, unavailable or mismatched claim.
        const before = await renew(admission);
        if (!before?.ok || before.claim_id !== admission.claim_id) {
          s.reason = before?.error ?? 'renewal_mismatch';
          await stopProcess(s);
          return fail(s.reason);
        }
        if (s.cleaned) return fail(s.reason ?? 'agent_cancelled');
        // Remote heartbeat can advance the fence, so the second preflight
        // must observe precisely the renewed lease before any process exists.
        const after = await admit({ workspace_id: workspaceId, worktree_id: worktreeId });
        if (!after?.ok || after.claim_id !== before.claim_id ||
            after.workspace_id !== workspaceId || after.worktree_id !== worktreeId ||
            after.issue !== s.issue) {
          s.reason = after?.error ?? 'admission_changed';
          await stopProcess(s);
          return fail(s.reason);
        }
        if (s.cleaned) return fail(s.reason ?? 'agent_cancelled');
        // Launch adapter is trusted local code, not an MCP command or pathname.
        // It must itself ensure sandbox confinement and process-group teardown.
        const child = await launch({ workspaceId, worktreeId, admission: after });
        if (!child || typeof child.stop !== 'function' ||
            typeof child.alive !== 'function' || !child.exited) {
          s.reason = 'invalid_agent_process';
          try { child?.stop?.('SIGKILL'); } catch {}
          await stopProcess(s);
          return fail(s.reason);
        }
        s.child = child;
        if (s.cleaned) {
          try { child.stop('SIGTERM'); } catch {}
          return fail(s.reason ?? 'agent_cancelled');
        }
        s.monitor = createMonitor({
          intervalMs,
          check: async () => {
            const r = await admit({ workspace_id: workspaceId, worktree_id: worktreeId });
            if (!r?.ok || r.issue !== s.issue) return fail(r?.error ?? 'stale_lease');
            const lease = await renew(r);
            return lease?.ok && lease.claim_id === r.claim_id ? { ok:true } :
              fail(lease?.error ?? 'renewal_mismatch');
          },
          terminate: reason => {
            s.reason = reason;
            return stopProcess(s);
          }
        });
        const monitored = await s.monitor.start();
        if (!monitored.ok) {
          s.reason = monitored.error;
          await stopProcess(s);
          return fail(s.reason);
        }
        // An exit is authoritative even if the caller has closed the MCP stream.
        void Promise.resolve(child.exited).then(
          () => end(s, 'agent_exited'), () => end(s, 'agent_failed')
        ).catch(() => {});
        if (s.cleaned) return fail(s.reason ?? 'agent_exited');
        s.state = 'running';
        return { ok: true, ...view(s) };
      } catch {
        s.reason = 'agent_start_failed';
        await stopProcess(s);
        return fail(s.reason);
      }
    },
    async stop(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return fail('unknown_session');
      await end(s);
      return { ok: true, ...view(s) };
    },
    status(sessionId) {
      const s = sessions.get(sessionId);
      return s ? { ok:true, ...view(s) } : fail('unknown_session');
    },
    async close() {
      await Promise.all([...sessions.values()].filter(s => live.has(s.state))
        .map(s => end(s, 'supervisor_shutdown')));
    }
  });
}
