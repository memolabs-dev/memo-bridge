// Kill switch and rate limits on the operator agent (Phase 6, TODO-P6-07, spec D6).
//
// Checked on every call, after the signature and before anything runs:
//  - FROZEN file: when policy.frozen_file exists (any type, any content), every op above T0
//    answers `frozen`. /etc/memo-operator/FROZEN on lab (root-owned directory, so only root
//    creates or removes it), ~/.memo-operator/FROZEN on the Mac. Checked with one lstat per
//    call: no cache, so `touch` takes effect on the next call (R-P6-06 "within one call");
//  - auto-freeze: 5 signature or policy refusals within 5 minutes freeze the agent above T0.
//    The flag is kept in memory and written to a marker file in the state directory
//    (auto_frozen_file), so a restart does not clear it. The owner clears it by removing the
//    marker over SSH, or with Telegram /unfreeze from the owner chat, which the hub turns into
//    a signed internal op (operator_owner_unfreeze) no model can call (Lot 2);
//  - per-tier rate limits (T1 120/min, T2 60/min, T3 20/min by default, policy.rate_limits),
//    sliding window per host. T0 is not rate limited here (spec D6); the hub's own limiter
//    (bridge/ratelimit.mjs) still counts it.
// The hub keeps its own freeze flag on top (bridge/hub.mjs, owner-only setter).
import { lstatSync, unlinkSync, writeFileSync } from 'node:fs';
import { SIGNATURE_REFUSALS } from './operator-signing.mjs';

export const AUTO_FREEZE = Object.freeze({ refusals: 5, windowMs: 5 * 60_000 });
const RATE_WINDOW_MS = 60_000;
const TIER_KEYS = Object.freeze([null, 'write', 'exec', 'root']);

// Refusals that count towards auto-freeze: every signature refusal except a full nonce cache
// (load, not forgery), a tier above the local policy, and a secret path request.
export const COUNTED_REFUSALS = Object.freeze(new Set([
  ...SIGNATURE_REFUSALS.filter(code => code !== 'nonce_cache_full'), 'tier_not_allowed', 'tier_mismatch', 'path_secret',
  'approval_required'
]));

const exists = path => {
  try { lstatSync(path); return true; } catch (error) { return error?.code !== 'ENOENT'; }
};

// policy: the parsed policy (frozenFile, rateLimits). Options:
//   autoFrozenFile  marker path (null: memory only)
//   extraFrozenFiles  more FROZEN switches, each checked like policy.frozen_file (the Mac root
//                   helper also obeys the owner's ~/.memo-operator/FROZEN)
//   fileExists      (path) => boolean, injectable for tests
//   writeMarker     (path, text) => void
//   log             (event, details) => void
export function createOperatorGuard(policy, { autoFrozenFile = null, extraFrozenFiles = [], now = Date.now, fileExists = exists,
  writeMarker = (path, text) => writeFileSync(path, text, { mode: 0o600 }), removeMarker = path => unlinkSync(path), log = () => {} } = {}) {
  const refusals = [];
  const calls = { write: [], exec: [], root: [] };
  let autoFrozen = autoFrozenFile !== null && fileExists(autoFrozenFile);

  const prune = (list, horizon) => { while (list.length && list[0] <= horizon) list.shift(); };

  return Object.freeze({
    // {file, auto} as seen right now.
    status() {
      if (autoFrozenFile !== null && !autoFrozen && fileExists(autoFrozenFile)) autoFrozen = true;
      // The owner removed the marker (SSH): the in-memory flag follows.
      if (autoFrozenFile !== null && autoFrozen && !fileExists(autoFrozenFile)) autoFrozen = false;
      return { file: [policy.frozenFile, ...extraFrozenFiles].some(path => fileExists(path)), auto: autoFrozen };
    },
    // null when a call of this tier may run now, else the refusal code.
    admit(tier) {
      if (tier === 0) return null;
      const s = this.status();
      if (s.file || s.auto) return 'frozen';
      const key = TIER_KEYS[tier];
      if (!key) return 'tier_not_allowed';
      const t = now();
      prune(calls[key], t - RATE_WINDOW_MS);
      if (calls[key].length >= policy.rateLimits[key]) return 'rate_limited';
      calls[key].push(t);
      return null;
    },
    // The owner's unfreeze (signed internal op from Telegram /unfreeze): the auto-freeze only.
    // The FROZEN file stays the owner's to remove on the host. Returns whether it was frozen.
    clearAuto() {
      const was = this.status().auto;
      if (autoFrozenFile !== null) { try { removeMarker(autoFrozenFile); } catch { /* already gone */ } }
      autoFrozen = false;
      refusals.length = 0;
      if (was) log('operator_auto_unfrozen', {});
      return was;
    },
    // Record a refusal; returns true when this one froze the agent.
    refused(code) {
      if (!COUNTED_REFUSALS.has(code)) return false;
      const t = now();
      refusals.push(t);
      prune(refusals, t - AUTO_FREEZE.windowMs);
      if (autoFrozen || refusals.length < AUTO_FREEZE.refusals) return false;
      autoFrozen = true;
      if (autoFrozenFile !== null) {
        try { writeMarker(autoFrozenFile, `${JSON.stringify({ at: new Date(t).toISOString(), reason: 'refusal_burst', refusals: refusals.length })}\n`); }
        catch { log('auto_freeze_marker_failed', {}); }
      }
      log('operator_auto_frozen', { refusals: refusals.length, window_ms: AUTO_FREEZE.windowMs });
      return true;
    }
  });
}
