// Runner supervisor (Phase 4, TODO-P4-09): the VPS job queue, run inside memo-bridge-runner.
//
// The store is the queue (D4): jobs_submit records 'queued' and returns. The supervisor then,
// on every tick (default 5 s, and at once when nudged):
//   1. settle      dispatched/running jobs: the final status root wrote in status.json wins
//                  (D5); otherwise `systemctl show` says whether the unit started (dispatched ->
//                  running) or is gone without a status (interrupted, after a grace).
//   2. lifecycle   an active job whose workspace closed, worktree was removed or claim was
//                  released or expired is cancelled (the Phase 3 runner did this on the Mac).
//   3. budgets     a running job whose worktree plus output exceeds the disk budget (du, every
//                  60 s), that cannot be measured several times in a row, or that runs while
//                  free disk is below the running floor becomes budget_exceeded (REQ-P4-18).
//   4. stop sweep  a job we ended (cancelled, budget_exceeded) while its unit may still run gets
//                  spool/cancel/<id>; repeated if the unit is still active a minute later.
//   5. release     a finished job with release_on_finish releases its claim, once no other job
//                  of that claim is active (REQ-P4-05).
//   6. dispatch    FIFO, concurrency 1: the oldest queued/deferred job is admitted (resources.mjs:
//                  free disk, MemAvailable, PSI) or deferred with its reason and re-evaluated
//                  every 30 s (REQ-P4-17); the ledger confirms the lease; the spool file is
//                  written, then queued -> dispatched is a compare-and-set.
// Lease renewal runs on its own timer (default 60 s), because a ledger call can take two
// minutes: every claim bound to a waiting or started job is renewed once less than a third of
// its TTL remains; a definitive denial (stale_lease) cancels the claim's jobs (REQ-P4-05).
// Start: reconcile first (REQ-P4-08). A running unit keeps running and is followed again; a
// unit that ended while the runner was down is settled from its status file, or reported
// interrupted when it has none.
//
// Authority (mirror versus authority, spec section 12): systemd (through root's status file)
// decides how a job ended; the ledger decides who holds a claim; the store decides what we
// asked for (cancel, budget). The supervisor only ever moves the store forward with
// compare-and-set, so a client call or a read racing with it never loses an update.
import { realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseIssueRef } from '../coordinator/issue-lease.mjs';
import { workerFor } from '../coordinator/policy.mjs';
import { ACTIVE_JOB_STATUSES, STARTED_JOB_STATUSES, WAITING_JOB_STATUSES, executorKindFromEnv, runnerWatchStart,
  setRunnerStatusProvider, setRunnerWatchStart, setSupervisorNudge } from './executor.mjs';
import { applyUnitResult, createSystemdExecutor, runnerRootFromEnv } from './executor-systemd.mjs';
import { DEFAULT_RUNNER_CONFIG, admit, createResourceReader, loadRunnerConfig, summarizeSnapshot } from './resources.mjs';

export const SUPERVISOR_PRINCIPAL = 'runner:supervisor';
export const SUPERVISOR_DEFAULTS = Object.freeze({
  pollMs: 5_000,
  renewEveryMs: 60_000,
  deferRetryMs: 30_000,
  diskCheckMs: 60_000,
  // A running unit seen inactive without a status file: wait this long for ExecStopPost.
  interruptGraceMs: 30_000,
  // A dispatched job whose spool file was taken but whose unit never appeared.
  dispatchGraceMs: 60_000,
  // Spool file still there after this: the dispatcher is not running (reported, not failed).
  dispatchStallMs: 120_000,
  // A stop request is repeated when the unit is still active this long after it (TimeoutStopSec=30 + margin).
  restopMs: 60_000,
  // Safety net behind RuntimeMaxSec: a unit still active this long past its job's timeout is
  // ended timed_out and stopped by the supervisor (TimeoutStopSec=30 plus margin).
  deadlineMarginMs: 60_000,
  releaseAttempts: 5,
  requestRetentionMs: 7 * 24 * 3600_000,
  concurrency: 1
});
// Ledger answers that do not prove the lease is lost: try again on the next round.
const SUPERVISOR_DEFAULTS_DISK = Object.freeze({ min_free_disk_running_gib: DEFAULT_RUNNER_CONFIG.min_free_disk_running_gib,
  max_unmeasured_readings: DEFAULT_RUNNER_CONFIG.max_unmeasured_readings });
const TRANSIENT = new Set(['ledger_unavailable', 'ledger_outcome_unknown', 'lease_race_lost']);
const RELEASE_OUTCOME = { succeeded: 'completed', cancelled: 'cancelled', interrupted: 'cancelled' };

/**
 * rt: the runtime (store, ledger, host, now). executor: the systemd executor. resources: a
 * reader from resources.mjs. config: loadRunnerConfig() output. Timers and intervals are
 * injectable; tests call tick() and renewLeases() directly with a fake clock.
 */
export function createSupervisor(rt, { executor, resources = createResourceReader(), config, options = {},
  timers = { setInterval, clearInterval }, log = () => {} } = {}) {
  if (!executor || executor.kind !== 'systemd') throw new Error('supervisor_needs_systemd_executor');
  const o = { ...SUPERVISOR_DEFAULTS, ...options };
  const cfg = config ?? { admission: undefined, disk_budget_gib: 20, lease_ttl_seconds: 1800 };
  const now = () => rt.now();
  // From now on this supervisor sees units end; one that ended earlier was not observed
  // (statusFromResult: interrupted rather than failed for a stop signal).
  const watchingSince = now();
  setRunnerWatchStart(watchingSince);
  const read = fn => rt.store().transaction(repo => fn(repo, now()), { write: false });
  const write = fn => rt.store().transaction(repo => fn(repo, now()));
  const event = (repo, jobId, at, kind, detail) =>
    repo.appendJobEvent({ job_id: jobId, at, kind, detail: detail === undefined ? null : JSON.stringify(detail) });
  const journal = (repo, at, op, outcome, code, ids = {}) =>
    repo.appendEvent({ at, principal: SUPERVISOR_PRINCIPAL, workspace_id: ids.workspace_id ?? null, issue_ref: ids.issue ?? null,
      op, outcome, code: code ?? null });

  // In-memory follow-up state; everything durable is in the store.
  const inactiveSince = new Map();
  const lastDiskCheck = new Map();
  const lastStop = new Map();
  const rejectedStatus = new Set();
  const unmeasured = new Map();
  const stalled = new Set();
  const view = {
    started_at: null, last_tick_at: null, queue_depth: 0, deferred: 0, active: null, last_result: null,
    admission: null, ledger: null, dispatcher: { stalled: false }, systemctl: null, disk: null, disk_free: null,
    waiting_for_unit: null, errors: 0
  };
  let ticking = null; let again = false; let renewing = null; let intervals = []; let lastPrune = 0;

  // Free space on the runner tree (statfs), or null when it cannot be read.
  const diskFree = () => {
    try {
      const d = typeof resources.disk === 'function' ? resources.disk(executor.paths.root)
        : resources.snapshot({ diskPath: executor.paths.root })?.disk;
      return d && Number.isFinite(d.free_bytes) ? d : null;
    } catch { return null; }
  };

  const startedJobs = () => read(repo => repo.listQueue({ host: rt.host, statuses: [...STARTED_JOB_STATUSES], limit: 50 }));

  // Move a job to a final status we decided (cancel, budget, interrupted), if it is still where we saw it.
  async function end(job, status, reason, kind, detail = {}) {
    return write((repo, at) => {
      if (!repo.updateJob(job.id, { status, ended_at: at, status_reason: reason }, job.status)) return false;
      event(repo, job.id, at, kind, { from: job.status, by: 'supervisor', reason, ...detail });
      return true;
    });
  }

  // 1. settle
  async function settle({ immediate = false } = {}) {
    for (const job of await startedJobs()) {
      const at = now();
      const r = executor.result(job);
      if (r.ok) {
        const summary = executor.summary(job);
        const after = await write((repo, t) => applyUnitResult(repo, repo.getJob(job.id), r.result, t, { summary, watchingSince }));
        inactiveSince.delete(job.id); lastDiskCheck.delete(job.id); stalled.delete(job.id); unmeasured.delete(job.id);
        view.last_result = { job_id: job.id, status: after.status, at: new Date(at).toISOString() };
        continue;
      }
      if (r.error === 'untrusted' && !rejectedStatus.has(job.id)) {
        // Never trusted, never retried as a status; journaled once.
        rejectedStatus.add(job.id);
        await write((repo, t) => event(repo, job.id, t, 'status_rejected', { detail: r.detail }));
      }
      const s = await executor.show(job);
      view.systemctl = s.ok ? { ok: true } : { ok: false, error: s.error };
      if (!s.ok) continue; // cannot tell; a reading error never ends a job
      if (s.active) {
        inactiveSince.delete(job.id); stalled.delete(job.id);
        // started_at is when the first unit of the job (the install, on the VPS) became active.
        const budget = job.timeout_ms + (executor.installBudgetMs ?? 0) + o.deadlineMarginMs;
        if (job.status === 'running' && Number.isInteger(job.started_at) && at > job.started_at + budget) {
          await end(job, 'timed_out', 'deadline_exceeded', 'timeout', { timeout_seconds: Math.round(job.timeout_ms / 1000) });
          continue;
        }
        if (job.status === 'dispatched') {
          await write((repo, t) => {
            if (repo.updateJob(job.id, { status: 'running', started_at: t }, 'dispatched')) {
              event(repo, job.id, t, 'started', { unit: job.unit, active_state: s.active_state });
            }
          });
        }
        continue;
      }
      if (job.status === 'dispatched' && executor.pendingDispatch(job)) {
        // The dispatcher has not taken the spool file yet.
        const since = await read(repo => repo.listJobEvents(job.id, 0, 1000).find(e => e.kind === 'dispatched')?.at ?? job.created_at);
        if (at - since > o.dispatchStallMs && !stalled.has(job.id)) {
          stalled.add(job.id);
          await write((repo, t) => event(repo, job.id, t, 'dispatch_stalled', { waited_seconds: Math.round((at - since) / 1000) }));
        }
        continue;
      }
      const first = inactiveSince.get(job.id) ?? at;
      inactiveSince.set(job.id, first);
      const grace = job.status === 'dispatched' ? o.dispatchGraceMs : (immediate ? 0 : o.interruptGraceMs);
      if (at - first < grace) continue;
      inactiveSince.delete(job.id);
      // Gone without a status written by root: the dispatcher refused it, or the unit was lost
      // (reboot without ExecStopPost, record-result failure).
      const ended = job.status === 'dispatched'
        ? await end(job, 'failed', 'dispatch_refused', 'dispatch_refused', { unit_state: s.active_state })
        : await end(job, 'interrupted', 'no_unit_status', 'interrupted', { unit_state: s.active_state });
      // The unit is inactive: nothing of it can hold the host any more.
      if (ended) await write((repo, t) => event(repo, job.id, t, 'no_unit', { unit_state: s.active_state }));
    }
  }

  // 2. lifecycle: code never runs, nor waits, without a live claim, workspace and worktree.
  async function lifecycle() {
    const at = now();
    const doomed = await read(repo => repo.listQueue({ host: rt.host, statuses: [...ACTIVE_JOB_STATUSES], limit: 500 }).map(job => {
      const workspace = repo.getWorkspace(job.workspace_id);
      const worktree = repo.getWorktree(job.worktree_id);
      const claim = job.claim_id ? repo.getClaim(job.claim_id) : null;
      const reason = workspace?.status !== 'active' ? 'workspace_closed'
        : worktree?.status !== 'active' ? 'worktree_removed'
          : !claim || claim.state !== 'claimed' ? 'claim_released'
            : Date.parse(claim.expires_at) <= at ? 'no_live_claim' : null;
      return reason ? { job, reason } : null;
    }).filter(Boolean));
    for (const { job, reason } of doomed) await end(job, 'cancelled', reason, 'cancelled');
  }

  // 3. disk budget. Fails closed (R-P4-06, scenario H): the job owns what it writes and can
  // make it unreadable to memo-runner (du partial) or slow to walk (du timeout). Such a reading
  // is "unmeasured"; max_unmeasured_readings in a row stop the job. A partial reading already
  // above the budget stops it at once (it is a lower bound). Independently of du, free disk on
  // the runner tree below min_free_disk_running_gib stops the running job on every tick: a
  // statfs(2) the job cannot influence, so production keeps room whatever du says.
  async function checkBudgets() {
    const budget = cfg.disk_budget_gib * 1024 ** 3;
    const floorGib = cfg.min_free_disk_running_gib ?? SUPERVISOR_DEFAULTS_DISK.min_free_disk_running_gib;
    const maxUnmeasured = cfg.max_unmeasured_readings ?? SUPERVISOR_DEFAULTS_DISK.max_unmeasured_readings;
    const running = (await startedJobs()).filter(j => j.status === 'running');
    if (!running.length) return;
    const free = diskFree();
    if (free) view.disk_free = { free_gib: Math.round(free.free_bytes / 1024 ** 3 * 100) / 100, floor_gib: floorGib };
    for (const job of running) {
      if (free && free.free_bytes < floorGib * 1024 ** 3) {
        await end(job, 'budget_exceeded', 'disk_floor', 'budget_exceeded', { free_bytes: free.free_bytes, floor_bytes: floorGib * 1024 ** 3 });
        continue;
      }
      const at = now();
      if (at - (lastDiskCheck.get(job.id) ?? 0) < o.diskCheckMs) continue;
      lastDiskCheck.set(job.id, at);
      const worktree = await read(repo => repo.getWorktree(job.worktree_id));
      // du -P never follows a symlink, operands included: measure the real worktree directory.
      let wt = null;
      try { wt = worktree?.path ? realpathSync(worktree.path) : null; } catch { wt = null; }
      const usage = await resources.usage([wt, dirname(executor.logPath(job))].filter(Boolean));
      if (usage) {
        view.disk = { job_id: job.id, used_gib: Math.round(usage.bytes / 1024 ** 3 * 100) / 100, budget_gib: cfg.disk_budget_gib,
          partial: usage.partial };
      }
      if (usage && usage.bytes > budget) {
        unmeasured.delete(job.id);
        await end(job, 'budget_exceeded', 'disk_budget', 'budget_exceeded', { used_bytes: usage.bytes, budget_bytes: budget, partial: usage.partial });
        continue;
      }
      if (usage && !usage.partial) { unmeasured.delete(job.id); continue; }
      const count = (unmeasured.get(job.id) ?? 0) + 1;
      unmeasured.set(job.id, count);
      const why = usage ? 'partial' : 'unavailable';
      if (count >= maxUnmeasured) {
        unmeasured.delete(job.id);
        await end(job, 'budget_exceeded', 'disk_unmeasurable', 'budget_exceeded', { readings: count, last: why,
          ...(usage ? { lower_bound_bytes: usage.bytes } : {}), budget_bytes: budget });
      } else {
        await write((repo, t) => event(repo, job.id, t, 'disk_unmeasured', { reading: count, of: maxUnmeasured, last: why }));
      }
    }
  }

  // 4. stop sweep: what we ended must not keep running.
  async function stopSweep() {
    const at = now();
    const candidates = await read(repo => ['cancelled', 'budget_exceeded', 'timed_out']
      .flatMap(status => repo.listJobs({ host: rt.host, status, limit: 50 }))
      .filter(job => job.unit && (job.ended_at ?? 0) > at - 24 * 3600_000)
      .map(job => {
        const events = repo.listJobEvents(job.id, 0, 1000);
        const kinds = new Set(events.map(e => e.kind));
        const lastStopAt = events.filter(e => e.kind === 'stop_requested').pop()?.at ?? null;
        return { job, dispatched: kinds.has('dispatched'), exited: kinds.has('exit') || kinds.has('no_unit'), stopRequested: lastStopAt !== null, lastStopAt };
      })
      .filter(c => c.dispatched && !c.exited));
    for (const { job, stopRequested, lastStopAt } of candidates) {
      // A status file may already be there: record it, nothing to stop.
      const r = executor.result(job);
      if (r.ok) {
        const summary = executor.summary(job);
        await write((repo, t) => applyUnitResult(repo, repo.getJob(job.id), r.result, t, { summary, watchingSince }));
        continue;
      }
      if (stopRequested) {
        if (at - Math.max(lastStopAt ?? 0, lastStop.get(job.id) ?? 0) < o.restopMs) continue;
        const s = await executor.show(job);
        if (!s.ok) continue;
        if (!s.active) {
          // Stopped, and root wrote nothing: close the follow-up so it is not retried forever.
          const first = inactiveSince.get(job.id) ?? at;
          inactiveSince.set(job.id, first);
          if (at - first >= o.interruptGraceMs) {
            inactiveSince.delete(job.id);
            await write((repo, t) => event(repo, job.id, t, 'no_unit', { unit_state: s.active_state }));
          }
          continue;
        }
      }
      lastStop.set(job.id, at);
      const stopped = executor.stop(job, { reason: job.status === 'budget_exceeded' ? 'budget_exceeded' : job.status_reason ?? 'cancelled' });
      await write((repo, t) => event(repo, job.id, t, 'stop_requested', { by: 'supervisor', ok: stopped.ok,
        withdrawn: Boolean(stopped.withdrawn), retry: stopRequested }));
    }
  }

  // 5. release_on_finish
  async function releaseFinished() {
    const at = now();
    const todo = await read(repo => repo.listJobs({ host: rt.host, limit: 200 })
      .filter(job => job.release_on_finish && !ACTIVE_JOB_STATUSES.includes(job.status) && job.claim_id
        && (job.ended_at ?? 0) > at - 24 * 3600_000)
      .map(job => {
        const events = repo.listJobEvents(job.id, 0, 1000);
        if (events.some(e => e.kind === 'released' || e.kind === 'release_skipped')) return null;
        const others = repo.listJobs({ claim_id: job.claim_id, limit: 1000 }).filter(j => ACTIVE_JOB_STATUSES.includes(j.status));
        if (others.length) return null; // the last job of the claim releases it
        return { job, attempts: events.filter(e => e.kind === 'release_failed').length,
          claim: repo.getClaim(job.claim_id), workspace: repo.getWorkspace(job.workspace_id) };
      }).filter(Boolean));
    for (const { job, attempts, claim, workspace } of todo) {
      const issue = claim ? parseIssueRef(claim.issue_ref) : null;
      if (!claim || claim.state !== 'claimed' || !workspace || !issue) {
        await write((repo, t) => event(repo, job.id, t, 'release_skipped', { reason: 'claim_not_held' }));
        continue;
      }
      const outcome = RELEASE_OUTCOME[job.status] ?? 'failed';
      let result;
      try { result = await rt.ledger.release(issue, workerFor(workspace), claim.claim_id, claim.fence_sha, outcome); } catch { result = { ok: false, error: 'ledger_unavailable' }; }
      await write((repo, t) => {
        const ids = { workspace_id: workspace.id, issue: issue.ref };
        if (result.ok) {
          repo.updateClaim(claim.claim_id, { state: 'released', outcome: `${outcome}: job ${job.id} ${job.status}`,
            fence_sha: result.receipt?.fence_sha ?? claim.fence_sha, updated_at: t }, claim.fence_sha);
          event(repo, job.id, t, 'released', { outcome });
          journal(repo, t, 'task_release', 'ok', null, ids);
        } else if (!TRANSIENT.has(result.error) || attempts + 1 >= o.releaseAttempts) {
          event(repo, job.id, t, 'release_skipped', { reason: result.error });
          journal(repo, t, 'task_release', TRANSIENT.has(result.error) ? 'error' : 'denied', result.error, ids);
        } else {
          event(repo, job.id, t, 'release_failed', { error: result.error });
        }
      });
    }
  }

  // A job we ended (cancel, budget, deadline) whose unit has not reported its end yet may still
  // be stopping (TimeoutStopSec=30): the host is not free until root wrote its status, or the
  // stop sweep closed the follow-up. The dispatcher would refuse the next job as host_busy.
  const unitsStopping = repo => ['cancelled', 'budget_exceeded', 'timed_out', 'interrupted']
    .flatMap(status => repo.listJobs({ host: rt.host, status, limit: 20 }))
    .some(job => {
      if (!job.unit) return false;
      const kinds = new Set(repo.listJobEvents(job.id, 0, 1000).map(e => e.kind));
      return kinds.has('dispatched') && !kinds.has('exit') && !kinds.has('no_unit');
    });

  // A job settled from its status file as soon as root wrote it is final in the store while its
  // unit is still deactivating (ExecStopPost=, record-result, cgroup teardown). The dispatcher
  // counts deactivating units as busy and would refuse the next job as host_busy, a permanent
  // failure (verifier finding 6). So before a dispatch, every recently ended unit must be seen
  // inactive by systemd; once seen, it is not asked again. A reading error waits too.
  const seenInactive = new Set();
  async function recentUnitBusy() {
    const at = now();
    const recent = await read(repo => repo.listJobs({ host: rt.host, limit: 20 })
      .filter(job => job.unit && !ACTIVE_JOB_STATUSES.includes(job.status) && !seenInactive.has(job.id)
        && (job.ended_at ?? 0) > at - 3600_000)
      .filter(job => repo.listJobEvents(job.id, 0, 1000).some(e => e.kind === 'dispatched')));
    for (const job of recent) {
      const s = await executor.show(job);
      if (!s.ok || s.active) {
        view.waiting_for_unit = { job_id: job.id, state: s.ok ? s.active_state : null, error: s.ok ? null : s.error };
        return true;
      }
      seenInactive.add(job.id);
    }
    view.waiting_for_unit = null;
    return false;
  }

  // 6. dispatch
  async function dispatchNext() {
    const head = await read(repo => {
      if (repo.countJobs({ host: rt.host, statuses: [...STARTED_JOB_STATUSES] }) >= o.concurrency) return null;
      if (unitsStopping(repo)) return null;
      return repo.listQueue({ host: rt.host, statuses: [...WAITING_JOB_STATUSES], limit: 1 })[0] ?? null;
    });
    if (!head) return;
    if (await recentUnitBusy()) return;
    const at = now();
    if (head.status === 'deferred') {
      const last = await read(repo => repo.listJobEvents(head.id, 0, 1000).filter(e => e.kind === 'deferred').pop()?.at ?? 0);
      const evaluated = Math.max(last, view.admission?.job_id === head.id ? view.admission.at_ms : 0);
      if (at - evaluated < o.deferRetryMs) return;
    }
    const defer = async (reason, detail) => {
      view.admission = { job_id: head.id, at_ms: at, at: new Date(at).toISOString(), ok: false, reason, detail, ...view.admission?.snapshot ? { snapshot: view.admission.snapshot } : {} };
      await write((repo, t) => {
        const current = repo.getJob(head.id);
        if (!current || !WAITING_JOB_STATUSES.includes(current.status)) return;
        if (current.status === 'deferred' && current.status_reason === reason) return; // still deferred, same reason
        if (repo.updateJob(head.id, { status: 'deferred', status_reason: reason }, current.status)) {
          event(repo, head.id, t, 'deferred', { reason, detail });
        }
      });
    };

    const snapshot = resources.snapshot({ diskPath: executor.paths.root });
    const decision = admit(snapshot, cfg.admission);
    view.admission = { job_id: head.id, at_ms: at, at: new Date(at).toISOString(), ok: decision.ok,
      ...(decision.ok ? {} : { reason: decision.reason, detail: decision.detail }), snapshot: summarizeSnapshot(snapshot) };
    if (!decision.ok) return defer(decision.reason, decision.detail);

    // Running code is a write boundary: the ledger confirms the lease is still this workspace's.
    const ctx = await read(repo => ({ workspace: repo.getWorkspace(head.workspace_id), worktree: repo.getWorktree(head.worktree_id),
      claim: head.claim_id ? repo.getClaim(head.claim_id) : null }));
    const issue = ctx.claim ? parseIssueRef(ctx.claim.issue_ref) : null;
    if (!ctx.workspace || !ctx.worktree || !ctx.claim || !issue) return; // lifecycle cancels it next tick
    let verified;
    try { verified = await rt.ledger.verify(issue, workerFor(ctx.workspace), ctx.claim.claim_id, ctx.claim.fence_sha); } catch { verified = null; }
    view.ledger = { reachable: Boolean(verified?.ok) || !TRANSIENT.has(verified?.error ?? 'ledger_unavailable'), at: new Date(now()).toISOString(),
      ...(verified?.ok ? {} : { error: verified?.error ?? 'ledger_unavailable' }) };
    if (!verified?.ok) {
      const error = verified?.error ?? 'ledger_unavailable';
      if (TRANSIENT.has(error)) return defer('deferred_ledger', error);
      await end(head, 'cancelled', error, 'cancelled');
      return;
    }
    let worktreePath;
    try {
      worktreePath = realpathSync(ctx.worktree.path);
      if (!statSync(worktreePath).isDirectory()) throw new Error('not_a_directory');
    } catch {
      await end(head, 'failed', 'worktree_unavailable', 'dispatch_failed');
      return;
    }

    // A unit that already ran or runs for this job (a crash between the spool write and the
    // compare-and-set below, before a restart) is followed, never started a second time.
    let already = executor.result(head).ok;
    if (!already) { const s = await executor.show(head); already = s.ok && s.active; }
    if (already) {
      await write((repo, t) => {
        if (repo.updateJob(head.id, { status: 'dispatched', status_reason: null }, head.status)) {
          event(repo, head.id, t, 'dispatched', { unit: head.unit, recovered: true });
        }
      });
      await settle();
      return;
    }

    // Spool first, then the compare-and-set: a crash in between leaves a queued job whose unit
    // the check above finds on the next start; a cancel in between withdraws the spool file.
    const launched = await executor.launch({ job: head, worktreePath });
    if (!launched.ok) return defer('deferred_spool', launched.error);
    const taken = await write((repo, t) => {
      if (repo.countJobs({ host: rt.host, statuses: [...STARTED_JOB_STATUSES] }) >= o.concurrency) return false;
      const current = repo.getJob(head.id);
      if (!current || !WAITING_JOB_STATUSES.includes(current.status)) return false;
      if (!repo.updateJob(head.id, { status: 'dispatched', status_reason: null }, current.status)) return false;
      event(repo, head.id, t, 'dispatched', { unit: launched.unit, admission: summarizeSnapshot(snapshot) });
      journal(repo, t, 'job_dispatch', 'ok', null, { workspace_id: head.workspace_id, issue: issue.ref });
      return true;
    });
    if (!taken) {
      const stopped = executor.stop(head);
      await write((repo, t) => event(repo, head.id, t, 'stop_requested', { by: 'supervisor', ok: stopped.ok, withdrawn: Boolean(stopped.withdrawn), reason: 'dispatch_race' }));
    }
  }

  async function refreshView() {
    const at = now();
    const snapshot = await read(repo => ({
      waiting: repo.listQueue({ host: rt.host, statuses: [...WAITING_JOB_STATUSES], limit: 500 }),
      started: repo.listQueue({ host: rt.host, statuses: [...STARTED_JOB_STATUSES], limit: 10 })
    }));
    view.last_tick_at = new Date(at).toISOString();
    view.queue_depth = snapshot.waiting.length;
    view.deferred = snapshot.waiting.filter(j => j.status === 'deferred').length;
    const a = snapshot.started[0];
    view.active = a ? { job_id: a.id, status: a.status, unit: a.unit, started_at: a.started_at ? new Date(a.started_at).toISOString() : null } : null;
    view.dispatcher = { stalled: stalled.size > 0 };
    if (at - lastPrune > 3600_000) {
      lastPrune = at;
      await write((repo, t) => repo.pruneRequests(t - o.requestRetentionMs));
    }
  }

  async function runTick({ immediate = false } = {}) {
    for (const [name, step] of [['settle', () => settle({ immediate })], ['lifecycle', lifecycle], ['budgets', checkBudgets],
      ['stop', stopSweep], ['release', releaseFinished], ['dispatch', dispatchNext], ['view', refreshView]]) {
      try { await step(); } catch (error) { view.errors++; log(`supervisor ${name}: ${error?.code ?? error?.message ?? 'error'}`); }
    }
  }

  // Lease renewal (REQ-P4-05).
  async function renewOnce() {
    const ttl = cfg.lease_ttl_seconds ?? 1800;
    const claims = await read(repo => {
      const ids = [...new Set(repo.listQueue({ host: rt.host, statuses: [...ACTIVE_JOB_STATUSES], limit: 500 }).map(j => j.claim_id).filter(Boolean))];
      return ids.map(id => {
        const claim = repo.getClaim(id);
        return claim ? { claim, workspace: repo.getWorkspace(claim.workspace_id) } : null;
      }).filter(Boolean);
    });
    for (const { claim, workspace } of claims) {
      if (claim.state !== 'claimed' || !workspace) continue;
      const at = now();
      if (Date.parse(claim.expires_at) - at >= (ttl * 1000) / 3) continue;
      const issue = parseIssueRef(claim.issue_ref);
      if (!issue) continue;
      const worker = workerFor(workspace);
      let r;
      try { r = await rt.ledger.heartbeat(issue, worker, claim.claim_id, claim.fence_sha, ttl); } catch { r = { ok: false, error: 'ledger_unavailable' }; }
      let receipt = r.ok ? r.receipt : null;
      if (!r.ok && r.error === 'ledger_outcome_unknown') {
        // The heartbeat may have landed: ask the ledger who holds the Issue now.
        let st;
        try { st = await rt.ledger.status(issue); } catch { st = null; }
        const h = st?.ok ? st.receipt : null;
        if (h && h.state === 'claimed' && !h.expired && h.worker === worker && h.claim_id === claim.claim_id) receipt = h;
      }
      const ids = { workspace_id: workspace.id, issue: issue.ref };
      if (receipt?.fence_sha && receipt?.expires_at) {
        view.ledger = { reachable: true, at: new Date(now()).toISOString() };
        await write((repo, t) => {
          if (!repo.updateClaim(claim.claim_id, { fence_sha: receipt.fence_sha, expires_at: receipt.expires_at, updated_at: t }, claim.fence_sha)) return;
          for (const job of repo.listJobs({ claim_id: claim.claim_id, limit: 1000 }).filter(j => ACTIVE_JOB_STATUSES.includes(j.status))) {
            event(repo, job.id, t, 'lease_renewed', { expires_at: receipt.expires_at });
          }
          journal(repo, t, 'task_renew', 'ok', null, ids);
        });
        continue;
      }
      const error = r.ok ? 'invalid_receipt' : r.error;
      if (TRANSIENT.has(error) || error === 'invalid_receipt') {
        view.ledger = { reachable: false, at: new Date(now()).toISOString(), error };
        await write((repo, t) => journal(repo, t, 'task_renew', 'error', error, ids));
        continue; // retried next round; lifecycle cancels the jobs if the claim expires meanwhile
      }
      // Definitive: the lease is no longer ours (stale_lease, taken over). Its jobs stop.
      view.ledger = { reachable: true, at: new Date(now()).toISOString() };
      await write((repo, t) => {
        for (const job of repo.listJobs({ claim_id: claim.claim_id, limit: 1000 }).filter(j => ACTIVE_JOB_STATUSES.includes(j.status))) {
          if (repo.updateJob(job.id, { status: 'cancelled', ended_at: t, status_reason: error }, job.status)) {
            event(repo, job.id, t, 'cancelled', { from: job.status, by: 'supervisor', reason: error });
          }
        }
        journal(repo, t, 'task_renew', 'denied', error, ids);
      });
    }
    // Stop the units of what was just cancelled without waiting for the next tick.
    await stopSweep().catch(() => {});
  }

  const supervisor = {
    options: o,
    // One tick at a time; a nudge during a tick runs one more right after.
    tick(opts) {
      if (ticking) { again = true; return ticking; }
      ticking = (async () => {
        try {
          do { again = false; await runTick(opts); } while (again);
        } finally { ticking = null; }
      })();
      return ticking;
    },
    renewLeases() {
      renewing ??= renewOnce().catch(() => { view.errors++; }).finally(() => { renewing = null; });
      return renewing;
    },
    async reconcileOnStart() {
      view.started_at = new Date(now()).toISOString();
      await supervisor.tick({ immediate: true });
    },
    async start() {
      setRunnerStatusProvider(supervisor.status);
      setSupervisorNudge(() => { supervisor.tick().catch(() => {}); });
      await supervisor.reconcileOnStart();
      await supervisor.renewLeases();
      intervals = [
        timers.setInterval(() => { supervisor.tick().catch(() => {}); }, o.pollMs),
        timers.setInterval(() => { supervisor.renewLeases(); }, o.renewEveryMs)
      ];
      for (const i of intervals) i?.unref?.();
      return supervisor;
    },
    async stop() {
      for (const i of intervals) timers.clearInterval(i);
      intervals = [];
      setSupervisorNudge(null);
      setRunnerStatusProvider(null);
      if (runnerWatchStart() === watchingSince) setRunnerWatchStart(null);
      await Promise.allSettled([ticking, renewing].filter(Boolean));
    },
    // Synchronous view for host_resources (REQ-P4-21): numbers and ids only.
    status() {
      const { admission, ...rest } = view;
      return { executor: 'systemd', concurrency: o.concurrency, ...rest,
        admission: admission ? { job_id: admission.job_id, at: admission.at, ok: admission.ok, reason: admission.reason ?? null,
          detail: admission.detail ?? null, snapshot: admission.snapshot ?? null } : null };
    }
  };
  return supervisor;
}

// For the runner process (agent-cli runtime mode, TODO-P4-05): build the systemd executor and
// the supervisor from the environment and start them. Returns null on a host that does not use
// the systemd executor, so the Mac never starts a supervisor.
// Misconfiguration (executor, runner tree) throws, so the unit fails and restarts visibly
// instead of serving a runner that cannot run jobs. `os`, `run` and `resources` are for tests.
export async function startSupervisorFromEnv(rt, env = process.env, { log, os, run, resources, timers } = {}) {
  const kind = executorKindFromEnv(env, ...(os ? [os] : []));
  if (!kind.ok) throw new Error(`${kind.error}: ${kind.detail ?? ''}`);
  if (kind.kind !== 'systemd') return null;
  const root = runnerRootFromEnv(env);
  if (!root.ok) throw new Error(`${root.error}: ${root.detail}`);
  const config = loadRunnerConfig(env.MEMO_BRIDGE_RUNNER_CONFIG);
  if (config.errors.length) log?.('runner_config_errors', { keys: config.errors });
  const executor = createSystemdExecutor({ root: root.root, maxQueue: config.max_queue, ...(run ? { run } : {}),
    policy: { recipes: config.recipes, max_timeout_seconds: config.max_timeout_seconds },
    limits: { slice: 'memo-dev.slice', disk_budget_gib: config.disk_budget_gib } });
  const supervisor = createSupervisor(rt, { executor, config, ...(log ? { log } : {}), ...(resources ? { resources } : {}),
    ...(timers ? { timers } : {}),
    options: { deferRetryMs: config.defer_retry_seconds * 1000, diskCheckMs: config.du_interval_seconds * 1000 } });
  return supervisor.start();
}
