import { loadTrustedEnrollmentPolicy } from './onboarding-policy.mjs';
import { reconcileAutoOnboarding } from './onboarding-auto-worker.mjs';

// Production wiring should use this entry point, not user-provided policy objects.
// Config paths are fixed by deployment; event content cannot supply or change them.
export async function reconcileWithHostPolicy({
  configPath, trustedRoot, change, catalog, proofs, completed = [],
  adapter, dryRun = true
} = {}) {
  let trusted;
  try {
    trusted = await loadTrustedEnrollmentPolicy({ configPath, trustedRoot });
  } catch {
    return { ok: false, error: 'trusted_policy_unavailable', actions: [], dry_run: true };
  }
  const result = await reconcileAutoOnboarding({
    change, policy: trusted.policy, catalog, proofs, completed, adapter, dryRun
  });
  return { ...result, policy_revision: trusted.revision };
}
