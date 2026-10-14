// Learning review (#38), after Hermes Agent's periodic nudges and background review (research
// 2026-10-14-hermes-agent-ideas.md sections 1.3 and 1.4, idea 2). Memo Bridge calls no model: it counts,
// and at the right moment a tool result carries a short, fixed `learning_review` block asking the
// conversation itself to review what it learned. Nothing is stored unless the conversation calls
// memory_save.
//
// Counters, per workspace, in the store (continuity-store.mjs), one write transaction per call:
//  - tool_calls: runtime tool calls naming the workspace (server/tools/learning-hook.mjs);
//  - user_turns: Memo Bridge never sees a user turn. A turn is estimated as a call that comes at
//    least TURN_GAP_MS after the previous call of that workspace (the first call counts as one).
//    An inference, reported as user_turns_estimated.
// Both reset on a successful memory_save naming the workspace, and when a block is returned.
// The block comes back:
//  - on the call that brings tool_calls to the call threshold or user_turns to the turn threshold
//    (MEMO_BRIDGE_LEARNING_CALLS, default 40; MEMO_BRIDGE_LEARNING_TURNS, default 10; 0 disables
//    that counter, both 0 disable the block entirely);
//  - on a successful task_complete, task_release or workspace_close, when at least one call
//    happened since the last memory write or block (right after a memory_save it does not).
// The block is server text only: enums and integers are its only variable parts, so no Issue,
// file or result text can ever reach it.
import { ownsWorkspace } from './policy.mjs';

export const LEARNING_DEFAULTS = Object.freeze({ turns: 10, calls: 40 });
export const TURN_GAP_MS = 90_000;
export const END_OPS = Object.freeze(['task_complete', 'task_release', 'workspace_close']);
export const LEARNING_REASONS = Object.freeze(['end_of_task', 'tool_calls', 'user_turns']);
export const LEARNING_REVIEW_MAX_BYTES = 1536;
const END = new Set(END_OPS);
const WS_RE = /^ws_[A-Za-z0-9_-]{16}$/;
// Refusals that say the call was not this workspace's conversation acting on it: not counted.
const NOT_COUNTED = new Set(['forbidden', 'unknown_workspace', 'workspace_other_session', 'session_required', 'session_mismatch']);

// Thresholds from the environment: an integer 0 to 10000, anything else keeps the default.
export function learningThresholds(env = process.env) {
  const parse = (raw, fallback) => {
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : fallback;
  };
  return Object.freeze({ turns: parse(env.MEMO_BRIDGE_LEARNING_TURNS, LEARNING_DEFAULTS.turns),
    calls: parse(env.MEMO_BRIDGE_LEARNING_CALLS, LEARNING_DEFAULTS.calls) });
}

const SIGNALS = Object.freeze([
  'the owner corrected the form, format or length of your answers',
  'the owner corrected your approach',
  'a non-trivial technique or fix emerged',
  'a skill or instruction you followed was wrong or incomplete'
]);
const DO_NOT_CAPTURE = Object.freeze([
  'environment failures (missing binary, missing credential)',
  'claims that a tool does not work, without evidence',
  'transient errors',
  'one-off task narratives',
  'unresolved failures presented as a method'
]);

// The block. Only `reason` (an enum) and the two integers vary.
export function learningReview(reason, { calls, turns }) {
  if (!LEARNING_REASONS.includes(reason)) throw new Error('invalid_reason');
  const count = n => (Number.isInteger(n) && n >= 0 ? Math.min(n, 1_000_000) : 0);
  return {
    reason,
    since_last_review: { tool_calls: count(calls), user_turns_estimated: count(turns) },
    ask: 'Review this conversation once, then go on. Memo Bridge saves nothing by itself.',
    signals: SIGNALS,
    save: 'For each signal, a durable fact a later conversation needs: memory_save with workspace_id. Facts, not orders; ' +
      'no secrets; scope owner for the owner, environment for a project or host.',
    skill: 'A skill or instruction was wrong or missing: write the fix as Issue or PR text for the owner. Prefer: patch the ' +
      'skill used, then a broader one, then add a reference file, a new skill last.',
    do_not_capture: DO_NOT_CAPTURE,
    nothing_to_save: 'Nothing qualifies: say "nothing to save" in one line and go on.'
  };
}

const fresh = workspaceId => ({ workspace_id: workspaceId, tool_calls: 0, user_turns: 0, last_call_at: null, last_write_at: null,
  last_review_at: null, reviews: 0 });

// One call on a counter row -> {next, reason|null, calls, turns}. Pure: the decision, no storage.
export function advance(row, { op, ok, at, thresholds }) {
  if (op === 'memory_save' && ok) {
    return { next: { ...row, tool_calls: 0, user_turns: 0, last_call_at: at, last_write_at: at }, reason: null, calls: 0, turns: 0 };
  }
  const newTurn = row.last_call_at === null || row.last_call_at === undefined || at - row.last_call_at >= TURN_GAP_MS;
  const calls = row.tool_calls + 1;
  const turns = row.user_turns + (newTurn ? 1 : 0);
  let reason = null;
  if (END.has(op) && ok && row.tool_calls > 0) reason = 'end_of_task';
  else if (thresholds.calls > 0 && calls >= thresholds.calls) reason = 'tool_calls';
  else if (thresholds.turns > 0 && turns >= thresholds.turns) reason = 'user_turns';
  const next = reason
    ? { ...row, tool_calls: 0, user_turns: 0, last_call_at: at, last_review_at: at, reviews: (row.reviews ?? 0) + 1 }
    : { ...row, tool_calls: calls, user_turns: turns, last_call_at: at };
  return { next, reason, calls, turns };
}

// read(fn) and write(fn) are the coordinator's transactions (fn(repo, now)); principal the caller.
export function createLearning({ write, principal, thresholds = learningThresholds() }) {
  const enabled = thresholds.turns > 0 || thresholds.calls > 0;

  // One counted call: {workspace_id?, op, result} and the request metadata. Returns the block to
  // add to the result, or null. A remote call without workspace_id counts against the active
  // workspace bound to its conversation.
  async function tick({ workspace_id: workspaceId, op, result }, meta = {}) {
    if (!enabled || typeof op !== 'string') return null;
    const ok = result?.ok !== false;
    if (!ok && NOT_COUNTED.has(result?.error)) return null;
    const session = typeof meta?.client_session === 'string' ? meta.client_session : null;
    if (!WS_RE.test(workspaceId ?? '') && !session) return null;
    return write((repo, at) => {
      let workspace = WS_RE.test(workspaceId ?? '') ? repo.getWorkspace(workspaceId) : null;
      if (!workspace && !WS_RE.test(workspaceId ?? '') && session) workspace = repo.sessionWorkspace(principal.id, session);
      if (!ownsWorkspace(principal, workspace)) return null;
      if (workspace.status !== 'active' && !END.has(op)) return null;
      const row = repo.getLearning(workspace.id) ?? fresh(workspace.id);
      const step = advance(row, { op, ok, at, thresholds });
      repo.putLearning(step.next);
      return step.reason ? learningReview(step.reason, step) : null;
    });
  }

  return Object.freeze({ tick, thresholds, enabled });
}
