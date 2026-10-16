// Single-owner, read-only MCP resource endpoint. Loopback only; HTTPS/OAuth edge is
// provided and owned by the installer, never by bridge.memolabs.dev.
// This process never acts as an OAuth authorization server or takes inbound tunnels itself.
import { createServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createStandaloneServer } from './server.mjs';
import { createPersonalVerifier } from './personal-auth.mjs';

export const PERSONAL_MCP_PATH = '/mcp';
export const PERSONAL_METADATA_PATHS = Object.freeze([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp'
]);
export const PERSONAL_MAX_BODY = 64 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const REJECTED_ORIGINS = /^null$/i;

function send(res, code, body = '', headers = {}) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(code, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }).end(body);
}

async function readBounded(req) {
  const declared = req.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > PERSONAL_MAX_BODY)) return null;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > PERSONAL_MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createPersonalRemoteService({ settings, localConfig, verifier = createPersonalVerifier(settings),
  bind = '127.0.0.1', port = settings?.port, gpuProbe } = {}) {
  if (!LOOPBACK.has(bind)) throw new Error('personal_endpoint_loopback_only');
  if (!localConfig || !Array.isArray(localConfig.projects) ||
      !settings || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid_personal_service_config');
  const resource = new URL(settings.resource);
  const metadata = JSON.stringify(verifier.metadata);
  const challenge = 'Bearer resource_metadata="' + verifier.metadataUrl + '", scope="inventory:read"';
  const handler = createMcpHandler(async context => {
    // No server instance for an unverified token.
    if (!context?.authInfo?.extra?.owner_verified) throw new Error('not_authorized');
    return createStandaloneServer({ config: localConfig, ...(gpuProbe ? { gpuProbe } : {}) });
  }, { legacy: 'stateless', responseMode: 'json', maxRequestBodySize: PERSONAL_MAX_BODY });

  async function forward(res, response) {
    const headers = { 'cache-control': 'no-store' };
    response.headers.forEach((value, name) => { headers[name] = value; });
    delete headers['mcp-session-id'];
    res.writeHead(response.status, headers);
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  }

  async function onRequest(req, res) {
    // Host must be the exact public resource host or loopback host: mitigate DNS rebinding.
    const expected = new Set([resource.host, '127.0.0.1:' + port, '[::1]:' + port]);
    if (!expected.has(req.headers.host)) return send(res, 403);
    let url;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); }
    catch { return send(res, 400); }
    if (PERSONAL_METADATA_PATHS.includes(url.pathname) && !url.search) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '', { allow: 'GET, HEAD' });
      return send(res, 200, req.method === 'HEAD' ? '' : metadata, { 'content-type': 'application/json' });
    }
    if (url.pathname !== PERSONAL_MCP_PATH || url.search) return send(res, 404);
    if (req.method !== 'POST') return send(res, 405, '', { allow: 'POST' });
    const origin = req.headers.origin;
    if (origin && (REJECTED_ORIGINS.test(origin) || origin !== 'https://chatgpt.com')) return send(res, 403);
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(authorization)) {
      return send(res, 401, '', { 'www-authenticate': challenge });
    }
    const verified = await verifier.verify(authorization.slice(7));
    if (!verified) return send(res, 401, '', { 'www-authenticate': challenge });
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return send(res, 415);
    const bytes = await readBounded(req);
    if (!bytes) return send(res, 413, '', { connection: 'close' });
    const headers = new Headers({
      'content-type': 'application/json',
      'accept': req.headers.accept || 'application/json, text/event-stream'
    });
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.startsWith('mcp-') && typeof value === 'string') headers.set(key, value);
    }
    const request = new Request(settings.resource, { method: 'POST', headers, body: bytes });
    await forward(res, await handler.fetch(request, {
      authInfo: { clientId: verified.clientId, scopes: ['inventory:read'],
        expiresAt: verified.expiresAt, token: '[redacted]',
        resource: resource, extra: { owner_verified: true } }
    }));
  }

  const server = createServer((req, res) => {
    onRequest(req, res).catch(() => send(res, 500));
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.maxRequestsPerSocket = 100;
  server.on('upgrade', (_, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'));

  return Object.freeze({
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bind, resolve);
      });
      return server.address();
    },
    async stop() {
      await handler.close().catch(() => {});
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
    metadata: verifier.metadata,
    boundAddress: bind
  });
}
