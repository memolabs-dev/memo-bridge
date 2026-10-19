// Mac install helper for the Memo Bridge runtime agent (issues #110, #114, #147).
// deploy/mac/install-runtime-agent.sh calls it once; it prints one JSON line and never a token.
//
//   node deploy/mac/runtime-mac.mjs configure --home <abs> --owner-sub <uuid> --release <abs>
//        --governance <abs> --node <abs> --out <dir> [--from-registry] [--repo memolabs-dev/x ...]
//
// configure does three things, all owner-local:
//   1. enrollment: the private memolabs-dev repositories this Mac may serve to ChatGPT. Each one
//      must be registered in ~/memolabs/PROJECTS.md, with a verified GitHub origin and not archived.
//      --from-registry enrolls only private repos; --repo explicitly opts in one verified public
//      or private repo. A discovery snapshot, VPS file or remote request never enrolls anything.
//   2. the two policy files the runtime reads (0600, ~/.local/share/memo-bridge/owner-policy/):
//        private-repos.json  memolabs.owner-private-repos.v1, read by the coordinator
//                            (server/coordinator/owner-private-repos.mjs) and by the governance
//                            ledger (memolabs-dev/.github scripts/private_owner_allowlist.py)
//        remote.json         the Mac runtime's remote policy (bridge/write-gate.mjs
//                            parseRemotePolicy): the owner sub, private and explicitly
//                            opted-in public project names,
//                            remote writes, enforce session binding, mac_runtime_routing
//   3. the launchd plist of dev.memolabs.memo-bridge-agent in runtime mode, staged in --out.
// Nothing here talks to the VPS: no corpus, path or credential leaves the Mac.
import { execFile } from 'node:child_process';
import { chmodSync, closeSync, constants as fsConstants, mkdirSync, openSync, renameSync, rmdirSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProjectRegistry } from '../../server/catalog.mjs';
import { ENROLL_LOCK } from '../../server/projects/mac-enroll.mjs';
import { acquireLock } from '../../server/projects/registry-writer.mjs';

export const LABEL = 'dev.memolabs.memo-bridge-agent';
export const AGENT_URL = 'wss://127.0.0.1:9444/agent';
export const PRIVATE_SCHEMA = 'memolabs.owner-private-repos.v1';
// The governance ledger accepts only a Pocket ID user id (private_owner_allowlist.py OWNER).
export const OWNER_SUB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REPO_RE = /^memolabs-dev\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
export const MAX_REPOS = 50;
// The memo-labs-automation App (lab-infra memo_runner_github_app_id and _installation_id): with
// --github-app the runtime may use it for project_create only (owner console D-A2-2); the key
// itself is the app-key credential the installer copies, never in the plist.
export const GITHUB_APP = Object.freeze({ id: '5298579', installation: '170927025', purposes: 'repo_create,repo_admin' });
const ORIGIN_RE = /[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?\s*$/;

export function runtimeLayout(home) {
  if (typeof home !== 'string' || !isAbsolute(home) || home.includes('~')) throw new Error('home_not_absolute');
  const base = join(home, '.local', 'share', 'memo-bridge');
  return {
    base,
    policyDir: join(base, 'owner-policy'),
    privatePolicy: join(base, 'owner-policy', 'private-repos.json'),
    remotePolicy: join(base, 'owner-policy', 'remote.json'),
    config: join(base, 'runtime-config'),
    credentials: join(base, 'runtime-config', 'credentials'),
    agentConfig: join(home, '.config', 'memo-bridge'),
    registryRoot: join(home, 'memolabs'),
    logs: join(home, 'Library', 'Logs', 'memo-bridge'),
    plist: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
  };
}

const run = (cmd, args, opts = {}) => new Promise(resolve => {
  execFile(cmd, args, { timeout: 25_000, maxBuffer: 256 * 1024, ...opts }, (error, stdout) =>
    resolve(error ? null : String(stdout)));
});

// owner/repo of a checkout's origin, or null.
export async function gitOrigin(path, { git = run } = {}) {
  const out = await git('git', ['-C', path, 'remote', 'get-url', 'origin'], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const match = out ? ORIGIN_RE.exec(out.trim()) : null;
  return match ? `${match[1]}/${match[2]}` : null;
}

// {private, archived} as GitHub answers for the owner's own gh login, or null.
export async function githubVisibility(repo, { gh = run } = {}) {
  const out = await gh('gh', ['api', '-X', 'GET', `repos/${repo}`, '--jq', '{full_name, private, archived}'],
    { env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  try {
    const value = JSON.parse(out);
    if (value?.full_name?.toLowerCase() !== repo.toLowerCase()) return null;
    if (typeof value.private !== 'boolean' || typeof value.archived !== 'boolean') return null;
    return { private: value.private, archived: value.archived };
  } catch { return null; }
}

// {ok:true, projects:[{name, repo}], skipped:[{name, reason}]} or {ok:false, error, detail}.
export async function enroll({ projects, explicit = [], fromRegistry = false, origin, visibility }) {
  for (const repo of explicit) if (!REPO_RE.test(repo)) return { ok: false, error: 'invalid_repo', detail: repo };
  const wanted = new Set(explicit.map(r => r.toLowerCase()));
  const chosen = new Map();
  const publicChosen = new Map();
  const skipped = [];
  for (const p of projects) {
    if (p.kind !== 'repo' || !p.available || !p.path) continue;
    const repo = await origin(p.path);
    if (!repo || !REPO_RE.test(repo)) continue;
    if (!fromRegistry && !wanted.has(repo.toLowerCase())) continue;
    if (!PROJECT_RE.test(p.name)) { skipped.push({ name: p.name, reason: 'project_name_invalid' }); continue; }
    if (chosen.has(repo.toLowerCase()) || publicChosen.has(repo.toLowerCase())) {
      skipped.push({ name: p.name, reason: 'origin_already_enrolled' }); continue;
    }
    const seen = await visibility(repo);
    if (!seen) { skipped.push({ name: p.name, reason: 'github_unverified' }); continue; }
    if (seen.archived) { skipped.push({ name: p.name, reason: 'archived' }); continue; }
    if (!seen.private) {
      // Public repositories need an explicit --repo opt-in; never granted by --from-registry.
      if (wanted.has(repo.toLowerCase())) publicChosen.set(repo.toLowerCase(), { name: p.name, repo });
      continue;
    }
    chosen.set(repo.toLowerCase(), { name: p.name, repo });
  }
  // An explicit --repo must be a registered Mac checkout of a private, live repository.
  for (const repo of wanted) {
    if (!chosen.has(repo) && !publicChosen.has(repo))
      return { ok: false, error: 'repo_not_enrolled', detail: repo, skipped };
  }
  if (chosen.size + publicChosen.size > MAX_REPOS)
    return { ok: false, error: 'too_many_repos', detail: String(chosen.size + publicChosen.size) };
  const byName = (a, b) => a.name.localeCompare(b.name);
  return { ok: true, projects: [...chosen.values()].sort(byName),
    publicProjects: [...publicChosen.values()].sort(byName), skipped };
}

export function renderPrivatePolicy({ ownerSub, projects }) {
  if (!OWNER_SUB_RE.test(ownerSub ?? '')) throw new Error('owner_sub_invalid');
  return `${JSON.stringify({ schema: PRIVATE_SCHEMA, owner_sub: ownerSub, repos: projects.map(p => p.repo) })}\n`;
}

export function renderRemotePolicy({ ownerSub, projects, publicProjects = [] }) {
  if (!OWNER_SUB_RE.test(ownerSub ?? '')) throw new Error('owner_sub_invalid');
  return `${JSON.stringify({
    version: 1, managed_by: 'memo-bridge deploy/mac/install-runtime-agent.sh',
    oidc: { owner_sub: ownerSub }, projects: [...projects, ...publicProjects].map(p => p.name),
    remote_writes: 'enabled', session_binding: 'enforce', mac_runtime_routing: 'enabled'
  }, null, 2)}\n`;
}

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderPlist({ home, node, release, governance, ownerSub, extraPath = [], githubApp = false }) {
  const L = runtimeLayout(home);
  for (const p of [node, release, governance, ...extraPath]) {
    if (typeof p !== 'string' || !isAbsolute(p) || p.includes('~')) throw new Error('plist_path_not_absolute');
  }
  if (!OWNER_SUB_RE.test(ownerSub ?? '')) throw new Error('owner_sub_invalid');
  const path = [...new Set([dirname(node), ...extraPath, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  const env = {
    MEMO_BRIDGE_AGENT_MODE: 'runtime',
    MEMO_BRIDGE_MAC_RUNTIME_ENABLED: 'enabled',
    MEMO_BRIDGE_HOST: 'mac',
    MEMO_BRIDGE_AGENT_URL: AGENT_URL,
    MEMO_BRIDGE_AGENT_CONFIG: L.agentConfig,
    CREDENTIALS_DIRECTORY: L.credentials,
    MEMO_BRIDGE_REMOTE_CONFIG: L.remotePolicy,
    MEMO_BRIDGE_OWNER_SUB: ownerSub,
    MEMO_BRIDGE_OWNER_PRIVATE_REPOS_FILE: L.privatePolicy,
    MEMO_BRIDGE_GOVERNANCE_ROOT: governance,
    MEMOLABS_ROOT: L.registryRoot,
    ...(githubApp ? { MEMO_BRIDGE_GITHUB_APP_ID: GITHUB_APP.id, MEMO_BRIDGE_GITHUB_APP_INSTALLATION_ID: GITHUB_APP.installation,
      MEMO_BRIDGE_GITHUB_APP_PURPOSES: GITHUB_APP.purposes } : {}),
    HOME: home,
    PATH: path
  };
  const str = v => `\t\t<string>${xml(v)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>', `\t<string>${LABEL}</string>`,
    '\t<key>ProgramArguments</key>', '\t<array>', str(node), str(join(release, 'bridge', 'agent-cli.mjs')), '\t</array>',
    '\t<key>EnvironmentVariables</key>', '\t<dict>',
    ...Object.entries(env).flatMap(([k, v]) => [`\t\t<key>${k}</key>`, str(v)]),
    '\t</dict>',
    '\t<key>WorkingDirectory</key>', `\t<string>${xml(release)}</string>`,
    '\t<key>KeepAlive</key>', '\t<true/>',
    '\t<key>RunAtLoad</key>', '\t<true/>',
    '\t<key>ThrottleInterval</key>', '\t<integer>30</integer>',
    '\t<key>Umask</key>', '\t<integer>63</integer>',
    '\t<key>StandardOutPath</key>', `\t<string>${xml(join(L.logs, 'stdout.log'))}</string>`,
    '\t<key>StandardErrorPath</key>', `\t<string>${xml(join(L.logs, 'stderr.log'))}</string>`,
    '</dict>',
    '</plist>',
    ''
  ].join('\n');
}

// Write a file through a temporary sibling and one rename, with its final mode.
function writeAtomic(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, text); } finally { closeSync(fd); }
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export async function configure({ home, ownerSub, release, governance, node, out, fromRegistry, repos, extraPath = [], githubApp = false,
  origin = path => gitOrigin(path), visibility = repo => githubVisibility(repo) }) {
  const L = runtimeLayout(home);
  if (!OWNER_SUB_RE.test(ownerSub ?? '')) return { ok: false, error: 'owner_sub_invalid' };
  if (!fromRegistry && repos.length === 0) return { ok: false, error: 'nothing_to_enroll', detail: 'pass --from-registry or --repo' };
  let registry;
  try { registry = await readProjectRegistry({ projectsRoot: L.registryRoot, layoutRoot: L.registryRoot }); } catch { return { ok: false, error: 'registry_unavailable' }; }
  const enrolled = await enroll({ projects: registry.projects, explicit: repos, fromRegistry, origin, visibility });
  if (!enrolled.ok) return enrolled;
  // Under the lock project_create's enrollment takes (server/projects/mac-enroll.mjs, #216), so an
  // enrollment never renames an older copy over what the installer just wrote.
  mkdirSync(L.policyDir, { recursive: true, mode: 0o700 });
  const lock = join(L.policyDir, ENROLL_LOCK);
  if (!(await acquireLock(lock, { waitMs: 10_000, stepMs: 50 }))) return { ok: false, error: 'owner_policy_locked', detail: lock };
  try {
    writeAtomic(L.privatePolicy, renderPrivatePolicy({ ownerSub, projects: enrolled.projects }), 0o600);
    writeAtomic(L.remotePolicy, renderRemotePolicy({ ownerSub, projects: enrolled.projects, publicProjects: enrolled.publicProjects }), 0o600);
  } finally {
    rmdirSync(lock);
  }
  chmodSync(L.policyDir, 0o700);
  const staged = join(out, `${LABEL}.plist`);
  writeAtomic(staged, renderPlist({ home, node, release, governance, ownerSub, extraPath, githubApp }), 0o644);
  return { ok: true, enrolled: enrolled.projects, public_enrolled: enrolled.publicProjects,
    skipped: enrolled.skipped, private_policy: L.privatePolicy,
    remote_policy: L.remotePolicy, plist: staged, github_app: githubApp };
}

function parseArgs(argv) {
  const opts = { repos: [], extraPath: [], fromRegistry: false, githubApp: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--home') opts.home = value();
    else if (a === '--owner-sub') opts.ownerSub = value();
    else if (a === '--release') opts.release = value();
    else if (a === '--governance') opts.governance = value();
    else if (a === '--node') opts.node = value();
    else if (a === '--out') opts.out = value();
    else if (a === '--repo') opts.repos.push(value());
    else if (a === '--path') opts.extraPath.push(value());
    else if (a === '--from-registry') opts.fromRegistry = true;
    else if (a === '--github-app') opts.githubApp = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [step, ...rest] = process.argv.slice(2);
  let result;
  try {
    if (step !== 'configure') throw new Error('usage: runtime-mac.mjs configure ...');
    result = await configure(parseArgs(rest));
  } catch (error) {
    result = { ok: false, error: 'configure_failed', detail: String(error?.message ?? error).slice(0, 200) };
  }
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
