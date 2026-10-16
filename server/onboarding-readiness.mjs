// Deterministic, read-only readiness evaluation for a project newly onboarded to Memo Bridge.
// Discovery is not authorization: every gate is independent and defaults to false.
const NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const ORIGIN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
export function assessProductOnboarding({ names, projects = [], origins = {}, ledgerRepos = [] } = {}) {
  if (!Array.isArray(names) || !names.length || names.length > 20 ||
      names.some(n => typeof n !== 'string' || !NAME.test(n)) ||
      new Set(names).size !== names.length) throw new Error('invalid_names');
  const registry = new Map(projects.map(p => [p.name, p]));
  const allowlist = new Set(ledgerRepos.filter(r => typeof r === 'string' && ORIGIN.test(r))
    .map(r => r.toLowerCase()));
  const results = names.map(name => {
    const p = registry.get(name);
    const registered = !!p && p.kind === 'repo';
    const available = registered && p.available === true && !!p.path;
    const origin = typeof origins[name] === 'string' && ORIGIN.test(origins[name])
      ? origins[name].toLowerCase() : null;
    const expectedOrigin = `memolabs-dev/${name}`;
    const originMatches = available && origin === expectedOrigin;
    const ledgerAuthorized = originMatches && allowlist.has(expectedOrigin);
    // App installation, runner registration and landing eligibility are NOT inferred here.
    const blockers = [
      ...(!registered ? ['not_registered_locally'] : []),
      ...(registered && !available ? ['checkout_unavailable'] : []),
      ...(available && !originMatches ? ['origin_not_verified'] : []),
      ...(originMatches && !ledgerAuthorized ? ['ledger_not_allowlisted'] : [])
    ];
    return { name, expected_origin: expectedOrigin, registered, available: Boolean(available),
      origin_verified: Boolean(originMatches), ledger_allowlisted: Boolean(ledgerAuthorized),
      coordinator_ready: Boolean(ledgerAuthorized), app_installation_verified: false,
      landing_verified: false, blockers };
  });
  return { schema: 'memo-bridge.product-onboarding.v1', read_only: true,
    authorization_inferred_from_snapshot: false,
    all_coordinator_ready: results.every(p => p.coordinator_ready), projects: results };
}
