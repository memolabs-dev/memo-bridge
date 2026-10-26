// Refresh registered project identities with live GitHub reads. Ownership metadata stays
// Mac-private and NEVER alters checkout origins, registrations or execution allowlists.
// A redirected name needs the repository ID known BEFORE this refresh; a fresh redirect
// response alone does not establish a transfer. All command failures fail closed.
import { parseRegisteredIdentities, IDENTITY_SCHEMA } from './github-identity-audit.mjs';

const REPO=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
const originalName=name=>name.toLowerCase();
export function githubOrigin(value){
  if(typeof value!=='string'||value.length>400)return null;
  const url=value.trim();
  let match=/^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+?)(?:\.git)?\/?$/.exec(url);
  if(!match)match=/^git@github\.com:([^/?#\s]+)\/([^/?#\s]+?)(?:\.git)?\/?$/.exec(url);
  if(!match)match=/^ssh:\/\/git@github\.com\/([^/?#\s]+)\/([^/?#\s]+?)(?:\.git)?\/?$/.exec(url);
  const repo=match?match[1]+'/'+match[2]:null;
  return repo&&REPO.test(repo)&&!repo.includes('..')&&!repo.endsWith('.git')?repo:null;
}
const failure=(project,status,requested_origin=null)=>({
  project:project.name,path_relative:project.pathRelative,kind:project.kind,status,
  ...(requested_origin?{requested_origin}:{})
});
export async function buildRegisteredIdentitySnapshot({
  projects,readOrigin,resolveGitHub,previous=null,now=new Date()
}={}){
  if(!Array.isArray(projects)||projects.length>500||
      typeof readOrigin!=='function'||typeof resolveGitHub!=='function')
    throw new Error('invalid_refresh_input');
  const previousIds=new Map();
  if(previous!==null){
    const safe=parseRegisteredIdentities(previous,{now:now.getTime()});
    for(const entry of safe.entries){
      if(entry.stable_key)previousIds.set(entry.project,entry.github_repository_id);
    }
  }
  const rows=[];
  const counts={local_checkout_missing:0,no_git_origin:0,non_github_remote:0,
    github_resolution_unavailable:0,observed_identity:0,verified_github_redirect:0,
    identity_mismatch:0,unattested_redirect:0};
  for(const project of projects){
    let result;
    if(!project.available||typeof project.path!=='string'){
      result=failure(project,'local_checkout_missing');
    }else{
      let origin=null;
      try{origin=await readOrigin(project);}catch{}
      if(origin===null){
        result=failure(project,'no_git_origin');
      }else{
        const requested=githubOrigin(origin);
        if(!requested){
          result=failure(project,'non_github_remote');
        }else{
          let reply=null;
          try{reply=await resolveGitHub(requested);}catch{}
          const repo=reply?.full_name, id=reply?.id,owner=reply?.owner?.login;
          const valid=Number.isSafeInteger(id)&&id>0&&typeof repo==='string'&&
            REPO.test(repo)&&!repo.includes('..')&&!repo.endsWith('.git')&&
            typeof owner==='string'&&
            repo.split('/')[0].toLowerCase()===owner.toLowerCase();
          const was=previousIds.get(project.name);
          const conflict=valid&&was!==undefined&&was!==id;
          const redirected=valid&&originalName(repo)!==originalName(requested);
          if(!valid||conflict||(redirected&&was===undefined)){
            result=failure(project,'github_resolution_unavailable',requested);
            if(conflict)counts.identity_mismatch++;
            else if(redirected&&was===undefined)counts.unattested_redirect++;
          }else{
            result={...failure(project,redirected?'verified_github_redirect':'observed_identity',requested),
              canonical_repo:repo,github_repository_id:id,provenance:'live_github_api'};
          }
        }
      }
    }
    counts[result.status]++;
    rows.push(result);
  }
  const snapshot={schema:IDENTITY_SCHEMA,observed_at:now.toISOString(),
    authoritative_for_execution:false,
    source:'PROJECTS.md local checkout remotes + authenticated GitHub metadata',
    projects:rows,same_repository_multiple_registered_projects:[],
    policy:'Observation only. Never use these aliases to grant remote access or merge projects without independent live verification.'};
  const validated=parseRegisteredIdentities(snapshot,{now:now.getTime()});
  if(validated.same_id_projects.length)throw new Error('duplicate_registered_repository_id');
  // Refuse to replace the known-good snapshot on detected ID changes or unattested aliases.
  if(counts.identity_mismatch||counts.unattested_redirect)throw new Error('identity_review_required');
  return {snapshot,counts,project_count:rows.length,identity_count:validated.identity_count,
    unresolved_count:validated.unresolved_count};
}
