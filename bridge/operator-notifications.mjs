// Job completion notifications (issue #35, spec .agent/project/notify-tail).
//
// A background operator run (operator_run, operator_script with background: true) or a runtime
// job (jobs_submit) started with notify: true is watched by the hub until it ends. Then:
//  - one notification lands in the inbox of the principal that started it (the last
//    INBOX_PER_PRINCIPAL per principal, in memory: same lifetime as approvals, grants and locks;
//    the job's own result stays on its host and in the runtime store, so a hub restart loses a
//    notice, never a result);
//  - the hub's Telegram bot sends ONE short message to the owner's private chat (status, duration,
//    a few redacted output lines, the job id). No tool names a recipient: the bot only knows the
//    owner chat. Without a bot, or when Telegram fails, the notice is still in the inbox and the
//    failure is journaled (notification_unsent).
// The watch polls the job's own read tool with the starter's principal: operator_job_status
// (signed, T0) for operator runs, job_status for runtime jobs; less often as the job gets older. A watch that outlives its job's
// timeout by WATCH_GRACE_MS ends as watch_expired; a job that keeps answering a permanent error
// (unknown_job, forbidden) ends as unknown after MAX_POLL_ERRORS polls.
import { randomBytes } from 'node:crypto';
import { redactSecrets } from './operator-output.mjs';

export const NOTIFY_LIMITS = Object.freeze({ perPrincipal: 50, principals: 256, watches: 200, watchesPerPrincipal: 20, pollMs: 20_000,
  tailLines: 20, tailChars: 2000, telegramLines: 5, telegramLineChars: 160, getDefault: 10, getMax: 50, ackMax: 50 });
export const NOTIFICATION_ID_RE = /^nt_[A-Za-z0-9_-]{16,40}$/;
const WATCH_GRACE_MS = 30 * 60_000;
const RUNTIME_QUEUE_MS = 4 * 3600_000;
const MAX_POLL_ERRORS = 3;
const TRANSIENT = new Set(['host_offline', 'timeout', 'agent_busy', 'agent_disconnected', 'shutting_down', 'store_unavailable', 'internal_error',
  'frozen', 'rate_limited', 'audit_unavailable']);
const RUNTIME_ACTIVE = new Set(['queued', 'deferred', 'dispatched', 'running']);

// The last `max` non-empty lines of a text, each cut at `chars`, secrets redacted.
export function outputTail(text, max = NOTIFY_LIMITS.tailLines, chars = 400) {
  if (typeof text !== 'string' || !text) return '';
  const lines = redactSecrets(text).text.replace(/\r/g, '').split('\n').map(l => l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')).filter(l => l.trim());
  return lines.slice(-max).map(l => (l.length > chars ? `${l.slice(0, chars)}...` : l)).join('\n');
}

const iso = ms => new Date(ms).toISOString();
export const formatDuration = ms => {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

// An operator_job_status answer -> {done, status, exit_code, duration_ms, tail} or {done:false}.
export function operatorOutcome(out) {
  if (!out || out.ok === false) return { done: false, error: out?.error ?? 'invalid' };
  if (out.status === 'running') return { done: false };
  if (out.status === 'lost') return { done: true, status: 'lost', exit_code: null, duration_ms: null, tail: '' };
  if (out.status !== 'done') return { done: false, error: 'invalid' };
  const status = out.timed_out ? 'timed_out' : out.exit_code === 0 ? 'succeeded' : 'failed';
  // The agent answers the output as untrusted_content {stdout, stderr} (bridge/operator-exec.mjs).
  const io = out.untrusted_content && typeof out.untrusted_content === 'object' ? out.untrusted_content : out;
  const stderr = typeof io.stderr === 'string' ? io.stderr : '';
  const stdout = typeof io.stdout === 'string' ? io.stdout : '';
  const text = status !== 'succeeded' && stderr.trim() ? stderr : stdout.trim() ? stdout : stderr;
  return { done: true, status, exit_code: Number.isInteger(out.exit_code) ? out.exit_code : null,
    duration_ms: Number.isFinite(out.duration_ms) ? out.duration_ms : null, tail: outputTail(text.replace(/^\[\.\.\. \d+ bytes before \.\.\.\]\n/, '')) };
}

// A job_status answer of the runtime -> the same shape.
export function runtimeOutcome(out) {
  const job = out?.ok === true ? out.job : null;
  if (!job) return { done: false, error: out?.error ?? 'invalid' };
  if (RUNTIME_ACTIVE.has(job.status)) return { done: false };
  const start = Date.parse(job.started_at ?? job.created_at ?? '');
  const end = Date.parse(job.ended_at ?? '');
  return { done: true, status: String(job.status).slice(0, 32), exit_code: Number.isInteger(job.exit_code) ? job.exit_code : null,
    duration_ms: Number.isFinite(start) && Number.isFinite(end) ? end - start : null, tail: outputTail(job.summary ?? '') };
}

// The Telegram text of one notification: short, no recipient, secrets redacted again.
export function telegramText(n) {
  const tail = n.output_tail ? n.output_tail.split('\n').slice(-NOTIFY_LIMITS.telegramLines)
    .map(l => (l.length > NOTIFY_LIMITS.telegramLineChars ? `${l.slice(0, NOTIFY_LIMITS.telegramLineChars)}...` : l)) : [];
  return redactSecrets([
    `Memo Bridge job ${n.status}`,
    `host: ${n.host}   ${n.kind === 'runtime' ? `recipe: ${n.label}` : `op: ${n.label}`}`,
    `job: ${n.job_id}`,
    `${n.exit_code === null ? 'no exit code' : `exit ${n.exit_code}`} after ${formatDuration(n.duration_ms)}`,
    `principal: ${n.principal}`,
    ...(tail.length ? ['last lines:', ...tail] : [])
  ].join('\n')).text.slice(0, 1500);
}

// poll(watch) -> the job's raw status answer (hub-provided, per kind). send(notification) -> the
// bot's notifyJob, or null when there is no bot. record(event, details) -> the hub journal.
export function createNotifier({ poll, send = () => null, record = () => {}, now = Date.now, random = randomBytes, limits = {} } = {}) {
  const L = { ...NOTIFY_LIMITS, ...limits };
  const inboxes = new Map(); // principal id -> notification[] (oldest first)
  const watches = new Map(); // `${kind}:${job_id}` -> watch
  let timer = null;
  let polling = false;

  function inboxOf(principalId, create = false) {
    let box = inboxes.get(principalId);
    if (!box && create) {
      box = [];
      inboxes.set(principalId, box);
      // The principal seen longest ago goes first.
      while (inboxes.size > L.principals) inboxes.delete(inboxes.keys().next().value);
    }
    return box ?? [];
  }

  // watch: {kind: 'operator'|'runtime', host, job_id, label, principal, timeout_s, clientSession?}.
  function watch(w) {
    const key = `${w.kind}:${w.job_id}`;
    if (watches.has(key)) return { registered: true, already: true };
    if (watches.size >= L.watches) return { registered: false, reason: 'too_many_watches' };
    const mine = [...watches.values()].filter(x => x.principal.id === w.principal.id).length;
    if (mine >= L.watchesPerPrincipal) return { registered: false, reason: 'too_many_watches' };
    const started = now();
    const budget = (Number.isInteger(w.timeout_s) ? w.timeout_s : 900) * 1000 + WATCH_GRACE_MS + (w.kind === 'runtime' ? RUNTIME_QUEUE_MS : 0);
    watches.set(key, { ...w, started, deadline: started + budget, errors: 0, nextAt: 0 });
    record('notify_watch', { kind: w.kind, host: w.host, job_id: w.job_id, principal: w.principal.id });
    return { registered: true };
  }

  async function complete(w, outcome) {
    watches.delete(`${w.kind}:${w.job_id}`);
    const n = { notification_id: `nt_${random(12).toString('base64url')}`, kind: w.kind, host: w.host, job_id: w.job_id, label: w.label,
      status: outcome.status, exit_code: outcome.exit_code ?? null, duration_ms: outcome.duration_ms ?? null, ended_at: iso(now()),
      output_tail: (outcome.tail ?? '').slice(-L.tailChars), principal: w.principal.id, acked: false, telegram: 'pending' };
    const box = inboxOf(w.principal.id, true);
    box.push(n);
    while (box.length > L.perPrincipal) box.shift();
    let sending = null;
    try { sending = send(n); } catch { sending = Promise.reject(new Error('telegram_error')); }
    if (!sending) {
      n.telegram = 'unavailable';
      record('notification_unsent', { notification_id: n.notification_id, job_id: n.job_id, principal: n.principal, reason: 'telegram_unavailable' });
    } else {
      try {
        await sending;
        n.telegram = 'sent';
        record('notification_sent', { notification_id: n.notification_id, job_id: n.job_id, principal: n.principal, status: n.status });
      } catch (error) {
        n.telegram = 'failed';
        record('notification_unsent', { notification_id: n.notification_id, job_id: n.job_id, principal: n.principal,
          reason: String(error?.message ?? 'telegram_error').split(':').slice(0, 2).join(':').slice(0, 64) });
      }
    }
    return n;
  }

  async function pollOnce() {
    if (polling) return 0;
    polling = true;
    let ended = 0;
    try {
      for (const w of [...watches.values()]) {
        if (w.nextAt > now()) continue;
        let outcome;
        try { outcome = (w.kind === 'runtime' ? runtimeOutcome : operatorOutcome)(await poll(w)); } catch { outcome = { done: false, error: 'internal_error' }; }
        if (outcome.done) { await complete(w, outcome); ended++; continue; }
        if (outcome.error && !TRANSIENT.has(outcome.error)) w.errors++;
        else if (!outcome.error) w.errors = 0;
        if (w.errors >= MAX_POLL_ERRORS) { await complete(w, { status: 'unknown', tail: '' }); ended++; continue; }
        if (now() > w.deadline) { await complete(w, { status: 'watch_expired', tail: '' }); ended++; continue; }
        // Every poll of an operator job is a line in both journals: every tick for 2 min, then
        // once a minute, then every 2 min after 15 min.
        const age = now() - w.started;
        w.nextAt = age < 120_000 ? 0 : now() + (age < 900_000 ? 60_000 : 120_000);
      }
    } finally { polling = false; }
    return ended;
  }

  const view = n => ({ notification_id: n.notification_id, kind: n.kind, host: n.host, job_id: n.job_id, label: n.label, status: n.status,
    exit_code: n.exit_code, duration_ms: n.duration_ms, ended_at: n.ended_at, acked: n.acked, telegram: n.telegram, output_tail: n.output_tail });

  return Object.freeze({
    watch, pollOnce, complete,
    get watching() { return watches.size; },
    // Counts for one principal (notifications_check, sessions_overview).
    check(principalId) {
      const box = inboxOf(principalId);
      const unread = box.filter(n => !n.acked);
      return { ok: true, unread: unread.length, total: box.length, watching: [...watches.values()].filter(w => w.principal.id === principalId).length,
        latest_unread_at: unread.length ? unread[unread.length - 1].ended_at : null };
    },
    // Newest first; unread only unless include_acked; one by id.
    get(principalId, { notification_id: id, limit, include_acked: all = false } = {}) {
      const box = inboxOf(principalId);
      if (id !== undefined) {
        const n = box.find(x => x.notification_id === id);
        return n ? { ok: true, notifications: [view(n)] } : { ok: false, error: 'unknown_notification' };
      }
      const max = Math.min(Number.isInteger(limit) ? limit : L.getDefault, L.getMax);
      const list = box.filter(n => all || !n.acked).reverse().slice(0, max).map(view);
      return { ok: true, notifications: list, unread: box.filter(n => !n.acked).length, total: box.length };
    },
    // Acknowledged notices leave the unread count; they stay readable with include_acked until
    // the inbox bound pushes them out.
    ack(principalId, { notification_ids: ids, all = false } = {}) {
      const box = inboxOf(principalId);
      if (all !== true && !(Array.isArray(ids) && ids.length)) return { ok: false, error: 'invalid_arguments', detail: 'notification_ids or all: true' };
      let acked = 0; const unknown = [];
      if (all === true) for (const n of box) { if (!n.acked) { n.acked = true; acked++; } }
      else for (const id of ids.slice(0, L.ackMax)) {
        const n = box.find(x => x.notification_id === id);
        if (!n) unknown.push(id); else if (!n.acked) { n.acked = true; acked++; }
      }
      return { ok: true, acked, unread: box.filter(n => !n.acked).length, ...(unknown.length ? { unknown } : {}) };
    },
    start(pollMs = L.pollMs) {
      if (timer || !(pollMs > 0)) return;
      timer = setInterval(() => { pollOnce().catch(() => {}); }, pollMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; }
  });
}
