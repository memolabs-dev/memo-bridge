import { createServer } from 'node:http';
import { MAX_BODY_BYTES } from './onboarding-auto-ingress.mjs';

// Hardened loopback-only intake. The hub/Traefik ingress and secrets are configured
// separately by a reviewed infra change; this server never binds on public interfaces.
export function createOnboardingHttpServer({ handler } = {}) {
  if (typeof handler !== 'function') throw new Error('handler_required');
  let active = 0;
  return createServer(async (request, response) => {
    const send = (status, error) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify(error) + '\n');
    };
    if (request.method !== 'POST' || request.url !== '/github/onboarding')
      return send(404, { ok: false, error: 'not_found' });
    if (active >= 4) return send(503, { ok: false, error: 'busy' });
    const type = request.headers['content-type']?.split(';')[0]?.trim();
    if (type !== 'application/json') return send(415, { ok: false, error: 'unsupported_media_type' });
    active++;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { send(413, { ok: false, error: 'body_too_large' }); return; }
        chunks.push(chunk);
      }
      const result = await handler({ rawBody: Buffer.concat(chunks), headers: request.headers });
      const status = Number.isInteger(result?.status) && result.status >= 200 && result.status < 600 ?
        result.status : 503;
      send(status, result?.ok ?
        { ok: true, schema: result.schema ?? null, action_count: result.action_count ?? 0,
          dry_run: result.dry_run, delivery_id: result.delivery_id ?? null } :
        { ok: false, error: result?.error || 'handler_unavailable' });
    } catch {
      send(503, { ok: false, error: 'handler_unavailable' });
    } finally { active--; }
  });
}
