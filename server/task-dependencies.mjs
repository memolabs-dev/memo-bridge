// Verified dependency graph for GitHub-backed agent tasks.
// A closed GitHub Issue is NOT automatically accepted: an independent receipt is required.
const REF = /^([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})#([0-9]{1,10})$/;
const DECLARATION = /<!--\s*memo-bridge:requires:v1\s*([\s\S]*?)-->/gi;
export const DEPENDENCY_LIMITS = Object.freeze({ refs: 20, nodes: 64, bodyBytes: 20_000, maxAgeMs: 300_000 });

export function normalizeIssueRef(value) {
  if (typeof value !== 'string') return null;
  const m = REF.exec(value.trim());
  if (!m || m[2] === '.' || m[2] === '..' || Number(m[3]) < 1 || Number(m[3]) > 2147483647) return null;
  return m[1].toLowerCase() + '/' + m[2].toLowerCase() + '#' + Number(m[3]);
}

// Only an exact versioned declaration is used, never prose or arbitrary Markdown instructions.
// Example: <!-- memo-bridge:requires:v1 {"requires":["memolabs-dev/core#12"]} -->
export function parseDependencySpec(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > DEPENDENCY_LIMITS.bodyBytes) {
    return { ok: false, error: 'dependency_body_unavailable' };
  }
  const markers = [...body.matchAll(DECLARATION)];
  if (!markers.length) {
    return /<!--\s*memo-bridge:requires(?::|\s)/i.test(body)
      ? { ok: false, error: 'dependency_manifest_invalid' }
      : { ok: true, requires: [] };
  }
  if (markers.length !== 1) return { ok: false, error: 'dependency_manifest_duplicate' };
  let data;
  try { data = JSON.parse(markers[0][1].trim()); } catch { return { ok: false, error: 'dependency_manifest_invalid' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).join(',') !== 'requires'
    || !Array.isArray(data.requires) || data.requires.length > DEPENDENCY_LIMITS.refs) {
    return { ok: false, error: 'dependency_manifest_invalid' };
  }
  const refs = [];
  for (const raw of data.requires) {
    const ref = normalizeIssueRef(raw);
    if (!ref) return { ok: false, error: 'dependency_ref_invalid' };
    if (refs.includes(ref)) return { ok: false, error: 'dependency_duplicate_ref' };
    refs.push(ref);
  }
  return { ok: true, requires: refs };
}

const failure = (reason, blockedBy = []) => ({ ok: true, eligible: false, reason, blocked_by: blockedBy });
export async function inspectDependencies(root, { loadIssue, verifyAcceptance, now = Date.now(),
  maxAgeMs = DEPENDENCY_LIMITS.maxAgeMs, maxNodes = DEPENDENCY_LIMITS.nodes } = {}) {
  const top = normalizeIssueRef(root);
  if (!top || typeof loadIssue !== 'function' || !Number.isFinite(now)
    || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 256) {
    return failure('dependency_invalid_input');
  }
  const visited = new Map(), active = new Set(), evidence = [];
  async function visit(ref, isRoot = false) {
    if (active.has(ref)) return failure('dependency_cycle', [ref]);
    if (visited.has(ref)) return visited.get(ref);
    if (visited.size >= maxNodes) return failure('dependency_graph_limit', [ref]);
    active.add(ref);
    try {
      let node;
      try { node = await loadIssue(ref); } catch { return failure('dependency_unavailable', [ref]); }
      const expected = normalizeIssueRef(node?.ref);
      const at = Date.parse(node?.observed_at ?? '');
      if (!node || node.authorized !== true || expected !== ref || !['open', 'closed'].includes(node.state)
        || !Number.isFinite(at) || at > now || now - at > maxAgeMs) {
        return failure('dependency_unavailable_or_stale', [ref]);
      }
      const parsed = parseDependencySpec(node.body);
      if (!parsed.ok) return failure(parsed.error, [ref]);
      const blockers = [];
      let firstReason = null;
      for (const prereq of parsed.requires) {
        const check = await visit(prereq);
        if (!check.eligible) {
          firstReason ??= check.reason;
          blockers.push(...(check.blocked_by?.length ? check.blocked_by : [prereq]));
        }
      }
      if (blockers.length) return failure(firstReason ?? 'dependency_blocked', [...new Set(blockers)]);
      if (!isRoot) {
        if (node.state !== 'closed') return failure('dependency_not_closed', [ref]);
        // Only a trusted runtime-supplied verifier may approve a prerequisite.
        let accepted;
        try { accepted = typeof verifyAcceptance === 'function' ? await verifyAcceptance(node) : null; }
        catch { return failure('dependency_verification_unavailable', [ref]); }
        if (accepted?.verified !== true || accepted?.passed !== true
          || typeof accepted?.evidence_ref !== 'string' || !accepted.evidence_ref.trim()) {
          return failure('dependency_acceptance_missing', [ref]);
        }
        evidence.push({ issue: ref, evidence_ref: accepted.evidence_ref });
      }
      const result = { ok: true, eligible: true, reason: 'ready', blocked_by: [] };
      visited.set(ref, result);
      return result;
    } finally { active.delete(ref); }
  }
  const result = await visit(top, true);
  return { ...result, issue: top, evidence, evaluated_at: new Date(now).toISOString(), observed_nodes: visited.size };
}
