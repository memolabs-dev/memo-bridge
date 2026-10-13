import { readFileSync } from 'node:fs';
import { createAgent } from './agent.mjs';
const dir=process.env.MEMO_BRIDGE_AGENT_CONFIG;
const host=process.env.MEMO_BRIDGE_HOST;
if(!dir || !['mac','vps'].includes(host))throw new Error('Missing agent configuration');
const agent=createAgent({
  host,
  url:process.env.MEMO_BRIDGE_AGENT_URL||'wss://localhost:9443/agent',
  privateKey:readFileSync(dir+'/agent.key','utf8'),
  ca:readFileSync(dir+'/hub-ca.crt','utf8'),
  log:(event,host)=>console.error(JSON.stringify({event,host}))
});
process.on('SIGTERM',()=>{agent.stop();process.exit(0);});
