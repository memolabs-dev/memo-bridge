// Lease safety loop for a future supervised OpenCode ACP process. No launch.
// A lost/unknown lease must stop the child; connection failure is NOT permission.
export function createAcpLeaseMonitor({check,terminate,intervalMs=10_000,setIntervalFn=setInterval,clearIntervalFn=clearInterval}={}) {
  if(typeof check!=='function'||typeof terminate!=='function'||
    !Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>30_000)throw new TypeError('invalid_monitor');
  let state='created',timer=null,inFlight=null,stopped=false,reason=null;
  const halt=async why=>{
    if(stopped)return;stopped=true;reason=why;state='stopping';
    if(timer!==null){clearIntervalFn(timer);timer=null;}
    try{await terminate(why);}finally{state='stopped';}
  };
  const tick=()=>{
    if(stopped||inFlight)return inFlight??Promise.resolve();
    const run=(async()=>{
      try{
        const result=await check();
        if(!result?.ok)await halt(result?.error??'lease_unavailable');
      }catch{await halt('lease_unavailable');}
    })();
    inFlight=run.finally(()=>{inFlight=null;});
    return inFlight;
  };
  return Object.freeze({
    async start(){
      if(state!=='created')return {ok:false,error:'already_started'};
      state='checking';
      await tick();
      if(stopped)return {ok:false,error:reason};
      state='running';
      timer=setIntervalFn(()=>{void tick();},intervalMs);
      timer?.unref?.();
      return {ok:true,status:'running'};
    },
    tick,
    stop:why=>halt(why??'user_cancelled'),
    status:()=>({state,reason,checking:inFlight!==null})
  });
}
