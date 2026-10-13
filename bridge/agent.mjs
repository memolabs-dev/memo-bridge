import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { signChallenge } from './crypto.mjs';

const PROBE=String.raw`import json,platform,os,shutil
disk=shutil.disk_usage("/")
print(json.dumps({"hostname":platform.node(),"system":platform.system(),"architecture":platform.machine(),"cpu_count":os.cpu_count(),"load_average":[round(v,2) for v in os.getloadavg()] if hasattr(os,"getloadavg") else None,"disk_free_gib":round(disk.free/(1024**3),1)}))
`;
export async function localStatus(host){
  if(!['mac','vps'].includes(host))throw new Error('Unknown host');
  return await new Promise(resolve=>{
    const p=spawn('python3',['-'],{stdio:['pipe','pipe','ignore']});
    let output='';
    const timer=setTimeout(()=>p.kill('SIGKILL'),3000);
    p.stdout.on('data',x=>output=(output+x).slice(0,4096));
    p.on('error',()=>{clearTimeout(timer);resolve({host,online:false,error:'probe_unavailable'});});
    p.on('close',status=>{clearTimeout(timer);
      try{const d=JSON.parse(output);if(status!==0)throw new Error();resolve({host,online:true,...d});}catch{resolve({host,online:false,error:'probe_failed'});}
    });
    p.stdin.on('error',()=>{});p.stdin.end(PROBE);
  });
}
export function createAgent({host,url,privateKey,ca, reconnectMs=3000, log=()=>{}}){
  if (!['mac','vps'].includes(host))throw new Error('Invalid host');
  const endpoint=new URL(url);
  if(endpoint.protocol!=='wss:' || !['localhost','127.0.0.1'].includes(endpoint.hostname) || endpoint.pathname!=='/agent' || endpoint.search || !endpoint.port) throw new Error('Only private TLS tunnel endpoints accepted');
  let stopped=false,ws=null, timer=null, trusted=false;
  const open=()=>{
    if(stopped)return;
    ws=new WebSocket(url,'memo-bridge-agent-v1',{ca, rejectUnauthorized:true,perMessageDeflate:false,handshakeTimeout:5000,maxPayload:16384});
    ws.on('message',async data=>{
      let msg;try{msg=JSON.parse(data.toString());}catch{ws.close();return;}
      if(msg.type==='challenge'){
        ws.send(JSON.stringify({type:'authenticate',host,signature:signChallenge(host,msg.nonce,privateKey)}));return;
      }
      if(msg.type==='authenticated'){trusted=true;log('connected',host);return;}
      if(trusted && msg.type==='request' && msg.op==='host_status' && typeof msg.id==='string'){
        const result=await localStatus(host);
        if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'result',id:msg.id,data:result}));
      }
    });
    ws.on('error',()=>{});
    ws.on('close',()=>{trusted=false; if(!stopped)timer=setTimeout(open,reconnectMs);});
  };
  open();
  return {stop(){stopped=true;clearTimeout(timer);ws?.terminate();}};
}
