// TODO-P5-03, AC-P5-02/03 (automated part): the public OIDC-only listener (spec D4) over real
// HTTPS on loopback, with locally minted tokens. No identity provider, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import WebSocket from 'ws';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { createPublicListener, parsePublicListenerSettings, PRM_PATHS, MAX_PUBLIC_BODY_BYTES } from '../bridge/public-listener.mjs';
import { createOidcVerifier, BASELINE_SCOPE, CANONICAL_RESOURCE, WRITE_CAPABILITIES } from '../bridge/oidc.mjs';

const issuer = 'https://auth.memolabs.dev';
const ownerSub = 'owner-uuid-1';
const chatgpt = 'https://chatgpt.com/oauth/client.json';
const HOST = 'bridge.memolabs.dev';
const PRM_URL = 'https://bridge.memolabs.dev/.well-known/oauth-protected-resource/mcp';

const dir = mkdtempSync(join(tmpdir(), 'memo-public-listener-'));
const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'tls.key'), '-out', join(dir, 'tls.crt')], { encoding: 'utf8' });
assert.equal(made.status, 0, made.stderr);
const tlsKey = readFileSync(join(dir, 'tls.key'));
const tlsCert = readFileSync(join(dir, 'tls.crt'));
const pair = await generateKeyPair('ES256');
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] });
const oidc = { issuer, ownerSub, allowedClientIds: [chatgpt], jwks };
test.after(() => rmSync(dir, { recursive: true, force: true }));

const mint = ({ sub = ownerSub, scope = BASELINE_SCOPE, typ = 'at+jwt', aud = CANONICAL_RESOURCE } = {}) =>
  new SignJWT({ scope, client_id: chatgpt }).setProtectedHeader({ alg: 'ES256', kid: 'k1', typ })
    .setIssuer(issuer).setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);

function call(port, path, { method = 'GET', token, body, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = httpsRequest({
      hostname: '127.0.0.1', port, path, method, ca: tlsCert, servername: 'localhost',
      headers: {
        host: HOST,
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(payload !== undefined ? { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } : {}),
        ...headers
      }
    }, res => {
      let data = '';
      res.on('data', b => { data += b; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}
// JSON or SSE (the legacy stateless leg may stream): the first JSON-RPC message.
function rpc(data) {
  const text = data.trim();
  if (text.startsWith('{')) return JSON.parse(text);
  const line = text.split('\n').find(l => l.startsWith('data:'));
  return JSON.parse(line.slice(5));
}

async function withListener(options, fn) {
  const events = [];
  const listener = createPublicListener({ tlsKey, tlsCert, oidc, remoteEnabled: true, port: 0, audit: e => events.push(e), ...options });
  const { port } = await listener.start();
  try { await fn(port, events, listener); } finally { await listener.stop(); }
}

const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

test('protected resource metadata is served at both RFC 9728 paths, GET only', async () => {
  await withListener({}, async port => {
    const docs = [];
    for (const path of PRM_PATHS) {
      const res = await call(port, path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers['content-type'], /application\/json/);
      assert.equal(res.headers['cache-control'], 'no-store');
      docs.push(res.data);
    }
    assert.equal(docs[0], docs[1], 'same document at both paths');
    const doc = JSON.parse(docs[0]);
    assert.equal(doc.resource, CANONICAL_RESOURCE);
    assert.deepEqual(doc.authorization_servers, [issuer]);
    assert.deepEqual(doc.scopes_supported, [BASELINE_SCOPE], 'write scopes absent while the gate is closed');
    const post = await call(port, PRM_PATHS[0], { method: 'POST', body: {} });
    assert.equal(post.status, 405);
  });
});

test('401 and 403 challenge shapes; the static owner bearer is never a credential here', async () => {
  await withListener({}, async (port, events) => {
    const none = await call(port, '/mcp', { method: 'POST', body: listTools });
    assert.equal(none.status, 401);
    assert.equal(none.headers['www-authenticate'], `Bearer resource_metadata="${PRM_URL}", scope="${BASELINE_SCOPE}"`);
    const bad = await call(port, '/mcp', { method: 'POST', body: listTools, token: await mint({ sub: 'intruder' }) });
    assert.equal(bad.status, 401);
    assert.match(bad.headers['www-authenticate'], /^Bearer error="invalid_token"/);
    assert.match(bad.headers['www-authenticate'], new RegExp(`resource_metadata="${PRM_URL}"`));
    assert.match(bad.headers['www-authenticate'], new RegExp(`scope="${BASELINE_SCOPE}"`));
    assert.ok(!bad.data.includes('owner'), 'the refusal reason stays in the audit line');
    // The Phase 4 owner bearer (random hex) and an ID-token-shaped JWT are both just invalid tokens.
    const ownerBearer = await call(port, '/mcp', { method: 'POST', body: listTools, token: 'a'.repeat(64) });
    assert.equal(ownerBearer.status, 401);
    const idToken = await call(port, '/mcp', { method: 'POST', body: listTools, token: await mint({ typ: 'JWT' }) });
    assert.equal(idToken.status, 401);
    const scope = await call(port, '/mcp', { method: 'POST', body: listTools, token: await mint({ scope: 'openid profile' }) });
    assert.equal(scope.status, 403);
    assert.match(scope.headers['www-authenticate'], /^Bearer error="insufficient_scope"/);
    assert.match(scope.headers['www-authenticate'], new RegExp(`scope="${BASELINE_SCOPE}"`));
    assert.match(scope.headers['www-authenticate'], new RegExp(`resource_metadata="${PRM_URL}"`));
    const reasons = events.filter(e => e.event === 'public_auth_denied').map(e => e.reason);
    assert.deepEqual(reasons, ['no_credentials', 'owner_mismatch', 'malformed', 'typ', 'insufficient_scope']);
    assert.ok(!JSON.stringify(events).includes('eyJ'), 'no token in audit events');
  });
});

test('a valid owner token reaches MCP; the factory sees the principal and MCP-Protocol-Version', async () => {
  const seen = [];
  const factory = ctx => {
    seen.push({ principal: ctx.authInfo.extra.principal.id, caps: [...ctx.authInfo.extra.principal.capabilities],
      version: ctx.requestInfo?.headers.get('mcp-protocol-version'), auth: ctx.requestInfo?.headers.get('authorization') });
    const server = new McpServer({ name: 'probe', version: '0.0.0' });
    server.registerTool('whoami', { description: 'probe', inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    async () => ({ content: [{ type: 'text', text: ctx.authInfo.extra.principal.id }] }));
    return server;
  };
  await withListener({ factory }, async (port, events) => {
    const token = await mint({ scope: [BASELINE_SCOPE, ...WRITE_CAPABILITIES].join(' ') });
    const list = await call(port, '/mcp', { method: 'POST', body: listTools, token, headers: { 'mcp-protocol-version': '2025-11-25' } });
    assert.equal(list.status, 200, list.data);
    assert.equal(list.headers['mcp-session-id'], undefined, 'stateless: no session id');
    assert.deepEqual(rpc(list.data).result.tools.map(t => t.name), ['whoami']);
    const out = await call(port, '/mcp', { method: 'POST', token, headers: { 'mcp-protocol-version': '2025-11-25' },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } } });
    assert.equal(rpc(out.data).result.content[0].text, 'oidc:' + ownerSub);
    assert.equal(seen[0].principal, 'oidc:' + ownerSub);
    assert.deepEqual(seen[0].caps, [BASELINE_SCOPE], 'write scopes in the token, gate closed: read only');
    assert.equal(seen[0].version, '2025-11-25');
    assert.equal(seen[0].auth, null, 'the bearer token is not forwarded to the MCP layer');
    const request = events.find(e => e.event === 'public_request');
    assert.equal(request.principal, 'oidc:' + ownerSub);
    assert.match(request.client_ref, /^[0-9a-f]{12}$/);
    assert.match(request.request_id, /^[0-9a-f-]{36}$/);
  });
});

test('the default surface lists no tools until the remote registry lands', async () => {
  await withListener({}, async port => {
    const res = await call(port, '/mcp', { method: 'POST', body: listTools, token: await mint() });
    assert.equal(res.status, 200, res.data);
    assert.deepEqual(rpc(res.data).result.tools, []);
  });
});

test('transport refusals: 405, Origin, Host, 415, 413, unknown paths and upgrades', async () => {
  await withListener({}, async (port, events) => {
    const token = await mint();
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const res = await call(port, '/mcp', { method, token });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, 'POST');
      assert.equal(res.headers['mcp-session-id'], undefined);
    }
    for (const origin of ['https://evil.example', 'null', 'https://chatgpt.com.evil.example']) {
      const res = await call(port, '/mcp', { method: 'POST', body: listTools, token, headers: { origin } });
      assert.equal(res.status, 403, origin);
    }
    const fromChatgpt = await call(port, '/mcp', { method: 'POST', body: listTools, token, headers: { origin: 'https://chatgpt.com' } });
    assert.equal(fromChatgpt.status, 200);
    for (const host of ['127.0.0.1', 'evil.example', 'bridge.memolabs.dev.evil.example']) {
      const res = await call(port, '/mcp', { method: 'POST', body: listTools, token, headers: { host } });
      assert.equal(res.status, 403, host);
    }
    const text = await call(port, '/mcp', { method: 'POST', raw: 'x', token, headers: { 'content-type': 'text/plain' } });
    assert.equal(text.status, 415);
    const big = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: { pad: 'x'.repeat(200 * 1024) } });
    const tooLarge = await call(port, '/mcp', { method: 'POST', raw: big, token });
    assert.equal(tooLarge.status, 413);
    const chunked = await call(port, '/mcp', { method: 'POST', raw: big, token, headers: { 'transfer-encoding': 'chunked' } });
    assert.equal(chunked.status, 413, 'no content-length: counted while reading');
    assert.equal(events.filter(e => e.reason === 'body_too_large').length, 2, 'both refused by the listener, before the MCP layer');
    const fits = JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: { _meta: { pad: 'x'.repeat(MAX_PUBLIC_BODY_BYTES - 200) } } });
    assert.equal((await call(port, '/mcp', { method: 'POST', raw: fits, token })).status, 200, 'just under 128 KiB is served');
    for (const path of ['/agent', '/health', '/foo', '/', '/mcp/', '/.well-known/oauth-authorization-server']) {
      assert.equal((await call(port, path, { token })).status, 404, path);
    }
    const upgrade = await new Promise(resolve => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/agent`, 'memo-bridge.agent.v1', { ca: tlsCert, servername: 'localhost', headers: { host: HOST } });
      ws.on('open', () => { ws.close(); resolve('open'); });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.on('error', e => resolve(String(e.message)));
    });
    assert.equal(upgrade, 404, 'no WebSocket on the public listener');
    const reasons = new Set(events.filter(e => e.event === 'public_refused').map(e => e.reason));
    for (const r of ['method', 'origin', 'host', 'content_type', 'body_too_large', 'path', 'upgrade']) assert.ok(reasons.has(r), r);
  });
});

test('kill switch: remote_enabled false answers 503 everywhere', async () => {
  await withListener({ remoteEnabled: false }, async port => {
    for (const path of ['/mcp', ...PRM_PATHS]) {
      const res = await call(port, path, { method: path === '/mcp' ? 'POST' : 'GET', body: path === '/mcp' ? listTools : undefined, token: await mint() });
      assert.equal(res.status, 503, path);
    }
  });
});

test('write gate: enabled needs a passing self-check, then the metadata advertises write scopes', async () => {
  assert.throws(() => createPublicListener({ tlsKey, tlsCert, oidc, remoteWrites: 'enabled' }), /write_gate_self_check_missing/);
  assert.throws(() => createPublicListener({ tlsKey, tlsCert, oidc, remoteWrites: 'enabled', writeGateCheck: () => ({ ok: false, error: 'root_runner_active' }) }), /root_runner_active/);
  await withListener({ remoteWrites: 'enabled', writeGateCheck: () => ({ ok: true }) }, async port => {
    const doc = JSON.parse((await call(port, PRM_PATHS[1])).data);
    assert.deepEqual(doc.scopes_supported, [BASELINE_SCOPE, ...WRITE_CAPABILITIES]);
  });
});

test('structural separation: no bearer digest, agent keys, public bind or missing OIDC', () => {
  for (const key of ['tokenSha256', 'readOnlyTokenSha256', 'allowedAgentKeys', 'oidcPrincipal', 'mutatingOps']) {
    assert.throws(() => createPublicListener({ tlsKey, tlsCert, oidc, [key]: 'x' }), new RegExp(key));
  }
  assert.throws(() => createPublicListener({ tlsKey, tlsCert }), /OIDC configuration required/);
  assert.throws(() => createPublicListener({ tlsKey, tlsCert, oidc, bind: '0.0.0.0' }), /loopback/);
  assert.throws(() => createPublicListener({ tlsKey, tlsCert, oidc, port: 9443 }), /hub port/);
  assert.throws(() => createPublicListener({ oidc }), /TLS/);
  assert.throws(() => createPublicListener({ tlsKey, tlsCert, oidc, maxBodyBytes: 1024 * 1024 }), /maxBodyBytes/);
  const verifier = createOidcVerifier({ ...oidc, remoteWrites: 'disabled' });
  assert.throws(() => createPublicListener({ tlsKey, tlsCert, verifier, remoteWrites: 'enabled', writeGateCheck: () => ({ ok: true }) }), /disagree/);
  // The module does not import the bearer check, the agent WebSocket server or the hub.
  const source = readFileSync(new URL('../bridge/public-listener.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['./crypto.mjs', "from 'ws'", './hub.mjs', 'bearerValid', 'WebSocketServer']) assert.ok(!source.includes(forbidden), forbidden);
});

// remote.json as lab-infra renders it (ansible/roles/memo-bridge/templates/remote.json.j2 with
// the group_vars/lab.yml values), with a test owner sub.
export const LAB_REMOTE_JSON = Object.freeze({
  version: 1, managed_by: 'lab-infra role memo-bridge', remote_enabled: true,
  listen: { host: '127.0.0.1', port: 9445 }, public_host: HOST, allowed_origins: ['https://chatgpt.com'], trusted_proxies: ['127.0.0.1'],
  oidc: { issuer, jwks_uri: 'http://127.0.0.1:1411/.well-known/jwks.json', audience: CANONICAL_RESOURCE, owner_sub: ownerSub,
    allowed_client_ids: [chatgpt], required_scope: 'coordinator:read', max_token_age_sec: 3600 },
  projects: ['memolabs-dev/memo-bridge'], remote_writes: 'disabled', session_binding: 'warn',
  client_cert: { mode: 'log', info_header: 'x-forwarded-tls-client-cert-info', expected_san: 'mtls.prod.connectors.openai.com' },
  budgets: { body_max_bytes: 131072, result_max_bytes: 24576, page_max_bytes: 16384, write_file_max_bytes: 98304, list_max_items: 50,
    soft_deadline_sec: 40 },
  rate_limits: { read_per_min: 60, write_per_min: 20, execute_per_min: 6, in_flight: 8, unauthorized_per_min_per_ip: 30 }
});

test('remote.json parsing: the lab-infra file maps onto every Phase 5 piece; bad values are refused', () => {
  const ok = parsePublicListenerSettings(LAB_REMOTE_JSON);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.settings, {
    remoteEnabled: true, bind: '127.0.0.1', port: 9445, remoteWrites: 'disabled', maxBodyBytes: 131072,
    oidc: { issuer, resource: CANONICAL_RESOURCE, ownerSub, allowedClientIds: [chatgpt], jwksUri: 'http://127.0.0.1:1411/.well-known/jwks.json',
      maxTokenAgeSec: 3600 },
    allowedHosts: [HOST], allowedOrigins: ['chatgpt.com']
  });
  const c = ok.config;
  assert.deepEqual({ ...c.surface }, { owner_sub: ownerSub, allowed_client_ids: [chatgpt], remote_writes: 'disabled', result_budget_bytes: 24576,
    list_limit: 50, read_page_bytes: 16384, write_content_bytes: 98304 });
  assert.deepEqual([c.policy.projects, c.policy.session_binding, c.policy.owner_sub], [['memo-bridge'], 'warn', ownerSub]);
  assert.equal(c.softDeadlineMs, 40_000);
  assert.deepEqual(c.rateLimits, { perMinute: { read: 60, write: 20, execute: 6 }, inFlight: 8 });
  assert.deepEqual(c.authFailures, { perMinute: 30, trustedProxies: ['127.0.0.1'] });
  assert.deepEqual(c.clientCert, { mode: 'log', infoHeader: 'x-forwarded-tls-client-cert-info', expectedSan: 'mtls.prod.connectors.openai.com' });
  const minimal = parsePublicListenerSettings({ version: 1, public_host: HOST, projects: ['drop'],
    oidc: { issuer, audience: CANONICAL_RESOURCE, owner_sub: ownerSub, allowed_client_ids: { [chatgpt]: 'chatgpt' } } });
  assert.equal(minimal.ok, true, JSON.stringify(minimal));
  assert.deepEqual([minimal.settings.remoteEnabled, minimal.settings.port, minimal.settings.remoteWrites], [false, 9445, 'disabled']);
  const lab = structuredClone(LAB_REMOTE_JSON);
  const with_ = (mutate) => { const raw = structuredClone(lab); mutate(raw); return raw; };
  const refusals = [
    [null, 'config'], [[], 'config'], [with_(r => { r.version = 2; }), 'version'], [with_(r => { r.extra = 1; }), 'extra'],
    [with_(r => { r.remote_enabled = 'yes'; }), 'remote_enabled'], [with_(r => { r.listen.host = '0.0.0.0'; }), 'listen.host'],
    [with_(r => { r.listen.port = 9443; }), 'listen.port'], [with_(r => { r.listen.port = 80; }), 'listen.port'],
    [with_(r => { r.listen.bind = 'x'; }), 'listen.bind'], [with_(r => { r.public_host = 'https://x'; }), 'public_host'],
    [with_(r => { r.oidc.audience = 'https://other.memolabs.dev/mcp'; }), 'oidc.audience'],
    [with_(r => { r.oidc.required_scope = 'hosts:read'; }), 'oidc.required_scope'],
    [with_(r => { r.oidc.ceiling = ['root']; }), 'oidc.ceiling'], [with_(r => { r.oidc.typo = 1; }), 'oidc.typo'],
    [with_(r => { r.remote_writes = 'on'; }), 'remote_writes'], [with_(r => { r.allowed_origins = ['http://chatgpt.com']; }), 'allowed_origins'],
    [with_(r => { r.trusted_proxies = ['proxy.example']; }), 'trusted_proxies'], [with_(r => { r.client_cert.mode = 'require'; }), 'client_cert.mode'],
    [with_(r => { r.budgets.body_max_bytes = 1024 * 1024; }), 'budgets.body_max_bytes'],
    [with_(r => { r.budgets.write_file_max_bytes = 200_000; }), 'budgets.write_file_max_bytes'],
    [with_(r => { r.budgets.soft_deadline_sec = 500; }), 'budgets.soft_deadline_sec'],
    [with_(r => { r.rate_limits.in_flight = 0; }), 'rate_limits.in_flight'], [with_(r => { r.projects = []; }), 'projects'],
    [with_(r => { r.session_binding = 'strict'; }), 'projects or session_binding']
  ];
  for (const [raw, field] of refusals) {
    const out = parsePublicListenerSettings(raw);
    assert.equal(out.ok, false, JSON.stringify(raw));
    assert.equal(out.error, 'invalid_remote_config');
    assert.equal(out.field, field, `${JSON.stringify(raw)} -> ${JSON.stringify(out)}`);
  }
  // The OIDC values the verifier refuses: plain-HTTP issuer, JWKS off the issuer, token age.
  for (const mutate of [r => { r.oidc.issuer = 'http://auth.memolabs.dev'; }, r => { r.oidc.jwks_uri = 'https://attacker.example/jwks'; },
    r => { r.oidc.jwks_uri = 'http://10.0.7.2:1411/jwks'; }, r => { r.oidc.max_token_age_sec = 5; }, r => { r.oidc.owner_sub = ''; },
    r => { r.oidc.allowed_client_ids = []; }]) {
    const out = parsePublicListenerSettings(with_(mutate));
    assert.equal(out.ok, false);
    assert.match(out.field, /^oidc: /, JSON.stringify(out));
  }
  // The values remote-surface.mjs bounds are checked here too, so the hub fails before listening.
  const surface = parsePublicListenerSettings(with_(r => { r.budgets.list_max_items = 0; }));
  assert.equal(surface.ok, false);
  assert.match(surface.field, /list_limit/);
});

test('hub-cli refuses to start on a bad remote.json, the old OIDC mode, or remote_writes enabled without the self-check', () => {
  const secrets = mkdtempSync(join(dir, 'secrets-'));
  writeFileSync(join(secrets, 'tls.key'), tlsKey);
  writeFileSync(join(secrets, 'tls.crt'), tlsCert);
  writeFileSync(join(secrets, 'owner.token'), 'b'.repeat(64));
  writeFileSync(join(secrets, 'mac.pub'), 'unused');
  writeFileSync(join(secrets, 'vps.pub'), 'unused');
  const run = (settings, extraEnv = {}) => {
    const path = join(secrets, 'remote.json');
    writeFileSync(path, JSON.stringify(settings));
    return spawnSync(process.execPath, [new URL('../bridge/hub-cli.mjs', import.meta.url).pathname], {
      encoding: 'utf8', timeout: 20000,
      env: { PATH: process.env.PATH, MEMO_BRIDGE_SECRETS: secrets, MEMO_BRIDGE_REMOTE_CONFIG: path, ...extraEnv }
    });
  };
  // remote_writes enabled: where systemctl is missing the probe cannot run and the hub must refuse.
  // Where systemd runs (Linux CI) the probe may pass legitimately, so the refusal is only asserted
  // without systemctl; root-runner refusals are covered with an injected systemctl in
  // tests/remote-write-gate.test.mjs and tests/remote-boot.test.mjs.
  if (!['/usr/bin/systemctl', '/bin/systemctl'].some(file => existsSync(file))) {
    const writes = run({ ...LAB_REMOTE_JSON, remote_writes: 'enabled' });
    assert.notEqual(writes.status, 0);
    assert.match(writes.stderr, /remote writes refused/);
    assert.doesNotMatch(writes.stderr, /hub_started/);
  }
  const bad = run({ ...LAB_REMOTE_JSON, listen: { host: '0.0.0.0', port: 9445 } });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /invalid_remote_config \(listen\.host\)/);
  assert.doesNotMatch(bad.stderr, /hub_started/);
  const legacy = run(LAB_REMOTE_JSON, { MEMO_BRIDGE_OIDC_SETTINGS: '/etc/memo-bridge/oidc.json' });
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /MEMO_BRIDGE_OIDC_SETTINGS is no longer supported/);
  const relative = spawnSync(process.execPath, [new URL('../bridge/hub-cli.mjs', import.meta.url).pathname], {
    encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, MEMO_BRIDGE_SECRETS: secrets, MEMO_BRIDGE_REMOTE_CONFIG: 'remote.json' } });
  assert.notEqual(relative.status, 0);
  assert.match(relative.stderr, /absolute path/);
});
