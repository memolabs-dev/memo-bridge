// Owner-local enrollment shared by installation and automatic reconciliation (#312).
import { execFile } from 'node:child_process';
export const REPO_RE = /^(?:memolabs-dev|guillaume-flambard)\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
export const MAX_REPOS = 100;
const ORIGIN_RE = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
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
export async function enroll({ projects, explicit = [], fromRegistry = false, allOwnerProjects = false, origin, visibility }) {
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
    const repo = await origin(p.path);
    if (!repo) {
      if (allOwnerProjects) skipped.push({ name: p.name, reason: 'origin_unverified' });
      continue;
    }
    if (!REPO_RE.test(repo)) continue;
    if (!fromRegistry && !allOwnerProjects && !wanted.has(repo.toLowerCase())) continue;
    if (!PROJECT_RE.test(p.name)) { skipped.push({ name: p.name, reason: 'project_name_invalid' }); continue; }
    if (chosen.has(repo.toLowerCase()) || publicChosen.has(repo.toLowerCase())) {
      skipped.push({ name: p.name, reason: 'origin_already_enrolled' }); continue;
    }
    const seen = await visibility(repo);
    if (!seen) { skipped.push({ name: p.name, reason: 'github_unverified' }); continue; }
    if (seen.archived) { skipped.push({ name: p.name, reason: 'archived' }); continue; }
    if (!seen.private) {
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

