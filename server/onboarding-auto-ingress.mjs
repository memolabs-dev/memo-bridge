import { extractInstallationChanges, verifyInstallationWebhook } from './onboarding-auto.mjs';
import { reconcileAutoOnboarding } from './onboarding-auto-worker.mjs';

const DELIVERY = /^[0-9a-f-]{12,80}$/i;
const MAX_BODY_BYTES = 256 * 1024;

// The HTTP router supplies raw bytes and headers. Policy and all evidence providers are
// administrator-supplied dependencies, NEVER fields from the untrusted webhook payload.
// Failures return bounded codes; no repository text, secrets, tokens or raw errors are echoed.
export async function ingestOnboardingWebhook({
  rawBody, headers, webhookSecret, trustedPolicy, catalogProvider,
  evidenceProvider, effectAdapter, dryRun = true
} = {}) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > MAX_BODY_BYTES)
    return { ok: false, error: 'invalid_body', status: 400 };
  const signature = headers?.['x-hub-signature-256'];
  const event = headers?.['x-github-event'];
  const delivery = headers?.['x-github-delivery'];
  if (typeof delivery !== 'string' || !DELIVERY.test(delivery) ||
      !verifyInstallationWebhook({ payloadBytes: rawBody, signature, secret: webhookSecret }))
    return { ok: false, error: 'unverified_event', status: 401 };
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); }
  catch { return { ok: false, error: 'invalid_json', status: 400 }; }
  const change = extractInstallationChanges({ event, payload, signatureVerified: true });
  if (!change.ok) return { ok: false, error: change.error, status: 422 };
  if (typeof catalogProvider !== 'function' || typeof evidenceProvider !== 'function' ||
      !trustedPolicy || typeof trustedPolicy !== 'object')
    return { ok: false, error: 'trusted_provider_not_configured', status: 503 };
  let catalog, proofs;
  try {
    catalog = await catalogProvider();
    if (!Array.isArray(catalog)) throw new Error('bad_catalog');
    proofs = {};
    // Scoped external reads must VERIFY the App can access this one repository.
    for (const repo of change.repositories) {
      const p = await evidenceProvider(repo);
      if (p && typeof p === 'object') proofs[repo.fullName] = p;
    }
  } catch {
    return { ok: false, error: 'verified_evidence_unavailable', status: 503 };
  }
  try {
    const result = await reconcileAutoOnboarding({
      change, policy: trustedPolicy, catalog, proofs, adapter: effectAdapter, dryRun
    });
    return { ...result, status: result.ok ? 200 : 403, delivery_id: delivery };
  } catch {
    return { ok: false, error: 'reconciliation_failed', status: 503, delivery_id: delivery };
  }
}

export { MAX_BODY_BYTES };
