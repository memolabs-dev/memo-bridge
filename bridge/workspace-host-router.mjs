// Durable, owner-scoped host affinity for the opt-in multi-runtime remote path.
// A Mac route is added only after an authenticated Mac runtime accepts workspace_open.
// Snapshot discovery is NEVER an execution grant. Unknown IDs use the legacy VPS
// runtime; a Mac route never falls back to VPS when its host is offline.
//
// Placement of a workspace_open that names no host (zero-friction spec, issue #110): the VPS
// runtime's projects_list says where the project is registered. A project the VPS knows only
// from the Mac discovery snapshot (metadata_only, source_host mac) opens on the Mac; anything
// else opens on the VPS, as before. Discovery decides placement only: the Mac runtime still
// checks its own registry, Git origin, remote policy and owner-private enrollment, and refuses
// on its own. A Mac that is offline, or connected in probe mode, answers host_offline.
//
// The snapshot is exported by hand, so a project created a minute ago by project_create is not in
// it (issue #218). When the VPS answers that it does not know the project at all (an empty exact
// match, never a refusal), the hub asks the Mac runtime's own projects_list for that exact name:
// one real (not metadata-only) row places the call on the Mac. The Mac answers for the same
// principal, through its own remote policy, so it lists only what it would also let this caller
// open. Any doubt (Mac offline or in probe mode, listing refused, zero or several rows) keeps the
// legacy VPS placement, and the placement is journaled.
//
// project_create always goes to the Mac runtime: PROJECTS.md, the source of truth of the
// projects, lives there (owner console spec section 09, D-A2-1); an offline Mac answers host_offline.
//
// Implicit workspaces (server/tools/implicit-workspace.mjs) are resolved by the runtime that
// receives the call, so a workspace tool called without workspace_id must reach the right host
// first: the Mac when this conversation already has a Mac workspace on the hinted project, or
// when that project (args.project, else the repository of args.issue) is registered on the Mac
// only. The workspace the Mac runtime then opens or picks is bound like any other.
//
// Repository-scoped GitHub reads (github_issues, github_pull_requests, github_workflows,
// github_checks) carry only `repo`: they name no workspace and no project, so the hint above has
// nothing to resolve and the discovery snapshot deliberately exports no git origin
// (server/catalog-snapshot.mjs, "never ... git origins"). Their placement uses the exact signal
// that is available instead: the local registry answer. A repository the receiving host does not
// register at all ("repo_not_registered") belongs to the host that holds the owner's private
// checkouts, so the read is asked of the Mac, which re-checks its own registry, policy and owner
// enrolment before answering (owner console REQ-A1). A policy refusal is never retried, and a Mac
// that cannot answer leaves the local refusal standing.
import { createHubState } from './hub-state.mjs';
import { IMPLICIT_WORKSPACE_TOOLS } from '../server/tools/implicit-workspace.mjs';

const ID = /^(?:ws|wt|job)_[A-Za-z0-9_-]{8,60}$/;
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
const ISSUE = /^[A-Za-z0-9-]{1,39}\/([A-Za-z0-9._-]{1,100})#[1-9][0-9]{0,7}$/;
// The `repo` argument of the repository-scoped GitHub reads, same shape as write-gate's REPO_RE.
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const MAX_ROUTES = 2000;
const BY_PROJECT = new Set(['batch_create', 'batch_status', 'tasks_list']);
// Reads whose only key is a repository (server/tools/github-tools.mjs): placed in call() from the
// local registry answer, since no argument names a project. github_create_pr is not here: it
// carries a worktree_id and already follows the Mac route of its workspace.
const GITHUB_READ_TOOLS = new Set(['github_issues', 'github_pull_requests', 'github_workflows', 'github_checks']);
// A Mac that cannot answer says one of these; the local refusal then stands unchanged.
const MAC_UNAVAILABLE = new Set(['host_offline', 'unsupported_op']);
// Calls that name no workspace but a project or an Issue: placed like an implicit workspace call.
// task_status reads the lease of an Issue: on the VPS a private repository is refused
// (project_not_allowed), so it must go where the project lives (seen 2026-10-18, CDKF#14).
// project_context checks the receiving runtime's allowlist the same way (memo-orbit, 2026-10-22).
const HINTED = new Set([...IMPLICIT_WORKSPACE_TOOLS, ...BY_PROJECT, 'task_status', 'project_context']);
const fail = (error, detail) => ({ ok:false, error, ...(detail ? { detail } : {}) });
const PROBE_ONLY = 'the Mac agent is connected in probe mode: its runtime is not installed (deploy/mac/install-runtime-agent.sh)';

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
      (row.project !== undefined && row.project !== null && !PROJECT.test(row.project)) ||
      (row.session !== undefined && row.session !== null && !SESSION.test(row.session)))
      throw new Error('mac_runtime_routing state invalid');
    routes.set(row.id,{host:row.host,owner:row.owner,...(row.project ? {project:row.project} : {}),
      ...(row.session ? {session:row.session} : {})});
  }
  function remember(id,principal,project=null,session=null) {
    if (!ID.test(id ?? '') || !principal?.id?.startsWith('oidc:') || (project && !PROJECT.test(project))) return false;
    if (!SESSION.test(session ?? '')) session=null;
    if (!routes.has(id) && routes.size >= MAX_ROUTES) return false;
    const previous=routes.get(id);
    if (previous && (previous.owner !== principal.id || (project && previous.project && previous.project !== project)))
      return false;
    routes.set(id,{host:'mac',owner:principal.id,...(project ? {project} : previous?.project ? {project:previous.project} : {}),
      ...(session ? {session} : previous?.session ? {session:previous.session} : {})});
    const result=state.save('workspace_routes',{bindings:[...routes].map(([name,route])=>({id:name,...route}))});
    if (result.ok !== true) {
      if (previous) routes.set(id,previous);
      else routes.delete(id);
      return false;
    }
    return true;
  }
  // {host, inferred:true, reason}. Any doubt (listing refused, several or no exact rows) keeps
  // the legacy VPS placement, where an unknown project is refused as before.
  async function placeOpen(host,project,envelope,op) {
    const vps={host,inferred:true,reason:'project_on_vps'};
    if (!PROJECT.test(project ?? '')) return vps;
    const exactRows=async on => {
      let listed;
      try { listed=await requestAgent(on,'projects_list',{...envelope,args:{search:project}}); } catch { return null; }
      if (listed?.ok === false || !Array.isArray(listed?.projects)) return null;
      return listed.projects.filter(p => p?.name === project);
    };
    const rows=await exactRows(host);
    if (rows === null) return vps;
    if (rows.length === 1)
      return rows[0].metadata_only === true && rows[0].source_host === 'mac'
        ? {host:'mac',inferred:true,reason:'project_registered_on_mac_only'} : vps;
    if (rows.length !== 0 || host === 'mac') return vps;
    // Unknown here: the live Mac registry, never a snapshot, says whether it is the owner's Mac project.
    const onMac=await exactRows('mac');
    if (onMac?.length !== 1 || onMac[0].metadata_only === true) return vps;
    audit({event:'project_placed_on_mac_live',op,project,principal:envelope.principal?.id});
    return {host:'mac',inferred:true,reason:'project_registered_on_mac'};
  }
  // The project a workspace tool without workspace_id means: its project, else its Issue's repository.
  function projectHint(args) {
    if (PROJECT.test(args.project ?? '')) return args.project;
    const repo=ISSUE.exec(typeof args.issue === 'string' ? args.issue : '')?.[1]?.toLowerCase();
    return repo && PROJECT.test(repo) ? repo : null;
  }
  async function implicitDestination(host,op,args,envelope) {
    const hint=projectHint(args);
    if (!hint) return host;
    const session=envelope.clientSession;
    for (const [id,binding] of routes) {
      if (id.startsWith('ws_') && binding.owner === envelope.principal?.id && binding.project === hint &&
        SESSION.test(session ?? '') && binding.session === session) return binding.host;
    }
    return (await placeOpen(host,hint,envelope,op)).host;
  }
  async function call(host,op,inbound) {
    let envelope=inbound;
    if (!enabled) return requestAgent(host,op,envelope);
    const args=envelope.args ?? {},principal=envelope.principal;
    const ids=[args.workspace_id,args.worktree_id,args.job_id].filter(Boolean);
    let destination=host;
    let placement=null;
    if (op === 'workspace_open' && args.host === undefined) {
      placement=await placeOpen(host,args.project,envelope,op);
      destination=placement.host;
      envelope={...envelope,args:{...args,host:placement.host}};
    } else if (op === 'workspace_open' && args.host === 'mac') destination='mac';
    // project_create runs where the registry lives (owner console D-A2-1), whatever the host argument.
    else if (op === 'project_create') destination='mac';
    else {
      for (const id of ids) {
        const binding=routes.get(id);
        if (!binding) continue;
        if (binding.owner !== principal?.id) return fail('workspace_other_principal');
        if (destination !== host && destination !== binding.host) return fail('host_mismatch');
        destination=binding.host;
      }
      if (destination === host && HINTED.has(op) && args.workspace_id === undefined && ids.length === 0)
        destination=await implicitDestination(host,op,args,envelope);
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
    let result=await requestAgent(destination,op,envelope);
    if (destination === 'mac' && result?.ok === false && result.error === 'unsupported_op') return fail('host_offline', PROBE_ONLY);
    // A repository the receiving host does not register belongs to the host that holds the owner's
    // private checkouts. Only this exact refusal moves the read, never a policy answer, and only
    // when the Mac actually answered: a Mac that is offline or in probe mode leaves the local
    // refusal standing, as before.
    if (destination !== 'mac' && GITHUB_READ_TOOLS.has(op) && REPO.test(args.repo ?? '')
      && result?.ok === false && result.error === 'repo_not_registered') {
      let onMac=null;
      try { onMac=await requestAgent('mac',op,envelope); } catch { onMac=null; }
      if (onMac && (onMac.ok === true || !MAC_UNAVAILABLE.has(onMac.error))) {
        audit({event:'repo_scoped_read_routed_to_mac',op,repo:args.repo,principal:principal?.id,
          outcome:onMac.ok === true ? 'ok' : onMac.error});
        result=onMac;
      }
    }
    if (destination !== 'mac' || !result?.ok) return result;
    const session=envelope.clientSession ?? null;
    if (op === 'workspace_open') {
      if (result.workspace?.host !== 'mac' || !remember(result.workspace?.workspace_id,principal,args.project,session))
        return fail('workspace_route_not_persisted');
      if (placement) return {...result,placement};
    } else {
      const implicit=result.implicit_workspace;
      if (implicit?.workspace_id && !remember(implicit.workspace_id,principal,PROJECT.test(implicit.project ?? '') ? implicit.project : null,session))
        return fail('workspace_route_not_persisted');
      for (const id of [result.worktree?.worktree_id,result.job?.job_id]) {
        if (id && !remember(id,principal,null,session)) return fail('workspace_route_not_persisted');
      }
    }
    return result;
  }
  return Object.freeze({call,bindingsCount:()=>routes.size});
}
