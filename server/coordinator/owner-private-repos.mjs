// Explicit, owner-scoped private repository eligibility on the owner's Mac.
// This is NOT an entitlement from the remote metadata-only catalog and NOT a
// replacement for project origin, GitHub App, claim, session or remote policy checks.
//
// Who may use it (#257, owner decision of 2026-10-22): on host mac only, the owner's remote
// principal oidc:<owner_sub> (the Mac runtime) and the owner's local principal local:<OS user>
// (the stdio server he starts himself; the file must belong to that same uid). Any other
// remote principal is refused; any other local principal (reader:, hub:) gets no private
// repository and keeps the public ones.
//
// The owner namespaces (memolabs-dev, guillaume-flambard) are a pre-filter for the owner's
// principals only (fix pass of #258): anyone else keeps the exact public literal, whether or not
// a private file is set, so hub:owner, hub:readonly and reader: never search a private
// repository the owner did not enroll.
import { readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isPrincipal, isRemotePrincipal, localOwnerId } from './policy.mjs';

// The owner's namespaces: his organization and his own account.
export const OWNER_NAMESPACES = Object.freeze(['memolabs-dev', 'guillaume-flambard']);
export const OWNER_REPO = /^(?:memolabs-dev|guillaume-flambard)\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SUB = /^[A-Za-z0-9._@-]{1,120}$/;
const MAX_BYTES = 16384;
export const MAX_REPOS = 100;
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
      raw.repos.some(v => typeof v !== 'string' || !OWNER_REPO.test(v)) ||
      new Set(raw.repos.map(x => x.toLowerCase())).size !== raw.repos.length)
    return fail('private_policy_invalid_repos');
  return {ok:true,repos:Object.freeze([...raw.repos])};
}

// 'remote' for oidc:<owner_sub>, 'local' for the minted local:<OS user> principal, else null.
export function ownerKind(principal, ownerSub, env = process.env) {
  if (typeof ownerSub !== 'string' || !SUB.test(ownerSub) || typeof principal?.id !== 'string') return null;
  if (principal.id === 'oidc:' + ownerSub) return 'remote';
  if (!isRemotePrincipal(principal) && isPrincipal(principal) && principal.id === localOwnerId(env)) return 'local';
  return null;
}

// A secure, MAC-ONLY owner file in the directory reserved for owner-controlled config.
// Paths from requests, files in repositories or catalog snapshot are never read.
// Resolves to the parsed JSON, or {error}. Exported for the external projects file
// (server/projects/external-projects.mjs), which uses the same checks.
export async function readOwnerFile({ file, name, home, uid, fs }) {
  if (typeof file !== 'string' || !isAbsolute(file) || file.includes('\0') ||
      !home || !isAbsolute(home)) return {error:'private_policy_path_invalid'};
  // A trusted, non-repository config prefix. Never load from the project tree
  // or from user-supplied arguments. Checks are repeated at read time.
  const prefix = resolve(home, '.local', 'share', 'memo-bridge', 'owner-policy');
  if (resolve(file) !== resolve(prefix,name)) return {error:'private_policy_path_invalid'};
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_BYTES || st.size === 0 ||
        (st.mode & 0o077) !== 0 || st.uid !== uid) return {error:'private_policy_untrusted_file'};
    if (await fs.realpath(file) !== file) return {error:'private_policy_untrusted_file'};
    const text = await fs.readFile(file,'utf8');
    if (Buffer.byteLength(text)>MAX_BYTES) return {error:'private_policy_untrusted_file'};
    return {value:JSON.parse(text)};
  } catch { return {error:'private_policy_unavailable'}; }
}

// Whether `principal` is the owner for the namespace pre-filter and the ledger's owner marker:
// his remote principal (oidc:<owner_sub>, the configured owner sub) or his local stdio principal
// (the minted local:<OS user>, which SECURITY.md already treats as the owner; no owner sub needed).
export function isOwnerPrincipal(principal, ownerSub, env = process.env) {
  if (ownerKind(principal, ownerSub, env)) return true;
  return !isRemotePrincipal(principal) && isPrincipal(principal) && principal.id === localOwnerId(env);
}

export async function loadOwnerPrivatePolicy({
  file, principal, remotePolicy, host,
  home = process.env.HOME,
  uid = process.getuid?.(),
  env = process.env,
  fs = {lstat,realpath,readFile}
} = {}) {
  if (!file) return {ok:true,repos:[]};
  const ownerSub = remotePolicy?.configured ? remotePolicy.owner_sub : null;
  const kind = ownerKind(principal, ownerSub, env);
  if (host !== 'mac' || !kind) {
    // A remote principal that is not the owner is refused outright (unchanged); a local
    // principal that is not the owner (reader:, hub:) simply gets no private repository.
    return isRemotePrincipal(principal) || host !== 'mac' || !principal ? fail('private_policy_owner_only') : {ok:true,repos:[],owner:false};
  }
  const read = await readOwnerFile({file,name:'private-repos.json',home,uid,fs});
  if (read.error) return fail(read.error);
  return parseOwnerPrivatePolicy(read.value,{expectedOwnerSub:ownerSub});
}

export async function withOwnerPrivateRepos(baseAllowlist, context={}) {
  // Do not widen a failed public registry or a remote principal not authorized
  // for the configured Mac runtime.
  if (!baseAllowlist?.ok || !Array.isArray(baseAllowlist.repos)) return baseAllowlist;
  const privateResult = await loadOwnerPrivatePolicy(context);
  if (!privateResult.ok) return privateResult;
  const repos = [...new Set([...baseAllowlist.repos,...privateResult.repos])];
  const ownerSub = context.remotePolicy?.configured ? context.remotePolicy.owner_sub : null;
  return isOwnerPrincipal(context.principal, ownerSub, context.env ?? process.env)
    ? {ok:true,repos,namespaces:OWNER_NAMESPACES} : {ok:true,repos};
}

// The exact entry an origin matches (the public literal, an enrolled private repository), or
// null. A repository allowed only through the owner namespaces is searched as public only
// (tasks_list adds is:public): its privacy is GitHub's to say, and the ledger decides at claim.
export function exactRepo(allowlist, origin) {
  if (!allowlist?.ok || typeof origin !== 'string') return null;
  return allowlist.repos.find(r => r.toLowerCase() === origin.toLowerCase()) ?? null;
}

// The repository spelling a project origin is allowed under, or null. An exact entry (the
// public literal, an enrolled private repository) wins; otherwise any repository of the owner's
// namespaces passes this pre-filter and the ledger decides against GitHub: public and not
// archived, or private and enrolled (scripts/issue_preflight.py assess). Any other owner never
// reaches the ledger.
export function allowedRepo(allowlist, origin) {
  if (!allowlist?.ok || typeof origin !== 'string') return null;
  const exactMatch = exactRepo(allowlist, origin);
  if (exactMatch) return exactMatch;
  const [owner] = origin.split('/');
  const namespaces = Array.isArray(allowlist.namespaces) ? allowlist.namespaces : [];
  return namespaces.some(n => n.toLowerCase() === owner.toLowerCase()) && OWNER_REPO.test(origin) ? origin : null;
}
