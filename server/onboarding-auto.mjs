import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

// A reconciliation controller, deliberately free from host, Git or GitHub side effects.
// A trusted worker can implement the returned bounded, idempotent actions after validating
// its own scoped installation token. It cannot use webhook content as a permission grant.
const REPO = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SHA = /^[a-f0-9]{40}$/;
const MAX_TARGETS = 50;
const ALLOWED_STAGES = Object.freeze(['governance', 'runner', 'landing', 'ready']);
const OPERATIONS = new Set(['propose_governance_pr', 'propose_runner_pr', 'propose_landing_pr', 'verify_activation']);

function sha(data) { return createHash('sha256').update(data).digest('hex').slice(0,24); }
function fail(reason) { return { ok: false, error: reason, actions: [] }; }

export function verifyInstallationWebhook({ payloadBytes, signature, secret } = {}) {
  if (!(Buffer.isBuffer(payloadBytes) || typeof payloadBytes === 'string') ||
      typeof secret !== 'string' || secret.length < 16 ||
      typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(payloadBytes).digest();
  const received = Buffer.from(signature.slice(7), 'hex');
  return received.length === expected.length && timingSafeEqual(expected, received);
}

export function extractInstallationChanges({ event, payload, signatureVerified, org = 'memolabs-dev' } = {}) {
  if (!signatureVerified) return fail('webhook_not_verified');
  if (event !== 'installation_repositories') return fail('unsupported_event');
  if (!payload || !['added', 'removed'].includes(payload.action) ||
      payload.installation?.account?.login !== org ||
      payload.installation?.account?.type !== 'Organization' ||
      !Number.isSafeInteger(payload.installation?.id) || payload.installation.id < 1 ||
      payload.organization?.login !== org) return fail('installation_identity_not_verified');
  const rows = payload.action === 'added' ? payload.repositories_added : payload.repositories_removed;
  if (!Array.isArray(rows) || rows.length > MAX_TARGETS) return fail('invalid_repository_batch');
  const seen = new Set();
  const repos = [];
  for (const row of rows) {
    const name = row?.name;
    if (typeof name !== 'string' || !REPO.test(name) ||
        row?.full_name !== org + '/' + name ||
        row?.owner?.login && row.owner.login !== org ||
        !Number.isSafeInteger(row?.id) || row.id < 1 ||
        seen.has(row.id) || seen.has(name)) return fail('invalid_repository_identity');
    seen.add(row.id);seen.add(name);
    repos.push({ name, fullName: row.full_name, repositoryId: row.id });
  }
  return { ok: true, org, installationId: payload.installation.id, change: payload.action,
    repositories: repos };
}

function action(repo, stage, targetSha) {
  const operation = {
    governance: 'propose_governance_pr',
    runner: 'propose_runner_pr',
    landing: 'propose_landing_pr',
    ready: 'verify_activation'
  }[stage];
  if (!OPERATIONS.has(operation)) throw new Error('unknown_operation');
  return { operation, repository: repo, key: sha(repo + ':' + operation + ':' + (targetSha ?? 'unknown')),
    requires_review: stage !== 'ready' };
}

export function planAutomaticOnboarding({
  change, trustedPolicy, catalog = [], proofs = {}, completed = []
} = {}) {
  if (!change?.ok) return fail('unverified_event');
  if (!trustedPolicy || trustedPolicy.org !== change.org ||
      trustedPolicy.enabled !== true ||
      trustedPolicy.installationId !== change.installationId) return fail('policy_not_authorized');
  // Enrollment is an owner-configured policy; the webhook, catalog and repository manifest
  // never grant anything by themselves.
  if (!Array.isArray(trustedPolicy.enrolledRepositories) ||
      trustedPolicy.enrolledRepositories.some(x => typeof x !== 'string') ||
      new Set(trustedPolicy.enrolledRepositories).size !== trustedPolicy.enrolledRepositories.length ||
      !Array.isArray(catalog) || !Array.isArray(completed)) return fail('invalid_trusted_policy');
  const enrolled = new Set(trustedPolicy.enrolledRepositories);
  const completion = new Set(completed);
  const catalogSet = new Set(catalog.filter(x => x?.kind === 'repo' && x?.name && !x?.catalog_stale).map(x => x.name));
  const output = [];
  for (const repo of change.repositories) {
    const expected = change.org + '/' + repo.name;
    const p = proofs[expected] ?? {};
    const blockers = [];
    if (change.change === 'removed') {
      output.push({ repository: expected, stage: 'suspended',
        blockers: ['app_access_revoked'], actions: [], stop_new_work: true });
      continue;
    }
    if (!enrolled.has(expected)) blockers.push('not_in_owner_approved_enrollment');
    if (!catalogSet.has(repo.name)) blockers.push('not_in_canonical_catalog');
    if (p.repositoryId !== repo.repositoryId || p.fullName !== expected ||
        p.archived !== false || p.private !== true)
      blockers.push('fresh_repository_metadata_not_verified');
    if (p.installationAccess !== true || p.installationId !== change.installationId)
      blockers.push('installation_token_scope_not_verified');
    if (p.defaultBranch !== 'main' || p.manifestVerified !== true)
      blockers.push('opt_in_manifest_not_verified');
    if (blockers.length) {
      output.push({ repository: expected, stage: 'blocked', blockers, actions: [], stop_new_work: true });
      continue;
    }
    const checks = p.prChecks;
    const ci = checks?.headSha && SHA.test(checks.headSha) && checks.checkedSha === checks.headSha &&
      checks.passed === true && checks.pending === false && checks.held !== true;
    const stages = [
      { stage: 'governance', ready: p.governanceMerged === true },
      { stage: 'runner', ready: p.runnerMerged === true && p.runnerOriginVerified === true },
      { stage: 'landing', ready: p.landingMerged === true && p.landingPolicyVerified === true },
      { stage: 'ready', ready: p.runnerLive === true && p.leaseEligible === true && ci }
    ];
    const pending = stages.find(s => !s.ready);
    const stage = pending?.stage ?? 'active';
    const blockersNext = [];
    if (stage === 'ready' && !ci) blockersNext.push('exact_sha_ci_not_green_or_held');
    // Exactly one bounded next action per repository; repeated webhook deliveries
    // produce the same operation key, allowing durable deduplication by the worker.
    const nextAction = pending && !(stage === 'ready' && !ci) ?
      action(expected, stage, checks?.headSha) : null;
    output.push({ repository: expected, stage, blockers: blockersNext,
      actions: nextAction && !completion.has(nextAction.key) ? [nextAction] : [],
      stop_new_work: stage !== 'active' });
  }
  return { ok: true, schema: 'memo-bridge.auto-onboarding.v1', org: change.org,
    next: output, action_count: output.reduce((n,x)=>n+x.actions.length,0),
    note: 'Proposals require review and scoped credentials. No permission is inferred from webhook discovery.' };
}
