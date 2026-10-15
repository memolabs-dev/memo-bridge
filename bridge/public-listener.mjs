// Public listener of the Memo Bridge hub (Phase 5, spec D4, TODO-P5-03).
//
// A second HTTPS listener, loopback only (default 127.0.0.1:9445), that Traefik routes
// https://bridge.memolabs.dev to. It serves exactly three paths:
//   POST /mcp                                        MCP, OAuth access token required
//   GET  /.well-known/oauth-protected-resource       RFC 9728 metadata
//   GET  /.well-known/oauth-protected-resource/mcp   the same document (path-aware form)
// Everything else is 404, WebSocket upgrades included.
//
// Client certificate (owner decision 2026-10-15, option A): Traefik verifies OpenAI's connector
// certificate when one is given (VerifyClientCertIfGiven, since ChatGPT's discovery requests
// carry none and TLS client auth cannot be scoped to a path). With client_cert.mode 'require',
// this listener refuses every /mcp request that carries credentials without the verified
// certificate info Traefik forwards: 403 client_cert_required, before the token is verified.
// The metadata paths and the bare 401 challenge (no Authorization header) stay open, so the
// OAuth discovery still works; neither runs a tool nor reveals anything beyond the metadata.
//
// Structural separation from the 9443 listener: this module never imports the bearer digest
// check (bridge/crypto.mjs), the agent WebSocket server or the hub's /health route, and
// createPublicListener refuses the options that would carry them. A caller holding the static
// owner bearer or an agent key reaches nothing here: the only credential path is the OIDC
// verifier of bridge/oidc.mjs.
//
// Since EV-P5-01 (ChatGPT Chat ran a write tool with no confirmation prompt), nothing here
// relies on annotations or client prompts: the principal, its capabilities and the write gate
// all come from the verified token and the server configuration.
import { createServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import {
  McpServer, bearerAuthChallengeResponse, createMcpHandler, validateHostHeader, validateOriginHeader, verifyBearerToken
} from '@modelcontextprotocol/server';
import { CANONICAL_RESOURCE, REMOTE_WRITES, createOidcVerifier } from './oidc.mjs';
import { CAPABILITIES } from '../server/coordinator/policy.mjs';
import { PACKAGE_VERSION } from './protocol.mjs';
import { CLIENT_CERT_MODES, HUB_PORT, LOOPBACK_BINDS, MAX_PUBLIC_BODY_BYTES, PUBLIC_BIND, PUBLIC_PORT, parseRemoteJson } from './remote-config.mjs';

export { HUB_PORT, LOOPBACK_BINDS, MAX_PUBLIC_BODY_BYTES, PUBLIC_BIND, PUBLIC_PORT };
export const MCP_PATH = '/mcp';
export const PRM_PATHS = Object.freeze(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']);
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze(['chatgpt.com']);
const FORBIDDEN_OPTIONS = ['tokenSha256', 'readOnlyTokenSha256', 'allowedAgentKeys', 'oidcPrincipal', 'mutatingOps'];
const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^\[[0-9a-f:.]+\]$/;
const NO_STORE = { 'cache-control': 'no-store' };
const CERT_HEADER_RE = /^[a-z0-9-]{1,64}$/;
const CLIENT_CERT_REFUSAL = JSON.stringify({ error: 'client_cert_required',
  error_description: 'this endpoint serves only the OpenAI connector client certificate' });

// Traefik passTLSClientCert info: one URL-escaped entry per certificate, joined by ','; inside an
// entry, Subject="...";Issuer="...";NA="...";SAN="a,b". Returns the SAN values and subject CNs
// of every entry. A malformed entry yields nothing (never a match).
export function certificateNames(value) {
  const sans = [], commonNames = [];
  for (const entry of String(value).split(',')) {
    let text;
    try { text = decodeURIComponent(entry.replace(/\+/g, ' ')); } catch { continue; }
    for (const m of text.matchAll(/(?:^|;)SAN="([^"]*)"/g)) sans.push(...m[1].split(',').map(v => v.trim()).filter(Boolean));
    for (const m of text.matchAll(/(?:^|;)Subject="([^"]*)"/g)) {
      for (const part of m[1].split(',')) { const cn = /^\s*CN=(.+)$/.exec(part); if (cn) commonNames.push(cn[1].trim()); }
    }
  }
  return { sans, commonNames };
}

// Until the remote surface lands (TODO-P5-04), the listener serves an MCP server with the tools
// capability and no tools: authentication, metadata and transport can be exercised end to end
// without exposing a single operation.
export function emptySurfaceFactory() {
  return new McpServer({ name: 'memo-bridge-remote', version: PACKAGE_VERSION }, {
    capabilities: { tools: {} },
    instructions: 'Memo Bridge remote surface for the owner. No tools are enabled on it yet.'
  });
}

// remote.json (lab-infra templates/remote.json.j2, bridge/remote-config.mjs) -> the listener's
// own options. {ok:true, settings, config} or {ok:false, error, field}; config holds the parts
// the other Phase 5 pieces take (surface, policy, rate limits).
export function parsePublicListenerSettings(raw) {
  const parsed = parseRemoteJson(raw);
  if (!parsed.ok) return parsed;
  return { ok: true, settings: { ...parsed.config.listener }, config: parsed.config };
}

// Options:
//   tlsKey, tlsCert        the hub certificate (Traefik pins it, spec D1)
//   oidc | verifier        createOidcVerifier config, or an already built verifier
//   remoteEnabled          false (default): every request answers 503 (kill switch 2, spec §4)
//   remoteWrites           'disabled' (default) | 'enabled'; enabled needs writeGateCheck
//   writeGateCheck         () => ({ok:true} | {ok:false, error}); the root-runner self-check (TODO-P5-04)
//   factory                McpServerFactory; receives ctx.authInfo (never absent)
//   allowedHosts           Host allowlist, default [hostname of the resource]
//   allowedOrigins         Origin allowlist (hostnames), default ['chatgpt.com']; absent Origin passes
//   port, bind             default 9445 on 127.0.0.1; loopback only
//   audit                  receives one object per refusal or request; never tokens or arguments
//   authLimiter            createAuthFailureLimiter() (bridge/ratelimit.mjs): a client over its
//                          401 budget gets 429 before its token is even verified (REQ-P5-16)
//   unlistedCalls          (authInfo, body) => [{op, reason}]: tools/call names this principal is
//                          not served, journaled before the SDK answers "unknown tool" (AC-P5-07)
//   clientCert             {mode:'require'|'log'|'off', infoHeader, expectedSan}: with 'log' or
//                          'require', the journal lines record whether Traefik passed client
//                          certificate info and whether it names expectedSan (U-P5-08), never
//                          the certificate itself; with 'require', a /mcp request carrying
//                          credentials without that info (or without expectedSan, when set)
//                          answers 403 client_cert_required before any token verification
export function createPublicListener(options = {}) {
  for (const key of FORBIDDEN_OPTIONS) if (Object.hasOwn(options, key)) throw new Error(`public listener does not take ${key}`);
  const { tlsKey, tlsCert, oidc, remoteEnabled = false, remoteWrites = 'disabled', writeGateCheck = null,
    factory = emptySurfaceFactory, port = PUBLIC_PORT, bind = PUBLIC_BIND, audit = () => {}, maxBodyBytes = MAX_PUBLIC_BODY_BYTES,
    authLimiter = null, unlistedCalls = null, clientCert = null } = options;
  if (!tlsKey || !tlsCert) throw new Error('TLS is mandatory');
  if (!LOOPBACK_BINDS.includes(bind)) throw new Error('public listener binds loopback only (Traefik is the public edge)');
  if (port === HUB_PORT) throw new Error('public listener must not share the hub port');
  if (typeof factory !== 'function') throw new Error('factory must be a function');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > MAX_PUBLIC_BODY_BYTES) throw new Error('invalid maxBodyBytes');
  if (!REMOTE_WRITES.includes(remoteWrites)) throw new Error('remoteWrites must be "disabled" or "enabled"');
  const certMode = clientCert?.mode ?? 'off';
  if (!CLIENT_CERT_MODES.includes(certMode)) throw new Error('clientCert.mode must be "off", "log" or "require"');
  if (certMode !== 'off' && (typeof clientCert.infoHeader !== 'string' || !CERT_HEADER_RE.test(clientCert.infoHeader))) {
    throw new Error('clientCert.infoHeader must be a lowercase header name');
  }
  // Write gate layer 2 (spec D7): with writes enabled the self-check must pass before listening.
  if (remoteWrites === 'enabled') {
    const check = typeof writeGateCheck === 'function' ? writeGateCheck() : { ok: false, error: 'write_gate_self_check_missing' };
    if (!check?.ok) throw new Error('remote writes refused: ' + (check?.error || 'write_gate_self_check_failed'));
  }
  let verifier = options.verifier;
  if (verifier) {
    if (typeof verifier.verifyAccessToken !== 'function' || !verifier.resourceMetadata || !verifier.resourceMetadataUrl || !verifier.resource) throw new Error('invalid verifier');
    if (verifier.remoteWrites !== remoteWrites) throw new Error('verifier and listener disagree on remoteWrites');
  } else {
    if (!oidc) throw new Error('OIDC configuration required: the public listener accepts OAuth access tokens only');
    verifier = createOidcVerifier({ ...oidc, remoteWrites });
  }
  const resource = new URL(verifier.resource);
  const allowedHosts = options.allowedHosts ?? [resource.hostname];
  const allowedOrigins = options.allowedOrigins ?? [...DEFAULT_ALLOWED_ORIGINS];
  for (const list of [allowedHosts, allowedOrigins]) if (!Array.isArray(list) || list.some(h => typeof h !== 'string' || !HOSTNAME_RE.test(h))) throw new Error('invalid host or origin allowlist');
  const requiredScopes = [verifier.baselineScope ?? CAPABILITIES.READ];
  const authOptions = { verifier, requiredScopes, resourceMetadataUrl: verifier.resourceMetadataUrl, expectedResource: resource };
  const metadataBody = JSON.stringify(verifier.resourceMetadata);
  // RFC 6750 §3.1: no error code when the request carried no credentials at all.
  const bareChallenge = `Bearer resource_metadata="${verifier.resourceMetadataUrl}", scope="${requiredScopes.join(' ')}"`;

  // U-P5-08: does ChatGPT present the OpenAI connector certificate? Traefik's passTLSClientCert
  // puts the certificate info in a header it strips from client requests at the entrypoint and
  // sets only for a certificate verified against the OpenAI Connectors CA; only two booleans
  // reach the journal. expectedSan matches a SAN value (OpenAI documents
  // mtls.prod.connectors.openai.com) or, failing that, the subject CN, exactly.
  function clientCertificate(req) {
    if (certMode === 'off') return null;
    const raw = req.headers[clientCert.infoHeader];
    const value = Array.isArray(raw) ? raw.join(',') : raw;
    if (typeof value !== 'string' || !value) return { present: false, san: false };
    if (!clientCert.expectedSan) return { present: true, san: null };
    const { sans, commonNames } = certificateNames(value);
    return { present: true, san: sans.includes(clientCert.expectedSan) || commonNames.includes(clientCert.expectedSan) };
  }
  function certFacts(cert) {
    if (!cert) return {};
    return { client_cert: cert.present, ...(cert.present && cert.san !== null ? { client_cert_san: cert.san } : {}) };
  }
  // Calls the SDK would answer "unknown tool" for: journaled here, by name and reason only.
  function inspect(authInfo, body, requestId) {
    if (typeof unlistedCalls !== 'function') return;
    let message;
    try { message = JSON.parse(body.toString('utf8')); } catch { return; }
    let found = [];
    try { found = unlistedCalls(authInfo, message) ?? []; } catch { return; }
    for (const { op, reason } of found.slice(0, 16)) {
      record('remote_denied', { request_id: requestId, principal: authInfo.extra.principal.id, op, reason });
    }
  }
  function record(event, details = {}) {
    try { audit({ at: new Date().toISOString(), event, listener: 'public', ...details }); } catch { /* audit must not break serving */ }
  }
  const handler = createMcpHandler(async ctx => {
    // Defence in depth: no server instance is ever built for an unauthenticated request.
    if (!ctx?.authInfo?.extra?.principal) throw new Error('unauthenticated_factory_call');
    return factory(ctx);
  }, {
    legacy: 'stateless', responseMode: 'json', maxRequestBodySize: maxBodyBytes,
    onerror: error => record('public_mcp_error', { kind: String(error?.name || 'Error').slice(0, 60) })
  });

  function plain(res, status, headers = {}, body = '') {
    res.writeHead(status, { ...NO_STORE, ...headers }).end(body);
  }
  async function sendWeb(res, response) {
    const headers = { ...NO_STORE };
    response.headers.forEach((value, key) => { headers[key] = value; });
    delete headers['mcp-session-id'];   // stateless: never hand out a session
    res.writeHead(response.status, headers);
    if (!response.body) { res.end(); return; }
    for await (const chunk of response.body) res.write(chunk);
    res.end();
  }
  async function readBody(req) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBodyBytes) return null;
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBodyBytes) return null;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  // The MCP request as the SDK sees it: the body we read, the content negotiation headers and
  // every MCP-* header (MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Param-*). Authorization
  // is not forwarded: the handler gets the verified AuthInfo instead.
  function mcpRequest(req, body) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (key === 'content-type' || key === 'accept' || key.startsWith('mcp-')) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    if (!headers.has('accept')) headers.set('accept', 'application/json, text/event-stream');
    return new Request(new URL(MCP_PATH, resource.origin), { method: 'POST', headers, body });
  }

  async function onRequest(req, res) {
    const requestId = randomUUID();
    const started = Date.now();
    const host = validateHostHeader(req.headers.host, allowedHosts);
    if (!host.ok) { record('public_refused', { request_id: requestId, status: 403, reason: 'host' }); plain(res, 403); return; }
    if (!remoteEnabled) { record('public_refused', { request_id: requestId, status: 503, reason: 'remote_disabled' }); plain(res, 503, { 'retry-after': '60' }); return; }
    let path;
    try { path = new URL(req.url || '/', 'https://localhost').pathname; } catch { plain(res, 400); return; }
    if (PRM_PATHS.includes(path)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { plain(res, 405, { allow: 'GET, HEAD' }); return; }
      plain(res, 200, { 'content-type': 'application/json' }, req.method === 'HEAD' ? '' : metadataBody);
      return;
    }
    if (path !== MCP_PATH) { record('public_refused', { request_id: requestId, status: 404, reason: 'path' }); plain(res, 404); return; }
    if (req.method !== 'POST') { record('public_refused', { request_id: requestId, status: 405, reason: 'method' }); plain(res, 405, { allow: 'POST' }); return; }
    const origin = validateOriginHeader(req.headers.origin, allowedOrigins);
    if (!origin.ok) { record('public_refused', { request_id: requestId, status: 403, reason: 'origin' }); plain(res, 403); return; }
    const header = req.headers.authorization;
    const retryAfter = authLimiter ? authLimiter.retryAfter({ remoteAddress: req.socket.remoteAddress, headers: req.headers }) : 0;
    if (retryAfter > 0) {
      record('public_refused', { request_id: requestId, status: 429, reason: 'auth_failures' });
      plain(res, 429, { 'retry-after': String(retryAfter) });
      return;
    }
    const cert = clientCertificate(req);
    // The bare challenge stays reachable without a certificate: it is the start of ChatGPT's
    // OAuth discovery (journal and Traefik access log of 2026-10-14: an unauthenticated POST /mcp
    // then the metadata fetch, beside the authenticated calls), it runs nothing and says no more
    // than the public metadata document. The journal line records the certificate facts.
    if (!header) {
      record('public_auth_denied', { request_id: requestId, status: 401, reason: 'no_credentials', ...certFacts(cert) });
      plain(res, 401, { 'www-authenticate': bareChallenge });
      return;
    }
    // Option A: credentials count only from OpenAI's infrastructure. Checked before the token is
    // verified, as a required TLS client certificate would have: a token replayed from elsewhere
    // learns nothing about its validity and costs no verification. Not an OAuth failure, so the
    // 401 flood bucket is not charged and no WWW-Authenticate is sent.
    if (certMode === 'require' && (!cert.present || (clientCert.expectedSan && !cert.san))) {
      record('public_refused', { request_id: requestId, status: 403, reason: 'client_cert_required', ...certFacts(cert) });
      plain(res, 403, { 'content-type': 'application/json' }, CLIENT_CERT_REFUSAL);
      req.resume();
      return;
    }
    let authInfo;
    try { authInfo = await verifyBearerToken(header, authOptions); }
    catch (error) {
      const response = bearerAuthChallengeResponse(error, authOptions);
      if (authLimiter && response.status === 401) authLimiter.failure({ remoteAddress: req.socket.remoteAddress, headers: req.headers });
      record('public_auth_denied', { request_id: requestId, status: response.status, reason: typeof error?.reason === 'string' ? error.reason : String(error?.code || 'invalid'),
        ...certFacts(cert) });
      await sendWeb(res, response);
      return;
    }
    const principal = authInfo.extra.principal.id;
    const clientRef = authInfo.extra.client_ref;
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) { record('public_refused', { request_id: requestId, principal, status: 415, reason: 'content_type' }); plain(res, 415); return; }
    const body = await readBody(req);
    if (!body) { record('public_refused', { request_id: requestId, principal, status: 413, reason: 'body_too_large' }); plain(res, 413, { connection: 'close' }); req.resume(); return; }
    inspect(authInfo, body, requestId);
    const response = await handler.fetch(mcpRequest(req, body), { authInfo });
    record('public_request', { request_id: requestId, principal, client_ref: clientRef, status: response.status, ms: Date.now() - started,
      ...certFacts(cert) });
    await sendWeb(res, response);
  }

  const server = createServer({ key: tlsKey, cert: tlsCert, minVersion: 'TLSv1.2', requestCert: false }, (req, res) => {
    onRequest(req, res).catch(() => {
      record('public_internal_error');
      if (!res.headersSent) plain(res, 500); else res.destroy();
    });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  // No WebSocket on this listener: /agent and every other upgrade are refused.
  server.on('upgrade', (req, socket) => {
    record('public_refused', { status: 404, reason: 'upgrade' });
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  return {
    verifier, resourceMetadata: verifier.resourceMetadata, allowedHosts: [...allowedHosts], allowedOrigins: [...allowedOrigins],
    remoteEnabled, remoteWrites, clientCertMode: certMode,
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); });
      return server.address();
    },
    async stop() {
      await handler.close().catch(() => {});
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
    }
  };
}

export { CANONICAL_RESOURCE };
