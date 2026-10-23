// Characterization of the gap tracked in memolabs-dev/memo-bridge#263.
// This is intentionally NOT an acceptance test for a fix: it proves the
// call-scoped implicit lock can serialize individual calls but cannot fence a
// branch -> edit -> test -> commit -> push transaction. No real checkout is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperatorLocks } from '../bridge/operator-locks.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';

const principal = makePrincipal('oidc:owner-sub', Object.values(CAPABILITIES),
  { client_type: 'chatgpt', via: 'hub' });
const first = { workspaceId: 'ws_AAAAAAAAAAAAAAAA', clientSession: 'a'.repeat(32) };
const second = { workspaceId: 'ws_BBBBBBBBBBBBBBBB', clientSession: 'b'.repeat(32) };
const root = '/Users/memo/memolabs/os/core/bridge';
const targets = [{ kind: 'path', key: root.toLowerCase(), shown: root }];
const acquire = (locks, actor) => locks.acquireImplicit('mac', targets, {
  principal, workspaceId: actor.workspaceId, clientSession: actor.clientSession
});

test('reproduction #263: a second session can replace the active branch between two individually locked calls', () => {
  const locks = createOperatorLocks({ verifyWorkspace: async () => ({ ok: true }) });
  let branch = 'main';
  const history = [];
  const mutatingCall = (actor, next) => {
    const gate = acquire(locks, actor);
    if (!gate.ok) return gate;
    try {
      if (next) branch = next;
      history.push({ workspace: actor.workspaceId, branch });
      return { ok: true };
    } finally {
      gate.release(); // production behavior: releases at the end of each call
    }
  };

  assert.equal(mutatingCall(first, 'feature/agent-a').ok, true);
  assert.equal(mutatingCall(second, 'feature/agent-b').ok, true);
  assert.equal(mutatingCall(first).ok, true, 'the continuation is permitted by the present gate');
  assert.deepEqual(history.map(h => h.branch),
    ['feature/agent-a', 'feature/agent-b', 'feature/agent-b']);
  assert.equal(locks.size, 0, 'the hub remembers no checkout ownership after the call');
});

test('the existing implicit lock still prevents truly simultaneous writes to an overlapping checkout', () => {
  const locks = createOperatorLocks({ verifyWorkspace: async () => ({ ok: true }) });
  const a = acquire(locks, first);
  assert.equal(a.ok, true);
  const b = acquire(locks, second);
  assert.equal(b.error, 'locked_by_other_session');
  a.release();
  assert.equal(acquire(locks, second).ok, true);
});

test('path-scoped per-call locks allow unrelated repositories, which a durable fix must preserve', () => {
  const locks = createOperatorLocks({ verifyWorkspace: async () => ({ ok: true }) });
  const a = acquire(locks, first);
  assert.equal(a.ok, true);
  const other = locks.acquireImplicit('mac', [{
    kind: 'path', key: '/users/memo/memolabs/products/drop', shown: '/Users/memo/memolabs/products/drop'
  }], { principal, workspaceId: second.workspaceId, clientSession: second.clientSession });
  assert.equal(other.ok, true);
  a.release();
  other.release();
});

test('reproduction #263: when no session identity is available, a principal-scoped workspace cannot distinguish two callers', () => {
  const locks = createOperatorLocks({ verifyWorkspace: async () => ({ ok: true }) });
  // hub implicitGate uses one derived workspace for a principal when there is no clientSession.
  // This is a failure mode to resolve, not an assertion that the calls are safely isolated.
  const sharedWorkspace = 'ws_CCCCCCCCCCCCCCCC';
  const args = { principal, workspaceId: sharedWorkspace, clientSession: null };
  const a = locks.acquireImplicit('mac', targets, args);
  assert.equal(a.ok, true);
  const b = locks.acquireImplicit('mac', targets, args);
  assert.equal(b.ok, true, 'the same implicit workspace is currently treated as one writer');
  assert.equal(b.ids.length, 0, 'second logical caller obtains no independent lock');
  a.release();
  b.release();
});
