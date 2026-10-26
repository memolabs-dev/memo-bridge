// Owner-private read-only GitHub identity audit. A GitHub repository ID survives
// a rename/transfer; a similar name, fork, or matching local path NEVER proves identity.
// This module is deliberately not part of project authorization or runner allowlists.
export const IDENTITY_SCHEMA = 'memolabs.registered-project-identities.v1';
export const IDENTITY_STATUSES = Object.freeze([
  'observed_identity', 'verified_github_redirect', 'local_checkout_missing',
  'no_git_origin', 'non_github_remote', 'github_resolution_unavailable'
]);
const VALID_STATUS = new Set(IDENTITY_STATUSES);
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const OBSERVATION_KEYS = new Set([
  'project','path_relative','kind','status','requested_origin',
  'canonical_repo','github_repository_id','provenance'
]);
const TOP_KEYS = new Set(['schema','observed_at','authoritative_for_execution','source',
  'projects','same_repository_multiple_registered_projects','policy']);
const LIMIT = 500;

const fail = code => { throw new Error(code); };
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const allowed = (v, ks) => Object.keys(v).every(k => ks.has(k));
const repoName = v => typeof v === 'string' && REPO.test(v) &&
  !v.includes('..') && !v.endsWith('.git');
const positiveId = v => Number.isSafeInteger(v) && v > 0;
const low = v => v.toLowerCase();
function timestamp(value) {
  if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function parseRegisteredIdentities(input, { now = Date.now(), maxAgeMs = 24 * 3600_000 } = {}) {
  if (!plain(input) || !allowed(input, TOP_KEYS) ||
      input.schema !== IDENTITY_SCHEMA || input.authoritative_for_execution !== false ||
      !Array.isArray(input.projects) || input.projects.length > LIMIT) fail('invalid_identity_snapshot');
  const at = timestamp(input.observed_at);
  if (at === null || at > now + 300_000 || !Number.isFinite(maxAgeMs) || maxAgeMs < 0)
    fail('invalid_identity_timestamp');
  const seenProjects=new Set(), sources=new Map(), byId=new Map(), canonicalIds=new Map();
  const entries=[];
  for(const p of input.projects){
    if(!plain(p) || !allowed(p, OBSERVATION_KEYS) || typeof p.project !== 'string' ||
       !PROJECT.test(p.project) || typeof p.path_relative !== 'string' ||
       !p.path_relative || p.path_relative.startsWith('/') ||
       p.path_relative.split('/').some(x => !x || x === '.' || x === '..' || x.startsWith('.')) ||
       typeof p.kind !== 'string' || p.kind.length === 0 || p.kind.length > 40 ||
       !VALID_STATUS.has(p.status)) fail('invalid_identity_entry');
    if(seenProjects.has(p.project)) fail('duplicate_project_name');
    seenProjects.add(p.project);
    const identified=p.status==='observed_identity'||p.status==='verified_github_redirect';
    if(identified){
      if(!repoName(p.requested_origin) || !repoName(p.canonical_repo) ||
         !positiveId(p.github_repository_id) ||
         !['authenticated_inventory','live_github_api'].includes(p.provenance))
        fail('invalid_identity_evidence');
      const src=low(p.requested_origin), canonical=low(p.canonical_repo);
      if(p.status==='observed_identity' && src!==canonical) fail('unverified_alias');
      if(p.status==='verified_github_redirect' &&
         (src===canonical || p.provenance!=='live_github_api')) fail('unverified_alias');
      if(sources.has(src)&&sources.get(src)!==p.github_repository_id) fail('conflicting_origin_id');
      if(canonicalIds.has(canonical)&&canonicalIds.get(canonical)!==p.github_repository_id)
        fail('conflicting_canonical_id');
      sources.set(src,p.github_repository_id);
      canonicalIds.set(canonical,p.github_repository_id);
      const group=byId.get(p.github_repository_id)??{canonical,projects:[]};
      if(group.canonical!==canonical) fail('conflicting_canonical_alias');
      group.projects.push(p.project);byId.set(p.github_repository_id,group);
    }else{
      if(p.github_repository_id!==undefined || p.canonical_repo!==undefined ||
         p.provenance!==undefined) fail('unverified_identity');
      if(p.requested_origin!==undefined && !repoName(p.requested_origin))
        fail('invalid_identity_entry');
    }
    entries.push(Object.freeze({...p,...(identified?{stable_key:'github:'+p.github_repository_id}:{})}));
  }
  return Object.freeze({
    schema:IDENTITY_SCHEMA,observed_at:input.observed_at,stale:now-at>maxAgeMs,
    entries:Object.freeze(entries),
    identity_count:byId.size,unresolved_count:entries.filter(x=>!x.stable_key).length,
    same_id_projects:Object.freeze([...byId].filter(([,v])=>v.projects.length>1)
      .map(([id,v])=>({stable_key:'github:'+id,projects:v.projects.slice().sort()}))),
    redirects:Object.freeze(entries.filter(x=>x.status==='verified_github_redirect')
      .map(x=>({from:x.requested_origin,to:x.canonical_repo,stable_key:x.stable_key})))
  });
}

// Verify a LIVE GitHub response again before considering an old path a redirect.
// An old fork with the same code but another numeric ID is always a different repo.
export function verifyLiveGitHubIdentity(requested, reply, expectedRepositoryId=null){
  if(!repoName(requested)||!plain(reply)||!repoName(reply.full_name)||
     !positiveId(reply.id)||!plain(reply.owner)||
     typeof reply.owner.login!=='string'||
     low(reply.full_name.split('/')[0])!==low(reply.owner.login))
    return {ok:false,error:'invalid_github_identity'};
  const redirected=low(requested)!==low(reply.full_name);
  // A redirect without a previously known ID does not establish an owner transfer.
  // Re-use that ID from the owner-private trusted map, then compare it to this live read.
  if(redirected && expectedRepositoryId===null)
    return {ok:false,error:'previous_repository_id_required'};
  if(expectedRepositoryId!==null &&
     (!positiveId(expectedRepositoryId)||expectedRepositoryId!==reply.id))
    return {ok:false,error:'repository_id_mismatch'};
  return Object.freeze({ok:true,requested,canonical:reply.full_name,repository_id:reply.id,
    stable_key:'github:'+reply.id,redirected,
    proof:'live_github_api',grants_access:false});
}

// Compare registries by immutable repo ID, never by local path. A changed ID is a
// conflict, not a rename, even when the owner/repo name happens to be identical.
export function compareRegisteredIdentities(before,after){
  const prior=new Map(before.entries.filter(x=>x.stable_key).map(x=>[x.project,x]));
  const current=new Map(after.entries.filter(x=>x.stable_key).map(x=>[x.project,x]));
  const moved=[],changed=[],removed=[];
  for(const [project,a] of prior){
    const b=current.get(project);
    if(!b){removed.push(project);continue;}
    if(a.stable_key!==b.stable_key){
      changed.push({project,from:a.stable_key,to:b.stable_key,status:'identity_changed_not_alias'});
    }else if(a.path_relative!==b.path_relative||low(a.canonical_repo)!==low(b.canonical_repo)){
      moved.push({project,stable_key:a.stable_key,path_changed:a.path_relative!==b.path_relative,
        canonical_changed:low(a.canonical_repo)!==low(b.canonical_repo)});
    }
  }
  return {moved,changed,removed};
}
