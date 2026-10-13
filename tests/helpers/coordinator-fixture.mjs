import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCoordinator } from '../../server/coordinator/index.mjs';
import { createIssueLeaseClient, defaultGovernanceRoot } from '../../server/coordinator/issue-lease.mjs';
import { CAPABILITIES, makePrincipal } from '../../server/coordinator/policy.mjs';
import { openSqliteStore } from '../../server/coordinator/store.mjs';

export const OWNER = makePrincipal('local:owner', Object.values(CAPABILITIES));
export const FAKE_GH_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fake-gh');

// The canonical ledger script from memolabs-dev/.github. CI checks it out and sets
// MEMO_BRIDGE_REQUIRE_GOVERNANCE=1 so a missing ledger fails instead of skipping.
export const GOVERNANCE_ROOT = defaultGovernanceRoot();
export const HAS_GOVERNANCE = existsSync(join(GOVERNANCE_ROOT, 'scripts', 'issue_lease.py'));
if (!HAS_GOVERNANCE && process.env.MEMO_BRIDGE_REQUIRE_GOVERNANCE === '1') {
  throw new Error(`issue_lease.py not found under ${GOVERNANCE_ROOT}`);
}
export const skipWithoutLedger = HAS_GOVERNANCE ? false : 'memolabs-dev/.github checkout not found (set MEMO_BRIDGE_GOVERNANCE_ROOT)';

export const PROJECT_ORIGINS = { drop: 'memolabs-dev/drop', cuesheet: 'memolabs-dev/cuesheet' };

export function stubProjects(repos = {}) {
  const known = new Set(['drop', 'cuesheet', 'unknown-origin', ...Object.keys(repos)]);
  return async name => {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(name)) return { ok: false, error: 'invalid_project_name' };
    if (!known.has(name)) return { ok: false, error: 'unknown_project' };
    return { ok: true, project: { name, repoPath: repos[name] ?? null } };
  };
}
const stubRemote = project => Promise.resolve(PROJECT_ORIGINS[project.name] ?? null);

export async function tempDir(t, prefix = 'memo-coordinator-') {
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
    // Simulate the passage of time: move every stored lease expiry into the past.
    async expireAll() {
      const state = JSON.parse(await readFile(file, 'utf8'));
      for (const commit of Object.values(state.commits)) {
        if (!commit.message.startsWith('MEMO_STAR_LEASE_V1\n')) continue;
        const record = JSON.parse(commit.message.slice('MEMO_STAR_LEASE_V1\n'.length));
        record.expires_at = '2000-01-01T00:00:00+00:00';
        commit.message = 'MEMO_STAR_LEASE_V1\n' + JSON.stringify(record, Object.keys(record).sort()).replace(/":/g, '":').replace(/,"/g, ',"');
      }
      await writeFile(file, JSON.stringify(state));
    },
    async editIssue(ref, patch) {
      const state = JSON.parse(await readFile(file, 'utf8'));
      state.issues[ref] = { ...state.issues[ref], ...patch };
      await writeFile(file, JSON.stringify(state));
    }
  };
}

export function ledgerFor(github, root = GOVERNANCE_ROOT) {
  return createIssueLeaseClient({ root, env: github.env, timeoutMs: 30000 });
}

export function coordinatorOn(stateDir, { principal = OWNER, now = Date.now, repos, ledger } = {}) {
  const store = openSqliteStore({ dir: stateDir });
  const coordinator = createCoordinator({ store, principal, now, ledger, resolveProject: stubProjects(repos),
    projectRemote: stubRemote, host: 'mac' });
  return { store, coordinator };
}
