// Failure-tolerant shutdown of the long-lived Mac/VPS runtime agent.
// Every phase is attempted even when the preceding phase failed, so an ACP
// owner's onShutdown hook cannot be skipped by an unrelated job supervisor.
export async function closeRuntimeAgent({agent=null,supervisor=null,runtimeOps=null,base=null}={}) {
  const failed=[];
  try { await agent?.stop?.(); } catch { failed.push('agent'); }
  for (const [name,dispose] of [
    ['jobs',()=>supervisor?.stop?.()],
    ['operations',()=>runtimeOps?.close?.()],
    ['runtime',()=>base?.close?.()]
  ]) {
    try { await dispose(); }
    catch { failed.push(name); }
  }
  return {ok:failed.length===0,failed};
}
