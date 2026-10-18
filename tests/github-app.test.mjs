// GitHub App installation tokens for the VPS runner (server/integrations/github-app.mjs).
// Everything here is offline: an RSA key generated for the test, a fake GitHub API on
// 127.0.0.1 that checks the JWT signature and claims, a local bare origin for Git, and a
// recording gh runner. Nothing reads the real App key, the network or GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  APP_ENV, JWT_LIFETIME_S, LEDGER_REPO, REFRESH_MARGIN_MS, TOKEN_PURPOSES, appJwt, appSettingsFromEnv, checkTokenResponse,
  createGitHubCredentials, loadAppKey
} from '../server/integrations/github-app.mjs';
import { APP_KEY_CREDENTIAL, LEDGER_CREDENTIAL, PUSH_CREDENTIAL, TOKEN_RE, readTokenFile } from '../server/coordinator/credentials.mjs';
import { createIssueLeaseClient } from '../server/coordinator/issue-lease.mjs';
import { ASKPASS_CREDENTIAL_VAR, ASKPASS_PATH, createWorktreeRunner, networkGit } from '../server/runners/worktrees.mjs';
import { createGitHub } from '../server/integrations/github.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { generateAgentIdentity } from '../bridge/crypto.mjs';

const OWNER = makePrincipal('local:owner', Object.values(CAPABILITIES));
const APP_ID = 5298579;
const INSTALLATION_ID = 170927025;
const ISSUE = 'memolabs-dev/drop#7';
const sha = value => createHash('sha256').update(value).digest('hex');
const pat = () => `test_pat_${randomBytes(20).toString('hex')}`;
// A stateless, JWT-shaped installation token like the ones GitHub mints since 2026-04-27.
const statelessToken = () => `ghs_${randomBytes(90).toString('base64url')}.${randomBytes(200).toString('base64url')}.${randomBytes(80).toString('base64url')}`;

const { privateKey: TEST_KEY_OBJECT, publicKey: TEST_PUBLIC } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_PEM = TEST_KEY_OBJECT.export({ type: 'pkcs1', format: 'pem' });

async function temp(t, prefix) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function credentials(t, values) {
  const dir = await temp(t, 'memo-app-creds-');
  for (const [name, value] of Object.entries(values)) await writeFile(join(dir, name), value.endsWith('\n') ? value : `${value}\n`, { mode: 0o400 });
  return dir;
}
const appEnv = (credsDir, extra = {}) => ({ PATH: process.env.PATH, CREDENTIALS_DIRECTORY: credsDir,
  [APP_ENV.id]: String(APP_ID), [APP_ENV.installationId]: String(INSTALLATION_ID), ...extra });
const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

// A fake GitHub API: verifies each JWT (RS256 signature with the test public key, iat/exp
// window), answers GET /app and POST /app/installations/:id/access_tokens, records requests.
async function fakeGitHub(t, { clock, respond } = {}) {
  const requests = [];
  const issued = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const auth = req.headers.authorization ?? '';
      const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const [h, p, s] = jwt.split('.');
      let claims = null; let header = null; let valid = false;
      try {
        header = decode(h); claims = decode(p);
        valid = verify('sha256', Buffer.from(`${h}.${p}`), TEST_PUBLIC, Buffer.from(s, 'base64url'));
      } catch { valid = false; }
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, url: req.url, header, claims, valid, body: parsed, apiVersion: req.headers['x-github-api-version'] });
      const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (!valid) return send(401, { message: 'A JSON web token could not be decoded' });
      if (req.method === 'GET' && req.url === '/app') return send(200, { id: APP_ID, slug: 'memo-labs-automation', client_id: 'Iv23liTESTCLIENT' });
      if (req.method === 'POST' && req.url === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
        const custom = respond?.(parsed);
        if (custom) return send(custom.status ?? 201, custom.data);
        const token = statelessToken();
        issued.push(token);
        return send(201, { token, expires_at: new Date(clock() + 3600_000).toISOString(),
          permissions: { ...parsed.permissions, metadata: 'read' },
          ...(parsed.repositories ? { repository_selection: 'selected',
            repositories: parsed.repositories.map(name => ({ name, full_name: `memolabs-dev/${name}` })) }
            : { repository_selection: 'all' }) });
      }
      return send(404, { message: 'Not Found' });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return { apiUrl: `http://127.0.0.1:${server.address().port}`, requests, issued,
    posts: () => requests.filter(r => r.method === 'POST') };
}

async function appProvider(t, { files = {}, env: extraEnv = {}, respond } = {}) {
  let nowMs = Date.parse('2026-10-14T10:00:00Z');
  const clock = () => nowMs;
  const api = await fakeGitHub(t, { clock, respond });
  const credsDir = await credentials(t, { [APP_KEY_CREDENTIAL]: TEST_PEM, ...files });
  const env = appEnv(credsDir, extraEnv);
  const events = [];
  const provider = createGitHubCredentials({ env, apiUrl: api.apiUrl, now: clock, log: (event, details) => events.push({ event, details }) });
  return { provider, api, env, credsDir, events, advance: ms => { nowMs += ms; }, clock };
}

// ---------------------------------------------------------------------------------------------
// JWT and settings

test('appJwt: RS256 over header.payload, iat 60 s in the past, exp under 10 minutes, iss the App id or the client id', () => {
  const now = Date.parse('2026-10-14T10:00:00Z');
  const jwt = appJwt({ appId: APP_ID, clientId: null }, TEST_KEY_OBJECT, now);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT' });
  const claims = decode(p);
  assert.deepEqual(claims, { iat: now / 1000 - 60, exp: now / 1000 + JWT_LIFETIME_S, iss: String(APP_ID) });
  assert.ok(claims.exp - now / 1000 <= 600, 'exp no more than 10 minutes ahead');
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), TEST_PUBLIC, Buffer.from(s, 'base64url')), 'signature verifies');
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
  assert.equal(verify('sha256', Buffer.from(`${h}.${p}`), other, Buffer.from(s, 'base64url')), false);
  assert.equal(decode(appJwt({ appId: APP_ID, clientId: 'Iv23liTESTCLIENT' }, TEST_KEY_OBJECT, now).split('.')[1]).iss, 'Iv23liTESTCLIENT');
});

test('App settings and key: numeric ids, optional client id, RSA key of at least 2048 bits only', async t => {
  assert.deepEqual(appSettingsFromEnv({}), { present: false });
  assert.deepEqual(appSettingsFromEnv({ [APP_ENV.id]: '5298579', [APP_ENV.installationId]: '170927025' }).settings,
    { appId: APP_ID, clientId: null, installationId: INSTALLATION_ID, owner: 'memolabs-dev' });
  for (const bad of [{ [APP_ENV.id]: '5298579' }, { [APP_ENV.id]: 'x', [APP_ENV.installationId]: '1' },
    { [APP_ENV.id]: '1', [APP_ENV.installationId]: '1', [APP_ENV.clientId]: 'bad id!' },
    { [APP_ENV.id]: '1', [APP_ENV.installationId]: '1', [APP_ENV.owner]: '-bad' }]) {
    assert.equal(appSettingsFromEnv(bad).error, 'app_config_invalid', JSON.stringify(bad));
  }
  const dir = await temp(t, 'memo-app-key-');
  await writeFile(join(dir, 'ok.pem'), TEST_PEM);
  assert.ok((await loadAppKey(join(dir, 'ok.pem'))).key);
  await writeFile(join(dir, 'ec.pem'), generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.deepEqual(await loadAppKey(join(dir, 'ec.pem')), { error: 'app_key_invalid' });
  await writeFile(join(dir, 'small.pem'), generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs1', format: 'pem' }));
  assert.deepEqual(await loadAppKey(join(dir, 'small.pem')), { error: 'app_key_invalid' });
  await writeFile(join(dir, 'junk.pem'), 'not a key');
  assert.deepEqual(await loadAppKey(join(dir, 'junk.pem')), { error: 'app_key_invalid' });
  assert.deepEqual(await loadAppKey(join(dir, 'missing.pem')), { error: 'credential_missing' });
});

test('token pattern accepts PATs and stateless JWT-shaped installation tokens, never separators', async t => {
  const stateless = statelessToken();
  assert.ok(stateless.length > 450 && stateless.split('.').length === 3);
  for (const ok of [stateless, 'ghs_' + 'a'.repeat(36), 'github_pat_' + 'A1_'.repeat(20), pat()]) assert.ok(TOKEN_RE.test(ok), ok.slice(0, 12));
  for (const bad of ['short', 'a b'.repeat(10), `${'a'.repeat(30)}:x`, `${'a'.repeat(30)}@x`, `${'a'.repeat(30)}\nb`, 'a'.repeat(2049)]) {
    assert.equal(TOKEN_RE.test(bad), false);
  }
  const dir = await temp(t, 'memo-app-tok-');
  await writeFile(join(dir, 'tok'), `${stateless}\n`);
  assert.deepEqual(await readTokenFile(join(dir, 'tok')), { token: stateless });
  // The askpass helper reads the same format.
  const answer = spawnSync(process.execPath, [ASKPASS_PATH, "Password for 'https://x-access-token@github.com': "],
    { env: { [ASKPASS_CREDENTIAL_VAR]: join(dir, 'tok') }, encoding: 'utf8' });
  assert.equal(answer.status, 0);
  assert.equal(answer.stdout, `${stateless}\n`);
});

// ---------------------------------------------------------------------------------------------
// Minting, narrowing, caching

test('mint: identity checked once, then one repository and the minimal permissions per purpose', async t => {
  const f = await appProvider(t);
  const ledger = await f.provider.token('ledger', 'memolabs-dev/anything-ignored');
  assert.equal(ledger.source, 'app');
  assert.equal(ledger.token, f.api.issued[0]);
  const push = await f.provider.token('push', 'memolabs-dev/cuesheet');
  const pr = await f.provider.token('pull_request', 'memolabs-dev/cuesheet');
  assert.equal(push.source, 'app');
  assert.equal(pr.source, 'app');
  assert.notEqual(push.token, pr.token, 'different permission sets get different tokens');

  assert.deepEqual(f.api.requests.map(r => `${r.method} ${r.url}`), [
    'GET /app', ...Array(3).fill(`POST /app/installations/${INSTALLATION_ID}/access_tokens`)]);
  assert.deepEqual(f.api.posts().map(r => r.body), [
    { repositories: ['.github'], permissions: { contents: 'write' } },
    { repositories: ['cuesheet'], permissions: { contents: 'write' } },
    { repositories: ['cuesheet'], permissions: { contents: 'write', pull_requests: 'write' } }]);
  assert.equal(LEDGER_REPO, 'memolabs-dev/.github');
  assert.deepEqual(TOKEN_PURPOSES.pull_request.permissions, { contents: 'write', pull_requests: 'write' });
  for (const r of f.api.requests) {
    assert.equal(r.valid, true);
    assert.equal(r.header.alg, 'RS256');
    assert.equal(r.claims.iss, String(APP_ID));
    assert.equal(r.claims.iat, f.clock() / 1000 - 60);
    assert.ok(r.claims.exp - r.claims.iat <= 600);
    assert.equal(r.apiVersion, '2022-11-28');
  }
});

test('project_create purposes: repo_create for the organization, repo_admin for one repository, App only, purpose gate', async t => {
  const f = await appProvider(t);
  const created = await f.provider.token('repo_create', 'memolabs-dev/ignored');
  const admin = await f.provider.token('repo_admin', 'memolabs-dev/new-thing');
  assert.equal(created.source, 'app');
  assert.equal(admin.source, 'app');
  assert.deepEqual(f.api.posts().map(r => r.body), [
    { permissions: { administration: 'write', contents: 'read' } },
    { repositories: ['new-thing'], permissions: { administration: 'write' } }]);
  // An organization token answered for selected repositories is refused.
  const narrowed = await appProvider(t, { respond: body => (body.repositories ? null : { data: { token: statelessToken(),
    expires_at: new Date(Date.parse('2026-10-14T11:00:00Z')).toISOString(), repository_selection: 'selected',
    permissions: { administration: 'write', contents: 'read' }, repositories: [{ name: 'x' }] } }) });
  assert.equal((await narrowed.provider.token('repo_create')).error, 'app_token_scope_mismatch');
  // Without the App: never the ambient login, never a PAT.
  const pats = await credentials(t, { [LEDGER_CREDENTIAL]: pat(), [PUSH_CREDENTIAL]: pat() });
  const noApp = createGitHubCredentials({ env: { PATH: process.env.PATH, CREDENTIALS_DIRECTORY: pats } });
  assert.equal((await noApp.token('repo_create')).error, 'app_key_missing');
  assert.equal((await createGitHubCredentials({ env: { PATH: process.env.PATH } }).token('repo_admin', 'memolabs-dev/x')).error, 'app_key_missing');
  // The Mac's gate: only the listed purposes use the App; push keeps the PAT, ledger too.
  const gated = await appProvider(t, { files: { [PUSH_CREDENTIAL]: pat(), [LEDGER_CREDENTIAL]: pat() },
    env: { MEMO_BRIDGE_GITHUB_APP_PURPOSES: 'repo_create,repo_admin' } });
  assert.equal((await gated.provider.token('push', 'memolabs-dev/cuesheet')).source, 'pat');
  assert.equal((await gated.provider.token('ledger')).source, 'pat');
  assert.equal((await gated.provider.token('repo_create')).source, 'app');
  assert.equal(gated.api.posts().length, 1);
  const only = await appProvider(t, { env: { MEMO_BRIDGE_GITHUB_APP_PURPOSES: 'push' } });
  assert.equal((await only.provider.token('repo_create')).error, 'app_purpose_disabled');
  const bad = await appProvider(t, { env: { MEMO_BRIDGE_GITHUB_APP_PURPOSES: 'push,everything' } });
  assert.equal((await bad.provider.token('push', 'memolabs-dev/cuesheet')).error, 'app_config_invalid');
});

test('cache: reused until 5 minutes before expiry, then refreshed; concurrent requests mint once', async t => {
  const f = await appProvider(t);
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => f.provider.token('push', 'memolabs-dev/cuesheet')));
  assert.equal(f.api.posts().length, 1, 'concurrent calls share one mint');
  assert.ok(a.token === b.token && b.token === c.token);
  f.advance(3600_000 - REFRESH_MARGIN_MS - 1000); // 54 min 59 s later: still more than 5 minutes left
  assert.equal((await f.provider.token('push', 'memolabs-dev/cuesheet')).token, a.token);
  assert.equal(f.api.posts().length, 1);
  f.advance(2000); // now under 5 minutes left: refreshed
  const refreshed = await f.provider.token('push', 'memolabs-dev/cuesheet');
  assert.notEqual(refreshed.token, a.token);
  assert.equal(f.api.posts().length, 2);
  // Another repository is its own entry.
  await f.provider.token('push', 'memolabs-dev/uni-protocol');
  assert.equal(f.api.posts().length, 3);
  assert.equal(f.provider.cacheSize(), 2, 'the expired entry was dropped');
});

test('responses are checked: scope, repository, expiry, token shape; identity mismatch; foreign owner never requested', async t => {
  const cases = [
    [{ data: { token: statelessToken(), expires_at: '2026-10-14T11:00:00Z', permissions: { contents: 'write', issues: 'write' } } }, 'app_token_scope_mismatch'],
    [{ data: { token: statelessToken(), expires_at: '2026-10-14T11:00:00Z', permissions: { contents: 'read' } } }, 'app_token_scope_mismatch'],
    [{ data: { token: statelessToken(), expires_at: '2026-10-14T11:00:00Z', permissions: { contents: 'write' },
      repositories: [{ name: 'cuesheet' }, { name: 'other' }] } }, 'app_token_scope_mismatch'],
    [{ data: { token: statelessToken(), expires_at: '2026-10-14T10:04:00Z', permissions: { contents: 'write' } } }, 'app_token_expiry_invalid'],
    [{ data: { token: 'bad token', expires_at: '2026-10-14T11:00:00Z', permissions: { contents: 'write' } } }, 'app_token_invalid_response'],
    [{ status: 422, data: { message: 'There is at least one repository that does not exist or is not accessible to the parent installation.' } }, 'app_token_http_422']
  ];
  for (const [answer, code] of cases) {
    const f = await appProvider(t, { respond: () => answer });
    const got = await f.provider.token('push', 'memolabs-dev/cuesheet');
    assert.deepEqual(got, { error: code, credential: APP_KEY_CREDENTIAL }, code);
    assert.equal(f.provider.cacheSize(), 0);
  }
  assert.deepEqual(checkTokenResponse({ token: statelessToken(), expires_at: '2026-10-14T11:00:00Z', permissions: { contents: 'write', metadata: 'read' } },
    { repoName: 'cuesheet', permissions: { contents: 'write' }, nowMs: Date.parse('2026-10-14T10:00:00Z') }).error, undefined,
  'metadata:read, always granted, is accepted; a missing repositories list is accepted');

  const f = await appProvider(t);
  assert.deepEqual(await f.provider.token('push', 'someone-else/cuesheet'), { error: 'app_repo_not_allowed', credential: APP_KEY_CREDENTIAL });
  assert.deepEqual(await f.provider.token('push', null), { error: 'app_repo_invalid', credential: APP_KEY_CREDENTIAL });
  assert.equal(f.api.requests.length, 0, 'nothing is sent for a repository outside the installation owner');

  const wrong = await appProvider(t, { env: { [APP_ENV.clientId]: 'Iv23liOTHERCLIENT' } });
  assert.deepEqual(await wrong.provider.token('push', 'memolabs-dev/cuesheet'), { error: 'app_identity_mismatch', credential: APP_KEY_CREDENTIAL });
  assert.equal(wrong.api.requests.at(-1).claims.iss, 'Iv23liOTHERCLIENT', 'the client id is the issuer when configured');
  assert.equal(wrong.api.posts().length, 0);
});

test('fallback: no App gives the PAT files as before; an App failure falls back to the PAT and says so; ambient on the Mac', async t => {
  const ledgerPat = pat(); const pushPat = pat();
  // No app-key: PAT mode, exactly the files of Phase 4.
  const patDir = await credentials(t, { [LEDGER_CREDENTIAL]: ledgerPat, [PUSH_CREDENTIAL]: pushPat });
  const patOnly = createGitHubCredentials({ env: appEnv(patDir), fetchImpl: () => { throw new Error('no network expected'); } });
  assert.deepEqual(await patOnly.token('ledger', LEDGER_REPO), { token: ledgerPat, source: 'pat', file: join(patDir, LEDGER_CREDENTIAL) });
  assert.deepEqual(await patOnly.token('push', 'memolabs-dev/cuesheet'), { token: pushPat, source: 'pat', file: join(patDir, PUSH_CREDENTIAL) });
  assert.deepEqual(await patOnly.token('pull_request', 'memolabs-dev/cuesheet'), { source: 'ambient' }, 'PR creation keeps the runner gh environment');
  const empty = createGitHubCredentials({ env: appEnv(await credentials(t, {})) });
  assert.deepEqual(await empty.token('push', 'memolabs-dev/cuesheet'), { error: 'credential_missing', credential: PUSH_CREDENTIAL });

  // App configured but GitHub refuses (repository not added to the installation): PAT used.
  const f = await appProvider(t, { files: { [PUSH_CREDENTIAL]: pushPat }, respond: () => ({ status: 422, data: { message: 'nope' } }) });
  assert.deepEqual(await f.provider.token('push', 'memolabs-dev/memo-bridge'), { token: pushPat, source: 'pat', file: join(f.credsDir, PUSH_CREDENTIAL) });
  assert.deepEqual(f.events.map(e => e.event), ['app_token_failed', 'app_token_fallback']);
  assert.deepEqual(f.events[1].details, { purpose: 'push', repo: 'memolabs-dev/memo-bridge', code: 'app_token_http_422', credential: PUSH_CREDENTIAL });
  // Without a PAT the App error is the answer.
  assert.deepEqual(await f.provider.token('ledger', LEDGER_REPO), { error: 'app_token_http_422', credential: APP_KEY_CREDENTIAL });
  assert.deepEqual(await f.provider.token('pull_request', 'memolabs-dev/cuesheet'), { error: 'app_token_http_422', credential: APP_KEY_CREDENTIAL });

  // A key without settings: misconfiguration, reported, PAT used when present.
  const noSettings = createGitHubCredentials({ env: { CREDENTIALS_DIRECTORY: await credentials(t, { [APP_KEY_CREDENTIAL]: TEST_PEM, [LEDGER_CREDENTIAL]: ledgerPat }) } });
  assert.equal((await noSettings.token('ledger', LEDGER_REPO)).source, 'pat');
  assert.deepEqual(await noSettings.token('push', 'memolabs-dev/cuesheet'), { error: 'app_config_invalid', credential: APP_KEY_CREDENTIAL });

  // The Mac: no systemd credentials, nothing changes.
  assert.deepEqual(await createGitHubCredentials({ env: { PATH: '/usr/bin' } }).token('push', 'memolabs-dev/cuesheet'), { source: 'ambient' });
});

test('startupCheck: offline view of which source each purpose uses', async t => {
  const f = await appProvider(t);
  assert.deepEqual(await f.provider.startupCheck(), { app: 'configured', ledger: 'app', push: 'app' });
  assert.equal(f.api.requests.length, 0, 'no network at startup');
  const patOnly = createGitHubCredentials({ env: appEnv(await credentials(t, { [LEDGER_CREDENTIAL]: pat() })) });
  assert.deepEqual(await patOnly.startupCheck(), { app: 'absent', ledger: 'pat', push: 'missing' });
  const badKey = createGitHubCredentials({ env: appEnv(await credentials(t, { [APP_KEY_CREDENTIAL]: 'junk', [LEDGER_CREDENTIAL]: pat() })) });
  assert.deepEqual(await badKey.startupCheck(), { app: 'app_key_invalid', ledger: 'pat', push: 'missing' });
  const nothing = createGitHubCredentials({ env: { CREDENTIALS_DIRECTORY: await credentials(t, { [APP_KEY_CREDENTIAL]: TEST_PEM }) } });
  assert.deepEqual(await nothing.startupCheck(), { app: 'app_config_invalid', ledger: 'missing', push: 'missing' });
});

// ---------------------------------------------------------------------------------------------
// Wiring: ledger, Git push, pull request creation

test('ledger with the App: the installation token reaches the python child only, never process.env', async t => {
  const f = await appProvider(t);
  const root = await temp(t, 'memo-gov-');
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts', 'issue_lease.py'), '# stub, never executed\n');
  const calls = [];
  const run = async (command, args, opts) => { calls.push({ args, env: opts.env }); return { code: 0, stdout: '{"state":"free"}', stderr: '' }; };
  const scratch = join(await temp(t, 'memo-state-'), 'ledger-gh');
  const client = createIssueLeaseClient({ root, env: f.env, run, scratchDir: scratch, credentials: f.provider });
  const issue = { ref: ISSUE, repo: 'memolabs-dev/drop', number: '7' };
  assert.equal((await client.status(issue)).ok, true);
  assert.equal((await client.status(issue)).ok, true);
  assert.equal(calls[0].env.GH_TOKEN, f.api.issued[0]);
  assert.equal(calls[1].env.GH_TOKEN, f.api.issued[0], 'cached token reused');
  assert.equal(f.api.posts().length, 1);
  assert.equal(calls[0].env.CREDENTIALS_DIRECTORY, undefined);
  assert.notEqual(process.env.GH_TOKEN, f.api.issued[0]);
  assert.equal(f.env.GH_TOKEN, undefined);
  // An App failure without ledger-gh: ledger_unavailable with a short code.
  const down = await appProvider(t, { respond: () => ({ status: 500, data: {} }) });
  const failing = createIssueLeaseClient({ root, env: down.env, run, scratchDir: scratch, credentials: down.provider });
  assert.deepEqual(await failing.status(issue), { ok: false, error: 'ledger_unavailable', detail: 'app-key app_token_http_500' });
});

const REGISTRY = `# Projects

## Projets appartenant a Memo Labs

| Name | Path | Kind | Status | Nature | Stack | Vault |
|---|---|---|---|---|---|---|
| demo | demo | repo | active | test project | node | - |
`;
function realGit() {
  for (const dir of String(process.env.PATH).split(delimiter)) {
    const candidate = join(dir, 'git');
    try { if (statSync(candidate).isFile()) { accessSync(candidate, fsConstants.X_OK); return candidate; } } catch { /* next */ }
  }
  throw new Error('git not found');
}

test('runner push with the App and no push-gh: per-call askpass file with the token, removed after, nothing in the journal', async t => {
  const f = await appProvider(t);
  const base = await temp(t, 'memo-app-push-');
  await writeFile(join(base, 'gitconfig'), ['[user]', '\tname = Test Owner', '\temail = owner@example.test',
    '[init]', '\tdefaultBranch = main', '[commit]', '\tgpgsign = false', ''].join('\n'));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE',
    'GH_TOKEN', 'GITHUB_TOKEN', 'CREDENTIALS_DIRECTORY', 'GIT_ASKPASS']) delete gitEnv[name];
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const projectsRoot = join(base, 'projects');
  const repo = join(projectsRoot, 'demo');
  await mkdir(repo, { recursive: true });
  await writeFile(join(projectsRoot, 'PROJECTS.md'), REGISTRY);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  // The origin path ends in memolabs-dev/demo.git, so the runner reads owner/name from it.
  const origin = join(base, 'memolabs-dev', 'demo.git');
  await mkdir(join(base, 'memolabs-dev'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: gitEnv });
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');

  const bin = join(base, 'bin');
  await mkdir(bin);
  const log = join(base, 'git-calls.jsonl');
  // Records, for each call, the askpass variables and a digest of the credential file content.
  await writeFile(join(bin, 'git'), [
    `#!${process.execPath}`,
    "const { appendFileSync, readFileSync } = require('node:fs');",
    "const { createHash } = require('node:crypto');",
    "const { spawnSync } = require('node:child_process');",
    'const e = process.env;',
    "let credSha = null; try { credSha = createHash('sha256').update(readFileSync(e.MEMO_BRIDGE_ASKPASS_CREDENTIAL, 'utf8').trim()).digest('hex'); } catch {}",
    "appendFileSync(e.GITWRAP_LOG, JSON.stringify({ argv: process.argv.slice(2), askpass: e.GIT_ASKPASS || null, cred: e.MEMO_BRIDGE_ASKPASS_CREDENTIAL || null, credSha,",
    "  creds: 'CREDENTIALS_DIRECTORY' in e, ghToken: 'GH_TOKEN' in e || 'GITHUB_TOKEN' in e }) + '\\n');",
    `const r = spawnSync(${JSON.stringify(realGit())}, process.argv.slice(2), { stdio: 'inherit' });`,
    'process.exit(r.status === null ? 1 : r.status);', ''
  ].join('\n'), { mode: 0o755 });

  const env = { ...gitEnv, ...f.env, PATH: `${bin}${delimiter}${process.env.PATH}`, GITWRAP_LOG: log,
    MEMO_BRIDGE_WORKTREES_ROOT: join(base, 'worktrees'), GH_TOKEN: 'ambient_should_not_pass' };
  const ledger = { status: async () => ({ ok: true, receipt: {} }), claim: async () => ({ ok: true, receipt: {} }),
    heartbeat: async () => ({ ok: true, receipt: {} }), release: async () => ({ ok: true, receipt: {} }), verify: async () => ({ ok: true, receipt: {} }) };
  const stateDir = join(base, 'state');
  const rt = createRuntime({ stateDir, principal: OWNER, ledger, catalogOptions: { projectsRoot }, host: 'vps', env, githubCredentials: f.provider });
  t.after(() => rt.close());
  const at = Date.now();
  const ws = `ws_${randomBytes(12).toString('base64url')}`;
  await rt.store().transaction(r => r.insertWorkspace({ id: ws, principal: OWNER.id, client_type: 'claude-code', client_label: null,
    project_id: 'demo', host: 'vps', branch: null, status: 'active', created_at: at, updated_at: at }));
  await rt.store().transaction(r => r.insertClaim({ claim_id: randomBytes(16).toString('hex'), workspace_id: ws, issue_ref: ISSUE,
    fence_sha: randomBytes(20).toString('hex'), epoch: 1, expires_at: new Date(at + 600_000).toISOString(), updated_at: at }));

  // The runner's environment is this test's VPS-like env; it shares the runtime's provider.
  const vpsRunner = createWorktreeRunner(rt, { env, credentials: rt.githubCredentials });
  const ctx = () => ({ ids: {} });
  const created = await vpsRunner.create({ workspace_id: ws, issue: ISSUE }, ctx());
  assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.worktree.worktree_id;
  assert.equal((await vpsRunner.writeFile({ worktree_id: id, path: 'a.txt', content: 'a\n' }, ctx())).ok, true);
  const committed = await vpsRunner.commit({ worktree_id: id, message: 'feat: a' }, ctx());
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const pushed = await vpsRunner.push({ worktree_id: id }, ctx());
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  assert.equal(git(origin, 'rev-parse', `refs/heads/${created.worktree.branch}`), committed.commit);

  assert.deepEqual(f.api.posts().map(r => r.body), [{ repositories: ['demo'], permissions: { contents: 'write' } }],
    'one push token for the origin repository, reused by create and push');
  const token = f.api.issued[0];
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const network = calls.filter(c => c.argv.some(a => ['fetch', 'ls-remote', 'push'].includes(a)));
  assert.ok(network.length >= 4, 'fetch, ls-remote, ls-remote, push');
  for (const call of network) {
    assert.equal(call.askpass, ASKPASS_PATH);
    assert.match(call.cred, new RegExp(`^${join(stateDir, 'askpass').replace(/[.]/g, '\\.')}/tok-[0-9a-f]{32}$`));
    assert.equal(call.credSha, sha(token), 'the askpass file holds the App token during the call');
    assert.equal(call.creds, false);
    assert.equal(call.ghToken, false);
    assert.ok(!call.argv.some(arg => arg.includes(token)), 'no token in argv');
  }
  for (const call of calls.filter(c => !network.includes(c))) assert.equal(call.cred, null);
  const dirInfo = await lstat(join(stateDir, 'askpass'));
  assert.equal(dirInfo.mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(stateDir, 'askpass')), [], 'every per-call token file is removed');

  // Nothing under the state directory (store, journal, askpass) contains the token.
  const walk = async dir => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async e => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  }))).flat();
  for (const file of await walk(stateDir)) assert.ok(!(await readFile(file)).includes(token), `${file} holds no token`);
  for (const file of await walk(stateDir)) assert.ok(!(await readFile(file)).includes(Buffer.from(token.slice(4, 60))), file);
});

test('networkGit with the App: file 0600 in a private directory, release() removes it, stale files are purged', async t => {
  const f = await appProvider(t);
  const scratch = join(await temp(t, 'memo-app-net-'), 'askpass');
  await mkdir(scratch, { mode: 0o700 });
  const stale = join(scratch, `tok-${'0'.repeat(32)}`);
  await writeFile(stale, 'old\n', { mode: 0o600 });
  const { utimes } = await import('node:fs/promises');
  await utimes(stale, new Date(Date.now() - 3 * 3600_000), new Date(Date.now() - 3 * 3600_000));
  const net = await networkGit(f.env, { repo: 'memolabs-dev/cuesheet', credentials: f.provider, scratchDir: scratch });
  const file = net.env[ASKPASS_CREDENTIAL_VAR];
  assert.equal(((await stat(file)).mode & 0o777), 0o600);
  assert.equal((await readFile(file, 'utf8')).trim(), f.api.issued[0]);
  assert.equal(existsSync(stale), false, 'a leftover older than two hours is removed');
  assert.ok(!Object.values(net.env).includes(f.api.issued[0]), 'the token is not in the environment');
  await net.release();
  assert.equal(existsSync(file), false);
  // An unknown origin falls back to push-gh when present, else fails closed with a short code.
  assert.deepEqual(await networkGit(f.env, { repo: null, credentials: f.provider, scratchDir: scratch }),
    { error: { ok: false, error: 'credential_unavailable', detail: 'app-key app_repo_invalid' } });
  // A scratch directory open to others is refused.
  const open = join(await temp(t, 'memo-app-open-'), 'askpass');
  await mkdir(open, { mode: 0o755 });
  const { chmod } = await import('node:fs/promises');
  await chmod(open, 0o755);
  assert.deepEqual(await networkGit(f.env, { repo: 'memolabs-dev/cuesheet', credentials: f.provider, scratchDir: open }),
    { error: { ok: false, error: 'credential_unavailable', detail: 'askpass_unavailable' } });
});

test('pull request creation: GH_TOKEN per gh call with a private config dir, never process-wide; ambient without the App', async t => {
  const f = await appProvider(t);
  const scratch = join(await temp(t, 'memo-app-pr-'), 'gh-pr');
  const seen = [];
  const gh = async (args, opts = {}) => {
    const env = opts.env;
    seen.push({ args, hasEnv: Boolean(env), token: env?.GH_TOKEN ?? null, config: env?.GH_CONFIG_DIR ?? null,
      configExists: env?.GH_CONFIG_DIR ? existsSync(env.GH_CONFIG_DIR) : null, creds: env ? 'CREDENTIALS_DIRECTORY' in env : null });
    if (args.includes('-X') && args[args.indexOf('-X') + 1] === 'POST') {
      return { code: 0, stdout: JSON.stringify({ number: 5, title: 't', state: 'open', head: { ref: 'agent/7-x' }, base: { ref: 'main' }, html_url: 'https://github.com/memolabs-dev/cuesheet/pull/5' }), stderr: '' };
    }
    if (args.at(-1).startsWith('repos/memolabs-dev/cuesheet/pulls')) return { code: 0, stdout: '[]', stderr: '' };
    return { code: 0, stdout: JSON.stringify({ default_branch: 'main' }), stderr: '' };
  };
  const baseEnv = { PATH: '/usr/bin', CREDENTIALS_DIRECTORY: f.credsDir, GITHUB_TOKEN: 'ambient_should_not_pass' };
  const github = createGitHub({ gh, credentials: f.provider, scratchDir: scratch, baseEnv });
  const repo = { full: 'memolabs-dev/cuesheet', owner: 'memolabs-dev', name: 'cuesheet' };
  assert.deepEqual(await github.defaultBranch(repo, { auth: 'pull_request' }), { ok: true, branch: 'main' });
  assert.deepEqual(await github.openPullFor(repo, 'agent/7-x', { auth: 'pull_request' }), { ok: true, pull: null });
  const created = await github.createPull(repo, { title: 't', head: 'agent/7-x', base: 'main', body: 'b', draft: false });
  assert.equal(created.ok, true, JSON.stringify(created));
  await github.defaultBranch(repo); // an ordinary read: the read token
  const token = f.api.issued[0];
  assert.equal(f.api.posts().length, 2, 'one pull_request token, cached for the three calls, then one read token');
  assert.deepEqual(f.api.posts()[0].body, { repositories: ['cuesheet'], permissions: { contents: 'write', pull_requests: 'write' } });
  assert.deepEqual(f.api.posts()[1].body, { repositories: ['cuesheet'],
    permissions: { actions: 'read', contents: 'read', issues: 'read', pull_requests: 'read' } });
  for (const call of seen.slice(0, 3)) {
    assert.equal(call.token, token);
    assert.equal(call.configExists, true);
    assert.ok(call.config.startsWith(scratch));
    assert.equal(call.creds, false, 'no credentials directory in the gh child');
  }
  assert.equal(seen[3].token, f.api.issued[1], 'reads outside the pull request flow use the read token');
  assert.notEqual(seen[3].token, token);
  for (const call of seen.slice(0, 4)) assert.equal(existsSync(call.config), false, 'config dir removed after the call');
  assert.notEqual(process.env.GH_TOKEN, token);
  assert.equal(baseEnv.GH_TOKEN, undefined, 'the base environment is not modified');

  // Without the App (PAT mode on the VPS, or the Mac): no token is injected, as before.
  const plain = [];
  const patGithub = createGitHub({ gh: async (args, opts = {}) => { plain.push(opts); return { code: 0, stdout: JSON.stringify({ number: 1, head: {}, base: {} }), stderr: '' }; },
    credentials: createGitHubCredentials({ env: { CREDENTIALS_DIRECTORY: await credentials(t, { [LEDGER_CREDENTIAL]: pat() }) } }) });
  assert.equal((await patGithub.createPull(repo, { title: 't', head: 'agent/7-x', base: 'main', body: 'b' })).ok, true);
  assert.equal(plain[0].env, undefined);
  // An App failure fails closed before gh runs.
  const down = await appProvider(t, { respond: () => ({ status: 403, data: {} }) });
  const calls = [];
  const downGithub = createGitHub({ gh: async (...a) => { calls.push(a); return { code: 0, stdout: '{}', stderr: '' }; }, credentials: down.provider, scratchDir: scratch });
  assert.deepEqual(await downGithub.createPull(repo, { title: 't', head: 'agent/7-x', base: 'main', body: 'b' }),
    { ok: false, error: 'credential_unavailable', detail: 'app-key app_token_http_403' });
  assert.equal(calls.length, 0);
});

test('reads and batch Issues on the VPS: read and issues tokens per call; ambient on the Mac (github_auth_required, 2026-10-14)', async t => {
  const f = await appProvider(t);
  const scratch = join(await temp(t, 'memo-app-reads-'), 'gh-pr');
  const seen = [];
  const gh = async (args, opts = {}) => {
    seen.push({ path: args.find(a => a.startsWith('repos/')), token: opts.env?.GH_TOKEN ?? null });
    if (args.includes('POST')) return { code: 0, stdout: JSON.stringify({ number: 9, title: 't', state: 'open', labels: [], user: { login: 'x' } }), stderr: '' };
    if (args.at(-1).includes('/actions/runs')) return { code: 0, stdout: JSON.stringify({ total_count: 0, workflow_runs: [] }), stderr: '' };
    return { code: 0, stdout: '[]', stderr: '' };
  };
  const github = createGitHub({ gh, credentials: f.provider, scratchDir: scratch, baseEnv: { PATH: '/usr/bin' } });
  const repo = { full: 'memolabs-dev/cuesheet', owner: 'memolabs-dev', name: 'cuesheet' };
  assert.equal((await github.issues(repo)).ok, true);
  assert.equal((await github.pullRequests(repo)).ok, true);
  assert.equal((await github.workflowRuns(repo)).ok, true);
  assert.equal((await github.labelledIssues(repo, 'batch:x')).ok, true);
  assert.equal((await github.ensureLabel(repo, { name: 'batch:x', color: 'ededed', description: 'd' })).ok, true);
  assert.equal((await github.createIssue(repo, { title: 't', body: 'b', labels: ['batch:x'] })).ok, true);
  const [readToken, issuesToken] = f.api.issued;
  assert.deepEqual(f.api.posts().map(r => r.body.permissions), [
    { actions: 'read', contents: 'read', issues: 'read', pull_requests: 'read' }, { issues: 'write' }]);
  assert.deepEqual(seen.map(s => s.token), [readToken, readToken, readToken, readToken, issuesToken, issuesToken]);
  assert.ok(f.api.posts().every(r => r.body.repositories.length === 1 && r.body.repositories[0] === 'cuesheet'));

  // The Mac (no credentials provider): gh's own login, no token injected, as before.
  const mac = [];
  const macGithub = createGitHub({ gh: async (args, opts = {}) => { mac.push(opts.env); return { code: 0, stdout: '[]', stderr: '' }; } });
  assert.equal((await macGithub.issues(repo)).ok, true);
  assert.deepEqual(mac, [undefined]);
  // An App failure fails closed before gh runs.
  const down = await appProvider(t, { respond: () => ({ status: 403, data: {} }) });
  const calls = [];
  const downGithub = createGitHub({ gh: async (...a) => { calls.push(a); return { code: 0, stdout: '[]', stderr: '' }; }, credentials: down.provider, scratchDir: scratch });
  assert.deepEqual(await downGithub.createIssue(repo, { title: 't', body: 'b', labels: [] }),
    { ok: false, error: 'credential_unavailable', detail: 'app-key app_token_http_403' });
  assert.equal((await downGithub.issues(repo)).error, 'credential_unavailable');
  assert.equal(calls.length, 0);
});

test('no token, JWT or key material in log events or errors', async t => {
  const f = await appProvider(t, { files: { [PUSH_CREDENTIAL]: pat() } });
  const minted = await f.provider.token('push', 'memolabs-dev/cuesheet');
  const failing = await appProvider(t, { respond: () => ({ status: 401, data: { message: 'Bad credentials' } }) });
  const failed = await failing.provider.token('ledger', LEDGER_REPO);
  const text = JSON.stringify([f.events, failing.events, failed]);
  assert.ok(f.events.some(e => e.event === 'app_token_minted'));
  assert.deepEqual(Object.keys(f.events[0].details).sort(), ['expires_in_s', 'permissions', 'repo']);
  assert.ok(!text.includes(minted.token));
  assert.equal(f.api.requests.length > 0 && failing.api.requests.length > 0, true);
  assert.ok(!/eyJ[A-Za-z0-9_-]{8,}/.test(text), 'no JWT segment');
  assert.ok(!text.includes('PRIVATE KEY') && !text.includes(TEST_PEM.split('\n')[1]));
});

// ---------------------------------------------------------------------------------------------
// agent-cli startup checks (real entry point, no hub needed: runtime_ready is logged before the
// agent connects).

async function startCli(t, files, extraEnv = {}) {
  const work = await temp(t, 'memo-app-cli-');
  const config = join(work, 'config'); const creds = join(work, 'creds');
  await mkdir(config); await mkdir(creds, { mode: 0o700 });
  await writeFile(join(config, 'hub-ca.crt'), 'not used before connecting\n');
  await writeFile(join(creds, 'agent-key'), generateAgentIdentity().privateKey, { mode: 0o600 });
  for (const [name, value] of Object.entries(files)) await writeFile(join(creds, name), value, { mode: 0o600 });
  const child = spawn(process.execPath, ['bridge/agent-cli.mjs'], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH, HOME: work, MEMO_BRIDGE_AGENT_MODE: 'runtime', MEMO_BRIDGE_HOST: 'vps', MEMO_BRIDGE_AGENT_CONFIG: config,
      CREDENTIALS_DIRECTORY: creds, MEMO_BRIDGE_STATE_DIR: join(work, 'state'), MEMO_BRIDGE_AGENT_URL: 'wss://127.0.0.1:9/agent', ...extraEnv } });
  let stderr = '';
  child.stderr.on('data', c => { stderr += c; });
  const exited = new Promise(r => child.on('exit', code => r(code)));
  t.after(() => child.kill('SIGKILL'));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !/runtime_ready/.test(stderr) && child.exitCode === null) await new Promise(r => setTimeout(r, 50));
  return { stderr: () => stderr, exited, child };
}
const appSettings = { [APP_ENV.id]: String(APP_ID), [APP_ENV.installationId]: String(INSTALLATION_ID) };

test('agent-cli: starts with the App and no PAT; refuses an unusable App without ledger-gh; logs a fallback to the PAT', async t => {
  const app = await startCli(t, { [APP_KEY_CREDENTIAL]: TEST_PEM }, appSettings);
  const ready = app.stderr().split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l)).find(e => e.event === 'runtime_ready');
  assert.ok(ready, app.stderr());
  assert.deepEqual(ready.github_auth, { app: 'configured', ledger: 'app', push: 'app' });
  assert.equal(ready.push_credential, true);
  assert.ok(!app.stderr().includes('PRIVATE KEY'));
  app.child.kill('SIGTERM');

  const noSettings = await startCli(t, { [APP_KEY_CREDENTIAL]: TEST_PEM });
  assert.notEqual(await noSettings.exited, 0);
  assert.match(noSettings.stderr(), /app-key app_config_invalid/);

  const badKeyNoPat = await startCli(t, { [APP_KEY_CREDENTIAL]: 'junk\n' }, appSettings);
  assert.notEqual(await badKeyNoPat.exited, 0);
  assert.match(badKeyNoPat.stderr(), /app-key app_key_invalid/);

  const ledgerPat = pat();
  const fallback = await startCli(t, { [APP_KEY_CREDENTIAL]: 'junk\n', [LEDGER_CREDENTIAL]: `${ledgerPat}\n` }, appSettings);
  const lines = fallback.stderr().split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  assert.deepEqual(lines.find(e => e.event === 'github_app_unusable')?.code, 'app_key_invalid');
  assert.deepEqual(lines.find(e => e.event === 'runtime_ready')?.github_auth, { app: 'app_key_invalid', ledger: 'pat', push: 'missing' });
  assert.ok(!fallback.stderr().includes(ledgerPat));
  fallback.child.kill('SIGTERM');

  const none = await startCli(t, {});
  assert.notEqual(await none.exited, 0);
  assert.match(none.stderr(), /ledger-gh credential_missing/);
});
