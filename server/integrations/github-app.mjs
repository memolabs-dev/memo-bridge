// GitHub credentials provider of the VPS runner: GitHub App installation tokens minted on
// demand, with the fine-grained PAT credential files as fallback.
//
// Given a purpose and one repository, token() returns a token for that repository only:
//   ledger        memolabs-dev/.github     contents:write                 PAT fallback ledger-gh
//   push          the worktree's origin    contents:write                 PAT fallback push-gh
//   pull_request  the worktree's origin    contents:write, pull_requests:write  (no PAT: as before,
//                                          the runner's own gh environment)
//   read          a registered repository  actions, contents, issues, pull_requests: read (no PAT)
//   issues        a registered repository  issues:write, for batch labels and Issues (no PAT)
// Without the App, read and issues answer 'ambient' like pull_request: the runner keeps its own
// gh environment, which on the VPS has no login, so those calls fail as github_auth_required.
//
// App mode needs, under $CREDENTIALS_DIRECTORY, the `app-key` credential (the App's PEM private
// key, systemd LoadCredential=) and, in the environment (no secret there), the App settings:
//   MEMO_BRIDGE_GITHUB_APP_ID               numeric App id (JWT `iss` unless a client id is set)
//   MEMO_BRIDGE_GITHUB_APP_CLIENT_ID        optional; GitHub recommends the client id as `iss`
//   MEMO_BRIDGE_GITHUB_APP_INSTALLATION_ID  numeric installation id on the organization
//   MEMO_BRIDGE_GITHUB_APP_OWNER            organization of the installation (default memolabs-dev)
//
// Sources (read 2026-10-14):
// - JWT: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
//   RS256; iat 60 s in the past against clock drift; exp "no more than 10 minutes into the
//   future"; iss the client id (recommended) or the App id; sent as `Authorization: Bearer`.
// - Installation token: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
//   POST /app/installations/{installation_id}/access_tokens with `repositories` and
//   `permissions` narrowing the token; it "will expire after 1 hour"; it cannot exceed the
//   App's own permissions. New tokens may be stateless JWT-shaped `ghs_` values (~520 chars).
// - Git over HTTPS: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
//   username x-access-token, the installation token as the password.
// The same flow (App id as iss, iat-60, exp under 10 min, one repository, explicit permissions,
// returned permissions checked, at least 5 minutes left) is the one validated live on
// 2026-10-13 by os/integrations/github/scripts/with-app-token.py.
//
// Tokens are cached per (repository, permissions) and reused until 5 minutes before their
// expiry. No token, JWT or key material is ever logged, returned in an error or put in
// process.env: errors are short codes.
import { createPrivateKey, sign } from 'node:crypto';
import { APP_KEY_CREDENTIAL, LEDGER_CREDENTIAL, PUSH_CREDENTIAL, TOKEN_RE, credentialPath, credentialsRequired,
  readCredentialFile, readTokenFile } from '../coordinator/credentials.mjs';

export const GITHUB_API = 'https://api.github.com';
export const LEDGER_REPO = 'memolabs-dev/.github';
export const DEFAULT_APP_OWNER = 'memolabs-dev';
export const REFRESH_MARGIN_MS = 5 * 60_000;
export const JWT_LIFETIME_S = 540; // 9 minutes: under GitHub's 10-minute ceiling, with margin
const JWT_BACKDATE_S = 60;
const KEY_MAX_BYTES = 16 * 1024;
const RESPONSE_MAX_BYTES = 64 * 1024;
const CACHE_MAX = 64;

export const TOKEN_PURPOSES = Object.freeze({
  ledger: Object.freeze({ permissions: Object.freeze({ contents: 'write' }), pat: LEDGER_CREDENTIAL, repo: LEDGER_REPO }),
  push: Object.freeze({ permissions: Object.freeze({ contents: 'write' }), pat: PUSH_CREDENTIAL }),
  pull_request: Object.freeze({ permissions: Object.freeze({ contents: 'write', pull_requests: 'write' }), pat: null }),
  read: Object.freeze({ permissions: Object.freeze({ actions: 'read', contents: 'read', issues: 'read', pull_requests: 'read' }), pat: null }),
  issues: Object.freeze({ permissions: Object.freeze({ issues: 'write' }), pat: null })
});

export const APP_ENV = Object.freeze({
  id: 'MEMO_BRIDGE_GITHUB_APP_ID',
  clientId: 'MEMO_BRIDGE_GITHUB_APP_CLIENT_ID',
  installationId: 'MEMO_BRIDGE_GITHUB_APP_INSTALLATION_ID',
  owner: 'MEMO_BRIDGE_GITHUB_APP_OWNER'
});

const ID_RE = /^[1-9][0-9]{0,11}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9.]{8,64}$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})$/;

const b64url = value => Buffer.from(value).toString('base64url');
const keyError = code => (code === 'credential_missing' ? 'app_key_missing'
  : code === 'credential_invalid' || code === 'app_key_invalid' ? 'app_key_invalid' : 'app_key_unreadable');

// App settings from the environment, or {error}. `present` is false when none is set.
export function appSettingsFromEnv(env) {
  const raw = Object.fromEntries(Object.entries(APP_ENV).map(([key, name]) => [key, env?.[name]]));
  const present = Boolean(raw.id || raw.clientId || raw.installationId);
  if (!present) return { present: false };
  const owner = raw.owner || DEFAULT_APP_OWNER;
  if (!ID_RE.test(raw.id ?? '') || !ID_RE.test(raw.installationId ?? '') || !OWNER_RE.test(owner)
    || (raw.clientId && !CLIENT_ID_RE.test(raw.clientId))) return { present: true, error: 'app_config_invalid' };
  return { present: true, settings: Object.freeze({ appId: Number(raw.id), clientId: raw.clientId || null,
    installationId: Number(raw.installationId), owner }) };
}

// The App private key from a PEM file, or {error}. RSA only, at least 2048 bits.
export async function loadAppKey(path) {
  const read = await readCredentialFile(path, { maxBytes: KEY_MAX_BYTES });
  if (read.error) return { error: read.error };
  try {
    const key = createPrivateKey({ key: read.text, format: 'pem' });
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return { error: 'app_key_invalid' };
    return { key };
  } catch {
    return { error: 'app_key_invalid' };
  }
}

// RS256 JWT for the App: iat 60 s in the past, exp JWT_LIFETIME_S after now, iss the client id
// when configured, else the App id.
export function appJwt(settings, key, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - JWT_BACKDATE_S, exp: now + JWT_LIFETIME_S,
    iss: settings.clientId ?? String(settings.appId) }));
  const input = `${header}.${payload}`;
  return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`;
}

const sortedPermissions = permissions => Object.fromEntries(Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b)));

// One GitHub API request with the JWT. Never follows a redirect (a bearer must not reach
// another host), bounds the body, and maps every failure to a short code.
async function appRequest(fetchImpl, apiUrl, method, path, jwt, body, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(`${apiUrl}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'memo-bridge-runner', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch {
    return { error: 'app_token_network' };
  }
  let text = '';
  try { text = await response.text(); } catch { return { error: 'app_token_network' }; }
  if (!response.ok) return { error: `app_token_http_${Number(response.status) || 0}` };
  if (text.length > RESPONSE_MAX_BYTES) return { error: 'app_token_invalid_response' };
  try { return { data: JSON.parse(text) }; } catch { return { error: 'app_token_invalid_response' }; }
}

// Check an access_tokens answer against the request: a well-formed token, an expiry at least
// REFRESH_MARGIN_MS away, every requested permission granted at the requested level and no
// other write or admin permission, and (when GitHub lists them) exactly the one repository.
export function checkTokenResponse(data, { repoName, permissions, nowMs }) {
  if (!data || typeof data !== 'object' || typeof data.token !== 'string' || !TOKEN_RE.test(data.token)) {
    return { error: 'app_token_invalid_response' };
  }
  const expiresAt = Date.parse(typeof data.expires_at === 'string' ? data.expires_at : '');
  if (!Number.isFinite(expiresAt) || expiresAt - nowMs <= REFRESH_MARGIN_MS) return { error: 'app_token_expiry_invalid' };
  const granted = data.permissions;
  if (!granted || typeof granted !== 'object') return { error: 'app_token_scope_mismatch' };
  for (const [name, level] of Object.entries(permissions)) if (granted[name] !== level) return { error: 'app_token_scope_mismatch' };
  for (const [name, level] of Object.entries(granted)) {
    if (!(name in permissions) && level !== 'read') return { error: 'app_token_scope_mismatch' };
  }
  if (data.repositories !== undefined) {
    const repos = Array.isArray(data.repositories) ? data.repositories : [];
    if (repos.length !== 1 || String(repos[0]?.name ?? '').toLowerCase() !== repoName.toLowerCase()) {
      return { error: 'app_token_scope_mismatch' };
    }
  }
  return { token: data.token, expiresAt };
}

// options.apiUrl and options.fetchImpl exist for tests (a local fake GitHub); production uses
// https://api.github.com and the global fetch. options.log(event, details) receives
// app_token_minted, app_token_failed and app_token_fallback with the purpose, the repository,
// a short code and the remaining lifetime: never a token.
export function createGitHubCredentials({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, apiUrl = GITHUB_API,
  timeoutMs = 20_000, log = () => {} } = {}) {
  const emit = (event, details) => { try { log(event, details); } catch { /* logging never breaks a call */ } };
  const cache = new Map(); // `${repo}\0${permissions}` -> {token, expiresAt}
  const inflight = new Map();
  let identity = null; // {appId} once GET /app matched the configured App

  const appKeyPath = () => credentialPath(env, APP_KEY_CREDENTIAL);

  // 'ambient' (no systemd credentials: the Mac), 'app' (key file and settings), 'pat'.
  // A key without valid settings counts as 'app' so token() reports app_config_invalid.
  async function appState() {
    if (!credentialsRequired(env)) return { mode: 'ambient' };
    const path = appKeyPath();
    const keyRead = path ? await readCredentialFile(path, { maxBytes: KEY_MAX_BYTES }) : { error: 'credential_missing' };
    if (keyRead.error === 'credential_missing') return { mode: 'pat' };
    const settings = appSettingsFromEnv(env);
    if (!settings.present) return { mode: 'app', error: 'app_config_invalid' };
    if (settings.error) return { mode: 'app', error: settings.error };
    return { mode: 'app', settings: settings.settings, path };
  }

  async function mint(settings, path, repo, permissions) {
    const loaded = await loadAppKey(path);
    if (loaded.error) return { error: keyError(loaded.error) };
    const jwt = appJwt(settings, loaded.key, now());
    if (identity?.appId !== settings.appId) {
      const app = await appRequest(fetchImpl, apiUrl, 'GET', '/app', jwt, null, timeoutMs);
      if (app.error) return app;
      if (app.data?.id !== settings.appId || (settings.clientId && app.data?.client_id !== settings.clientId)) {
        return { error: 'app_identity_mismatch' };
      }
      identity = { appId: settings.appId };
    }
    const repoName = repo.split('/')[1];
    const answer = await appRequest(fetchImpl, apiUrl, 'POST', `/app/installations/${settings.installationId}/access_tokens`, jwt,
      { repositories: [repoName], permissions }, timeoutMs);
    if (answer.error) return answer;
    return checkTokenResponse(answer.data, { repoName, permissions, nowMs: now() });
  }

  async function appToken(state, repo, permissions) {
    const match = REPO_RE.exec(repo ?? '');
    if (!match || match[2] === '.' || match[2] === '..') return { error: 'app_repo_invalid' };
    if (match[1].toLowerCase() !== state.settings.owner.toLowerCase()) return { error: 'app_repo_not_allowed' };
    const perms = sortedPermissions(permissions);
    const key = `${repo.toLowerCase()}\0${JSON.stringify(perms)}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) return { token: cached.token };
    if (inflight.has(key)) return inflight.get(key);
    const pending = (async () => {
      const minted = await mint(state.settings, state.path, repo, perms);
      if (minted.error) return minted;
      emit('app_token_minted', { repo, permissions: Object.keys(perms).join(','), expires_in_s: Math.round((minted.expiresAt - now()) / 1000) });
      for (const [k, v] of cache) if (v.expiresAt - now() <= REFRESH_MARGIN_MS) cache.delete(k);
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, { token: minted.token, expiresAt: minted.expiresAt });
      return { token: minted.token };
    })().finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  }

  return {
    // {token, source: 'app'|'pat', file?} | {source: 'ambient'} | {error, credential}.
    // 'ambient': no systemd credentials (the Mac), or a pull request without App on the VPS:
    // the caller keeps its previous behavior. On an App failure the purpose's PAT file, when
    // present, is used instead; otherwise the App error is returned.
    async token(purpose, repo) {
      const spec = TOKEN_PURPOSES[purpose];
      if (!spec) return { error: 'purpose_invalid', credential: APP_KEY_CREDENTIAL };
      const state = await appState();
      if (state.mode === 'ambient') return { source: 'ambient' };
      const target = spec.repo ?? repo;
      let appError = null;
      if (state.mode === 'app') {
        if (state.error) appError = state.error;
        else {
          const got = await appToken(state, target, spec.permissions);
          if (got.token) return { token: got.token, source: 'app' };
          appError = got.error;
        }
        emit('app_token_failed', { purpose, repo: target ?? null, code: appError });
      }
      if (!spec.pat) return appError ? { error: appError, credential: APP_KEY_CREDENTIAL } : { source: 'ambient' };
      const file = credentialPath(env, spec.pat);
      const read = file ? await readTokenFile(file) : { error: 'credential_missing' };
      if (!read.error) {
        if (appError) emit('app_token_fallback', { purpose, repo: target ?? null, code: appError, credential: spec.pat });
        return { token: read.token, source: 'pat', file };
      }
      if (appError && read.error === 'credential_missing') return { error: appError, credential: APP_KEY_CREDENTIAL };
      return { error: read.error, credential: spec.pat };
    },

    // Offline startup check (no network): which source each purpose would use.
    // {app: 'absent'|'configured'|<error code>, ledger: 'app'|'pat'|'missing', push: 'app'|'pat'|'missing'}
    async startupCheck() {
      const state = await appState();
      if (state.mode === 'ambient') return { app: 'absent', ledger: 'ambient', push: 'ambient' };
      let app = 'absent';
      if (state.mode === 'app') {
        if (state.error) app = state.error;
        else {
          const loaded = await loadAppKey(state.path);
          app = loaded.error ? keyError(loaded.error) : 'configured';
        }
      }
      const pat = async name => !(await readTokenFile(credentialPath(env, name))).error;
      const source = async name => (app === 'configured' ? 'app' : (await pat(name)) ? 'pat' : 'missing');
      return { app, ledger: await source(LEDGER_CREDENTIAL), push: await source(PUSH_CREDENTIAL) };
    },

    // Test hook: number of cached tokens (never the tokens).
    cacheSize: () => cache.size
  };
}
