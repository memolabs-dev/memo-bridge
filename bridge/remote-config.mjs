// remote.json: the one configuration file of the remote surface (Phase 5, TODO-P5-23).
//
// lab-infra renders it (ansible/roles/memo-bridge/templates/remote.json.j2) to
// /etc/memo-bridge/remote.json, root 0644, and points both units at it with
// MEMO_BRIDGE_REMOTE_CONFIG:
//   - the hub (bridge/hub-cli.mjs) parses the whole file here and opens the public listener;
//   - the runner (server/runtime.mjs, bridge/write-gate.mjs parseRemotePolicy) reads the
//     project allowlist, the session binding, the write gate and the owner sub from it.
// One file, so the two processes cannot disagree on the write gate or on who the owner is.
//
// Format version 1 (snake_case; every key below is checked, an unknown key is refused so a typo
// in lab-infra stops the hub instead of being silently ignored):
//   version            1
//   managed_by         free text (ignored)
//   remote_enabled     kill switch 2: false keeps the listener up, every request answers 503
//   listen             {host: 127.0.0.1 | ::1, port: not 9443}             default 127.0.0.1:9445
//   public_host        the MCP host name, e.g. bridge.memolabs.dev (Host allowlist, audience)
//   allowed_origins    ["https://chatgpt.com"]; an absent Origin header passes
//   trusted_proxies    TCP peers whose X-Forwarded-For is believed (the 401 flood bucket)
//   oidc               {issuer, jwks_uri, audience, owner_sub, allowed_client_ids,
//                       required_scope (coordinator:read only), max_token_age_sec,
//                       clock_tolerance_sec?, ceiling?}
//   projects           remote project allowlist (names or owner/repo), REQ-P5-09
//   remote_writes      "disabled" | "enabled" (D7)
//   session_binding    "warn" | "block" | "enforce" (D8; enforce: multi-session D-MS3)
//   client_cert        {mode: "require" | "log" | "off", info_header, expected_san} (U-P5-08):
//                       require refuses any request carrying credentials without Traefik's
//                       verified client certificate info (owner decision 2026-10-15, option A)
//   budgets            {body_max_bytes, result_max_bytes, page_max_bytes, write_file_max_bytes,
//                       list_max_items, soft_deadline_sec, job_tail_lines?}
//   rate_limits        {read_per_min, write_per_min, execute_per_min, in_flight,
//                       unauthorized_per_min_per_ip}
import { CAPABILITIES } from '../server/coordinator/policy.mjs';
import { BASELINE_SCOPE, REMOTE_WRITES, createOidcVerifier } from './oidc.mjs';
import { parseRemotePolicy, SOFT_DEADLINE } from './write-gate.mjs';
import { RATE_DEFAULTS } from './ratelimit.mjs';
import { parseRemoteConfig } from './remote-surface.mjs';

export const REMOTE_CONFIG_ENV = 'MEMO_BRIDGE_REMOTE_CONFIG';
export const REMOTE_CONFIG_VERSION = 1;
export const PUBLIC_BIND = '127.0.0.1';
export const PUBLIC_PORT = 9445;
export const HUB_PORT = 9443;
export const LOOPBACK_BINDS = Object.freeze(['127.0.0.1', '::1']);
export const MAX_PUBLIC_BODY_BYTES = 128 * 1024;
const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ADDRESS_RE = /^[0-9a-f:.]{2,45}$/;
const HEADER_RE = /^[a-z0-9-]{1,64}$/;
// client_cert.mode. lab-infra checks the pinned release for 'client_cert_required' before it
// renders "require" (role memo-bridge, tasks/remote.yml).
export const CLIENT_CERT_MODES = Object.freeze(['off', 'log', 'require']);

const KEYS = Object.freeze({
  top: ['version', 'managed_by', 'remote_enabled', 'listen', 'public_host', 'allowed_origins', 'trusted_proxies', 'oidc', 'projects',
    'remote_writes', 'session_binding', 'client_cert', 'budgets', 'rate_limits', 'mac_runtime_routing'],
  listen: ['host', 'port'],
  oidc: ['issuer', 'jwks_uri', 'audience', 'owner_sub', 'allowed_client_ids', 'required_scope', 'max_token_age_sec',
    'clock_tolerance_sec', 'ceiling'],
  client_cert: ['mode', 'info_header', 'expected_san'],
  budgets: ['body_max_bytes', 'result_max_bytes', 'page_max_bytes', 'write_file_max_bytes', 'list_max_items', 'soft_deadline_sec',
    'job_tail_lines'],
  rate_limits: ['read_per_min', 'write_per_min', 'execute_per_min', 'in_flight', 'unauthorized_per_min_per_ip']
});

class ConfigError extends Error {
  constructor(error, field) { super(field ? `${error} (${field})` : error); this.code = error; this.field = field ?? null; }
}
const bad = field => { throw new ConfigError('invalid_remote_config', field); };
const plainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

function section(raw, name, required) {
  const value = raw[name];
  if (value === undefined && !required) return {};
  if (!plainObject(value)) bad(name);
  for (const key of Object.keys(value)) if (!KEYS[name].includes(key)) bad(`${name}.${key}`);
  return value;
}
function int(value, field, [min, max], fallback) {
  if (value === undefined) {
    if (fallback === undefined) bad(field);
    return fallback;
  }
  if (!Number.isInteger(value) || value < min || value > max) bad(field);
  return value;
}
// An Origin allowlist entry: an https origin ("https://chatgpt.com") or a bare host name. The
// listener compares host names (SDK validateOriginHeader).
function originHost(entry) {
  if (typeof entry !== 'string') return null;
  if (HOSTNAME_RE.test(entry)) return entry;
  try {
    const url = new URL(entry);
    if (url.protocol !== 'https:' || url.origin !== entry || !HOSTNAME_RE.test(url.hostname)) return null;
    return url.hostname;
  } catch { return null; }
}

// remote.json (already JSON-parsed) -> the options every Phase 5 piece takes. Returns
// {ok:true, config} or {ok:false, error:'invalid_remote_config', field}.
//   config.listener   createPublicListener options (without TLS, factory and hooks)
//   config.surface    createRemoteServerFactory config (bridge/remote-surface.mjs)
//   config.policy     the runtime remote policy (bridge/write-gate.mjs parseRemotePolicy)
//   config.rateLimits createRateLimiter options; config.authFailures createAuthFailureLimiter options
//   config.softDeadlineMs, config.clientCert
export function parseRemoteJson(raw) {
  try {
    return { ok: true, config: parse(raw) };
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, error: error.code, field: error.field };
    return { ok: false, error: 'invalid_remote_config', field: String(error?.message ?? 'config').slice(0, 120) };
  }
}

function parse(raw) {
  if (!plainObject(raw)) bad('config');
  for (const key of Object.keys(raw)) if (!KEYS.top.includes(key)) bad(key);
  if (raw.version !== REMOTE_CONFIG_VERSION) bad('version');
  if (raw.remote_enabled !== undefined && typeof raw.remote_enabled !== 'boolean') bad('remote_enabled');
  const listen = section(raw, 'listen', false);
  const bind = listen.host ?? PUBLIC_BIND;
  if (!LOOPBACK_BINDS.includes(bind)) bad('listen.host');
  const port = int(listen.port, 'listen.port', [1024, 65535], PUBLIC_PORT);
  if (port === HUB_PORT) bad('listen.port');
  if (typeof raw.public_host !== 'string' || !HOSTNAME_RE.test(raw.public_host)) bad('public_host');

  const oidc = section(raw, 'oidc', true);
  const resource = oidc.audience;
  if (resource !== `https://${raw.public_host}/mcp`) bad('oidc.audience');
  if (oidc.required_scope !== undefined && oidc.required_scope !== BASELINE_SCOPE) bad('oidc.required_scope');
  const known = Object.values(CAPABILITIES);
  if (oidc.ceiling !== undefined && (!Array.isArray(oidc.ceiling) || oidc.ceiling.length > 16 || oidc.ceiling.some(c => !known.includes(c)))) bad('oidc.ceiling');
  const macRuntimeRouting = raw.mac_runtime_routing ?? 'disabled';
  if (!['enabled', 'disabled'].includes(macRuntimeRouting)) bad('mac_runtime_routing');
  const remoteWrites = raw.remote_writes ?? 'disabled';
  if (!REMOTE_WRITES.includes(remoteWrites)) bad('remote_writes');
  const verifierOptions = {
    issuer: oidc.issuer, resource, ownerSub: oidc.owner_sub, allowedClientIds: oidc.allowed_client_ids,
    ...(oidc.jwks_uri !== undefined ? { jwksUri: oidc.jwks_uri } : {}),
    ...(oidc.max_token_age_sec !== undefined ? { maxTokenAgeSec: oidc.max_token_age_sec } : {}),
    ...(oidc.clock_tolerance_sec !== undefined ? { clockToleranceSec: oidc.clock_tolerance_sec } : {}),
    ...(oidc.ceiling !== undefined ? { ceiling: [...oidc.ceiling] } : {})
  };
  // The verifier checks issuer, owner sub, client ids, token age, skew and the JWKS location.
  // createRemoteJWKSet fetches lazily: this makes no network call.
  try { createOidcVerifier({ ...verifierOptions, remoteWrites }); } catch (error) { bad(`oidc: ${String(error.message).slice(0, 100)}`); }

  const origins = raw.allowed_origins ?? ['https://chatgpt.com'];
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > 16) bad('allowed_origins');
  const allowedOrigins = origins.map(originHost);
  if (allowedOrigins.some(h => h === null)) bad('allowed_origins');
  const proxies = raw.trusted_proxies ?? ['127.0.0.1'];
  if (!Array.isArray(proxies) || proxies.length > 8 || proxies.some(p => typeof p !== 'string' || !ADDRESS_RE.test(p))) bad('trusted_proxies');

  const cert = section(raw, 'client_cert', false);
  const certMode = cert.mode ?? 'off';
  if (!CLIENT_CERT_MODES.includes(certMode)) bad('client_cert.mode');
  const infoHeader = (cert.info_header ?? 'x-forwarded-tls-client-cert-info');
  if (typeof infoHeader !== 'string' || !HEADER_RE.test(infoHeader)) bad('client_cert.info_header');
  if (cert.expected_san !== undefined && (typeof cert.expected_san !== 'string' || !HOSTNAME_RE.test(cert.expected_san))) bad('client_cert.expected_san');

  const budgets = section(raw, 'budgets', false);
  const maxBodyBytes = int(budgets.body_max_bytes, 'budgets.body_max_bytes', [1024, MAX_PUBLIC_BODY_BYTES], MAX_PUBLIC_BODY_BYTES);
  const softDeadlineSec = int(budgets.soft_deadline_sec, 'budgets.soft_deadline_sec', [SOFT_DEADLINE.min / 1000, SOFT_DEADLINE.max / 1000],
    SOFT_DEADLINE.default / 1000);
  const writeContentBytes = int(budgets.write_file_max_bytes, 'budgets.write_file_max_bytes', [1, maxBodyBytes], 96 * 1024);
  const rates = section(raw, 'rate_limits', false);
  const perMin = (key, fallback) => int(rates[key], `rate_limits.${key}`, [1, 10_000], fallback);

  let policy;
  try { policy = parseRemotePolicy(raw); } catch { bad('projects or session_binding'); }
  if (policy.projects.length === 0) bad('projects');
  const surface = Object.freeze({
    owner_sub: oidc.owner_sub, allowed_client_ids: oidc.allowed_client_ids, remote_writes: remoteWrites,
    ...(raw.mac_runtime_routing !== undefined ? { mac_runtime_routing: macRuntimeRouting } : {}),
    ...(oidc.ceiling !== undefined ? { ceiling: [...oidc.ceiling] } : {}),
    ...(budgets.result_max_bytes !== undefined ? { result_budget_bytes: budgets.result_max_bytes } : {}),
    ...(budgets.list_max_items !== undefined ? { list_limit: budgets.list_max_items } : {}),
    ...(budgets.page_max_bytes !== undefined ? { read_page_bytes: budgets.page_max_bytes } : {}),
    ...(budgets.job_tail_lines !== undefined ? { job_tail_lines: budgets.job_tail_lines } : {}),
    write_content_bytes: writeContentBytes
  });
  try { parseRemoteConfig(surface); } catch (error) { bad(String(error.message).replace(/^invalid_remote_config:/, 'surface.')); }

  return Object.freeze({
    listener: Object.freeze({
      remoteEnabled: raw.remote_enabled === true, bind, port, remoteWrites, maxBodyBytes,
      oidc: Object.freeze(verifierOptions), allowedHosts: Object.freeze([raw.public_host]), allowedOrigins: Object.freeze(allowedOrigins)
    }),
    // The shape bridge/remote-surface.mjs parseRemoteConfig takes (checked above).
    surface,
    policy,
    softDeadlineMs: softDeadlineSec * 1000,
    rateLimits: Object.freeze({
      perMinute: Object.freeze({ read: perMin('read_per_min', RATE_DEFAULTS.perMinute.read), write: perMin('write_per_min', RATE_DEFAULTS.perMinute.write),
        execute: perMin('execute_per_min', RATE_DEFAULTS.perMinute.execute) }),
      inFlight: int(rates.in_flight, 'rate_limits.in_flight', [1, 64], RATE_DEFAULTS.inFlight)
    }),
    authFailures: Object.freeze({
      perMinute: perMin('unauthorized_per_min_per_ip', RATE_DEFAULTS.authFailuresPerMinute),
      trustedProxies: Object.freeze([...proxies])
    }),
    clientCert: Object.freeze({ mode: certMode, infoHeader, expectedSan: cert.expected_san ?? null })
  });
}
