import { planAutomaticOnboarding } from './onboarding-auto.mjs';

// Trusted coordinator entry point. Auto-enrollment is opt-in ONCE at organization scope.
// A GitHub webhook or untrusted repository cannot flip that switch. A scoped App token,
// canonical catalog membership and a verified manifest on main are still mandatory.
export function ownerApprovedPolicy({ policy, change, proofs }) {
  if (!policy || !change?.ok || policy.org !== change.org) return null;
  const explicit = Array.isArray(policy.enrolledRepositories) ? policy.enrolledRepositories : [];
  if (policy.orgWideAutoEnrollment !== true) return {
    ...policy, enrolledRepositories: explicit
  };
  const excluded = new Set(policy.excludedRepositories ?? []);
  const implicit = change.repositories
    .filter(r => {
      const repo = r.fullName, p = proofs?.[repo];
      return !excluded.has(repo) && p?.repositoryId === r.repositoryId &&
        p?.fullName === repo && p?.private === true &&
        p?.defaultBranch === 'main' && p?.manifestVerified === true &&
        p?.installationAccess === true &&
        p?.installationId === change.installationId;
    })
    .map(r => r.fullName);
  return { ...policy, enrolledRepositories: [...new Set([...explicit, ...implicit])] };
}

// Transactional effect adapter contract:
// reserve(key) -> Boolean (false when already applied or in flight)
// propose(action) -> must open or discover ONE reviewed PR, never merge/deploy/grant access
// finish(key,receipt) -> record durable receipt; fail(key,error) -> allow a later retry.
// No dynamic commands are executed by this module. Hosts implement the adapter from
// an approved service with narrow repo-scoped GitHub App credentials.
export async function reconcileAutoOnboarding({
  change, policy, catalog, proofs, completed = [], adapter, dryRun = true
} = {}) {
  const trustedPolicy = ownerApprovedPolicy({ policy, change, proofs });
  const plan = planAutomaticOnboarding({ change, trustedPolicy, catalog, proofs, completed });
  if (!plan.ok || dryRun || !adapter) return { ...plan, dry_run: true, executions: [] };
  if (typeof adapter.reserve !== 'function' || typeof adapter.propose !== 'function' ||
      typeof adapter.finish !== 'function' || typeof adapter.fail !== 'function')
    return { ok: false, error: 'invalid_effect_adapter', actions: [] };
  const executions = [];
  const permitted = new Set(['propose_governance_pr', 'propose_runner_pr',
    'propose_landing_pr', 'verify_activation']);
  for (const row of plan.next) {
    for (const action of row.actions) {
      // Runtime recheck before every side effect; no grant, merge or root operations here.
      if (!permitted.has(action.operation) || action.repository !== row.repository ||
          row.stop_new_work === false && action.operation !== 'verify_activation') {
        executions.push({ key: action.key, status: 'refused' });
        continue;
      }
      const reserved = await adapter.reserve(action.key);
      if (!reserved) { executions.push({ key: action.key, status: 'already_recorded' }); continue; }
      try {
        const receipt = await adapter.propose(Object.freeze({ ...action }));
        if (!receipt || typeof receipt.id !== 'string' ||
            !/^[a-zA-Z0-9._:/-]{1,180}$/.test(receipt.id)) throw new Error('invalid_receipt');
        await adapter.finish(action.key, receipt);
        executions.push({ key: action.key, status: 'proposed', receipt: receipt.id });
      } catch {
        await adapter.fail(action.key, 'proposal_failed');
        executions.push({ key: action.key, status: 'retryable_error' });
      }
    }
  }
  return { ...plan, dry_run: false, executions };
}
