// Phase 6, TODO-P6-04 (R-P6-05, AC-P6-03): hub-signed operator requests. A replayed request,
// one argument changed, an expired or too-far expiry, an unknown key, another host or another
// request id: each refused with its own code, before anything runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { argsSha256, canonicalJson, createOperatorSigner, createOperatorVerifier, operatorKeyId } from '../bridge/operator-signing.mjs';
import { operatorKeys, signingPair } from './helpers/operator-fixture.mjs';

const REQ = { id: 'req_0123456789abcdef', op: 'operator_read', host: 'vps', tier: 0, principal: 'oidc:owner',
  args: { host: 'vps', path: '/var/log/syslog', max_bytes: 4096 } };
const ctx = (over = {}) => ({ id: REQ.id, op: REQ.op, args: REQ.args, principal: REQ.principal, ...over });

test('canonical JSON and the args hash do not depend on key order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } }), '{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}');
  assert.equal(argsSha256({ path: '/x', host: 'vps' }), argsSha256({ host: 'vps', path: '/x' }));
  assert.notEqual(argsSha256({ path: '/x' }), argsSha256({ path: '/y' }));
});

test('AC-P6-03: a valid request passes once; replay, changed args, expiry and unknown key are refused', () => {
  const { signer, verifier, clock } = signingPair();
  const env = signer.sign(REQ);
  assert.equal(env.key_id, signer.keyId);
  assert.deepEqual(verifier.verify(env, ctx()), { ok: true, tier: 0, keyId: signer.keyId });
  assert.deepEqual(verifier.verify(env, ctx()), { ok: false, error: 'replayed' }, 'same nonce twice');

  // One argument byte changed after signing.
  const env2 = signer.sign(REQ);
  assert.deepEqual(verifier.verify(env2, ctx({ args: { ...REQ.args, path: '/etc/shadow' } })), { ok: false, error: 'args_mismatch' });
  // The envelope's own fields edited: the signature breaks.
  for (const field of [['tier', 3], ['op', 'operator_run'], ['host', 'mac'], ['exp', env2.exp + 1], ['args_sha256', 'f'.repeat(64)], ['principal', 'oidc:other']]) {
    assert.deepEqual(verifier.verify({ ...signer.sign(REQ), [field[0]]: field[1] }, ctx()), { ok: false, error: 'signature_invalid' }, field[0]);
  }
  // Rides on another request id, op or principal than it was signed for.
  assert.equal(verifier.verify(signer.sign(REQ), ctx({ id: 'req_other_000000000' })).error, 'request_mismatch');
  assert.equal(verifier.verify(signer.sign(REQ), ctx({ principal: 'oidc:intruder' })).error, 'request_mismatch');

  // Expired: signed now, checked 31 s later (ttl 30 s).
  const late = signer.sign(REQ);
  clock.t += 31_000;
  assert.deepEqual(verifier.verify(late, ctx()), { ok: false, error: 'expired' });

  // Unknown key: a valid signature by a key this host does not trust.
  const stranger = createOperatorSigner({ privateKeyPem: operatorKeys().privateKeyPem, now: () => clock.t });
  assert.deepEqual(verifier.verify(stranger.sign(REQ), ctx()), { ok: false, error: 'unknown_key' });
  // A forged key id with the stranger's signature.
  assert.deepEqual(verifier.verify({ ...stranger.sign(REQ), key_id: signer.keyId }, ctx()), { ok: false, error: 'signature_invalid' });
  // Missing or malformed.
  assert.deepEqual(verifier.verify(null, ctx()), { ok: false, error: 'signature_missing' });
  assert.deepEqual(verifier.verify({ sig: 'x' }, ctx()), { ok: false, error: 'signature_invalid' });
});

test('AC-P6-03: exp too far, host mismatch, key rotation, bounded nonce cache', () => {
  const clock = { t: 1_800_000_000_000 };
  const keys = operatorKeys();
  const verifier = createOperatorVerifier({ publicKeys: [keys.publicKeyPem], host: 'vps', now: () => clock.t, maxEntries: 3 });
  const ahead = createOperatorSigner({ privateKeyPem: keys.privateKeyPem, now: () => clock.t + 45_000 });
  assert.deepEqual(verifier.verify(ahead.sign(REQ), ctx()), { ok: false, error: 'exp_too_far' }, 'exp 75 s ahead');
  const signer = createOperatorSigner({ privateKeyPem: keys.privateKeyPem, now: () => clock.t });
  // Signed for the Mac, delivered to lab.
  assert.deepEqual(verifier.verify(signer.sign({ ...REQ, host: 'mac' }), ctx()), { ok: false, error: 'host_mismatch' });
  // The cache holds at most 3 live nonces, then refuses; expired ones leave it.
  for (let i = 0; i < 3; i++) assert.equal(verifier.verify(signer.sign(REQ), ctx()).ok, true);
  assert.deepEqual(verifier.verify(signer.sign(REQ), ctx()), { ok: false, error: 'nonce_cache_full' });
  clock.t += 31_000;
  assert.equal(verifier.verify(signer.sign(REQ), ctx()).ok, true, 'expired entries were swept');
  assert.equal(verifier.cacheSize, 1);
  // Two trusted keys during a rotation.
  const next = operatorKeys();
  const both = createOperatorVerifier({ publicKeys: [keys.publicKeyPem, next.publicKeyPem], host: 'vps', now: () => clock.t });
  assert.deepEqual([...both.keyIds].sort(), [operatorKeyId(keys.publicKeyPem), operatorKeyId(next.publicKeyPem)].sort());
  assert.equal(both.verify(createOperatorSigner({ privateKeyPem: next.privateKeyPem, now: () => clock.t }).sign(REQ), ctx()).ok, true);
  // Construction refuses no key, a non-Ed25519 key and a bad host.
  assert.throws(() => createOperatorVerifier({ publicKeys: [], host: 'vps' }), /no operator key/);
  assert.throws(() => createOperatorVerifier({ publicKeys: [keys.publicKeyPem], host: 'lab' }), /invalid operator host/);
  assert.throws(() => createOperatorSigner({ privateKeyPem: keys.privateKeyPem, ttlMs: 120_000 }), /invalid ttl/);
});
