// Assembles the public listener from remote.json (Phase 5, D4, D5, D7, D10). hub-cli calls it
// before the hub listens, so a bad file or a closed write gate stops the unit with nothing open.
//
//   remote.json --parseRemoteJson--> listener options, surface config, rate limits
//   write gate layer 2 (assertWriteGate): with remote_writes "enabled", refuse to start while a
//     GitHub Actions runner unit runs, or would start at boot, as root (lab-infra #161)
//   tools/call --remote surface (gate layer 1, bounds)--> forwarder (request id, session hash,
//     rate limits, soft deadline, journal line) --> requestAgent (the hub's v2 envelope) --> the
//     VPS runtime, which maps the principal with its own grants and authorizes again (layer 3)
//
// requestAgent is the only thing taken from the hub: this module never sees the bearer digests,
// the agent keys or the 9443 listener.
import { assertWriteGate } from './write-gate.mjs';
import { createForwarder } from './forward.mjs';
import { createWorkspaceHostRouter } from './workspace-host-router.mjs';
import { createAuthFailureLimiter, createRateLimiter } from './ratelimit.mjs';
import { REMOTE_RUNTIME_HOST, createRemoteServerFactory, unlistedToolCalls } from './remote-surface.mjs';
import { createPublicListener } from './public-listener.mjs';
import { parseRemoteJson } from './remote-config.mjs';
import { isOperatorOp } from './ops.mjs';

// Options:
//   raw          remote.json, JSON-parsed
//   tlsKey/Cert  the hub certificate (Traefik pins it)
//   requestAgent the hub's requestAgent(host, op, {args, principal, requestId, clientSession})
//   requestOperator the hub's requestOperator(host, op, {...}) (Phase 6): operator tools go there,
//                to the host named in their own `host` argument, signed. Absent: operator_disabled.
//   audit        journal sink (one object per line); never receives tokens, arguments or results
//   systemctl    the systemctl runner for the write gate probe (tests inject a fixture)
//   verifier     a prebuilt OIDC verifier (tests: local JWKS); else built from remote.json
// Resolves with the listener (not started). Throws Error('invalid_remote_config ...') or
// Error('remote writes refused: <code>').
export async function createRemoteService({ raw, tlsKey, tlsCert, requestAgent, requestOperator = null, audit = () => {}, systemctl,
  verifier, port, stateDir = null } = {}) {
  if (typeof requestAgent !== 'function') throw new Error('requestAgent required');
  const parsed = parseRemoteJson(raw);
  if (!parsed.ok) throw new Error(`${parsed.error}${parsed.field ? ` (${parsed.field})` : ''}`);
  const { listener, surface, softDeadlineMs, rateLimits, authFailures, clientCert } = parsed.config;

  // Gate layer 2. The probe runs once, here; the listener only sees its verdict.
  let gate = { ok: false, error: 'write_gate_self_check_missing' };
  if (listener.remoteWrites === 'enabled') {
    try {
      const probe = await assertWriteGate({ remote_writes: 'enabled' }, systemctl ? { systemctl } : {});
      gate = { ok: true, units: probe.units ?? [] };
    } catch (error) {
      throw new Error(`remote writes refused: ${error?.code ?? error?.message ?? 'write_gate_refused'}`);
    }
  }

  const journal = event => { try { audit(event); } catch { /* the journal never fails a call */ } };
  const router = createWorkspaceHostRouter({ requestAgent, enabled: surface.mac_runtime_routing === 'enabled', stateDir,
    audit: journal });
  const forwarder = createForwarder({
    requestAgent: (host, op, o) => {
      const envelope = { args: o.args, principal: o.principal, requestId: o.requestId, clientSession: o.clientSession };
      if (!isOperatorOp(op)) return router.call(host, op, envelope);
      if (typeof requestOperator !== 'function') return { ok: false, error: 'operator_disabled' };
      return requestOperator(o.args?.host, op, envelope);
    },
    host: REMOTE_RUNTIME_HOST, softDeadlineMs, limiter: createRateLimiter(rateLimits), audit: journal
  });
  const factory = createRemoteServerFactory({
    config: surface,
    dispatch: (host, op, o) => forwarder.call({ op, args: o.args, principal: o.principal, ctx: o.ctx, clientId: o.clientId }),
    audit: journal
  });
  return createPublicListener({
    tlsKey, tlsCert, ...listener, ...(port !== undefined ? { port } : {}), ...(verifier ? { verifier } : {}),
    writeGateCheck: () => gate, factory, audit: journal,
    authLimiter: createAuthFailureLimiter(authFailures),
    unlistedCalls: (authInfo, message) => unlistedToolCalls(authInfo, surface, message),
    clientCert
  });
}
