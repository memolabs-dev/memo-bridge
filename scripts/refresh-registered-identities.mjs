#!/usr/bin/env node
// Owner-Mac only. Reads registered checkout remotes + authenticated GitHub metadata;
// creates a timestamped PRIVATE snapshot with 0600 mode. Never mutates repositories,
// remotes, project allowlists or GitHub. Stdout contains aggregates only, no repo names.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { mkdir, open, readFile, realpath, stat, lstat, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { readProjectRegistry } from '../server/catalog.mjs';
import { memolabsRoot } from '../server/memolabs-root.mjs';
import { parseRegisteredIdentities } from '../server/projects/github-identity-audit.mjs';
import { buildRegisteredIdentitySnapshot } from '../server/projects/owner-identity-refresh.mjs';

const command=promisify(execFile);
const root=memolabsRoot();
const directory=join(root,'workspace/data/github-ownership');
const previousPath=process.argv[2];
const shortError=error=>{
  const allowed=new Set(['invalid_identity_snapshot','invalid_identity_timestamp',
    'invalid_identity_entry','unverified_identity','unverified_alias','identity_review_required',
    'duplicate_registered_repository_id','duplicate_project_name']);
  return allowed.has(error?.message)?error.message:'identity_refresh_unavailable';
};
async function run(argv,{cwd,timeout=10000}={}){
  const {stdout}=await command(argv[0],argv.slice(1),{
    cwd,timeout,maxBuffer:1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}
  });
  return stdout.trim();
}
async function securePrivateFile(path){
  if(!isAbsolute(path)||path.includes('\0'))throw new Error('private_snapshot_required');
  const realDir=await realpath(directory);
  const parent=await realpath(dirname(path));
  if(parent!==realDir)throw new Error('private_snapshot_required');
  const info=await lstat(path); // refuse symlinks to secrets or files outside the private folder
  if(!info.isFile()||info.size>512*1024||(info.mode&0o077)!==0)
    throw new Error('private_snapshot_required');
  return JSON.parse(await readFile(path,'utf8'));
}
async function readOrigin(p){
  // Never borrow a parent/monorepo's origin as evidence for a child project.
  const gitPath=join(p.path,'.git');
  try{const info=await lstat(gitPath);if(!info.isFile()&&!info.isDirectory())return null;}
  catch{return null;}
  const top=await run(['git','rev-parse','--show-toplevel'],{cwd:p.path});
  if(await realpath(top)!==await realpath(p.path))return null;
  return await run(['git','config','--get','remote.origin.url'],{cwd:p.path});
}
async function resolveGitHub(fullName){
  const text=await run(['gh','api','/repos/'+fullName],{timeout:15000});
  const response=JSON.parse(text);
  return {id:response.id,full_name:response.full_name,
    owner:{login:response.owner?.login}};
}
try{
  if(process.platform!=='darwin')throw new Error('owner_mac_only');
  const home=homedir();
  if(!root.startsWith(home+'/'))throw new Error('unexpected_owner_root');
  await mkdir(directory,{recursive:true,mode:0o700});
  const dir=await lstat(directory);
  if(!dir.isDirectory()||(dir.mode&0o077)!==0||
     await realpath(directory)!==join(await realpath(root),'workspace/data/github-ownership'))
    throw new Error('private_directory_required');
  let previous=null;
  if(previousPath)previous=await securePrivateFile(resolve(previousPath));
  const registered=await readProjectRegistry({
    projectsRoot:root,layoutRoot:root,externalProjects:false
  });
  const now=new Date();
  const result=await buildRegisteredIdentitySnapshot({
    projects:registered.projects,readOrigin,resolveGitHub,previous,now
  });
  const stamp=now.toISOString().replaceAll(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const file=join(directory,'registered-project-identities-'+stamp+'-'+randomBytes(4).toString('hex')+'.json');
  const temp=join(directory,'.identity-'+randomBytes(8).toString('hex')+'.tmp');
  const stream=await open(temp,'wx',0o600);
  try{
    await stream.writeFile(JSON.stringify(result.snapshot,null,2)+'\n');
    await stream.sync();
  }finally{await stream.close();}
  try{await rename(temp,file);}
  finally{await unlink(temp).catch(()=>{});}
  process.stdout.write(JSON.stringify({ok:true,snapshot:file,private_mode:'0600',
    registered:result.project_count,github_identities:result.identity_count,
    unresolved:result.unresolved_count,verified_redirects:result.counts.verified_github_redirect,
    policy:'observational_only'})+'\n');
}catch(error){
  process.stdout.write(JSON.stringify({ok:false,error:shortError(error)})+'\n');
  process.exitCode=2;
}
