// Advisory reuse-first matcher. No inference from a repository name or stack.
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().trim();
const tokens = value => [...new Set(normalize(value).split(/[^a-z0-9]+/).filter(term => term.length > 2))];
export function matchProjects(projects, evidence, goal, { now = Date.now(), maxAgeMs = 7 * 86400000 } = {}) {
  const query = tokens(goal);
  return projects.map(project => {
    const entry = evidence.find(x => x.project === project.name);
    const verified = entry?.evidence?.kind === 'repository' && typeof entry.evidence.ref === 'string' && entry.evidence.ref.length > 0;
    const updated = Date.parse(entry?.verified_at ?? '');
    const fresh = Number.isFinite(updated) && updated <= now && now - updated <= maxAgeMs;
    const capabilities = verified && Array.isArray(entry.capabilities) ? entry.capabilities.filter(x => typeof x === 'string') : [];
    const terms = tokens(verified ? [entry.purpose, ...capabilities].filter(Boolean).join(' ') : '');
    const matches = query.filter(term => terms.includes(term));
    const score = query.length ? matches.length / query.length : 0;
    const state = !entry ? 'unknown' : !verified ? 'unverified' : !fresh ? 'stale' : 'verified';
    return { project: project.name, status: project.status, available: Boolean(project.available),
      metadata_only: Boolean(project.metadata_only), state, score, matched_terms: matches,
      purpose: verified ? entry.purpose : null, capabilities, verified_at: entry?.verified_at ?? null,
      evidence_ref: verified ? entry.evidence.ref : null,
      action: score > 0 && state === 'verified' ? 'inspect_existing_project' : 'verify_before_creating' };
  }).sort((a, b) => b.score - a.score || a.project.localeCompare(b.project));
}
export function creationGate(matches) {
  const candidates = matches.filter(x => x.score > 0);
  if (!candidates.length) return { decision: 'verify_registry_and_source_engine', reason: 'absence_of_match_is_not_proof_of_absence' };
  const verified = candidates.filter(x => x.state === 'verified');
  if (verified.length) return { decision: 'inspect_existing_first', candidates: verified.map(x => x.project) };
  return { decision: 'verify_candidates', candidates: candidates.map(x => x.project) };
}
