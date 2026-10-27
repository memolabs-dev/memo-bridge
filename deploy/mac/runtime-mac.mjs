// Mac install helper for the Memo Bridge runtime agent (issues #110, #114, #147).
// deploy/mac/install-runtime-agent.sh calls it once; it prints one JSON line and never a token.
//
//   node deploy/mac/runtime-mac.mjs configure --home <abs> --owner-sub <uuid> --release <abs>
//        --governance <abs> --node <abs> --out <dir> [--from-registry] [--repo memolabs-dev/x ...]
//
// configure does three things, all owner-local:
//   1. enrollment: the private repositories of the owner's namespaces (memolabs-dev,
//      guillaume-flambard, #257) this Mac may serve to ChatGPT. Each one must be registered in
//      ~/memolabs/PROJECTS.md, or be an owner external project of
//      owner-policy/external-projects.json (server/projects/external-projects.mjs, provisioned by
//      the owner, never written here), with a verified GitHub origin and not archived.
//      --from-registry enrolls only private repos; --repo opts in one verified repository;
//      --all-owner-projects opts in all registered owner repositories and periodic reconciliation.
//      A discovery snapshot, VPS file or remote request never enrolls anything.
//   2. the two policy files the runtime reads (0600, ~/.local/share/memo-bridge/owner-policy/):
//        private-repos.json  memolabs.owner-private-repos.v1, read by the coordinator
//                            (server/coordinator/owner-private-repos.mjs) and by the governance
//                            ledger (memolabs-dev/.github scripts/private_owner_allowlist.py)
//        remote.json         the Mac runtime's remote policy (bridge/write-gate.mjs
//                            parseRemotePolicy): the owner sub, private and explicitly
//                            opted-in public project names,
//                            remote writes, enforce session binding, mac_runtime_routing
//   3. the launchd plist of dev.memolabs.memo-bridge-agent in runtime mode, staged in --out.
// Everything configure writes is STAGED in --out (fix pass of #258, finding 4): the policy files
// in --out/owner-policy/, with a record of the live files it saw and, when the owner has none
// yet, a new lease-key.json (the key of private lease names, memolabs-dev/.github
// scripts/issue_lease.py). The running runtime keeps reading the live files until --install:
//
//   node deploy/mac/runtime-mac.mjs promote --home <abs> [--out <dir>]
//
// moves the staged policies into place under the enrollment lock, keeps a 0600 .bak-<time> of
// each live one, never replaces a live lease key, and refuses when a live policy changed since
// the stage run (a project_create enrollment would otherwise be lost).
// Nothing here talks to the VPS: no corpus, path or credential leaves the Mac.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProjectRegistry } from '../../server/catalog.mjs';
import { ENROLL_LOCK } from '../../server/projects/mac-enroll.mjs';
import { acquireLock } from '../../server/projects/registry-writer.mjs';

export const LABEL = 'dev.memolabs.memo-bridge-agent';
export const AGENT_URL = 'wss://127.0.0.1:9444/agent';
export const PRIVATE_SCHEMA = 'memolabs.owner-private-repos.v1';
export const LEASE_KEY_SCHEMA = 'memolabs.owner-lease-key.v1';
// The governance ledger accepts only a Pocket ID user id (private_owner_allowlist.py OWNER).
export const OWNER_SUB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
import { enroll, gitOrigin, githubVisibility } from '../../server/projects/owner-enrollment.mjs';
export { enroll, gitOrigin, githubVisibility, REPO_RE, PROJECT_RE, MAX_REPOS } from '../../server/projects/owner-enrollment.mjs';
// The memo-labs-automation App (lab-infra memo_runner_github_app_id and _installation_id): with
// --github-app the runtime may use it for project_create only (owner console D-A2-2); the key
// itself is the app-key credential the installer copies, never in the plist.
export const GITHUB_APP = Object.freeze({ id: '5298579', installation: '170927025', purposes: 'repo_create,repo_admin' });

export function runtimeLayout(home) {
  if (typeof home !== 'string' || !isAbsolute(home) || home.includes('~')) throw new Error('home_not_absolute');
  const base = join(home, '.local', 'share', 'memo-bridge');
  return {
    base,
    policyDir: join(base, 'owner-policy'),
    privatePolicy: join(base, 'owner-policy', 'private-repos.json'),
    externalProjects: join(base, 'owner-policy', 'external-projects.json'),
    remotePolicy: join(base, 'owner-policy', 'remote.json'),
    leaseKey: join(base, 'owner-policy', 'lease-key.json'),
    config: join(base, 'runtime-config'),
    credentials: join(base, 'runtime-config', 'credentials'),
    agentConfig: join(home, '.config', 'memo-bridge'),
    registryRoot: join(home, 'memolabs'),
    logs: join(home, 'Library', 'Logs', 'memo-bridge'),
    plist: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
  };
}

// Where configure stages the policy files (the installer's --out, ~/.local/share/memo-bridge/launchd).
export function stagedLayout(home, out = join(runtimeLayout(home).base, 'launchd')) {
  if (typeof out !== 'string' || !isAbsolute(out)) throw new Error('out_not_absolute');
  const policyDir = join(out, 'owner-policy');
  return { policyDir, privatePolicy: join(policyDir, 'private-repos.json'), remotePolicy: join(policyDir, 'remote.json'),
    leaseKey: join(policyDir, 'lease-key.json'), record: join(policyDir, 'stage.json') };
}

const sha256 = path => { try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; } };
// What the stage run saw of the live policy files (null: absent).
export function stageRecord(home) {
  const L = runtimeLayout(home);
  return { private_sha256: sha256(L.privatePolicy), remote_sha256: sha256(L.remotePolicy) };
}

export function renderLeaseKey({ ownerSub, key = randomBytes(32).toString('hex') }) {
  if (!OWNER_SUB_RE.test(ownerSub ?? '')) throw new Error('owner_sub_invalid');
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('lease_key_invalid');
  return `${JSON.stringify({ schema: LEASE_KEY_SCHEMA, owner_sub: ownerSub, key })}\n`;
}

export function renderPrivatePolicy({ ownerSub, projects }) {
  if (!OWNER_SUB_RE.test(ownerSub ?? '')) throw new Error('owner_sub_invalid');
  return `${JSON.stringify({ schema: PRIVATE_SCHEMA, owner_sub: ownerSub, repos: projects.map(p => p.repo) })}\n`;
}

export function renderRemotePolicy({ ownerSub, projects, publicProjects = [], allOwnerProjects = false }) {
  if (!OWNER_SUB_RE.test(ownerSub ?? '')) throw new Error('owner_sub_invalid');
  return `${JSON.stringify({
    version: 1, managed_by: 'memo-bridge deploy/mac/install-runtime-agent.sh',
    ...(allOwnerProjects ? { registry_enrollment: 'all-owner-projects' } : {}),
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
    MEMO_BRIDGE_OWNER_EXTERNAL_PROJECTS_FILE: L.externalProjects,
    MEMO_BRIDGE_OWNER_LEASE_KEY_FILE: L.leaseKey,
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

export async function configure({ home, ownerSub, release, governance, node, out, fromRegistry, allOwnerProjects = false, repos, extraPath = [], githubApp = false,
  origin = path => gitOrigin(path), visibility = repo => githubVisibility(repo) }) {
  const L = runtimeLayout(home);
  if (!OWNER_SUB_RE.test(ownerSub ?? '')) return { ok: false, error: 'owner_sub_invalid' };
  if (!fromRegistry && !allOwnerProjects && repos.length === 0) return { ok: false, error: 'nothing_to_enroll', detail: 'pass --all-owner-projects, --from-registry or --repo' };
  let registry;
  // The owner's external projects count as registered checkouts here (#257); absent file, none.
  try {
    registry = await readProjectRegistry({ projectsRoot: L.registryRoot, layoutRoot: L.registryRoot,
      externalProjects: { file: L.externalProjects, ownerSub, home, root: L.registryRoot } });
  } catch { return { ok: false, error: 'registry_unavailable' }; }
  const enrolled = await enroll({ projects: registry.projects, explicit: repos, fromRegistry, allOwnerProjects, origin, visibility });
  if (!enrolled.ok) return enrolled;
  // Staged only: the running runtime keeps the live files until promote (--install).
  const S = stagedLayout(home, out);
  writeAtomic(S.privatePolicy, renderPrivatePolicy({ ownerSub, projects: enrolled.projects }), 0o600);
  writeAtomic(S.remotePolicy, renderRemotePolicy({ ownerSub, projects: enrolled.projects, publicProjects: enrolled.publicProjects, allOwnerProjects }), 0o600);
  // A lease key is made once and never replaced (that would orphan every live private lease).
  let leaseKey = 'live';
  if (!existsSync(L.leaseKey)) {
    if (!existsSync(S.leaseKey)) writeAtomic(S.leaseKey, renderLeaseKey({ ownerSub }), 0o600);
    leaseKey = 'staged';
  }
  writeAtomic(S.record, `${JSON.stringify(stageRecord(home))}\n`, 0o600);
  chmodSync(S.policyDir, 0o700);
  const staged = join(out, `${LABEL}.plist`);
  writeAtomic(staged, renderPlist({ home, node, release, governance, ownerSub, extraPath, githubApp }), 0o644);
  return { ok: true, enrolled: enrolled.projects, public_enrolled: enrolled.publicProjects,
    skipped: enrolled.skipped, private_policy: S.privatePolicy, remote_policy: S.remotePolicy, lease_key: leaseKey,
    live_unchanged: true, plist: staged, github_app: githubApp };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const privateFile = path => { try { const st = lstatSync(path); return st.isFile() && (st.mode & 0o077) === 0 && st.uid === process.getuid(); } catch { return false; } };

// Move the staged policy files into place (--install, right before the agent restarts).
export async function promote({ home, out, now = stamp }) {
  const L = runtimeLayout(home);
  const S = stagedLayout(home, out);
  if (![S.privatePolicy, S.remotePolicy, S.record].every(privateFile)) return { ok: false, error: 'nothing_staged', detail: S.policyDir };
  mkdirSync(L.policyDir, { recursive: true, mode: 0o700 });
  // Under the lock project_create's enrollment takes (server/projects/mac-enroll.mjs, #216).
  const lock = join(L.policyDir, ENROLL_LOCK);
  if (!(await acquireLock(lock, { waitMs: 10_000, stepMs: 50 }))) return { ok: false, error: 'owner_policy_locked', detail: lock };
  try {
    let seen;
    try { seen = JSON.parse(readFileSync(S.record, 'utf8')); } catch { return { ok: false, error: 'nothing_staged', detail: S.record }; }
    const live = stageRecord(home);
    if (seen?.private_sha256 !== live.private_sha256 || seen?.remote_sha256 !== live.remote_sha256) {
      return { ok: false, error: 'owner_policy_changed_since_stage', detail: 'stage again, then --install' };
    }
    const at = now();
    const backups = [];
    for (const [staged, target] of [[S.privatePolicy, L.privatePolicy], [S.remotePolicy, L.remotePolicy]]) {
      if (existsSync(target)) {
        const backup = `${target}.bak-${at}`;
        copyFileSync(target, backup, fsConstants.COPYFILE_EXCL);
        chmodSync(backup, 0o600);
        backups.push(backup);
      }
    }
    // The private list first: until remote.json names a new project, nothing routes to it.
    renameSync(S.privatePolicy, L.privatePolicy);
    renameSync(S.remotePolicy, L.remotePolicy);
    let leaseKey = 'kept';
    if (privateFile(S.leaseKey)) {
      if (existsSync(L.leaseKey)) unlinkSync(S.leaseKey);
      else { renameSync(S.leaseKey, L.leaseKey); leaseKey = 'created'; }
    }
    unlinkSync(S.record);
    chmodSync(L.policyDir, 0o700);
    return { ok: true, promoted: [L.privatePolicy, L.remotePolicy], backups, lease_key: leaseKey };
  } finally {
    rmdirSync(lock);
  }
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
    else if (a === '--all-owner-projects') opts.allOwnerProjects = true;
    else if (a === '--github-app') opts.githubApp = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [step, ...rest] = process.argv.slice(2);
  let result;
  try {
    if (step === 'promote') {
      const opts = parseArgs(rest);
      result = await promote({ home: opts.home, out: opts.out });
    } else if (step === 'configure') {
      result = await configure(parseArgs(rest));
    } else {
      throw new Error('usage: runtime-mac.mjs configure|promote ...');
    }
  } catch (error) {
    result = { ok: false, error: 'configure_failed', detail: String(error?.message ?? error).slice(0, 200) };
  }
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
