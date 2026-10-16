// Explicit, owner-scoped private repository eligibility for the Mac runtime.
// This is NOT an entitlement from the remote metadata-only catalog and NOT a
// replacement for project origin, GitHub App, claim, session or remote policy checks.
import { readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const REPO = /^memolabs-dev\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SUB = /^[A-Za-z0-9._@-]{1,120}$/;
const MAX_BYTES = 16384;
const MAX_REPOS = 50;
export const SCHEMA = 'memolabs.owner-private-repos.v1';

const fail = error => ({ok:false,error});
const pureObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  [Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact = (o, keys) => pureObject(o) &&
  Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o,k));

export function parseOwnerPrivatePolicy(raw, {expectedOwnerSub} = {}) {
  if (!exact(raw,['schema','owner_sub','repos'])) return fail('private_policy_invalid');
  if (raw.schema !== SCHEMA || !SUB.test(raw.owner_sub) ||
      raw.owner_sub !== expectedOwnerSub) return fail('private_policy_owner_mismatch');
  if (!Array.isArray(raw.repos) || raw.repos.length > MAX_REPOS ||
      raw.repos.some(v => typeof v !== 'string' || !REPO.test(v)) ||
      new Set(raw.repos.map(x => x.toLowerCase())).size !== raw.repos.length)
    return fail('private_policy_invalid_repos');
  return {ok:true,repos:Object.freeze([...raw.repos])};
}

// Secure MAC-ONLY policy in a directory reserved for owner-controlled config.
// Paths from requests, files in repositories or catalog snapshot are never read.
export async function loadOwnerPrivatePolicy({
  file, principal, remotePolicy, host,
  home = process.env.HOME,
  uid = process.getuid?.(),
  fs = {lstat,realpath,readFile}
} = {}) {
  if (!file) return {ok:true,repos:[]};
  if (host !== 'mac' || !remotePolicy?.configured ||
      typeof remotePolicy.owner_sub !== 'string' ||
      principal?.id !== 'oidc:' + remotePolicy.owner_sub) return fail('private_policy_owner_only');
  if (typeof file !== 'string' || !isAbsolute(file) || file.includes('\0') ||
      !home || !isAbsolute(home)) return fail('private_policy_path_invalid');
  // A trusted, non-repository config prefix. Never load from the project tree
  // or from user-supplied arguments. Checks are repeated at read time.
  const prefix = resolve(home, '.local', 'share', 'memo-bridge', 'owner-policy');
  if (resolve(file) !== resolve(prefix,'private-repos.json')) return fail('private_policy_path_invalid');
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_BYTES || st.size === 0 ||
        (st.mode & 0o077) !== 0 || st.uid !== uid) return fail('private_policy_untrusted_file');
    if (await fs.realpath(file) !== file) return fail('private_policy_untrusted_file');
    const text = await fs.readFile(file,'utf8');
    if (Buffer.byteLength(text)>MAX_BYTES) return fail('private_policy_untrusted_file');
    return parseOwnerPrivatePolicy(JSON.parse(text),{expectedOwnerSub:remotePolicy.owner_sub});
  } catch { return fail('private_policy_unavailable'); }
}

export async function withOwnerPrivateRepos(baseAllowlist, context={}) {
  // Do not widen a failed public registry or a remote principal not authorized
  // for the configured Mac runtime.
  if (!baseAllowlist?.ok || !Array.isArray(baseAllowlist.repos)) return baseAllowlist;
  const privateResult = await loadOwnerPrivatePolicy(context);
  if (!privateResult.ok) return privateResult;
  return {ok:true,repos:[...new Set([...baseAllowlist.repos,...privateResult.repos])]};
}
