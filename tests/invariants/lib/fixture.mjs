// Self-contained fixture for the invariant tests. Invariants import only this directory and
// production code (server/, bridge/), never tests/helpers/: the ratchet freezes these files.
// Copied from tests/helpers/coordinator-fixture.mjs and memory-ledger.mjs, then extended where an
// invariant needs more (a lease store shared by two ledgers that read different clocks, a git
// project with a bare origin, a gh stub).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCoordinator } from '../../../server/coordinator/index.mjs';
import { createIssueLeaseClient, defaultGovernanceRoot } from '../../../server/coordinator/issue-lease.mjs';
import { CAPABILITIES, makePrincipal } from '../../../server/coordinator/policy.mjs';
import { openSqliteStore } from '../../../server/coordinator/store.mjs';
import { createRuntime } from '../../../server/runtime.mjs';
import { registerWorktreeTools } from '../../../server/tools/worktree-tools.mjs';
import { registerGithubTools } from '../../../server/tools/github-tools.mjs';

export const OWNER = makePrincipal('local:owner', Object.values(CAPABILITIES));
// The offline `gh` used by fakeGitHub (a copy of tests/helpers/fake-gh; the canonical ledger script runs against it).
export const FAKE_GH_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fake-gh');

// The canonical ledger script from memolabs-dev/.github. CI checks it out and sets
// MEMO_BRIDGE_REQUIRE_GOVERNANCE=1 so a missing ledger fails instead of skipping.
export const GOVERNANCE_ROOT = defaultGovernanceRoot();
export const HAS_GOVERNANCE = Boolean(GOVERNANCE_ROOT) && existsSync(join(GOVERNANCE_ROOT, 'scripts', 'issue_lease.py'));
if (!HAS_GOVERNANCE && process.env.MEMO_BRIDGE_REQUIRE_GOVERNANCE === '1') {
  throw new Error(`issue_lease.py not found under ${GOVERNANCE_ROOT}`);
}
export const skipWithoutLedger = HAS_GOVERNANCE ? false : 'memolabs-dev/.github checkout not found (set MEMO_BRIDGE_GOVERNANCE_ROOT)';

export const PROJECT_ORIGINS = { drop: 'memolabs-dev/drop', cuesheet: 'memolabs-dev/cuesheet' };

function stubProjects(repos = {}) {
  const known = new Set(['drop', 'cuesheet', 'unknown-origin', ...Object.keys(repos)]);
  return async name => {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(name)) return { ok: false, error: 'invalid_project_name' };
    if (!known.has(name)) return { ok: false, error: 'unknown_project' };
    return { ok: true, project: { name, repoPath: repos[name] ?? null } };
  };
}
const stubRemote = project => Promise.resolve(PROJECT_ORIGINS[project.name] ?? null);

export async function tempDir(t, prefix = 'memo-invariant-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t?.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}
export async function tempStateDir(t) {
  return join(await tempDir(t), 'state');
}

// A fresh offline GitHub: an empty ledger repository and the given Issues.
export async function fakeGitHub(t, issues = {}) {
  const file = join(await tempDir(t, 'memo-fake-gh-'), 'github.json');
  const root = 'f'.repeat(40);
  const defaults = { 'memolabs-dev/drop#7': {}, 'memolabs-dev/cuesheet#3': {} };
  await writeFile(file, JSON.stringify({
    refs: { 'refs/heads/main': root },
    commits: { [root]: { message: 'root', tree: { sha: 'e'.repeat(40) }, parents: [] } },
    issues: { ...defaults, ...issues }
  }));
  return {
    file,
    env: { ...process.env, PATH: `${FAKE_GH_DIR}:${process.env.PATH}`, FAKE_GH_STATE: file },
    async state() { return JSON.parse(await readFile(file, 'utf8')); }
  };
}

export function ledgerFor(github, root = GOVERNANCE_ROOT) {
  return createIssueLeaseClient({ root, env: github.env, timeoutMs: 30000 });
}

// `tasks` overrides the tasks_list sources so no test reads the real catalog, governance
// checkout or GitHub.
export function coordinatorOn(stateDir, { principal = OWNER, now = Date.now, repos, ledger, tasks = {} } = {}) {
  const store = openSqliteStore({ dir: stateDir });
  const coordinator = createCoordinator({ store, principal, now, ledger, resolveProject: stubProjects(repos),
    projectRemote: stubRemote, host: 'mac',
    listProjectRepos: async () => Object.keys(PROJECT_ORIGINS).map(name => ({ name, repoPath: null })),
    readAllowlist: async () => ({ ok: true, repos: ['memolabs-dev/drop', 'memolabs-dev/cuesheet'] }),
    searchIssues: async () => ({ ok: false, error: 'github_unavailable', detail: 'not stubbed' }),
    ...tasks });
  return { store, coordinator };
}

// An in-memory lease ledger with the contract of scripts/issue_lease.py: one live lease per
// Issue, check and write in one step, an expired lease can be claimed again. Unlike the script
// it takes an injected clock, which is what lets a test put two machines 30 s apart. Two ledgers
// built on one `leases` Map are two machines reading the same GitHub with their own clocks.
export function memoryLedger(clock, leases = new Map()) {
  const tick = () => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 3)));
  const view = l => ({ ...l, expired: l.state === 'claimed' && Date.parse(l.expires_at) <= clock() });
  const unclaimed = { state: 'unclaimed', expired: false, worker: null, claim_id: null, fence_sha: null, epoch: null, expires_at: null };
  const owned = (issue, worker, claimId, fence) => {
    const l = leases.get(issue.ref);
    return l && l.state === 'claimed' && l.worker === worker && l.claim_id === claimId && l.fence_sha === fence &&
      Date.parse(l.expires_at) > clock() ? l : null;
  };
  return {
    leases,
    claims: 0,
    async status(issue) { await tick(); const l = leases.get(issue.ref); return { ok: true, receipt: l ? view(l) : unclaimed }; },
    async claim(issue, worker, ttl) {
      await tick();
      this.claims += 1;
      const l = leases.get(issue.ref);
      if (l && l.state === 'claimed' && Date.parse(l.expires_at) > clock()) return { ok: false, error: 'lease_held', detail: 'Active lease exists' };
      const r = { state: 'claimed', worker, claim_id: randomBytes(16).toString('hex'), fence_sha: randomBytes(20).toString('hex'),
        epoch: (l?.epoch ?? 0) + 1, expires_at: new Date(clock() + ttl * 1000).toISOString() };
      leases.set(issue.ref, r);
      return { ok: true, receipt: view(r) };
    },
    async verify(issue, worker, claimId, fence) {
      await tick(); const l = owned(issue, worker, claimId, fence);
      return l ? { ok: true, receipt: view(l) } : { ok: false, error: 'stale_lease' };
    },
    async heartbeat(issue, worker, claimId, fence, ttl) {
      await tick(); const l = owned(issue, worker, claimId, fence);
      if (!l) return { ok: false, error: 'stale_lease' };
      Object.assign(l, { fence_sha: randomBytes(20).toString('hex'), expires_at: new Date(clock() + ttl * 1000).toISOString() });
      return { ok: true, receipt: view(l) };
    },
    async release(issue, worker, claimId, fence) {
      await tick(); const l = owned(issue, worker, claimId, fence);
      if (!l) return { ok: false, error: 'stale_lease' };
      Object.assign(l, { state: 'released', fence_sha: randomBytes(20).toString('hex') });
      return { ok: true, receipt: view(l) };
    }
  };
}

// Git must never read the user's own configuration (identity, signing, hooks) in these tests.
export async function isolateGit(t) {
  const dir = await mkdtemp(join(tmpdir(), 'memo-invariant-gitconfig-'));
  await writeFile(join(dir, 'gitconfig'), ['[user]', '\tname = Test Owner', '\temail = owner@example.test',
    '[init]', '\tdefaultBranch = main', '[commit]', '\tgpgsign = false', '[tag]', '\tgpgsign = false', ''].join('\n'));
  process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE']) {
    delete process.env[name];
  }
  t?.after(() => rm(dir, { recursive: true, force: true }));
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const DEMO_ISSUE = 'memolabs-dev/demo#7';
const REGISTRY = `# Projects

## Projets appartenant a Memo Labs

| Name | Path | Kind | Status | Nature | Stack | Vault |
|---|---|---|---|---|---|---|
| demo | demo | repo | active | test project | node | - |
`;

// A runtime on a registered git project `demo` with a bare origin, an injected clock and ledger,
// and the worktree and GitHub tools on a fake MCP server. `gh` answers GitHub's API.
export async function gitRuntime(t, { ledger, now, gh }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'memo-invariant-git-')));
  const projectsRoot = join(base, 'projects');
  const repo = join(projectsRoot, 'demo');
  await mkdir(repo, { recursive: true });
  await writeFile(join(projectsRoot, 'PROJECTS.md'), REGISTRY);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  const origin = join(base, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  process.env.MEMO_BRIDGE_WORKTREES_ROOT = join(base, 'worktrees');

  const rt = createRuntime({ stateDir: join(base, 'state'), principal: OWNER, ledger, catalogOptions: { projectsRoot }, host: 'mac', now,
    projectRemote: async () => 'memolabs-dev/demo' });
  t.after(async () => { await rt.close(); await rm(base, { recursive: true, force: true }); });
  const tools = new Map();
  const server = { registerTool(name, def, handler) { tools.set(name, { def, handler }); } };
  registerWorktreeTools(server, () => rt);
  registerGithubTools(server, () => rt, { gh, registeredRepos: async () => ['memolabs-dev/demo'], projectRepo: async () => 'memolabs-dev/demo' });
  const call = async (name, args = {}) => {
    const { def, handler } = tools.get(name);
    const response = await handler(def.inputSchema.parse(args));
    return JSON.parse(response.content[0].text);
  };
  return { rt, call, coordinator: rt.coordinator(), origin };
}

// A recording `gh` stub for github_create_pr on memolabs-dev/demo: default branch main, no open
// pull request, one POST creates #42.
export function demoGh() {
  const calls = [];
  const SHA = 'c'.repeat(40);
  let created = null;
  const out = data => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
  const gh = async (args, opts = {}) => {
    const method = args[args.indexOf('-X') + 1];
    const endpoint = args.find(a => /^repos\//.test(a)) ?? '';
    calls.push({ method, endpoint });
    if (method === 'GET' && endpoint === 'repos/memolabs-dev/demo') return out({ full_name: 'memolabs-dev/demo', default_branch: 'main' });
    if (method === 'GET' && /^repos\/memolabs-dev\/demo\/pulls\?state=open&head=/.test(endpoint)) return out(created ? [created] : []);
    if (method === 'POST' && endpoint === 'repos/memolabs-dev/demo/pulls') {
      const payload = JSON.parse(opts.input);
      created = { number: 42, title: payload.title, state: 'open', draft: payload.draft, user: { login: 'guillaume' },
        head: { ref: payload.head, sha: SHA }, base: { ref: payload.base }, html_url: 'https://github.com/memolabs-dev/demo/pull/42' };
      return out(created);
    }
    return { code: 1, stdout: '{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)' };
  };
  return { gh, calls };
}
