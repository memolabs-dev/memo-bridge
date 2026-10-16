// Durable, owner-scoped host affinity for the opt-in multi-runtime remote path.
// A Mac route is added only after an authenticated Mac runtime accepts workspace_open.
// Snapshot discovery is NEVER an execution grant. Unknown IDs use the legacy VPS
// runtime; a Mac route never falls back to VPS when its host is offline.
import { createHubState } from './hub-state.mjs';

const ID = /^(?:ws|wt|job)_[A-Za-z0-9_-]{8,60}$/;
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MAX_ROUTES = 2000;
const BY_PROJECT = new Set(['batch_create', 'batch_status', 'tasks_list']);
const fail = error => ({ ok:false, error });

export function createWorkspaceHostRouter({ requestAgent, enabled=false, stateDir=null, audit=()=>{} }={}) {
  if (typeof requestAgent !== 'function') throw new TypeError('requestAgent required');
  if (enabled && !stateDir) throw new Error('mac_runtime_routing requires durable hub state');
  const state = enabled ? createHubState({dir:stateDir,record:(event,info)=>audit({event,...info})}) : null;
  const saved = state?.load('workspace_routes',{bindings:[]});
  if (enabled && (!saved || !Array.isArray(saved.bindings) || saved.bindings.length > MAX_ROUTES))
    throw new Error('mac_runtime_routing state invalid');
  const routes = new Map();
  for (const row of saved?.bindings ?? []) {
    if (!row || !ID.test(row.id ?? '') || row.host !== 'mac' ||
      typeof row.owner !== 'string' || !row.owner.startsWith('oidc:') ||
      (row.project !== undefined && row.project !== null && !PROJECT.test(row.project)))
      throw new Error('mac_runtime_routing state invalid');
    routes.set(row.id,{host:row.host,owner:row.owner,...(row.project ? {project:row.project} : {})});
  }
  function remember(id,principal,project=null) {
    if (!ID.test(id ?? '') || !principal?.id?.startsWith('oidc:') || (project && !PROJECT.test(project))) return false;
    if (!routes.has(id) && routes.size >= MAX_ROUTES) return false;
    const previous=routes.get(id);
    if (previous && (previous.owner !== principal.id || (project && previous.project && previous.project !== project)))
      return false;
    routes.set(id,{host:'mac',owner:principal.id,...(project ? {project} : previous?.project ? {project:previous.project} : {})});
    const result=state.save('workspace_routes',{bindings:[...routes].map(([name,route])=>({id:name,...route}))});
    if (result.ok !== true) {
      if (previous) routes.set(id,previous);
      else routes.delete(id);
      return false;
    }
    return true;
  }
  async function call(host,op,envelope) {
    if (!enabled) return requestAgent(host,op,envelope);
    const args=envelope.args ?? {},principal=envelope.principal;
    const ids=[args.workspace_id,args.worktree_id,args.job_id].filter(Boolean);
    let destination=host;
    if (op === 'workspace_open' && args.host === 'mac') destination='mac';
    else {
      for (const id of ids) {
        const binding=routes.get(id);
        if (!binding) continue;
        if (binding.owner !== principal?.id) return fail('workspace_other_principal');
        if (destination !== host && destination !== binding.host) return fail('host_mismatch');
        destination=binding.host;
      }
      // batch_create has no workspace_id. Bind a project only AFTER Mac
      // successfully opened a workspace for this same authenticated owner.
      if (destination === host && BY_PROJECT.has(op) && PROJECT.test(args.project ?? '')) {
        for (const [id,binding] of routes) {
          if (!id.startsWith('ws_') || binding.project !== args.project) continue;
          if (binding.owner !== principal?.id) continue;
          destination=binding.host;
          break;
        }
      }
    }
    const result=await requestAgent(destination,op,envelope);
    if (destination !== 'mac' || !result?.ok) return result;
    if (op === 'workspace_open') {
      if (result.workspace?.host !== 'mac' || !remember(result.workspace?.workspace_id,principal,args.project))
        return fail('workspace_route_not_persisted');
    } else {
      for (const id of [result.worktree?.worktree_id,result.job?.job_id]) {
        if (id && !remember(id,principal)) return fail('workspace_route_not_persisted');
      }
    }
    return result;
  }
  return Object.freeze({call,bindingsCount:()=>routes.size});
}
