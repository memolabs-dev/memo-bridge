// Remote write policy (Phase 5, D7 layer 2, D8, D9). Pure functions shared by the hub and the
// runtime, plus the systemd probe the hub runs before it opens the write gate.
//
// EV-P5-01 (2026-10-14): a ChatGPT Chat conversation called a remote write tool with no
// confirmation prompt. Nothing here relies on annotations, prompts or tool descriptions: every
// rule is enforced by the server that executes the operation, whatever the caller sends.
//
// What lives here:
// - isRemotePrincipal: a principal authenticated by the public OIDC listener (`oidc:<sub>`, D6);
// - the remote policy (remote.json): project allowlist, session binding mode, soft deadline;
// - isProtectedRepoPath: paths no Memo Bridge write may touch (CI configuration, #161);
// - sessionBindingDecision: the D8 cross-talk guard (never an authorization signal);
// - the D7 layer 2 probe: the hub refuses to open writes while a GitHub Actions runner unit
//   runs as root (lab-infra #161).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isRemotePrincipal } from '../server/coordinator/policy.mjs';

const fail = (error, detail) => ({ ok: false, error, ...(detail !== undefined ? { detail } : {}) });
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

// ---------------------------------------------------------------------------------------------
// Principals.

// D6: the public listener maps a verified token to `oidc:<sub>` (policy.mjs remotePrincipal).
// Phase 4 hub principals (`hub:owner`, `hub:readonly`, loopback 9443) and local stdio
// principals are not remote. Re-exported so the hub side needs one import.
export { isRemotePrincipal };

// ---------------------------------------------------------------------------------------------
// Remote policy (remote.json, rendered by lab-infra, root 0644, read by the hub and the runner).

// enforce (multi-session spec D-MS3): strict for remote principals, see sessionBindingDecision.
export const SESSION_BINDING_MODES = Object.freeze(['warn', 'block', 'enforce']);
export const SOFT_DEADLINE = Object.freeze({ default: 40_000, min: 1_000, max: 120_000 });
const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
// lab-infra lists the remote projects as GitHub repositories (owner/repo, a subset of the
// runner's pilot repositories). The catalog name of a pilot repository is its repository name,
// so `memolabs-dev/memo-bridge` allows the project `memo-bridge`; the coordinator still checks
// that an Issue belongs to the project's real GitHub origin before any claim.
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/([A-Za-z0-9._-]{1,100})$/;
const SUB_RE = /^[A-Za-z0-9._@-]{1,120}$/;
const MAX_PROJECTS = 50;

function projectName(entry) {
  if (typeof entry !== 'string') return null;
  const repo = REPO_RE.exec(entry);
  const name = repo ? repo[1].toLowerCase() : entry;
  return PROJECT_RE.test(name) ? name : null;
}

// Validate the parts of remote.json the runtime uses (lab-infra templates/remote.json.j2):
//   projects            project names or owner/repo entries (REQ-P5-09)
//   session_binding     warn | block | enforce (D8, multi-session D-MS3)
//   remote_writes       enabled | disabled (D7)
//   oidc.owner_sub      the owner's sub: the runtime grants oidc:<owner_sub> from this file
//   budgets.soft_deadline_sec, or soft_deadline_ms
// Unknown keys are ignored here (the hub parses the whole file, bridge/remote-config.mjs); a
// malformed known key throws invalid_remote_policy.
export function parseRemotePolicy(value) {
  if (!plainObject(value)) throw new Error('invalid_remote_policy');
  const projects = value.projects ?? [];
  if (!Array.isArray(projects) || projects.length > MAX_PROJECTS) throw new Error('invalid_remote_policy');
  const names = projects.map(projectName);
  if (names.some(name => name === null)) throw new Error('invalid_remote_policy');
  const binding = value.session_binding ?? 'warn';
  if (!SESSION_BINDING_MODES.includes(binding)) throw new Error('invalid_remote_policy');
  const budgets = value.budgets ?? {};
  if (!plainObject(budgets)) throw new Error('invalid_remote_policy');
  let deadline = value.soft_deadline_ms;
  if (deadline === undefined && budgets.soft_deadline_sec !== undefined) {
    if (!Number.isInteger(budgets.soft_deadline_sec)) throw new Error('invalid_remote_policy');
    deadline = budgets.soft_deadline_sec * 1000;
  }
  deadline ??= SOFT_DEADLINE.default;
  if (!Number.isInteger(deadline) || deadline < SOFT_DEADLINE.min || deadline > SOFT_DEADLINE.max) throw new Error('invalid_remote_policy');
  const macRoute = value.mac_runtime_routing ?? 'disabled';
  if (!['enabled', 'disabled'].includes(macRoute)) throw new Error('invalid_remote_policy');
  const writes = value.remote_writes ?? 'disabled';
  if (!['enabled', 'disabled'].includes(writes)) throw new Error('invalid_remote_policy');
  const oidc = value.oidc ?? {};
  if (!plainObject(oidc)) throw new Error('invalid_remote_policy');
  const ownerSub = oidc.owner_sub ?? value.owner_sub ?? null;
  if (ownerSub !== null && (typeof ownerSub !== 'string' || !SUB_RE.test(ownerSub))) throw new Error('invalid_remote_policy');
  return Object.freeze({ projects: Object.freeze([...new Set(names)]), session_binding: binding,
    soft_deadline_ms: deadline, remote_writes: writes, owner_sub: ownerSub, configured: true,
    ...(macRoute === 'enabled' ? { allow_mac_runtime: true } : {}) });
}

// Without a readable policy every remote project check fails closed (empty allowlist), the
// session binding stays at its default and writes stay disabled.
export const UNCONFIGURED_POLICY = Object.freeze({ projects: Object.freeze([]), session_binding: 'warn',
  soft_deadline_ms: SOFT_DEADLINE.default, remote_writes: 'disabled', owner_sub: null, configured: false });

// MEMO_BRIDGE_REMOTE_CONFIG: absolute path of remote.json. Read once per process.
const loaded = new Map();
export function remotePolicyFromEnv(env = process.env, { readFile = path => readFileSync(path, 'utf8') } = {}) {
  const path = env.MEMO_BRIDGE_REMOTE_CONFIG;
  if (typeof path !== 'string' || !path.startsWith('/')) return UNCONFIGURED_POLICY;
  if (loaded.has(path)) return loaded.get(path);
  let policy;
  try { policy = parseRemotePolicy(JSON.parse(readFile(path))); } catch { policy = UNCONFIGURED_POLICY; }
  loaded.set(path, policy);
  return policy;
}

// The tolerant side of a project reference. An argument may arrive as `drop`, `Drop` or
// `memolabs-dev/drop` (lab-infra writes owner/repo, the catalog uses the bare name, a model may
// send either): they name the same project, so the gate accepts the spelling the caller used and
// the catalog still decides whether the project exists (unknown_project). Policy entries stay
// strict (projectName above): remote.json is configuration, not input.
export function projectRef(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const repo = REPO_RE.exec(trimmed);
  const name = (repo ? repo[1] : trimmed).toLowerCase();
  return PROJECT_RE.test(name) ? name : null;
}

// A refusal must name WHICH condition blocked and, when the answering side knows it, which
// runtime answered: the hub, the VPS runner and the Mac runtime all produce the same codes, and
// a bare `project_not_allowed` left the owner unable to tell them apart (2026-10-18: the Mac
// refused an allowlisted-on-the-VPS project without naming itself).
const HOST_LABEL = Object.freeze({ mac: 'Mac', vps: 'VPS' });
export const runtimeLabel = host => (typeof host === 'string' && HOST_LABEL[host]) || null;
// "the Mac runtime's" / "the VPS runtime's" / "the": the subject of a refusal sentence.
export const scopeOwner = host => {
  const label = runtimeLabel(host);
  return label ? `the ${label} runtime's` : 'the';
};

// null when `principal` may work on `project`, else a refusal. Local and Phase 4 hub principals
// are not limited here (their own catalog is the scope). `host` names the runtime that answers;
// it is used in the detail only and never changes the decision.
export function remoteProjectRefusal(principal, project, policy = UNCONFIGURED_POLICY, { host = null } = {}) {
  if (!isRemotePrincipal(principal)) return null;
  const label = runtimeLabel(host);
  if (!policy?.configured) {
    return fail('project_not_allowed',
      `no remote project allowlist is configured${label ? ` on the ${label} runtime` : ''}`);
  }
  const name = projectRef(project);
  if (name === null) return fail('project_not_allowed', 'the project argument is not a project name');
  if (policy.projects.includes(name)) return null;
  return fail('project_not_allowed',
    `project "${name}" is not in ${scopeOwner(host)} remote project allowlist (${policy.projects.length} allowed)`);
}

// ---------------------------------------------------------------------------------------------
// Protected repository paths (D9). A workflow or action change on a same-repository branch runs
// on CI runners, which is exactly the lab-infra #161 risk; Dependabot configuration can open
// such branches. Compared without case and with trailing dots and spaces ignored per segment:
// on APFS `.GitHub/Workflows/x.yml` is the same file as `.github/workflows/x.yml`.

const fold = segment => segment.replace(/[. ]+$/, '').toLowerCase();
export function isProtectedRepoPath(path) {
  if (typeof path !== 'string') return true;
  const parts = path.split('/').filter(part => part !== '' && part !== '.').map(fold);
  if (parts[0] !== '.github') return false;
  if (parts.length === 1) return false;
  if (parts[1] === 'workflows' || parts[1] === 'actions') return true;
  return parts.length === 2 && ['dependabot.yml', 'dependabot.yaml'].includes(parts[1]);
}
// The protected entries of a list of paths, bounded for an error detail.
export function protectedPaths(paths, max = 10) {
  const hits = paths.filter(isProtectedRepoPath);
  return { count: hits.length, shown: hits.slice(0, max).map(p => String(p).slice(0, 200)) };
}

// ---------------------------------------------------------------------------------------------
// Session binding (D8). `bound` is the hash recorded on the workspace, `presented` the hash of
// the caller's `_meta["openai/session"]` as computed by the hub.
//  - warn (default), block: only two present, different hashes count as a mismatch; an absent
//    session is never a reason to refuse (U-P5-05). block refuses with session_mismatch.
//  - enforce (multi-session D-MS3), for a remote principal: the presented session must be there
//    (session_required otherwise: fail safe) and equal to the bound one; an unbound workspace is
//    another conversation's (workspace_other_session). For any other principal (stdio, the 9443
//    hub principals, which never carry a session) enforce behaves as block: unchanged.
export const CLIENT_SESSION_RE = /^[0-9a-f]{32}$/;
export function sessionBindingDecision(bound, presented, mode = 'warn', { remote = false } = {}) {
  const b = CLIENT_SESSION_RE.test(bound ?? '') ? bound : null;
  const p = CLIENT_SESSION_RE.test(presented ?? '') ? presented : null;
  if (mode === 'enforce' && remote) {
    if (!p) return fail('session_required');
    return b === p ? { ok: true } : fail('workspace_other_session');
  }
  if (!b || !p || b === p) return { ok: true };
  return mode === 'block' || mode === 'enforce' ? fail('session_mismatch') : { ok: true, warning: 'session_mismatch' };
}
// The refusals of the session binding, for the callers' denied-code lists.
export const SESSION_REFUSALS = Object.freeze(['session_mismatch', 'workspace_other_session', 'session_required']);

// A short tag for one conversation (multi-session D-MS2), safe to show to every model: derived
// from the session hash with its own prefix, never the hint, never the binding hash itself.
export function sessionTag(hash) {
  if (!CLIENT_SESSION_RE.test(hash ?? '')) return null;
  return `s${createHash('sha256').update(`memo-bridge/session-tag|${hash}`).digest('hex').slice(0, 6)}`;
}

// Per-request metadata the hub attaches to a forwarded call (bridge/forward.mjs): the session
// hash and the request id. Anything malformed is dropped, never trusted.
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export function requestMeta(value) {
  const meta = plainObject(value) ? value : {};
  return Object.freeze({
    client_session: CLIENT_SESSION_RE.test(meta.client_session ?? '') ? meta.client_session : null,
    request_id: REQUEST_ID_RE.test(meta.request_id ?? '') ? meta.request_id : null
  });
}
// The metadata of a tool handler's second argument: `extra.meta` (runtime operations), never
// the tool arguments.
export const metaFromExtra = extra => requestMeta(plainObject(extra) ? extra.meta : null);

// ---------------------------------------------------------------------------------------------
// D7 layer 2: GitHub Actions runner units running as root.
//
// systemd 257 on the VPS (read 2026-10-14, man systemctl): `show` hides empty properties unless
// --all is given, and an empty User= means the unit runs as root. A pattern given to `show`
// only matches units loaded in memory, so the names come from list-unit-files and
// list-units --all, then `show --all` is asked for each name explicitly. Checked as the hub's
// own user (memo-bridge) with runuser, read-only: the calls work unprivileged.

export const RUNNER_PATTERN = 'actions.runner.*';
const UNIT_RE = /^actions\.runner\.[A-Za-z0-9@._:-]{1,200}\.service$/;
const ACTIVE_STATES = new Set(['active', 'activating', 'reloading', 'deactivating', 'refreshing']);
// An enabled unit starts at the next boot: a root runner that is merely stopped still counts.
const STARTS_ON_BOOT = new Set(['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias', 'static', 'generated', 'transient']);
const MAX_UNITS = 200;

// Default runner: systemctl with a fixed argv, no shell, bounded output and time.
export function runSystemctl(args, { timeoutMs = 5_000 } = {}) {
  return new Promise(resolve => {
    execFile('systemctl', args, { timeout: timeoutMs, maxBuffer: 256 * 1024, env: { PATH: '/usr/bin:/bin', SYSTEMD_PAGER: '', LC_ALL: 'C' } },
      (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: String(stdout ?? '') }));
  });
}

// Unit names from `list-unit-files --no-legend --plain` or `list-units --all --no-legend --plain`
// (first column).
export function parseUnitNames(text) {
  return String(text).split('\n').map(line => line.trim().split(/\s+/)[0]).filter(name => UNIT_RE.test(name ?? ''));
}

// `systemctl show` output: blocks separated by blank lines, KEY=value lines.
export function parseSystemctlShow(text) {
  const units = [];
  for (const block of String(text).split(/\n\s*\n/)) {
    const props = {};
    for (const line of block.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) props[line.slice(0, at)] = line.slice(at + 1);
    }
    if (props.Id) units.push(props);
  }
  return units;
}

export function runsAsRoot(unit) {
  const user = (unit.User ?? '').trim();
  return user === '' || user === 'root' || user === '0';
}
export function rootRunnerRisk(unit) {
  if (!runsAsRoot(unit)) return null;
  if (ACTIVE_STATES.has(unit.ActiveState)) return 'active';
  if (STARTS_ON_BOOT.has(unit.UnitFileState)) return 'enabled';
  return null;
}

// {ok:true, units} when no runner unit runs (or would start) as root; otherwise
// {ok:false, error:'root_runner', units:[{unit, reason}]} or {ok:false, error:'probe_failed'}.
// Every failure to observe is a refusal: the gate fails closed.
export async function checkRunnerUsers({ systemctl = runSystemctl } = {}) {
  const files = await systemctl(['list-unit-files', '--no-legend', '--plain', RUNNER_PATTERN]);
  const loaded = await systemctl(['list-units', '--all', '--no-legend', '--plain', RUNNER_PATTERN]);
  // list-unit-files exits 1 when nothing matches; an empty, successful list-units is the proof.
  if (loaded.code !== 0 || ![0, 1].includes(files.code)) return fail('probe_failed', 'systemctl list');
  const names = [...new Set([...parseUnitNames(files.stdout), ...parseUnitNames(loaded.stdout)])];
  if (names.length > MAX_UNITS) return fail('probe_failed', 'too many runner units');
  if (!names.length) return { ok: true, units: [] };
  const shown = await systemctl(['show', '--all', '-p', 'Id,User,ActiveState,UnitFileState,LoadState', '--', ...names]);
  if (shown.code !== 0) return fail('probe_failed', 'systemctl show');
  const units = parseSystemctlShow(shown.stdout);
  const seen = new Set(units.map(u => u.Id));
  if (names.some(name => !seen.has(name))) return fail('probe_failed', 'unit missing from systemctl show');
  const risky = units.map(u => ({ unit: u.Id, reason: rootRunnerRisk(u) })).filter(u => u.reason);
  return risky.length ? { ok: false, error: 'root_runner', units: risky } : { ok: true, units: units.map(u => u.Id) };
}

// Called by the hub at start-up. With remote_writes enabled, the hub must not start while any
// runner unit runs (or would start) as root, or when that cannot be established. Throws
// write_gate_refused; returns the probe result otherwise ({skipped:true} when writes are off).
export async function assertWriteGate(policy, { systemctl = runSystemctl } = {}) {
  if (policy?.remote_writes !== 'enabled') return { ok: true, skipped: true };
  const probe = await checkRunnerUsers({ systemctl });
  if (!probe.ok) {
    const error = new Error('write_gate_refused');
    error.code = probe.error;
    error.units = probe.units ?? [];
    throw error;
  }
  return probe;
}
