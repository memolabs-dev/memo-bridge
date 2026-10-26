#!/usr/bin/env node
// Read-only verification of an owner-private identity snapshot produced by the local Mac audit.
// No GitHub tokens, network calls, writes, raw origins, private repo names or paths in stdout.
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseRegisteredIdentities } from '../server/projects/github-identity-audit.mjs';

const fail = code => { process.stdout.write(JSON.stringify({ok:false,error:code})+'\n'); process.exitCode=2; };
const path=process.argv[2];
if(!path || !isAbsolute(path)){
  fail('absolute_snapshot_path_required');
}else{
  try{
    const info=await stat(path);
    if(!info.isFile() || info.size>512*1024 || (info.mode&0o077)!==0)
      throw new Error('private_snapshot_required');
    const payload=await readFile(path,'utf8');
    const parsed=parseRegisteredIdentities(JSON.parse(payload));
    const out={ok:!parsed.stale&&parsed.same_id_projects.length===0,
      schema:parsed.schema,observed_at:parsed.observed_at,stale:parsed.stale,
      registered_entries:parsed.entries.length,distinct_github_ids:parsed.identity_count,
      unresolved:parsed.unresolved_count,live_verified_redirects:parsed.redirects.length,
      repeated_ids_requiring_review:parsed.same_id_projects.length,
      authoritative_for_execution:false};
    process.stdout.write(JSON.stringify(out)+'\n');
    if(!out.ok)process.exitCode=2;
  }catch(error){
    // Exact paths, repo names and untrusted file content must not escape to logs.
    fail(['invalid_identity_snapshot','invalid_identity_timestamp','invalid_identity_entry',
      'invalid_identity_evidence','unverified_alias','conflicting_origin_id',
      'conflicting_canonical_id','conflicting_canonical_alias','duplicate_project_name',
      'unverified_identity'].includes(error.message)?error.message:'identity_snapshot_unavailable');
  }
}
