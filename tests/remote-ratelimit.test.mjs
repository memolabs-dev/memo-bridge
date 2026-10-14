// Phase 5, TODO-P5-07 (AC-P5-15, REQ-P5-16): hub rate limits per principal and op class, the
// in-flight cap, rate_limited with retry_after_s as a tool result, and the 401 flood bucket keyed
// on the trusted proxy header only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RATE_DEFAULTS, clientAddress, createAuthFailureLimiter, createRateLimiter, opClass } from '../bridge/ratelimit.mjs';
import { createForwarder } from '../bridge/forward.mjs';
import { CAPABILITIES, OPERATION_CAPABILITY, makePrincipal } from '../server/coordinator/policy.mjs';

const clock = (start = 1_000_000) => { let t = start; return { now: () => t, advance: ms => { t += ms; } }; };

test('op classes follow the policy capability: read, write, execute', () => {
  assert.deepEqual(RATE_DEFAULTS.perMinute, { read: 60, write: 20, execute: 6 });
  assert.equal(RATE_DEFAULTS.inFlight, 8);
  assert.equal(opClass('task_status'), 'read');
  assert.equal(opClass('audit_events'), 'read');
  assert.equal(opClass('bridge_info'), 'read');
  assert.equal(opClass('task_claim'), 'write');
  assert.equal(opClass('worktree_push'), 'write');
  assert.equal(opClass('github_create_pr'), 'write');
  assert.equal(opClass('jobs_submit'), 'execute');
  assert.equal(opClass('job_cancel'), 'execute');
  assert.equal(opClass('no_such_op'), 'write', 'unknown names are not free');
  for (const [op, capability] of Object.entries(OPERATION_CAPABILITY)) {
    const expected = capability === CAPABILITIES.READ || capability === CAPABILITIES.AUDIT ? 'read'
      : capability === CAPABILITIES.EXECUTE ? 'execute' : 'write';
    assert.equal(opClass(op), expected, op);
  }
});

test('buckets are per principal and per class; refusals carry retry_after_s; tokens refill over time', () => {
  const c = clock();
  const limiter = createRateLimiter({ perMinute: { read: 3, write: 2, execute: 1 }, inFlight: 100, now: c.now });
  const take = (p, op) => { const r = limiter.acquire(p, op); if (r.ok) r.release(); return r; };
  for (let i = 0; i < 2; i++) assert.equal(take('oidc:a', 'task_claim').ok, true);
  const refused = take('oidc:a', 'worktree_push');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'rate_limited');
  assert.equal(refused.class, 'write');
  assert.ok(Number.isInteger(refused.retry_after_s) && refused.retry_after_s >= 1 && refused.retry_after_s <= 30, String(refused.retry_after_s));
  // Another class, another principal: separate buckets.
  assert.equal(take('oidc:a', 'task_status').ok, true);
  assert.equal(take('oidc:b', 'task_claim').ok, true);
  assert.equal(take('oidc:a', 'jobs_submit').ok, true);
  assert.equal(take('oidc:a', 'jobs_submit').error, 'rate_limited');
  // One write token comes back after 30 s at 2 per minute.
  c.advance(30_000);
  assert.equal(take('oidc:a', 'task_claim').ok, true);
  assert.equal(take('oidc:a', 'task_claim').ok, false);
});

test('no more than the in-flight cap per principal; release frees the slot once', () => {
  const limiter = createRateLimiter({ perMinute: { read: 1000, write: 1000, execute: 1000 }, inFlight: 2 });
  const a = limiter.acquire('oidc:a', 'task_status');
  const b = limiter.acquire('oidc:a', 'task_status');
  const c = limiter.acquire('oidc:a', 'task_status');
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'in_flight');
  assert.equal(limiter.acquire('oidc:b', 'task_status').ok, true, 'another principal is not affected');
  a.release(); a.release();
  assert.equal(limiter.inFlight('oidc:a'), 1);
  assert.equal(limiter.acquire('oidc:a', 'task_status').ok, true);
  b.release();
});

test('the forwarder answers rate_limited as a tool result with retry_after_s and journals the refusal; nothing is forwarded', async () => {
  const principal = makePrincipal('oidc:owner', [CAPABILITIES.READ]);
  const lines = []; let forwarded = 0;
  const forwarder = createForwarder({ requestAgent: async () => { forwarded++; return { ok: true }; },
    limiter: createRateLimiter({ perMinute: { read: 1, write: 1, execute: 1 } }), audit: l => lines.push(l),
    newRequestId: () => 'req-rate-0001' });
  assert.equal((await forwarder.call({ op: 'task_status', args: {}, principal })).ok, true);
  const refused = await forwarder.call({ op: 'task_status', args: {}, principal });
  assert.deepEqual(Object.keys(refused).sort(), ['error', 'ok', 'request_id', 'retry_after_s']);
  assert.equal(refused.error, 'rate_limited');
  assert.equal(forwarded, 1);
  assert.deepEqual(lines.map(l => [l.event, l.outcome, l.code]), [['remote_call', 'ok', null], ['remote_refused', 'denied', 'rate_limited']]);
});

test('401 bucket: keyed on the forwarded address only behind the trusted proxy; a forged header elsewhere changes nothing', () => {
  const viaProxy = xff => ({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': xff } });
  assert.equal(clientAddress(viaProxy('203.0.113.9')), '203.0.113.9');
  // Client-supplied entries to the left of the proxy's own are ignored.
  assert.equal(clientAddress(viaProxy('198.51.100.1, 203.0.113.9')), '203.0.113.9');
  assert.equal(clientAddress({ remoteAddress: '::ffff:127.0.0.1', headers: new Headers({ 'x-forwarded-for': '203.0.113.9' }) }), '203.0.113.9');
  // Not from the trusted proxy: the header is ignored, the peer is the key.
  assert.equal(clientAddress({ remoteAddress: '192.0.2.7', headers: { 'x-forwarded-for': '203.0.113.9' } }), '192.0.2.7');
  // From the proxy but without a usable header: one shared, explicit key.
  assert.equal(clientAddress(viaProxy('not an address')), 'proxy:127.0.0.1');
  assert.equal(clientAddress({ remoteAddress: '127.0.0.1', headers: {} }), 'proxy:127.0.0.1');

  const c = clock();
  const flood = createAuthFailureLimiter({ perMinute: 3, now: c.now });
  for (let i = 0; i < 3; i++) { assert.equal(flood.retryAfter(viaProxy('203.0.113.9')), 0); flood.failure(viaProxy('203.0.113.9')); }
  assert.ok(flood.retryAfter(viaProxy('203.0.113.9')) >= 1, 'the flooding client waits');
  assert.equal(flood.retryAfter(viaProxy('203.0.113.10')), 0, 'another client behind the same proxy does not');
  // A direct peer forging the victim's address in the header cannot fill the victim's bucket.
  const other = createAuthFailureLimiter({ perMinute: 1, now: c.now });
  other.failure({ remoteAddress: '192.0.2.7', headers: { 'x-forwarded-for': '203.0.113.50' } });
  assert.equal(other.retryAfter(viaProxy('203.0.113.50')), 0);
  c.advance(60_000);
  assert.equal(flood.retryAfter(viaProxy('203.0.113.9')), 0, 'refilled after a minute');
});
