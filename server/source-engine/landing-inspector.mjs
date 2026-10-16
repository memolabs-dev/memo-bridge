// Source Engine: server-only one-step queue claim + fresh GitHub read. No merges.
// Designed to plug into claimLanding(store, { repo, worker }) after issue #106 lands.
// The hub must inject the observed host, reader, policy and ONE shared VPS queue.
import { landingAuthorityGuard, preflightAfterLandingLease } from './landing-authority.mjs';

const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const WORKER = /^[A-Za-z0-9_-]{1,80}$/;
const fail = error => ({ ok: false, error, merge_authorized: false });

function authorizedRepo(repo, allowlist) {
  return typeof repo === 'string' && REPO.test(repo) && !repo.includes('..') &&
    Array.isArray(allowlist) && allowlist.some(x => typeof x === 'string' &&
      x.toLowerCase() === repo.toLowerCase());
}

// Never expose this as a general-purpose MCP tool. serverHost/mode must be injected
// from the verified hub connection, not taken from a client request.
export function createLandingInspector({
  serverHost, mode, allowedRepos, queue, readGitHub, checkPolicy, now = Date.now
} = {}) {
  const gate = landingAuthorityGuard({ host: serverHost, mode });
  const configured = gate.ok &&
    Array.isArray(allowedRepos) &&
    queue && typeof queue.claim === 'function' &&
    typeof readGitHub === 'function' && typeof checkPolicy === 'function' &&
    typeof now === 'function';

  return Object.freeze({
    async inspectNext({ repo, worker } = {}) {
      // Refuse *before* contacting the queue or GitHub if this isn't the
      // explicitly authorized VPS singleton.
      if (!gate.ok) return fail(gate.error);
      if (!configured) return fail('inspector_not_configured');
      if (!authorizedRepo(repo, allowedRepos)) return fail('repo_not_allowed');
      if (typeof worker !== 'string' || !WORKER.test(worker)) return fail('invalid_worker');

      let lease;
      try { lease = await queue.claim({ repo, worker }); }
      catch { return fail('queue_unavailable'); }
      if (!lease || lease.ok !== true) return fail(lease?.error ?? 'queue_unavailable');
      if (lease.empty === true) return { ok: true, empty: true, merge_authorized: false };

      // Even a compromised queue adapter cannot redirect an authorized worker
      // to a different repository.
      if (lease.item?.repo !== repo) return fail('queue_scope_mismatch');
      const inspected = await preflightAfterLandingLease({
        host: serverHost, mode, lease, readGitHub, checkPolicy, now
      });
      if (!inspected?.ok) return fail(inspected?.error ?? 'preflight_failed');

      // This is ONLY an inspected observation. A trusted #88 GitHub workflow
      // must recheck requirements at actual merge time.
      return { ...inspected, merge_authorized: false };
    }
  });
}
