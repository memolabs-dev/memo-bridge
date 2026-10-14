// Signed operator requests (Phase 6, TODO-P6-04, spec D4).
//
// The hub signs every operator request with a dedicated Ed25519 key (operator-signing.key in
// the hub's secrets), separate from the TLS key and from the agents' identity keys. The
// signature travels next to the v2 request envelope as an additive field (`operator`, see
// bridge/protocol.mjs); an agent that does not know it ignores it, and an operator agent refuses
// any request without a valid one.
//
// Signed statement: canonical JSON of
//   {v:1, id, op, host, tier, principal, args_sha256, exp, nonce, approval}
// where id is the wire request id, host the operator host ("mac" | "vps") the hub routes to,
// tier the op's tier (0..3), principal the forwarded principal id, args_sha256 the SHA-256 of
// the canonical JSON of the arguments, exp a Unix time in ms at most 60 s ahead, nonce 128
// random bits. The agent recomputes args_sha256 from the arguments it received, so changing one
// argument byte breaks the signature (AC-P6-03). approval (Lot 2) is the id of the owner's
// Telegram approval the hub consumed for this exact call, or null: an agent or the root helper
// whose own policy requires an approval refuses a signed call that carries none.
//
// Limit (spec D4, stated plainly): the key lives on lab next to the hub, so root on lab can
// sign. Signing protects the Mac and the root helper from anything that reaches the hub's agent
// channel without the key.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';

export const SIGNATURE_VERSION = 1;
export const MAX_SKEW_MS = 60_000;           // exp at most this far ahead of the agent's clock
export const DEFAULT_TTL_MS = 30_000;         // what the hub asks for
export const NONCE_CACHE_MAX = 4096;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;         // 64 bytes, base64url
const KEY_ID_RE = /^[0-9a-f]{16}$/;
export const APPROVAL_ID_RE = /^ap_[A-Za-z0-9_-]{16,40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

// JSON with object keys sorted at every level: one document, one byte string.
export function canonicalJson(value) {
  return JSON.stringify(value, (key, v) => (plainObject(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
}
export const argsSha256 = args => createHash('sha256').update(canonicalJson(args ?? {})).digest('hex');

// Key id: first 16 hex characters of the SHA-256 of the SPKI DER public key.
export function operatorKeyId(publicKeyPem) {
  return createHash('sha256').update(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

const statement = fields => Buffer.from(`memo-bridge-operator-v1\n${canonicalJson({
  v: SIGNATURE_VERSION, id: fields.id, op: fields.op, host: fields.host, tier: fields.tier, principal: fields.principal,
  args_sha256: fields.args_sha256, exp: fields.exp, nonce: fields.nonce, approval: fields.approval ?? null
})}`, 'utf8');

// Hub side. privateKeyPem: the operator signing key. Returns sign({id, op, host, tier,
// principal, args}) -> the `operator` envelope field.
export function createOperatorSigner({ privateKeyPem, now = Date.now, ttlMs = DEFAULT_TTL_MS, random = randomBytes } = {}) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('operator signing key must be Ed25519');
  const keyId = operatorKeyId(createPublicKey(key).export({ type: 'spki', format: 'pem' }));
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_SKEW_MS) throw new Error('invalid ttl');
  return Object.freeze({
    keyId,
    sign({ id, op, host, tier, principal, args, approval = null }) {
      const fields = { id, op, host, tier, principal, args_sha256: argsSha256(args), exp: now() + ttlMs,
        nonce: random(16).toString('base64url'), approval: typeof approval === 'string' && APPROVAL_ID_RE.test(approval) ? approval : null };
      return { key_id: keyId, ...fields, sig: sign(null, statement(fields), key).toString('base64url') };
    }
  });
}

// Shape check of the envelope field, before any cryptography.
function wellFormed(env) {
  return plainObject(env) && typeof env.key_id === 'string' && KEY_ID_RE.test(env.key_id)
    && typeof env.id === 'string' && typeof env.op === 'string' && typeof env.host === 'string'
    && Number.isInteger(env.tier) && env.tier >= 0 && env.tier <= 3
    && typeof env.principal === 'string' && env.principal.length <= 130
    && typeof env.args_sha256 === 'string' && HEX64.test(env.args_sha256)
    && Number.isInteger(env.exp) && typeof env.nonce === 'string' && NONCE_RE.test(env.nonce)
    && typeof env.sig === 'string' && SIG_RE.test(env.sig)
    && (env.approval === undefined || env.approval === null || (typeof env.approval === 'string' && APPROVAL_ID_RE.test(env.approval)));
}

// Agent (and, in Lot 2, root helper) side.
//   publicKeys  [PEM] of the hub operator keys this host trusts (several during a rotation)
//   host        this agent's operator host ("mac" | "vps")
// verify(env, {id, op, args, principal}) -> {ok:true, tier} | {ok:false, error}. Errors:
//   signature_missing, signature_invalid (shape or bytes), unknown_key, host_mismatch,
//   request_mismatch (id, op or principal differ from the envelope), args_mismatch, expired,
//   exp_too_far, replayed, nonce_cache_full.
// The nonce is recorded only after the signature checks out, so garbage cannot fill the cache;
// entries leave the cache when their exp passes. A full cache refuses (fail closed).
export function createOperatorVerifier({ publicKeys, host, now = Date.now, maxEntries = NONCE_CACHE_MAX } = {}) {
  if (!['mac', 'vps'].includes(host)) throw new Error('invalid operator host');
  const keys = new Map();
  for (const pem of publicKeys ?? []) {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('operator key must be Ed25519');
    keys.set(operatorKeyId(pem), key);
  }
  if (keys.size === 0) throw new Error('no operator key');
  const seen = new Map(); // nonce -> exp
  const sweep = t => { for (const [nonce, exp] of seen) if (exp < t) seen.delete(nonce); };
  return Object.freeze({
    get cacheSize() { return seen.size; },
    keyIds: Object.freeze([...keys.keys()]),
    verify(env, { id, op, args, principal } = {}) {
      if (env === undefined || env === null) return { ok: false, error: 'signature_missing' };
      if (!wellFormed(env)) return { ok: false, error: 'signature_invalid' };
      const key = keys.get(env.key_id);
      if (!key) return { ok: false, error: 'unknown_key' };
      let good = false;
      try { good = verify(null, statement(env), key, Buffer.from(env.sig, 'base64url')); } catch { good = false; }
      if (!good) return { ok: false, error: 'signature_invalid' };
      // The signature binds these; the envelope must also describe the request it rides on.
      if (env.host !== host) return { ok: false, error: 'host_mismatch' };
      if (env.id !== id || env.op !== op || env.principal !== principal) return { ok: false, error: 'request_mismatch' };
      if (argsSha256(args) !== env.args_sha256) return { ok: false, error: 'args_mismatch' };
      const t = now();
      if (env.exp < t) return { ok: false, error: 'expired' };
      if (env.exp > t + MAX_SKEW_MS) return { ok: false, error: 'exp_too_far' };
      sweep(t);
      if (seen.has(env.nonce)) return { ok: false, error: 'replayed' };
      if (seen.size >= maxEntries) return { ok: false, error: 'nonce_cache_full' };
      seen.set(env.nonce, env.exp);
      return { ok: true, tier: env.tier, keyId: env.key_id, approval: env.approval ?? null };
    }
  });
}

// The refusal codes of verify(), counted towards auto-freeze (TODO-P6-07).
export const SIGNATURE_REFUSALS = Object.freeze(['signature_missing', 'signature_invalid', 'unknown_key', 'host_mismatch',
  'request_mismatch', 'args_mismatch', 'expired', 'exp_too_far', 'replayed', 'nonce_cache_full']);
