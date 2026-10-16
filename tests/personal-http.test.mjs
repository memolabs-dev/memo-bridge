import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createPersonalRemoteService } from '../standalone/personal-http.mjs';
import { parsePersonalRemoteConfig, createPersonalVerifier } from '../standalone/personal-auth.mjs';

async function decodeMcp(res) {
  const text = await res.text();
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const messages = text.split(/\r?\n/).filter(line => line.startsWith('data:'));
    assert.ok(messages.length > 0, 'SSE must include at least one JSON-RPC message');
    return JSON.parse(messages.at(-1).slice(5).trim());
  }
  return JSON.parse(text);
}

async function reservePort() {
  const s = createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return port;
}

async function setup(t) {
  const port = await reservePort();
  const settings = parsePersonalRemoteConfig({
    version: 1, enabled: true, issuer: 'https://login.friend.example',
    resource: 'https://endpoint.friend.example/mcp', owner_sub: 'friend-sub',
    allowed_client_ids: ['chatgpt-friend'], port
  });
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const verifier = createPersonalVerifier(settings, { jwks: createLocalJWKSet({ keys: [jwk] }) });
  const service = createPersonalRemoteService({
    settings, verifier, port, localConfig: { schema_version: 1, projects: [] },
    gpuProbe: async () => ({ source: 'observed', status: 'unknown', gpus: [] })
  });
  const address = await service.start();
  t.after(() => service.stop());
  const origin = 'http://127.0.0.1:' + address.port;
  const token = async (sub = 'friend-sub') => new SignJWT({
    scope: 'inventory:read', client_id: 'chatgpt-friend'
  }).setProtectedHeader({ typ: 'at+jwt', alg: 'RS256', kid: 'test-key' })
    .setIssuer(settings.issuer).setAudience(settings.resource).setSubject(sub)
    .setIssuedAt().setExpirationTime('30m').sign(privateKey);
  const request = (method, path, { bearer, body, headers = {} } = {}) => fetch(origin + path, {
    method, headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
      ...(body ? { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { origin, settings, service, token, request };
}

test('unauthenticated discovery works; MCP tools and other paths are protected', async t => {
  const { settings, request } = await setup(t);
  const metadata = await request('GET', '/.well-known/oauth-protected-resource');
  assert.equal(metadata.status, 200);
  const data = await metadata.json();
  assert.equal(data.resource, settings.resource);
  assert.deepEqual(data.authorization_servers, [settings.issuer]);
  assert.deepEqual(data.scopes_supported, ['inventory:read']);

  const noToken = await request('POST', '/mcp');
  assert.equal(noToken.status, 401);
  assert.match(noToken.headers.get('www-authenticate'), /resource_metadata=/);
  assert.equal((await request('GET', '/agent')).status, 404);
  assert.equal((await request('GET', '/mcp')).status, 405);
  assert.equal((await request('POST', '/mcp?x=1')).status, 404);
  assert.equal((await request('POST', '/mcp', { headers: { origin: 'https://evil.example' } })).status, 403);
});

test('authenticated personal owner can list only the five standalone read-only tools', async t => {
  const { token, request } = await setup(t);
  const bearer = await token();
  const response = await request('POST', '/mcp', {
    bearer, body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
  });
  const json = await decodeMcp(response);
  assert.equal(response.status, 200, JSON.stringify(json));
  const names = json.result?.tools?.map(t => t.name).sort();
  assert.deepEqual(names, ['bridge_info', 'gpu_inventory', 'host_capabilities', 'project_inspect', 'projects_list']);
  const info = await request('POST', '/mcp', {
    bearer, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_info', arguments: {} } }
  });
  const body = await decodeMcp(info);
  assert.equal(info.status, 200, JSON.stringify(body));
  assert.equal(JSON.parse(body.result.content[0].text).local_only, true);
});

test('valid token of another owner cannot access the same endpoint', async t => {
  const { token, request } = await setup(t);
  const bearer = await token('another-person');
  const result = await request('POST', '/mcp', {
    bearer, body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
  });
  assert.equal(result.status, 401);
  assert.equal((await result.text()).includes('another-person'), false);
});

test('listener rejects every non-loopback bind', async () => {
  const settings = parsePersonalRemoteConfig({
    version: 1, enabled: true, issuer: 'https://auth.friend.example',
    resource: 'https://remote.friend.example/mcp',
    owner_sub: 'me', allowed_client_ids: ['personal'], port: 4481
  });
  const verifier = { metadata: {}, metadataUrl: 'https://remote.friend.example/.well-known/oauth-protected-resource',
    verify: async () => null };
  assert.throws(() => createPersonalRemoteService({
    settings, verifier, bind: '0.0.0.0', localConfig: { projects: [] }
  }), /loopback_only/);
});
