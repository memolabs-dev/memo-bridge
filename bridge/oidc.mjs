import { createRemoteJWKSet, jwtVerify } from 'jose';

export const REQUIRED_SCOPE = 'hosts:read';
export function oidcGuard(config) {
  if (!config || typeof config !== 'object') throw new Error('OIDC configuration required');
  const { issuer, audience, ownerSub, jwksUri, jwks, scope = REQUIRED_SCOPE } = config;
  for(const [key,val] of Object.entries({issuer,audience,ownerSub,scope})) {
    if(typeof val !== 'string' || val.length === 0) throw new Error('Missing OIDC value: '+key);
  }
  for (const val of [issuer,audience]) {
    const url = new URL(val);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('HTTPS issuer and resource required');
  }
  if(!audience.endsWith('/mcp')) throw new Error('Audience must be exact canonical MCP endpoint');
  if(typeof ownerSub !== 'string' || ownerSub.trim() !== ownerSub) throw new Error('Invalid owner subject');
  if(!jwks && typeof jwksUri !== 'string') throw new Error('Pinned JWKS URI is required');
  if(jwksUri){
    const u=new URL(jwksUri);
    if(u.protocol!=='https:' || u.username || u.password || u.hash || u.origin!==new URL(issuer).origin) throw new Error('JWKS URI must be HTTPS on issuer origin');
  }
  const keys=jwks || createRemoteJWKSet(new URL(jwksUri),{timeoutDuration:3000,cooldownDuration:20000});
  const requested=new Set(scope.split(' ').filter(Boolean));
  const guard={
    issuer, audience, scope,
    resourceMetadata: Object.freeze({resource:audience,authorization_servers:[issuer],scopes_supported:[...requested],bearer_methods_supported:['header']}),
    challenge: `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource',audience).href}", scope="${scope}"`,
    async accepts(auth){
      if(typeof auth!=='string' || !/^Bearer [A-Za-z0-9_.\-]+$/.test(auth)) return false;
      try{
        const {payload}=await jwtVerify(auth.slice(7),keys,{issuer,audience,algorithms:['RS256','ES256','EdDSA'],requiredClaims:['sub','exp','iat'],maxTokenAge:'20m'});
        if(payload.sub!==ownerSub) return false;
        const scopes=new Set((typeof payload.scope==='string'?payload.scope:'').split(' ').filter(Boolean));
        for(const needed of requested){if(!scopes.has(needed))return false;}
        return true;
      }catch{return false;}
    }
  };
  return Object.freeze(guard);
}
