// Explicit lifecycle policy for Git worktrees, separate from agent/session identity.
// Unknown entries are never eligible for automatic removal.
export const MODES = Object.freeze(['persistent', 'ephemeral', 'shared']);
export function classifyWorktree({ project, branch, policy }) {
  if (!policy || policy.version !== 1 || !Array.isArray(policy.entries)) {
    return { mode: 'unclassified', reason: 'policy_missing_or_invalid' };
  }
  const matching = policy.entries.filter(e => e && e.project === project &&
    (e.branch === branch || e.branch === '*') && MODES.includes(e.mode));
  const specific = matching.filter(e => e.branch === branch);
  const candidates = specific.length ? specific : matching;
  if (candidates.length !== 1) return { mode: 'unclassified', reason: candidates.length ? 'policy_ambiguous' : 'policy_not_matched' };
  return { mode: candidates[0].mode, reason: 'policy_match' };
}
export function lifecycleDecision({ classification, cleanup }) {
  if (classification.mode === 'persistent' || classification.mode === 'shared') {
    return { action: 'keep', reason: classification.mode + '_workspace', mode: classification.mode };
  }
  if (classification.mode !== 'ephemeral') {
    return { action: 'keep', reason: classification.reason || 'unclassified', mode: 'unclassified' };
  }
  return { ...cleanup, mode: 'ephemeral' };
}
