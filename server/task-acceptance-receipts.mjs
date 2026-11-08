import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { normalizeIssueRef } from './task-dependencies.mjs';

// Receipts are issued OFFLINE by an independent verifier, never by an MCP model.
// The sealed payload is bound to the exact observed GitHub Issue revision.
const KEYS = ['schema','issue','issue_updated_at','issue_closed_at','body_sha256',
  'verifier_id','producer_id','verified_at','pr_ref','deployment_ref','policy_ref','e2e_ref'];
const HEX64 = /^[a-f0-9]{64}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = object => JSON.stringify(Object.fromEntries(KEYS.map(k => [k, object[k] ?? null])));
const trustedString = x => typeof x === 'string' && x.length > 4 && x.length < 1024 && !/[\x00-\x1f]/.test(x);
const instant = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(x) && Number.isFinite(Date.parse(x));
export const receiptFilename = ref => {
  const canonicalRef = normalizeIssueRef(ref);
  return canonicalRef ? sha256(canonicalRef) + '.json' : null;
};
export function sealAcceptanceReceipt(payload, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid_receipt_key');
  const data = Object.fromEntries(KEYS.map(k => [k, payload[k] ?? null]));
  const signature = createHmac('sha256', key).update(canonical(data)).digest('hex');
  return { ...data, signature };
}
export function verifyAcceptanceReceipt(node, receipt, key, { now = Date.now(), maxAgeMs = 30*86400000 } = {}) {
  if (!node || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || !Buffer.isBuffer(key) || key.length !== 32 || !Number.isFinite(now)) return null;
  if (Object.keys(receipt).length !== KEYS.length + 1 || !KEYS.every(k => Object.hasOwn(receipt,k))
    || !Object.hasOwn(receipt, 'signature') || !HEX64.test(receipt.signature)) return null;
  if (receipt.schema !== 1 || receipt.issue !== normalizeIssueRef(node.ref)
    || node.state !== 'closed' || !instant(node.updated_at) || !instant(node.closed_at)
    || receipt.issue_updated_at !== node.updated_at || receipt.issue_closed_at !== node.closed_at
    || receipt.body_sha256 !== sha256(node.body ?? '')) return null;
  if (!trustedString(receipt.verifier_id) || !trustedString(receipt.producer_id)
    || receipt.verifier_id === receipt.producer_id || !instant(receipt.verified_at)
    || now < Date.parse(receipt.verified_at) || now - Date.parse(receipt.verified_at) > maxAgeMs) return null;
  if (!trustedString(receipt.pr_ref) || !trustedString(receipt.e2e_ref)
    || !(trustedString(receipt.deployment_ref) !== trustedString(receipt.policy_ref))) return null;
  if (!HEX64.test(receipt.body_sha256)) return null;
  const expected = createHmac('sha256', key).update(canonical(receipt)).digest();
  if (!timingSafeEqual(expected, Buffer.from(receipt.signature, 'hex'))) return null;
  return { verified:true, passed:true, evidence_ref:receipt.e2e_ref };
}
async function privateFile(path, maxBytes) {
  if (!isAbsolute(path)) return null;
  let fd;
  try {
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await fd.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > maxBytes
      || (process.getuid && info.uid !== process.getuid())) return null;
    return await fd.readFile();
  } catch { return null; }
  finally { await fd?.close().catch(() => {}); }
}
export function privateReceiptVerifier({ stateDir, now = Date.now } = {}) {
  // Never generate a credential, never make an attestation, never trust Issue comments.
  return async node => {
    if (!isAbsolute(stateDir ?? '')) return null;
    const filename = receiptFilename(node?.ref);
    if (!filename) return null;
    const key = await privateFile(join(stateDir,'dependency-acceptance.key'), 64);
    if (!key || key.length !== 32) return null;
    try {
      const dir = await lstat(join(stateDir, 'dependency-acceptance'));
      if (!dir.isDirectory() || (dir.mode & 0o077) !== 0 ||
        (process.getuid && dir.uid !== process.getuid())) return null;
    } catch { return null; }
    const file = await privateFile(join(stateDir,'dependency-acceptance',filename), 8192);
    if (!file) return null;
    try { return verifyAcceptanceReceipt(node,JSON.parse(file.toString('utf8')),key,{now:now()}); }
    catch { return null; }
  };
}
