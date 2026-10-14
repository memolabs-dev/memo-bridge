// Hub entry point (memo-bridge-hub.service). Secrets come from MEMO_BRIDGE_SECRETS:
//   tls.key, tls.crt, owner.token, mac.pub, vps.pub   (as before)
//   readonly.token                                     optional, read-only test bearer (spec D9, O-9)
// Configuration (environment, set by the lab-infra unit):
//   MEMO_BRIDGE_OIDC_SETTINGS      path of the OIDC settings (Phase 5); bearer mode otherwise
//   MEMO_BRIDGE_HUB_RUNTIME_HOST   'vps' to forward the runtime tools to that agent (read ops)
//   MEMO_BRIDGE_HUB_MUTATING_OPS   'owner' to also forward mutating ops for the owner principal.
//                                  Leave unset until the AC-14 gate passes (TODO-P4-40,
//                                  docs/HUB_SECURITY.md). Any other value refuses to start.
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createHub } from './hub.mjs';

const dir=process.env.MEMO_BRIDGE_SECRETS;
if(!dir)throw new Error('MEMO_BRIDGE_SECRETS required');
const get=file=>readFileSync(dir+'/'+file,'utf8');
const digest=value=>createHash('sha256').update(value).digest('hex');
const tlsKey=get('tls.key'),tlsCert=get('tls.crt');
const oidcSettings=process.env.MEMO_BRIDGE_OIDC_SETTINGS;
const oidc=oidcSettings ? JSON.parse(readFileSync(oidcSettings,'utf8')) : null;
const tokenSha256=oidc ? undefined : digest(get('owner.token').trim());
const readOnlyToken=!oidc && existsSync(dir+'/readonly.token') ? get('readonly.token').trim() : '';
const readOnlyTokenSha256=readOnlyToken ? digest(readOnlyToken) : null;
const runtimeHost=process.env.MEMO_BRIDGE_HUB_RUNTIME_HOST || null;
const mutatingRaw=process.env.MEMO_BRIDGE_HUB_MUTATING_OPS;
if (mutatingRaw!==undefined && mutatingRaw!=='' && mutatingRaw!=='owner') throw new Error('MEMO_BRIDGE_HUB_MUTATING_OPS must be "owner" or unset');
const mutatingOps=mutatingRaw==='owner' ? 'owner' : false;
const allowedAgentKeys={mac:get('mac.pub'),vps:get('vps.pub')};
const hub=createHub({tlsKey,tlsCert,tokenSha256,readOnlyTokenSha256,oidc,allowedAgentKeys,runtimeHost,mutatingOps,
  audit:ev=>console.error(JSON.stringify(ev))});
await hub.start();
console.error(JSON.stringify({event:'hub_started',bind:'127.0.0.1:9443',runtime_host:runtimeHost,mutating_ops:mutatingOps||'disabled',
  readonly_principal:Boolean(readOnlyTokenSha256)}));
process.on('SIGTERM',async()=>{await hub.stop();process.exit(0);});
