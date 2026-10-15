// The whole Phase 5 path on one machine, offline: an MCP client over HTTPS -> the public
// listener (bridge/remote-boot.mjs, built from a lab-infra shaped remote.json) -> the remote
// surface -> the forwarder -> the hub's v2 envelope -> a real agent -> the runtime (store,
// coordinator, worktrees) on a temporary Git repository with a local bare origin.
// Tokens are minted locally (jose); the ledger is a stub that grants; no network, no GitHub.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHub } from '../../bridge/hub.mjs';
import { createAgent, createRuntimeOperations, probeOperations, wireClaim } from '../../bridge/agent.mjs';
import { generateAgentIdentity } from '../../bridge/crypto.mjs';
import { createOidcVerifier } from '../../bridge/oidc.mjs';
import { createRemoteService } from '../../bridge/remote-boot.mjs';
import { createRuntime } from '../../server/runtime.mjs';
import { CAPABILITIES, makePrincipal } from '../../server/coordinator/policy.mjs';
import { stubLedger } from './coordinator-fixture.mjs';

export const HOST = 'bridge.memolabs.dev';
export const RESOURCE = `https://${HOST}/mcp`;
export const ISSUER = 'https://auth.memolabs.dev';
export const SUB = '7f0c2a51-3b8e-4d7a-9c11-2f4e5a6b7c8d';
export const CHATGPT = 'https://chatgpt.com/oauth/client.json';
export const ISSUE = 'memolabs-dev/demo#7';
export const ALL_SCOPES = Object.values(CAPABILITIES).join(' ');
export const CERT_INFO_HEADER = 'x-forwarded-tls-client-cert-info';
export const OPENAI_SAN = 'mtls.prod.connectors.openai.com';
// Go's url.QueryEscape, which Traefik's passTLSClientCert applies to each certificate entry.
export const queryEscape = text => encodeURIComponent(text).replace(/%20/g, '+');
// The info header as Traefik forwards it for a client certificate verified against the OpenAI
// Connectors CA (route memo-bridge.yml.j2: notAfter, sans, subject and issuer CN and O).
export const OPENAI_CERT_INFO = queryEscape(`Subject="CN=${OPENAI_SAN},O=OpenAI";Issuer="CN=OpenAI-Connectors-mTLS-CA,O=OpenAI";`
  + `NA="1798761600";SAN="${OPENAI_SAN}"`);

// remote.json exactly as ansible/roles/memo-bridge/templates/remote.json.j2 renders it from
// ansible/group_vars/lab.yml (lab-infra), with a test owner sub and the test project. Since the
// owner decision of 2026-10-15 (option A) lab renders client_cert.mode "require".
export function labRemoteJson(overrides = {}) {
  return {
    version: 1, managed_by: 'lab-infra role memo-bridge', remote_enabled: true,
    listen: { host: '127.0.0.1', port: 9445 }, public_host: HOST, allowed_origins: ['https://chatgpt.com'], trusted_proxies: ['127.0.0.1'],
    oidc: { issuer: ISSUER, jwks_uri: 'http://127.0.0.1:1411/.well-known/jwks.json', audience: RESOURCE, owner_sub: SUB,
      allowed_client_ids: [CHATGPT], required_scope: 'coordinator:read', max_token_age_sec: 3600 },
    projects: ['memolabs-dev/demo'], remote_writes: 'disabled', session_binding: 'warn',
    client_cert: { mode: 'require', info_header: CERT_INFO_HEADER, expected_san: OPENAI_SAN },
    budgets: { body_max_bytes: 131072, result_max_bytes: 24576, page_max_bytes: 16384, write_file_max_bytes: 98304, list_max_items: 50,
      soft_deadline_sec: 40 },
    rate_limits: { read_per_min: 60, write_per_min: 20, execute_per_min: 6, in_flight: 8, unauthorized_per_min_per_ip: 30 },
    ...overrides
  };
}

// systemctl fixtures for the write gate probe (bridge/write-gate.mjs checkRunnerUsers).
export const SYSTEMCTL_NO_RUNNER = async args => ({ code: args[0] === 'list-unit-files' ? 1 : 0, stdout: '' });
export const SYSTEMCTL_ROOT_RUNNER = async args => {
  const unit = 'actions.runner.memolabs-dev-emargo.vps.service';
  if (args[0] === 'list-unit-files') return { code: 0, stdout: `${unit} enabled enabled\n` };
  if (args[0] === 'list-units') return { code: 0, stdout: `${unit} loaded active running GitHub Actions Runner\n` };
  return { code: 0, stdout: `Id=${unit}\nUser=\nActiveState=active\nUnitFileState=enabled\nLoadState=loaded\n` };
};

export function tlsPair(t) {
  return mkdtemp(join(tmpdir(), 'memo-remote-tls-')).then(dir => {
    t.after(() => rm(dir, { recursive: true, force: true }));
    const out = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return Promise.all([readFile(join(dir, 'k'), 'utf8'), readFile(join(dir, 'c'), 'utf8')]).then(([tlsKey, tlsCert]) => ({ tlsKey, tlsCert }));
  });
}

// fetch over node:https to the loopback listener, presenting Host: bridge.memolabs.dev and
// trusting only the test certificate (what Traefik's serversTransport does on the VPS), and,
// like Traefik for ChatGPT, forwarding OpenAI's verified client certificate info. A null value
// in extraHeaders removes a header (null for CERT_INFO_HEADER: a caller without a certificate).
export function loopbackFetch(port, ca, extraHeaders = {}) {
  return async (url, init = {}) => {
    const target = new URL(url);
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    headers.host = HOST;
    headers[CERT_INFO_HEADER] = OPENAI_CERT_INFO;
    Object.assign(headers, extraHeaders);
    for (const [key, value] of Object.entries(headers)) if (value === null) delete headers[key];
    const body = init.body == null ? undefined : typeof init.body === 'string' ? init.body : Buffer.from(await new Response(init.body).arrayBuffer());
    return new Promise((resolve, reject) => {
      const req = httpsRequest({ hostname: '127.0.0.1', port, path: target.pathname + target.search, method: init.method ?? 'GET', ca,
        servername: 'localhost', headers }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const out = new Headers();
          for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) out.set(key, Array.isArray(value) ? value.join(', ') : value);
          const empty = [204, 205, 304].includes(res.statusCode) || (init.method ?? 'GET') === 'HEAD';
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status: res.statusCode, headers: out }));
        });
        res.on('error', reject);
      });
      init.signal?.addEventListener?.('abort', () => req.destroy(new Error('aborted')));
      req.on('error', reject);
      req.end(body);
    });
  };
}

async function until(fn, ms = 5000) {
  const expire = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > expire) throw new Error('wait expired'); await new Promise(r => setTimeout(r, 15)); }
}

const gitIn = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Git must never read the user's own configuration here.
async function gitSandbox(t, base) {
  await writeFile(join(base, 'gitconfig'), ['[user]', '\tname = Test Owner', '\temail = owner@example.test', '[init]', '\tdefaultBranch = main',
    '[commit]', '\tgpgsign = false', ''].join('\n'));
  const saved = {};
  const set = { GIT_CONFIG_GLOBAL: join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', MEMO_BRIDGE_WORKTREES_ROOT: join(base, 'worktrees') };
  for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE', ...Object.keys(set)]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  Object.assign(process.env, set);
  return () => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } };
}

// Build the stack. remote: overrides of remote.json; systemctl: the write gate fixture.
export async function remoteStack(t, { remote = {}, systemctl = SYSTEMCTL_NO_RUNNER } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'memo-remote-stack-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  t.after(await gitSandbox(t, base));

  const projectsRoot = join(base, 'projects');
  const repo = join(projectsRoot, 'demo');
  await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
  await writeFile(join(projectsRoot, 'PROJECTS.md'), ['# Projects', '', '## Projets appartenant a Memo Labs', '',
    '| Name | Path | Kind | Status | Nature | Stack | Vault |', '|---|---|---|---|---|---|---|',
    '| demo | demo | repo | active | test project | node | - |', ''].join('\n'));
  gitIn(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  await writeFile(join(repo, 'README.md'), '# demo\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'initial');
  const origin = join(base, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  gitIn(repo, 'remote', 'add', 'origin', origin);
  gitIn(repo, 'push', '-q', '-u', 'origin', 'main');

  const raw = labRemoteJson(remote);
  const configPath = join(base, 'remote.json');
  await writeFile(configPath, JSON.stringify(raw));
  // The catalog and GitHub tools read the process environment; the runtime takes its own env.
  const previous = process.env.MEMO_BRIDGE_REMOTE_CONFIG;
  process.env.MEMO_BRIDGE_REMOTE_CONFIG = configPath;
  t.after(() => { if (previous === undefined) delete process.env.MEMO_BRIDGE_REMOTE_CONFIG; else process.env.MEMO_BRIDGE_REMOTE_CONFIG = previous; });

  const runtime = createRuntime({ stateDir: join(base, 'state'), principal: makePrincipal('local:owner', Object.values(CAPABILITIES)),
    ledger: stubLedger(), catalogOptions: { projectsRoot, layoutRoot: projectsRoot }, host: 'vps',
    projectRemote: async () => 'memolabs-dev/demo', env: { MEMO_BRIDGE_REMOTE_CONFIG: configPath } });
  t.after(() => runtime.close());
  const wire = [];
  const ops = await createRuntimeOperations({ runtimeFor: p => runtime.as(p),
    // The mapping bridge/agent-cli.mjs uses in production.
    principalFromWire: claim => { wire.push(claim); return runtime.principalFromHub(wireClaim(claim)); } });
  t.after(() => ops.close());

  const { tlsKey, tlsCert } = await tlsPair(t);
  const identity = generateAgentIdentity();
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: createHash('sha256').update('x'.repeat(64)).digest('hex'),
    allowedAgentKeys: { vps: identity.publicKey }, port: 0 });
  const { port: hubPort } = await hub.start();
  t.after(() => hub.stop());
  const agent = createAgent({ host: 'vps', url: `wss://127.0.0.1:${hubPort}/agent`, privateKey: identity.privateKey, ca: tlsCert,
    reconnectMs: 100_000, operations: { ...probeOperations('vps'), ...ops.handlers } });
  t.after(() => agent.stop());
  await until(() => hub.agentInfo('vps')?.version === 2);

  const pair = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] });
  const verifier = createOidcVerifier({ issuer: ISSUER, ownerSub: SUB, allowedClientIds: [CHATGPT], jwks, remoteWrites: raw.remote_writes });
  const journal = [];
  const listener = await createRemoteService({ raw, tlsKey, tlsCert, requestAgent: hub.requestAgent, audit: e => journal.push(e),
    systemctl, verifier, port: 0 });
  const { port } = await listener.start();
  t.after(() => listener.stop());

  const mint = ({ scope = ALL_SCOPES, sub = SUB } = {}) => new SignJWT({ scope, client_id: CHATGPT })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' }).setIssuer(ISSUER).setAudience(RESOURCE).setSubject(sub)
    .setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  const fetch = loopbackFetch(port, tlsCert);

  // An MCP client as ChatGPT would hold it: the bearer on every request, a stateless server.
  async function client(token) {
    const c = new Client({ name: 'remote-smoke', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), { fetch, requestInit: { headers: { authorization: `Bearer ${token}` } } });
    await c.connect(transport);
    t.after(() => c.close().catch(() => {}));
    return {
      raw: c,
      tools: async () => (await c.listTools()).tools,
      call: async (name, args = {}, session) => {
        const out = await c.callTool({ name, arguments: args, ...(session ? { _meta: { 'openai/session': session } } : {}) });
        const text = out.content?.[0]?.text;
        try { return { result: out, data: JSON.parse(text) }; } catch { return { result: out, data: null, text }; }
      }
    };
  }
  const events = () => runtime.store().transaction(r => r.listEvents({ limit: 500 }), { write: false });
  return { base, repo, origin, runtime, hub, listener, port, journal, wire, mint, client, fetch, events, tlsCert, raw,
    git: gitIn };
}
