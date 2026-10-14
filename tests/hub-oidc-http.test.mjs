// Phase 5, decision D4: OAuth reaches the hub through the public listener only. The 9443
// listener of Phase 4 never takes an OAuth token, never serves the protected resource metadata,
// and refuses the Phase 1 OIDC options rather than ignoring them (that mode accepted any JWT
// with the right audience, ID tokens included).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { generateKeyPair, SignJWT } from 'jose';
import { createHub } from '../bridge/hub.mjs';

test('the 9443 hub refuses the OIDC options and answers an OAuth access token with 401, never with metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-oidc-http-'));
  let hub;
  try {
    const c = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'tls.key'), '-out', join(dir, 'tls.crt')], { encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
    const tlsKey = readFileSync(join(dir, 'tls.key'));
    const tlsCert = readFileSync(join(dir, 'tls.crt'));
    const tokenSha256 = createHash('sha256').update('o'.repeat(64)).digest('hex');
    const issuer = 'https://auth.memolabs.dev';
    const audience = 'https://bridge.memolabs.dev/mcp';
    for (const key of ['oidc', 'oidcPrincipal']) {
      assert.throws(() => createHub({ tlsKey, tlsCert, tokenSha256, allowedAgentKeys: {}, [key]: { issuer, audience } }),
        /public listener only/, key);
    }
    hub = createHub({ tlsKey, tlsCert, tokenSha256, allowedAgentKeys: {}, port: 0 });
    const { port } = await hub.start();
    const call = (path, { token, method = 'GET', body } = {}) => new Promise((resolve, reject) => {
      const req = httpsRequest({ hostname: '127.0.0.1', port, path, method, ca: tlsCert, headers: {
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } : {}) } }, res => {
        let data = ''; res.on('data', b => { data += b; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
      });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      assert.equal((await call(path)).status, 404, path);
    }
    const pair = await generateKeyPair('ES256');
    const token = await new SignJWT({ scope: 'coordinator:read hosts:read', client_id: 'https://chatgpt.com/oauth/client.json' })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt' }).setIssuer(issuer).setAudience(audience).setSubject('owner')
      .setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
    const denied = await call('/mcp', { method: 'POST', token, body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers['www-authenticate'], 'Bearer realm="memo-bridge"', 'no OAuth challenge on 9443');
    const owner = await call('/mcp', { method: 'POST', token: 'o'.repeat(64), body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } });
    assert.equal(owner.status, 200, 'the Phase 4 owner bearer keeps working');
  } finally { await hub?.stop(); rmSync(dir, { recursive: true, force: true }); }
});
