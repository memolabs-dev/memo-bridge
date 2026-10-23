// Read-only GitHub onboarding evidence. This is a report, NOT permission to run or merge.
// A personal gh session cannot attest the GitHub App installation's selected repo access.
export const ONBOARDING_TARGETS = Object.freeze({
  'rebuild-radar': { repo: 'memolabs-dev/rebuild-radar', requiredCheck: 'validate' },
  'mobile-explorer': { repo: 'memolabs-dev/mobile-explorer', requiredCheck: 'swift-build' }
});
const SHA_RE = /^[0-9a-f]{40}$/;
export function assessGithubOnboarding(name, { metadata, pull, checks, landingFile, installations } = {}) {
  const target = ONBOARDING_TARGETS[name];
  if (!target) throw new Error('unknown_product');
  const repo = target.repo;
  const repoVerified = metadata?.full_name === repo && metadata?.private === true &&
    metadata?.archived === false && metadata?.default_branch === 'main';
  const prVerified = repoVerified && pull?.number === 1 && pull?.base?.ref === 'main' &&
    pull?.head?.repo?.full_name === repo && SHA_RE.test(pull?.head?.sha ?? '') &&
    (pull?.state === 'open' || pull?.merged_at != null);
  const sha = prVerified ? pull.head.sha : null;
  const records = Array.isArray(checks?.check_runs) ? checks.check_runs : [];
  const matching = sha ? records.filter(c => c?.name === target.requiredCheck && c?.head_sha === sha) : [];
  const ciPassed = matching.length > 0 && matching.every(c =>
    c.status === 'completed' && c.conclusion === 'success');
  const workflowPresent = landingFile?.type === 'file' && landingFile?.name === 'land.yml';
  const installed = Array.isArray(installations?.installations) ?
    installations.installations.find(x => x?.app_slug === 'memo-labs-automation') : null;
  const selection = installed?.repository_selection === 'all' || installed?.repository_selection === 'selected'
    ? installed.repository_selection : 'unverified';
  // Installation visibility never proves access to this specific repository or its permissions.
  const needs = [
    ...(!repoVerified ? ['repository_metadata_not_verified'] : []),
    ...(!prVerified ? ['pull_request_not_verified'] : []),
    ...(prVerified && !ciPassed ? ['required_check_not_green_for_pr_sha'] : []),
    ...(!workflowPresent ? ['landing_workflow_missing_or_unverified'] : []),
    ...(selection === 'selected' ? ['github_app_selected_repo_access_unverified'] :
      selection === 'unverified' ? ['github_app_installation_unverified'] : [])
  ];
  return {
    schema: 'memo-bridge.product-github-onboarding.v1',
    name, repo, visibility: repoVerified ? 'private' : 'unverified',
    pr: { number: 1, state: prVerified ? (pull.merged_at ? 'merged' : 'open') : 'unverified',
      head_sha: sha },
    required_check: target.requiredCheck, ci_passed_for_exact_sha: Boolean(ciPassed),
    landing_workflow_present: Boolean(workflowPresent),
    github_app_installation_selection: selection,
    github_app_access_verified: false,
    coordinator_execution_authorized: false,
    landing_authorized: false,
    blockers: needs,
    note: 'Read-only observational evidence. The separate registry, lease allowlist, App token and landing policy gates remain authoritative.'
  };
}
