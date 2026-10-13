import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { oidcGuard } from '../bridge/oidc.mjs';

test('owner-bound OAuth resource guard: audience, issuer, subject, expiration and scopes',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('ES256');
  const publicJwk=await exportJWK(publicKey);
  const jwks=createLocalJWKSet({keys:[{...publicJwk,kid:'k1',alg:'ES256',use:'sig'}]});
  const issuer='https://auth.example.test',audience='https://bridge.example.test/mcp';
  const guard=oidcGuard({issuer,audience,ownerSub:'owner-uuid',jwks});
  async function make({iss=issuer,aud=audience,sub='owner-uuid',scope='hosts:read',expiry='5m',iat}={}){
    let builder=new SignJWT({scope}).setProtectedHeader({alg:'ES256',kid:'k1'}).setIssuer(iss).setAudience(aud).setSubject(sub).setIssuedAt(iat||Math.floor(Date.now()/1000));
    return builder.setExpirationTime(expiry).sign(privateKey);
  }
  assert.equal(await guard.accepts('Bearer '+await make()),true);
  assert.equal(await guard.accepts('Bearer '+await make({iss:'https://evil.example.test'})),false);
  assert.equal(await guard.accepts('Bearer '+await make({aud:'https://other.example.test/mcp'})),false);
  assert.equal(await guard.accepts('Bearer '+await make({sub:'other-owner'})),false);
  assert.equal(await guard.accepts('Bearer '+await make({scope:'hosts:write'})),false);
  assert.equal(await guard.accepts('Bearer '+await make({expiry:'-2m'})),false);
  assert.equal(await guard.accepts('Bearer '+await make({iat:Math.floor(Date.now()/1000)-3600})),false);
  assert.equal(await guard.accepts('Bearer malformed'),false);
  assert.equal(await guard.accepts(''),false);
  assert.deepEqual(guard.resourceMetadata.authorization_servers,[issuer]);
  assert.equal(guard.resourceMetadata.resource,audience);
  assert.equal(guard.challenge,'Bearer resource_metadata="https://bridge.example.test/.well-known/oauth-protected-resource", scope="hosts:read"');
});
test('refuse unsafe identity and resource configuration',()=>{
  for(const c of [
    {issuer:'http://insecure.example',audience:'https://bridge.example/mcp',ownerSub:'owner',jwksUri:'https://insecure.example/jwks'},
    {issuer:'https://issuer.example',audience:'https://bridge.example/mcp',ownerSub:'',jwksUri:'https://issuer.example/jwks'},
    {issuer:'https://issuer.example',audience:'https://bridge.example/mcp',ownerSub:'owner',jwksUri:'http://issuer.example/jwks'},
    {issuer:'https://issuer.example',audience:'https://bridge.example/mcp',ownerSub:'owner',jwksUri:'https://attacker.example/jwks'},
    {issuer:'https://issuer.example',audience:'https://bridge.example/other',ownerSub:'owner',jwksUri:'https://issuer.example/jwks'}
  ])assert.throws(()=>oidcGuard(c));
});
