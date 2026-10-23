import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckoutLeases, verifiedCheckoutRoot, ambiguousGitTarget } from '../bridge/checkout-leases.mjs';

const ROOT = '/Users/memo/memolabs/os/core/bridge';
const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);
const acquire = (leases, session, root = ROOT, principal = 'oidc:owner') =>
  leases.acquire({ host: 'mac', root, principal, clientSession: session });

function memoryState(clock) {
  let saved = null;
  const read = () => ({ ok: true, data: saved });
  const save = data => { saved = JSON.parse(JSON.stringify(data)); return { ok: true }; };
  const open = () => createCheckoutLeases({ now: () => clock.now, reload: read, onChange: save, ttlMs: 60_000 });
  return { open, read, save };
}

test('one session owns checkout across many calls; second session is rejected', () => {
  const clock = { now: 0 }, state = memoryState(clock), l = state.open();
  assert.equal(acquire(l, A).ok, true);
  assert.equal(acquire(l, A).renewed, true);
  assert.equal(acquire(l, B).error, 'locked_by_other_session');
  assert.equal(acquire(l, B, '/Users/memo/memolabs/products/drop').ok, true);
  assert.equal(l.size, 2);
});

test('the same repo under a case-variant path on mac cannot evade ownership', () => {
  const l = memoryState({ now: 0 }).open();
  assert.equal(acquire(l, A).ok, true);
  assert.equal(acquire(l, B, '/users/MEMO/memolabs/os/core/bridge').error, 'locked_by_other_session');
});

test('lease is restored after restart, not treated as an empty table', () => {
  const clock = { now: 0 }, state = memoryState(clock);
  assert.equal(acquire(state.open(), A).ok, true);
  assert.equal(acquire(state.open(), B).error, 'locked_by_other_session');
});

test('expiry refuses takeover and same-session resurrection across restart', () => {
  const clock = { now: 0 }, state = memoryState(clock), l = state.open();
  assert.equal(acquire(l, A).ok, true);
  clock.now = 60_000;
  assert.equal(acquire(l, B).error, 'checkout_recovery_required');
  assert.equal(acquire(l, A).error, 'checkout_recovery_required');
  clock.now = 120_000;
  assert.equal(acquire(state.open(), A).error, 'checkout_recovery_required');
  assert.equal(acquire(state.open(), C).error, 'checkout_recovery_required');
  assert.equal(state.read().data.rows[0].session, A);
  assert.equal(l.release({ host: 'mac', root: ROOT, principal: 'oidc:owner', clientSession: A }).error,
    'checkout_recovery_required', 'an expired owner cannot manufacture a clean handoff');
});

test('missing session hint fails closed; it cannot inherit the owner principal identity', () => {
  const l = memoryState({ now: 0 }).open();
  assert.equal(acquire(l, null).error, 'session_required');
  assert.equal(acquire(l, '').error, 'session_required');
  assert.equal(acquire(l, [A]).error, 'session_required', 'no regex coercion of arrays');
  assert.equal(l.size, 0);
});

test('unavailable or corrupt durable state fails closed; no implicit reset', () => {
  const broken = createCheckoutLeases({
    reload: () => ({ ok: false }),
    onChange: () => ({ ok: true })
  });
  assert.equal(acquire(broken, A).error, 'checkout_lease_state_unavailable');
  const corrupt = createCheckoutLeases({ reload: () => ({ ok: true, data: { schema: 99, rows: [] } }) });
  assert.equal(acquire(corrupt, A).error, 'checkout_lease_state_unavailable');
});

test('failed save refuses the write and restores the prior owner', () => {
  const l = createCheckoutLeases({
    reload: () => ({ ok: true, data: null }),
    onChange: () => ({ ok: false, error: 'disk_full' })
  });
  assert.equal(acquire(l, A).error, 'checkout_lease_state_unavailable');
  assert.equal(l.size, 0);
});

test('malformed persisted identities and unrepresentable expiries fail closed', () => {
  const base = { host: 'mac', root: ROOT.toLowerCase(), principal: 'oidc:owner', session: A, expires: 60_000, revoked: [] };
  for (const delta of [{ session: [A] }, { principal: '' }, { revoked: [[B]] }, { expires: Number.MAX_SAFE_INTEGER }]) {
    const leases = createCheckoutLeases({ reload: () => ({ ok: true, data: { schema: 1, rows: [{ ...base, ...delta }] } }) });
    assert.equal(acquire(leases, B).error, 'checkout_lease_state_unavailable');
  }
  assert.equal(acquire(createCheckoutLeases({ now: () => NaN }), A).error, 'checkout_lease_state_unavailable');
});

test('normalized root requires a verified ancestor, not a path controlled by git output', () => {
  assert.equal(verifiedCheckoutRoot('mac', ROOT, ROOT + '/bridge'), ROOT.toLowerCase());
  assert.equal(verifiedCheckoutRoot('mac', ROOT, '/Users/memo/another'), null);
  assert.equal(verifiedCheckoutRoot('mac', '/tmp/../bridge', '/bridge'), null);
  assert.equal(verifiedCheckoutRoot('vps', '/opt/repo', '/opt/repo/tests'), '/opt/repo');
});

test('git -C and override flags cannot bypass the checkout-scoped guard', () => {
  for (const argv of [['git','-C','/other','switch','x'],['git','--git-dir=/x','commit'],['git','--work-tree','/x','add','.']]) {
    assert.equal(ambiguousGitTarget(argv), true);
  }
  assert.equal(ambiguousGitTarget(['git','switch','-c','feature']), false);
  assert.equal(ambiguousGitTarget(['node','index.mjs']), false);
});

test('hub with opt-in reserves an entire checkout across calls and restarts; without opt-in remains unchanged', async t => {
  const { createHub } = await import('../bridge/hub.mjs');
  const { makePrincipal, CAPABILITIES } = await import('../server/coordinator/policy.mjs');
  const { generateKeyPairSync, createHash } = await import('node:crypto');
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'checkout-guard-e2e-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const tls = spawnSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost',
    '-keyout',join(tmp,'tls.key'),'-out',join(tmp,'tls.crt')], { encoding: 'utf8' });
  assert.equal(tls.status, 0, tls.stderr);
  const { privateKey } = generateKeyPairSync('ed25519');
  const signingKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const principal = makePrincipal('oidc:owner', Object.values(CAPABILITIES), { client_type: 'chatgpt', via: 'hub' });
  let now = Date.now();
  const opts = {
    tlsKey: readFileSync(join(tmp,'tls.key'),'utf8'), tlsCert: readFileSync(join(tmp,'tls.crt'),'utf8'),
    tokenSha256: createHash('sha256').update('checkout-test').digest('hex'), port: 0,
    stateDir: join(tmp,'state'), allowedAgentKeys: {},
    operator: {
      signingKeyPem, checkoutLeasesEnabled: true, now: () => now,
      sessionWorkspace: async () => ({ ok: false, error: 'no_workspace' }),
      checkoutProbe: async ({path}) => ({ ok: true, path,
        git: { repository: true, root: ROOT } })
    }
  };
  const call = (hub, session, cwd = ROOT) => hub.requestOperator('mac','operator_edit',{
    args: { host: 'mac', path: cwd + '/README.md', mode: 'append', new_text: 'test' },
    principal, clientSession: session
  });
  const first = createHub(opts);
  const concurrent = createHub(opts); // independently cached state before first acquisition
  const noHost = await call(first, A);
  assert.equal(noHost.error, 'host_offline', JSON.stringify(noHost));
  assert.equal((await call(concurrent, B)).error, 'locked_by_other_session', 'second hub re-reads live state');
  assert.equal((await call(first, B)).error, 'locked_by_other_session');
  assert.equal((await call(first, null)).error, 'session_required');
  const second = createHub(opts);
  assert.equal((await call(second, B)).error, 'locked_by_other_session', 'hub restart preserved ownership');
  assert.equal((await call(second, A)).error, 'host_offline', 'first session renews after restart');
  now += 30 * 60_000;
  const expired = createHub(opts);
  assert.equal((await call(expired, B)).error, 'checkout_recovery_required', 'hub must not hand off while old host operation may still run');
  assert.equal((await call(expired, A)).error, 'checkout_recovery_required');
  const optOut = createHub({ ...opts, stateDir: join(tmp,'off'), operator: { ...opts.operator, checkoutLeasesEnabled: false } });
  assert.equal((await call(optOut, null)).error, 'host_offline', 'default behavior tolerates absent session hints');
});

test('two hub-state instances serialize a lease update across processes and refuse stale lockfiles', async t => {
  const { createHubState } = await import('../bridge/hub-state.mjs');
  const { mkdtempSync, writeFileSync, unlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'memo-checkout-exclusive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = createHubState({ dir });
  const second = createHubState({ dir });
  let collision;
  const outer = first.exclusive('checkout_leases', () => {
    collision = second.exclusive('checkout_leases', () => ({ ok: true }));
    return { ok: true };
  });
  assert.equal(outer.ok, true);
  assert.equal(collision.error, 'checkout_lease_busy');
  assert.equal(second.exclusive('checkout_leases', () => ({ ok: true })).ok, true,
    'lock is released after successful transaction');
  const marker = join(dir, '.checkout_leases.lock');
  writeFileSync(marker, 'unrecovered previous owner', { flag: 'wx', mode: 0o600 });
  assert.equal(first.exclusive('checkout_leases', () => ({ ok: true })).error, 'checkout_lease_busy',
    'crash-like orphaned marker is NOT silently stolen');
  unlinkSync(marker); // test fixture only: a real reset requires owner review
});

test('a separate Node process cannot enter a held checkout-state transaction', async t => {
  const { createHubState } = await import('../bridge/hub-state.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'memo-checkout-child-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createHubState({ dir });
  const url = new URL('../bridge/hub-state.mjs', import.meta.url).href;
  const runChild = () => {
    const code = `import { createHubState } from ${JSON.stringify(url)};
const state = createHubState({ dir: process.argv[1] });
console.log(JSON.stringify(state.exclusive('checkout_leases', () => ({ok:true}))));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, dir],
      { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim());
  };
  const outer = state.exclusive('checkout_leases', () => {
    assert.equal(runChild().error, 'checkout_lease_busy');
    return { ok: true };
  });
  assert.equal(outer.ok, true);
  assert.equal(runChild().ok, true);
});

test('Mac authority refuses automatic takeover after a missed heartbeat, including same-session restarts', () => {
  const clock = { now: 0 };
  let saved = null;
  const make = () => createCheckoutLeases({
    now: () => clock.now, ttlMs: 60_000,
    reload: () => ({ ok: true, data: saved }),
    onChange: data => { saved = JSON.parse(JSON.stringify(data)); return { ok: true }; }
  });
  const first = make();
  assert.equal(acquire(first, A).ok, true);
  clock.now = 60_001;
  assert.equal(acquire(make(), B).error, 'checkout_recovery_required',
    'new session cannot steal lease from potentially live orphaned child');
  assert.equal(acquire(make(), A).error, 'checkout_recovery_required',
    'same session ID does not prove a crashed process stopped');
  assert.equal(saved.rows[0].session, A, 'refusals preserve the previous owner record');
});

test('legacy release tombstones cannot certify quiescence or permit takeover', () => {
  const clock = { now: 0 };
  let saved = null;
  const make = () => createCheckoutLeases({
    now: () => clock.now, ttlMs: 60_000,
    reload: () => ({ ok: true, data: saved }),
    onChange: data => { saved = JSON.parse(JSON.stringify(data)); return { ok: true }; }
  });
  const first = make();
  assert.equal(acquire(first, A).ok, true);
  const released = first.release({ host: 'mac', root: ROOT, clientSession: A, principal: 'oidc:owner' });
  assert.equal(released.ok, true);
  assert.equal(acquire(make(), B).error, 'checkout_recovery_required');
  assert.equal(acquire(make(), A).error, 'checkout_lease_revoked');
});
