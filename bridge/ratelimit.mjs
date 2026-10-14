// Hub rate limits for the public listener (Phase 5, REQ-P5-16, D10).
//
// In memory, per hub process: a hub restart resets every bucket (single owner, accepted in the
// spec §4 "Recovery"). Two limiters:
// - per principal and op class (read, write, execute): a token bucket refilled continuously,
//   plus a cap on calls in flight per principal. A refusal is a tool result
//   {ok:false, error:'rate_limited', retry_after_s}, never an HTTP 429, so the model can read it;
// - authentication failures (401) per client address, where the address comes from the trusted
//   proxy header only when the TCP peer is the trusted proxy (Traefik on the host network
//   connects from 127.0.0.1); any other peer is keyed on its own address, so a forged header
//   from elsewhere never moves another client's bucket.
import { CAPABILITIES, OPERATION_CAPABILITY } from '../server/coordinator/policy.mjs';

export const RATE_DEFAULTS = Object.freeze({
  perMinute: Object.freeze({ read: 60, write: 20, execute: 6 }),
  inFlight: 8,
  authFailuresPerMinute: 30
});
const MAX_KEYS = 10_000;
const MINUTE = 60_000;

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

// The class an op is counted in. Unknown ops are counted as writes (the hub refuses them
// anyway; a flood of unknown names must not be free).
export function opClass(op) {
  const capability = Object.hasOwn(OPERATION_CAPABILITY, op) ? OPERATION_CAPABILITY[op] : null;
  if (capability === CAPABILITIES.READ || capability === CAPABILITIES.AUDIT) return 'read';
  if (capability === CAPABILITIES.EXECUTE) return 'execute';
  if (capability === null && ['list_hosts', 'host_status', 'bridge_info'].includes(op)) return 'read';
  return 'write';
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// A token bucket of `capacity` tokens refilled at capacity per minute. take() returns 0 when a
// token was taken, else the milliseconds until one is available.
function bucket(capacity, at) {
  return { tokens: capacity, at, capacity };
}
function take(b, now) {
  const elapsed = Math.max(0, now - b.at);
  b.tokens = Math.min(b.capacity, b.tokens + (elapsed * b.capacity) / MINUTE);
  b.at = now;
  if (b.tokens >= 1) { b.tokens -= 1; return 0; }
  return Math.ceil(((1 - b.tokens) * MINUTE) / b.capacity);
}

// Keep the map bounded: drop the oldest entries first (Map keeps insertion order).
function bound(map) {
  while (map.size > MAX_KEYS) map.delete(map.keys().next().value);
}

export function createRateLimiter({ perMinute = RATE_DEFAULTS.perMinute, inFlight = RATE_DEFAULTS.inFlight, now = Date.now } = {}) {
  const limits = {
    read: positiveInt(perMinute.read, RATE_DEFAULTS.perMinute.read),
    write: positiveInt(perMinute.write, RATE_DEFAULTS.perMinute.write),
    execute: positiveInt(perMinute.execute, RATE_DEFAULTS.perMinute.execute)
  };
  const maxInFlight = positiveInt(inFlight, RATE_DEFAULTS.inFlight);
  const buckets = new Map();
  const running = new Map();

  return {
    limits: Object.freeze({ ...limits, inFlight: maxInFlight }),
    // {ok:true, class, release} or a rate_limited refusal. release() must be called once the
    // call settles (it is idempotent); the in-flight slot is held until then.
    acquire(principalId, op) {
      const cls = opClass(op);
      const id = typeof principalId === 'string' ? principalId : 'unknown';
      const current = running.get(id) ?? 0;
      if (current >= maxInFlight) return fail('rate_limited', { retry_after_s: 1, class: cls, reason: 'in_flight' });
      const key = `${id}|${cls}`;
      const t = now();
      let b = buckets.get(key);
      if (!b) { b = bucket(limits[cls], t); buckets.set(key, b); bound(buckets); }
      const wait = take(b, t);
      if (wait > 0) return fail('rate_limited', { retry_after_s: Math.max(1, Math.ceil(wait / 1000)), class: cls });
      running.set(id, current + 1);
      let released = false;
      return {
        ok: true, class: cls,
        release() {
          if (released) return;
          released = true;
          const left = (running.get(id) ?? 1) - 1;
          if (left > 0) running.set(id, left); else running.delete(id);
        }
      };
    },
    inFlight: principalId => running.get(principalId) ?? 0
  };
}

// ---------------------------------------------------------------------------------------------
// Client address for the 401 bucket.
//
// The TCP peer is trusted as a proxy only when it is in `trustedProxies` (exact addresses,
// IPv4-mapped IPv6 normalized). Then the right-most entry of the forwarded header is the
// address that proxy saw: entries to its left were supplied by the client and are ignored.
// That the proxy appends its peer's address (X-Forwarded-For) is the de facto behaviour of
// reverse proxies and is inferred for Traefik 3.6, not read in its documentation; the header
// name is configurable and the choice is checked in TODO-P5-01.

const normalizeAddress = value => String(value ?? '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '').toLowerCase();
const ADDRESS_RE = /^[0-9a-f:.]{2,45}$/;

export function clientAddress({ remoteAddress, headers } = {}, { trustedProxies = ['127.0.0.1', '::1'], header = 'x-forwarded-for' } = {}) {
  const peer = normalizeAddress(remoteAddress);
  if (!trustedProxies.map(normalizeAddress).includes(peer)) return ADDRESS_RE.test(peer) ? peer : 'unknown';
  const raw = typeof headers?.get === 'function' ? headers.get(header) : headers?.[header];
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  const last = typeof value === 'string' ? normalizeAddress(value.split(',').pop()) : '';
  return ADDRESS_RE.test(last) ? last : `proxy:${peer}`;
}

export function createAuthFailureLimiter({ perMinute = RATE_DEFAULTS.authFailuresPerMinute, now = Date.now, ...addressOptions } = {}) {
  const capacity = positiveInt(perMinute, RATE_DEFAULTS.authFailuresPerMinute);
  const buckets = new Map();
  const peek = key => {
    const b = buckets.get(key);
    if (!b) return 0;
    const t = now();
    const tokens = Math.min(b.capacity, b.tokens + (Math.max(0, t - b.at) * b.capacity) / MINUTE);
    return tokens >= 1 ? 0 : Math.ceil(((1 - tokens) * MINUTE) / b.capacity);
  };
  return {
    keyFor: req => clientAddress(req, addressOptions),
    // Seconds to wait before this client may try again, or 0. Called before the token is
    // verified, so a flooding client costs no JWT verification.
    retryAfter(req) {
      const wait = peek(clientAddress(req, addressOptions));
      return wait > 0 ? Math.max(1, Math.ceil(wait / 1000)) : 0;
    },
    // Record one authentication failure for this client.
    failure(req) {
      const key = clientAddress(req, addressOptions);
      let b = buckets.get(key);
      if (!b) { b = bucket(capacity, now()); buckets.set(key, b); bound(buckets); }
      take(b, now());
      return key;
    }
  };
}
