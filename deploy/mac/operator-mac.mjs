// Mac install helper for the operator agent `operator-mac` (Phase 6, TODO-P6-13, spec D2, D6,
// D7, D8, D11, DEV-P6-05). deploy/mac/install-operator-agent.sh calls it once per step; each
// step is idempotent and prints one JSON line, never key material.
//
//   node deploy/mac/operator-mac.mjs keygen  --home <abs>
//   node deploy/mac/operator-mac.mjs hub-ca  --home <abs> --from <cert>
//   node deploy/mac/operator-mac.mjs hub-pub --home <abs> --from <pem>
//   node deploy/mac/operator-mac.mjs policy  --home <abs>
//   node deploy/mac/operator-mac.mjs runtime --home <abs> --from <built dir> [--commit <sha>]
//   node deploy/mac/operator-mac.mjs plist   --home <abs> --node <abs> --out <dir>
// Mac root helper (spec §13 Mac root follow-up; deploy/mac/install-operator-root.sh, run as the
// owner's user, never as root):
//   node deploy/mac/operator-mac.mjs hub-key-id  --from <pem>
//   node deploy/mac/operator-mac.mjs root-plan   --home <abs> --node <abs> --uid <n> --gid <n>
//   node deploy/mac/operator-mac.mjs root-policy --home <abs> --out <file>
//   node deploy/mac/operator-mac.mjs root-plist  --home <abs> --uid <n> --gid <n> --out <file>
//
// Layout on the Mac (macLayout below):
//   ~/.memo-operator/                 0700  configuration of the agent, denied to its own tools
//     agent.key                       0600  Ed25519 identity of operator-mac (never printed)
//     operator-mac.pub                0444  its public half; lab-infra copies it to the hub
//                                           (role memo-operator, memo_operator_mac_pub_path)
//     hub-ca.crt                      0444  the hub TLS CA, copied from the probe agent's
//                                           ~/.config/memo-bridge/hub-ca.crt
//     operator-hub.pub                0444  the hub's operator signing key (lab:
//                                           /etc/memo-operator/operator-hub.pub)
//     policy.json                     0444  read-only: the agent runs as the owner (DEV-P6-05)
//     FROZEN                                created by the owner to freeze (D6 b)
//     state/                          0700  background runs, uploads, AUTO-FROZEN marker
//   ~/.local/share/memo-bridge/operator/   pinned bundle (scripts/build-operator.mjs), 0444 files
//   ~/Library/Logs/memo-operator/     0700  stdout.log, stderr.log, audit.jsonl (D7)
import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import {
  chmodSync, closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync,
  writeSync
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAgentIdentity, keyFingerprint } from '../../bridge/crypto.mjs';
import { loadOperatorPolicy, parseOperatorPolicy } from '../../bridge/operator-policy.mjs';
import { readProjectRegistry } from '../../server/catalog.mjs';
import { MAC_ROOT_LABEL, macRootLayout } from '../../bridge/operator-root-mac.mjs';

export const LABEL = 'dev.memolabs.memo-operator-agent';
// The tunnel dev.memolabs.memo-bridge-tunnel listens on 127.0.0.1:9444 only; the hub
// certificate names DNS:localhost and IP:127.0.0.1, and the live probe agent uses this form.
export const AGENT_URL = 'wss://127.0.0.1:9444/agent';
export const RUNTIME_FILES = Object.freeze(['package.json', 'bridge/operator-job-supervisor.mjs', 'bridge/operator-agent-cli.mjs']);

export function macLayout(home) {
  if (typeof home !== 'string' || !isAbsolute(home) || home.includes('~') || home === '/') throw new Error('home_invalid');
  const conf = join(home, '.memo-operator');
  const logs = join(home, 'Library', 'Logs', 'memo-operator');
  const runtime = join(home, '.local', 'share', 'memo-bridge', 'operator');
  return Object.freeze({
    home, conf, logs, runtime,
    keyFile: join(conf, 'agent.key'),
    pubFile: join(conf, 'operator-mac.pub'),
    hubCa: join(conf, 'hub-ca.crt'),
    hubPub: join(conf, 'operator-hub.pub'),
    policyFile: join(conf, 'policy.json'),
    frozenFile: join(conf, 'FROZEN'),
    stateDir: join(conf, 'state'),
    auditFile: join(logs, 'audit.jsonl'),
    script: join(runtime, 'bridge', 'operator-agent-cli.mjs'),
    probeCa: join(home, '.config', 'memo-bridge', 'hub-ca.crt'),
    launchAgent: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
  });
}

// The project registry the catalog already uses (server/catalog.mjs): PROJECTS.md lives in
// ~/memolabs, its Path column is relative to ~/projects, which the 2026-10-14 migration points at
// ~/memolabs/.links (F-P6-02). The real checkouts sit under ~/memolabs (the layout root).
export function macRepositories(home) {
  return {
    projects_root: join(home, 'memolabs', '.links'),
    registry_file: join(home, 'memolabs', 'PROJECTS.md'),
    layout_root: join(home, 'memolabs')
  };
}

// The Mac policy (spec D1, D5, D8, O-P6-5 as briefed for Lot 3). T2, or T3 once the root helper
// is installed (rootSocket: its socket path; spec §13 Mac root follow-up, R-MR-07).
export function macPolicy(home, { repositories = macRepositories(home), rootSocket = null } = {}) {
  const L = macLayout(home);
  const h = rel => join(home, rel);
  const support = h('Library/Application Support');
  return {
    version: 1,
    host: 'mac',
    max_tier: rootSocket ? 'root' : 'exec',
    approval_mode: 'dangerous',
    ...(rootSocket ? { root_helper: { socket: rootSocket } } : {}),
    roots: {
      read: [home],
      write: [h('memolabs'), h('Desktop'), h('Downloads'), h('Documents'), '/tmp']
    },
    // Added to the built-in list of bridge/operator-paths.mjs (which already holds .ssh, .gnupg,
    // .env*, *.pem, *.key, id_*, *secret*, ~/Library/Keychains, .memo-operator, .netrc, .aws
    // credentials, gh, docker and kube configs). Repeated here where the brief names them, so
    // the Mac file says what it denies on its own.
    denylist: [
      `${h('Library/Keychains')}/**`,
      `${h('.ssh')}/**`,
      `${h('.gnupg')}/**`,
      `${h('.config')}/**/secrets/**`,
      `${h('.config/memo-bridge')}/**`,
      `${L.conf}/**`,
      `${h('.aws')}/**`,
      `${h('.azure')}/**`,
      `${h('.config/gcloud')}/**`,
      h('.netrc'),
      h('.codex/auth.json'),
      h('.claude/.credentials.json'),
      '**/*.p8',
      '**/*.p12',
      '**/*.pem',
      `${support}/*/Cookies`,
      `${support}/**/Cookies*`,
      `${support}/**/Local Storage/**`,
      `${support}/**/Session Storage/**`,
      `${support}/Google/Chrome/**`,
      `${support}/BraveSoftware/**`,
      `${support}/Arc/**`,
      `${support}/Firefox/**`,
      `${support}/Microsoft Edge/**`,
      `${support}/1Password/**`,
      `${h('Library/Safari')}/**`,
      `${h('Library/Cookies')}/**`,
      `${h('Library/HTTPStorages')}/**`,
      `${h('Library/Messages')}/**`,
      `${h('Library/Mail')}/**`,
      `${h('Library/Group Containers')}/**`
    ],
    frozen_file: L.frozenFile,
    audit_file: L.auditFile,
    state_dir: L.stateDir,
    repositories
  };
}

// The Mac root helper's own policy, root-owned at /Library/Application Support/MemoBridge/
// operator-root/policy.json. Every path absolute (root's "~" would be /var/root). The read root
// '/' only bounds the working directory of a root call; the denylist and the repository guard
// still apply to it. Its FROZEN switch sits in the root directory; the owner's
// ~/.memo-operator/FROZEN is obeyed too (plist MEMO_OPERATOR_USER_FROZEN).
export function macRootPolicy(home, { layout = macRootLayout(), repositories = macRepositories(home) } = {}) {
  const user = macPolicy(home, { repositories });
  return {
    version: 1,
    host: 'mac',
    max_tier: 'root',
    approval_mode: 'dangerous',
    roots: { read: ['/'], write: [] },
    denylist: user.denylist,
    frozen_file: layout.frozen,
    audit_file: layout.audit,
    state_dir: layout.stateDir,
    repositories,
    root_helper: { socket: layout.socket }
  };
}

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// The launchd job, every path absolute (launchd expands no "~"). launchd.plist(5) on this Mac:
// Umask takes a decimal integer (63 = 077), ThrottleInterval is in seconds. Same shape as the live
// dev.memolabs.memo-bridge-agent: KeepAlive, RunAtLoad, ThrottleInterval 30, logs under
// ~/Library/Logs; plus Umask 077 so what the agent creates (jobs, audit) is private.
export function renderPlist({ home, node, label = LABEL, url = AGENT_URL }) {
  const L = macLayout(home);
  if (typeof node !== 'string' || !isAbsolute(node)) throw new Error('node_path_not_absolute');
  const env = {
    MEMO_OPERATOR_HOST: 'mac',
    MEMO_OPERATOR_CONFIG: L.conf,
    MEMO_OPERATOR_POLICY: L.policyFile,
    MEMO_BRIDGE_AGENT_URL: url,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
  };
  const paths = [node, L.script, L.conf, L.policyFile, L.runtime, join(L.logs, 'stdout.log'), join(L.logs, 'stderr.log')];
  for (const p of paths) if (!isAbsolute(p) || p.includes('~')) throw new Error('plist_path_not_absolute');
  const str = v => `\t\t<string>${xml(v)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>', `\t<string>${xml(label)}</string>`,
    '\t<key>ProgramArguments</key>', '\t<array>', str(node), str(L.script), '\t</array>',
    '\t<key>EnvironmentVariables</key>', '\t<dict>',
    ...Object.entries(env).flatMap(([k, v]) => [`\t\t<key>${xml(k)}</key>`, str(v)]),
    '\t</dict>',
    '\t<key>WorkingDirectory</key>', `\t<string>${xml(L.runtime)}</string>`,
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

// The LaunchDaemon (launchd.plist(5) on this Mac: UserName and GroupName apply in the system
// domain; Umask is a decimal integer, 63 = 077; StandardErrorPath is created with that umask).
// It runs the root-owned node copy on the root-owned bundle; nothing it names is under the home.
export function renderRootPlist({ home, uid, gid, layout = macRootLayout() }) {
  const L = macLayout(home);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) throw new Error('agent_uid_invalid');
  const env = {
    MEMO_OPERATOR_ROOT_DIR: layout.dir,
    MEMO_OPERATOR_AGENT_UID: String(uid),
    MEMO_OPERATOR_AGENT_GID: String(gid),
    MEMO_OPERATOR_USER_FROZEN: L.frozenFile,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
  };
  for (const p of [layout.node, layout.script, layout.helperLog]) if (!isAbsolute(p) || p.startsWith(`${home}/`)) throw new Error('plist_path_invalid');
  const str = v => `\t\t<string>${xml(v)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>', `\t<string>${xml(layout.label)}</string>`,
    '\t<key>ProgramArguments</key>', '\t<array>', str(layout.node), str(layout.script), '\t</array>',
    '\t<key>UserName</key>', '\t<string>root</string>',
    '\t<key>GroupName</key>', '\t<string>wheel</string>',
    '\t<key>EnvironmentVariables</key>', '\t<dict>',
    ...Object.entries(env).flatMap(([k, v]) => [`\t\t<key>${xml(k)}</key>`, str(v)]),
    '\t</dict>',
    '\t<key>WorkingDirectory</key>', '\t<string>/</string>',
    '\t<key>KeepAlive</key>', '\t<true/>',
    '\t<key>RunAtLoad</key>', '\t<true/>',
    '\t<key>ThrottleInterval</key>', '\t<integer>30</integer>',
    '\t<key>Umask</key>', '\t<integer>63</integer>',
    '\t<key>StandardOutPath</key>', `\t<string>${xml(layout.helperLog)}</string>`,
    '\t<key>StandardErrorPath</key>', `\t<string>${xml(layout.helperLog)}</string>`,
    '</dict>',
    '</plist>',
    ''
  ].join('\n');
}

// What `sudo deploy/mac/install-operator-root.sh --install` does, in order, every target with its
// owner and mode. Printed by the dry run and again before the install. Sources may sit in the
// home (the node, the hub key); no target does.
export function rootPlan({ home, node, uid, gid, layout = macRootLayout() }) {
  const L = macLayout(home);
  const dir = (path, mode) => ({ action: 'mkdir', path, owner: 'root:wheel', mode });
  const file = (path, mode, from) => ({ action: 'install', path, owner: 'root:wheel', mode, from });
  const steps = [
    dir(layout.parent, '0755'), dir(layout.dir, '0755'), dir(join(layout.dir, 'bin'), '0755'), dir(join(layout.dir, 'bridge'), '0755'),
    file(layout.node, '0555', node),
    file(layout.script, '0444', 'bundle built as the user (scripts/build-operator.mjs --root)'),
    file(layout.supervisor, '0444', 'bundle'),
    file(layout.packageJson, '0444', 'bundle'),
    file(join(layout.dir, 'VERSION'), '0444', 'git rev-parse HEAD'),
    file(layout.policy, '0444', 'rendered as the user (root-policy)'),
    file(layout.hubPub, '0444', L.hubPub),
    dir(layout.stateDir, '0700'), dir(layout.logDir, '0700'),
    { action: 'check', path: layout.script, owner: 'root', detail: `${layout.node} ${layout.script} --check` },
    file(layout.plist, '0644', 'rendered as the user (root-plist)'),
    { action: 'launchctl', path: layout.plist, owner: 'root', detail: `launchctl bootstrap system ${layout.plist}` },
    { action: 'runtime', path: layout.socketDir, owner: 'root:wheel', mode: '0755', detail: 'made by the helper at each start' },
    { action: 'runtime', path: layout.socket, owner: `${uid}:${gid}`, mode: '0600', detail: 'the agent user connects; nobody else' },
    { action: 'runtime', path: layout.audit, owner: 'root:wheel', mode: '0600', detail: 'hash-chained root journal' }
  ];
  return steps.map(s => ({ step: 'plan', ...s }));
}

// Write a file atomically with a fixed mode: unchanged when content and mode already match,
// else a temporary file in the same directory (O_EXCL, no symlink followed) renamed over it.
// A symlink or a non-file at the target is refused, never followed.
export function writeFileMode(path, content, mode) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  let existing = null;
  try { existing = lstatSync(path); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (existing && !existing.isFile()) throw new Error(`not_a_regular_file:${path}`);
  if (existing && (existing.mode & 0o777) === mode && readFileSync(path).equals(data)) return 'unchanged';
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, data); } finally { closeSync(fd); }
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  return existing ? 'replaced' : 'written';
}

function ensureDir(path, mode) {
  mkdirSync(path, { recursive: true, mode });
  const info = lstatSync(path);
  if (!info.isDirectory()) throw new Error(`not_a_directory:${path}`);
  if (info.uid !== process.getuid()) throw new Error(`directory_not_owned:${path}`);
  if ((info.mode & 0o777) !== mode) chmodSync(path, mode);
}

const pemBlocks = text => text.split(/(?=-----BEGIN PUBLIC KEY-----)/).map(s => s.trim()).filter(Boolean);
const keyId = pem => createHash('sha256').update(createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);

// Same generator as the probe agent's key (bridge/crypto.mjs generateAgentIdentity: Ed25519,
// PKCS#8 and SPKI PEM). An existing key is never regenerated: rotation is a manual move.
export function keygen(home) {
  const L = macLayout(home);
  ensureDir(L.conf, 0o700);
  let created = false;
  let privatePem;
  if (lstatExists(L.keyFile)) {
    const info = lstatSync(L.keyFile);
    if (!info.isFile()) throw new Error('agent_key_not_a_file');
    privatePem = readFileSync(L.keyFile, 'utf8');
    const key = createPrivateKey(privatePem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('agent_key_not_ed25519');
    if ((info.mode & 0o777) !== 0o600) chmodSync(L.keyFile, 0o600);
  } else {
    const identity = generateAgentIdentity();
    privatePem = identity.privateKey;
    const fd = openSync(L.keyFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, privatePem); } finally { closeSync(fd); }
    chmodSync(L.keyFile, 0o600);
    created = true;
  }
  const publicPem = createPublicKey(privatePem).export({ type: 'spki', format: 'pem' });
  const pub = writeFileMode(L.pubFile, publicPem, 0o444);
  return { step: 'keygen', key_created: created, public_key: L.pubFile, public_key_state: pub, fingerprint: keyFingerprint(publicPem) };
}

function lstatExists(path) { try { lstatSync(path); return true; } catch { return false; } }

export function installHubCa(home, from) {
  const L = macLayout(home);
  ensureDir(L.conf, 0o700);
  const text = readFileSync(from, 'utf8');
  const cert = new X509Certificate(text);
  return { step: 'hub-ca', path: L.hubCa, state: writeFileMode(L.hubCa, text, 0o444), valid_to: cert.validTo };
}

// One or more Ed25519 public keys (a rotation may list two, DEV-P6-04).
export function installHubPub(home, from) {
  const L = macLayout(home);
  ensureDir(L.conf, 0o700);
  const blocks = pemBlocks(readFileSync(from, 'utf8'));
  if (blocks.length === 0 || blocks.length > 4) throw new Error('hub_pub_invalid');
  for (const pem of blocks) if (createPublicKey(pem).asymmetricKeyType !== 'ed25519') throw new Error('hub_pub_not_ed25519');
  return { step: 'hub-pub', path: L.hubPub, state: writeFileMode(L.hubPub, `${blocks.join('\n')}\n`, 0o444), key_ids: blocks.map(keyId) };
}

// The policy: built, checked against the schema, the registry read through the catalog's own
// reader (D11 needs at least one registered checkout), written 0444, then loaded back exactly
// as the agent will load it. A changed file keeps the previous one as policy.json.<ts>.bak.
// With the root helper's policy installed (root-owned, /Library/Application Support/MemoBridge/
// operator-root/policy.json), the agent's policy grants root and names the helper's socket;
// without it, exec. Rerun after installing or removing the root helper (R-MR-07).
export async function writePolicy(home, { read = readProjectRegistry, now = Date.now, rootLayout = macRootLayout() } = {}) {
  const L = macLayout(home);
  ensureDir(L.conf, 0o700);
  ensureDir(L.stateDir, 0o700);
  ensureDir(L.logs, 0o700);
  const rootInstalled = (() => { try { return lstatSync(rootLayout.policy).isFile(); } catch { return false; } })();
  const raw = macPolicy(home, { rootSocket: rootInstalled ? rootLayout.socket : null });
  parseOperatorPolicy(raw, { home });
  const catalog = await read({ projectsRoot: raw.repositories.projects_root, registryFile: raw.repositories.registry_file,
    layoutRoot: raw.repositories.layout_root });
  const available = catalog.projects.filter(p => p.available && p.path).length;
  if (available === 0) throw new Error('registry_has_no_available_project');
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  let backup = null;
  if (lstatExists(L.policyFile) && lstatSync(L.policyFile).isFile() && !readFileSync(L.policyFile).equals(Buffer.from(text))) {
    backup = `${L.policyFile}.${now()}.bak`;
    renameSync(L.policyFile, backup);
  }
  const state = writeFileMode(L.policyFile, text, 0o444);
  const policy = loadOperatorPolicy({ path: L.policyFile, expectedHost: 'mac', trustedUids: [0, process.getuid()], home });
  return { step: 'policy', path: L.policyFile, state, backup, max_tier: policy.maxTierName, approval_mode: policy.approvalMode,
    root_helper: policy.rootHelper?.socket ?? null,
    write_roots: [...policy.declaredRoots.write], missing_roots: [...policy.missingRoots], registered_projects: available };
}

// Copy the bundle built by scripts/build-operator.mjs; files 0444, one atomic rename each.
export function installRuntime(home, from, { commit = null } = {}) {
  const L = macLayout(home);
  // The parent (~/.local/share/memo-bridge) also holds the probe agent's runtime: created if
  // missing, its mode never changed.
  mkdirSync(dirname(L.runtime), { recursive: true, mode: 0o755 });
  ensureDir(L.runtime, 0o755);
  ensureDir(join(L.runtime, 'bridge'), 0o755);
  const states = {};
  for (const rel of RUNTIME_FILES) states[rel] = writeFileMode(join(L.runtime, rel), readFileSync(join(from, rel)), 0o444);
  if (commit !== null) {
    if (!/^[0-9a-f]{7,40}(-dirty)?$/.test(commit)) throw new Error('commit_invalid');
    states.VERSION = writeFileMode(join(L.runtime, 'VERSION'), `${commit}\n`, 0o444);
  }
  return { step: 'runtime', path: L.runtime, script: L.script, files: states };
}

export function writePlist(home, { node, out }) {
  if (typeof out !== 'string' || !isAbsolute(out)) throw new Error('out_not_absolute');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const path = join(out, `${LABEL}.plist`);
  return { step: 'plist', path, state: writeFileMode(path, renderPlist({ home, node }), 0o644), label: LABEL, url: AGENT_URL };
}

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}

async function main() {
  const step = process.argv[2];
  const home = arg('home');
  const from = arg('from');
  let result;
  switch (step) {
    case 'keygen': result = keygen(home); break;
    case 'hub-ca': result = installHubCa(home, from); break;
    case 'hub-pub': result = installHubPub(home, from); break;
    case 'policy': result = await writePolicy(home); break;
    case 'runtime': result = installRuntime(home, from, { commit: arg('commit') ?? null }); break;
    case 'plist': result = writePlist(home, { node: arg('node'), out: arg('out') }); break;
    case 'hub-key-id': {
      // The hub key the root helper will trust, by key id (bridge/operator-signing.mjs operatorKeyId),
      // so the owner can compare it with lab's before installing. Read only.
      const blocks = pemBlocks(readFileSync(from, 'utf8'));
      if (blocks.length === 0 || blocks.length > 4) throw new Error('hub_pub_invalid');
      for (const pem of blocks) if (createPublicKey(pem).asymmetricKeyType !== 'ed25519') throw new Error('hub_pub_not_ed25519');
      result = { step: 'hub-pub', path: from, key_ids: blocks.map(keyId) };
      break;
    }
    case 'root-plan': {
      const plan = rootPlan({ home, node: arg('node'), uid: Number(arg('uid')), gid: Number(arg('gid')) });
      for (const line of plan) console.log(JSON.stringify(line));
      result = { step: 'root-plan', steps: plan.length, label: MAC_ROOT_LABEL };
      break;
    }
    case 'root-policy': {
      const raw = macRootPolicy(home);
      parseOperatorPolicy(raw, { home });
      const out = arg('out');
      // Without --out (the dry run): the policy itself, on one line.
      if (out === undefined) { result = { step: 'root-policy', content: raw }; break; }
      if (typeof out !== 'string' || !isAbsolute(out)) throw new Error('out_not_absolute');
      result = { step: 'root-policy', path: out, state: writeFileMode(out, `${JSON.stringify(raw, null, 2)}\n`, 0o644), max_tier: raw.max_tier,
        approval_mode: raw.approval_mode, socket: raw.root_helper.socket };
      break;
    }
    case 'root-plist': {
      const out = arg('out');
      const text = renderRootPlist({ home, uid: Number(arg('uid')), gid: Number(arg('gid')) });
      if (out === undefined) { result = { step: 'root-plist', content: text }; break; }
      if (typeof out !== 'string' || !isAbsolute(out)) throw new Error('out_not_absolute');
      result = { step: 'root-plist', path: out, state: writeFileMode(out, text, 0o644), label: MAC_ROOT_LABEL };
      break;
    }
    default: throw new Error('usage: operator-mac.mjs keygen|hub-ca|hub-pub|policy|runtime|plist|root-plan|root-policy|root-plist --home <abs> ...');
  }
  console.log(JSON.stringify(result));
}

const invoked = (() => { try { return realpathSync(process.argv[1] ?? ''); } catch { return null; } })();
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exit(1); });
}
