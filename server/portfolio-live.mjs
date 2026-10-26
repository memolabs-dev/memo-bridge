import { rankPortfolio } from './portfolio.mjs';

// Live authenticated reads use the existing GitHub integration and its registered-repo scope.
// The paginated portfolioPages API is preferred; a one-page fallback may be incomplete.
async function fetchProject(project, github, limit, issues, prs, errors, observed) {
  const origin = await github.projectRepo(project.name).catch(() => null);
  if (!origin) {
    errors.push({ project: project.name, error: 'origin_unavailable' });
    return;
  }
  const resolved = await github.resolveRepo(origin).catch(() => null);
  if (!resolved?.ok) {
    errors.push({ project: project.name, error: resolved?.error ?? 'repo_unavailable' });
    return;
  }
  const repo = resolved.repo;
  let resultIssue, resultPR;
  try {
    [resultIssue, resultPR] = await Promise.all([
      github.portfolioPages
        ? github.portfolioPages(repo, { kind: 'issues' })
        : github.issues(repo, { state: 'open', limit }),
      github.portfolioPages
        ? github.portfolioPages(repo, { kind: 'pulls' })
        : github.pullRequests(repo, { state: 'open', limit }),
    ]);
  } catch {
    errors.push({ project: project.name, repo: repo.full, error: 'github_unavailable' });
    return;
  }
  if (!resultIssue?.ok || !resultPR?.ok) {
    errors.push({
      project: project.name,
      repo: repo.full,
      error: resultIssue?.error ?? resultPR?.error ?? 'github_unavailable',
    });
    return;
  }
  if (!github.portfolioPages && (resultIssue.count >= limit || resultPR.count >= limit)) {
    errors.push({ project: project.name, repo: repo.full, error: 'possibly_truncated' });
  }
  const issueRows = (resultIssue.items ?? resultIssue.issues) ?? [];
  const pullRows = (resultPR.items ?? resultPR.pull_requests) ?? [];
  for (const item of issueRows) {
    const labels = item.labels ?? [];
    const priority = ['p0', 'p1', 'p2'].find(p => labels.includes('priority:' + p)) ?? null;
    issues.push({
      repo: repo.full, number: item.number, title: item.title, url: item.url,
      state: item.state, priority, ready: labels.includes('agent:ready'),
      blocked: labels.includes('blocked') || labels.includes('status:blocked'),
      claimed: labels.includes('agent:claimed'),
      created_at: item.created_at ?? item.updated_at, labels,
    });
  }
  for (const item of pullRows) {
    prs.push({
      repo: repo.full, number: item.number, title: item.title, url: item.url,
      state: item.state, draft: item.draft, created_at: item.updated_at, merged_at: null,
    });
  }
  observed.push({
    project: project.name, repo: repo.full,
    issue_count: issueRows.length, pr_count: pullRows.length,
  });
}

export async function livePortfolio({ projects, github, allowedProjects = null, limit = 100, concurrency = 4 }) {
  const issues = [], prs = [], errors = [], observed = [];
  const allowed = allowedProjects === null ? null : new Set(allowedProjects);
  const candidates = (projects ?? []).filter(p =>
    p.kind === 'repo' && p.available && (!allowed || allowed.has(p.name)));
  // Bound caller inputs to protect GitHub rate limits and the operator's laptop.
  const requested = Number(concurrency);
  const cap = Number.isFinite(requested) ? Math.min(8, Math.max(1, Math.floor(requested))) : 4;
  for (let index = 0; index < candidates.length; index += cap) {
    await Promise.all(candidates.slice(index, index + cap).map(
      project => fetchProject(project, github, limit, issues, prs, errors, observed),
    ));
  }
  observed.sort((a, b) => a.project.localeCompare(b.project));
  errors.sort((a, b) => String(a.project ?? '').localeCompare(String(b.project ?? '')));
  return {
    ...rankPortfolio({ issues, prs, errors }),
    observed_projects: observed,
    unobserved_projects: candidates.length - observed.length,
    scope: 'registered_available_repositories_only',
  };
}
