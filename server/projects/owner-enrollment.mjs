// Owner-local enrollment shared by installation and automatic reconciliation (#312).
import { execFile } from 'node:child_process';
export const REPO_RE = /^(?:memolabs-dev|guillaume-flambard)\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
export const MAX_REPOS = 100;
const ORIGIN_RE = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
const run = (cmd, args, opts = {}) => new Promise(resolve => {
  execFile(cmd, args, { timeout: 25_000, maxBuffer: 256 * 1024, ...opts }, (error, stdout, stderr) =>
    resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
});

// A test may inject a bare stdout, or its own {code, stdout, stderr}. Normalize both to {ok}.
const asRun = value => (typeof value === 'string' ? { ok: true, stdout: value, stderr: '' }
  : value && typeof value === 'object' && typeof value.ok === 'boolean' ? value
  : value && typeof value === 'object' && typeof value.code === 'number'
    ? { ok: value.code === 0, stdout: String(value.stdout ?? ''), stderr: String(value.stderr ?? '') }
  : { ok: false, stdout: '', stderr: '' });

// A checkout without an owner origin cannot be enrolled, and that is a stable fact, not a
// failure: the registry legitimately carries client projects, forks and local pilots. Only a
// git or GitHub failure that answers nothing about the repository is inconclusive (#312).
export const NOT_OWNER_ORIGIN = Object.freeze({ reason: 'not_owner_origin' });
export const ORIGIN_UNAVAILABLE = Object.freeze({ reason: 'origin_unavailable' });
export const REPO_ABSENT = Object.freeze({ reason: 'repo_absent' });
export const GITHUB_UNAVAILABLE = Object.freeze({ reason: 'github_unavailable' });

// {repo} when the origin is an owner namespace, else a conclusive or inconclusive reason.
export async function gitOriginStatus(path, { git = run } = {}) {
  const r = asRun(await git('git', ['-C', path, 'remote', 'get-url', 'origin'], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }));
  if (!r.ok) return /No such remote/i.test(r.stderr) ? NOT_OWNER_ORIGIN : ORIGIN_UNAVAILABLE;
  const match = ORIGIN_RE.exec(r.stdout.trim());
  return match ? { repo: `${match[1]}/${match[2]}` } : NOT_OWNER_ORIGIN;
}

// A 404, or an API answer naming another repository, proves what this path is not: conclusive.
// Authentication, network, rate-limit and malformed answers prove nothing: inconclusive.
const DEFINITE_ABSENCE = /HTTP 404|Could not resolve to a Repository|Not Found/i;

// {visibility:{private,archived}} or a conclusive/inconclusive reason.
export async function githubVisibilityStatus(repo, { gh = run } = {}) {
  const r = asRun(await gh('gh', ['api', '-X', 'GET', `repos/${repo}`, '--jq', '{full_name, private, archived}'],
    { env: { ...process.env, GH_PROMPT_DISABLED: '1' } }));
  if (!r.ok) return DEFINITE_ABSENCE.test(r.stderr) ? REPO_ABSENT : GITHUB_UNAVAILABLE;
  try {
    const value = JSON.parse(r.stdout);
    if (typeof value?.private !== 'boolean' || typeof value?.archived !== 'boolean') return GITHUB_UNAVAILABLE;
    // A transferred or renamed repository answers 200 with another full_name: its old path no
    // longer designates it, so the checkout's origin is stale, not unverifiable.
    if (value.full_name?.toLowerCase() !== repo.toLowerCase()) return REPO_ABSENT;
    return { visibility: { private: value.private, archived: value.archived } };
  } catch { return GITHUB_UNAVAILABLE; }
}

// owner/repo of a checkout's origin, or null.
export const gitOrigin = async (path, opts) => (await gitOriginStatus(path, opts)).repo ?? null;

// {private, archived} as GitHub answers for the owner's own gh login, or null.
export const githubVisibility = async (repo, opts) => (await githubVisibilityStatus(repo, opts)).visibility ?? null;

// {ok:true, projects:[{name, repo}], skipped:[{name, reason}]} or {ok:false, error, detail}.
// Injected origin/visibility may answer the status shapes above, or the legacy ones a test or a
// caller already uses: a string, a null (inconclusive) or {private, archived}.
const asOrigin = value => (typeof value === 'string' ? { repo: value } : value && typeof value === 'object' ? value : ORIGIN_UNAVAILABLE);
const asVisibility = value => (!value || typeof value !== 'object' ? GITHUB_UNAVAILABLE
  : 'reason' in value || 'visibility' in value ? value : { visibility: value });

export async function enroll({ projects, explicit = [], fromRegistry = false, allOwnerProjects = false,
  origin = path => gitOriginStatus(path), visibility = repo => githubVisibilityStatus(repo) }) {
  for (const repo of explicit) if (!REPO_RE.test(repo)) return { ok: false, error: 'invalid_repo', detail: repo };
  const wanted = new Set(explicit.map(r => r.toLowerCase()));
  const chosen = new Map();
  const publicChosen = new Map();
  const skipped = [];
  for (const p of projects) {
    if (p.kind !== 'repo') continue;
    if (!p.available || !p.path) {
      if (allOwnerProjects) skipped.push({ name: p.name, reason: 'checkout_unavailable' });
      continue;
    }
    const seenOrigin = asOrigin(await origin(p.path));
    if (seenOrigin.reason === 'not_owner_origin') {
      if (allOwnerProjects) skipped.push({ name: p.name, reason: 'not_owner_origin' });
      continue;
    }
    if (!seenOrigin.repo) {
      if (allOwnerProjects) skipped.push({ name: p.name, reason: 'origin_unverified' });
      continue;
    }
    const repo = seenOrigin.repo;
    // An origin outside the owner namespaces (a fork, a client clone) is conclusive: it cannot
    // be enrolled, and a project that used to point into an owner namespace must be refused as
    // a revoke rather than dropped silently.
    if (!REPO_RE.test(repo)) {
      if (allOwnerProjects) skipped.push({ name: p.name, reason: 'not_owner_origin' });
      continue;
    }
    if (!fromRegistry && !allOwnerProjects && !wanted.has(repo.toLowerCase())) continue;
    if (!PROJECT_RE.test(p.name)) { skipped.push({ name: p.name, reason: 'project_name_invalid' }); continue; }
    if (chosen.has(repo.toLowerCase()) || publicChosen.has(repo.toLowerCase())) {
      skipped.push({ name: p.name, reason: 'origin_already_enrolled' }); continue;
    }
    const seen = asVisibility(await visibility(repo));
    if (seen.reason === 'repo_absent') { skipped.push({ name: p.name, reason: 'repo_absent' }); continue; }
    if (!seen.visibility) { skipped.push({ name: p.name, reason: 'github_unverified' }); continue; }
    if (seen.visibility.archived) { skipped.push({ name: p.name, reason: 'archived' }); continue; }
    if (!seen.visibility.private) {
      // Public repositories require the owner opt-in: one --repo or --all-owner-projects.
      if (allOwnerProjects || wanted.has(repo.toLowerCase())) publicChosen.set(repo.toLowerCase(), { name: p.name, repo });
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

