// Operator agent (Phase 6, TODO-P6-05, spec D1 to D8): the host side of every operator call.
//
// The agent is a separate process per host (bridge/operator-agent-cli.mjs): `operator-vps` as
// the user memo-operator on lab, `operator-mac` as memo on the Mac. It connects out to the hub
// with the v2 wire (bridge/agent.mjs createAgent, own identity key) and serves the operator ops.
// Every request goes through the same pipeline, in this order, before anything is read or run:
//   1. signature: the hub's Ed25519 operator signature over id, op, host, tier, principal,
//      args hash, expiry and nonce (operator-signing.mjs); refused: bad, unknown key, expired,
//      replayed, or arguments that do not hash to the signed value;
//   2. tier: the op's tier from this side's own table must equal the signed tier, and be at most
//      the local policy's max_tier (the hub cannot raise it);
//   3. kill switch and rate limit: FROZEN file, auto-freeze, per-tier limits (operator-guard.mjs);
//   4. arguments: the shared schema (server/tools/operator-tools.mjs), and host == this host;
//   5. the tool (operator-tools.mjs), then redaction and the 128 KiB bound (operator-output.mjs);
//   6. one hash-chained journal line (operator-audit.mjs) for every call, refusals included.
// Refusals answer {ok:false, error:<code>} as data, so the hub journals them like any result.
// Signature and policy refusals count towards auto-freeze.
import { OPERATOR_SCHEMAS } from '../server/tools/operator-tools.mjs';
import { operatorTier, OPERATOR_OPERATION_CAPABILITY } from '../server/coordinator/policy.mjs';
import { finalizeResult } from './operator-output.mjs';
import { argsSha256 } from './operator-signing.mjs';

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

// policy    parsed local policy (operator-policy.mjs)
// verifier  createOperatorVerifier for this host
// guard     createOperatorGuard(policy)
// chain     createAuditChain (null: no host journal, tests only)
// tools     {op: async (args) => data}, by default createOperatorTools (the caller builds it, so
//           the guard and the chain it reports on are the same objects)
// tierOf    op -> tier (policy.mjs operatorTier; tests inject a T1 op to exercise the freeze)
// schemas   op -> zod schema
export function createOperatorOperations({ policy, verifier, guard, chain = null, tools, tierOf = operatorTier,
  schemas = OPERATOR_SCHEMAS, ops = Object.keys(OPERATOR_OPERATION_CAPABILITY), now = Date.now, log = () => {} } = {}) {
  if (!policy || !verifier || !guard || !tools) throw new Error('operator agent needs policy, verifier, guard and tools');
  const handlers = {};
  for (const op of ops) {
    handlers[op] = async (args, ctx = {}) => {
      const started = now();
      const principal = typeof ctx.principal?.id === 'string' ? ctx.principal.id : null;
      const requestId = ctx.meta?.request_id ?? ctx.id ?? null;
      const ref = typeof args?.ref === 'string' ? args.ref.slice(0, 128) : null;
      const tier = tierOf(op);
      const journal = (outcome, code, output) => {
        if (!chain) return true;
        try {
          chain.append({ request_id: requestId, ref, op, tier, principal, args, args_sha256: argsSha256(args), outcome, code,
            ms: now() - started, output });
          return true;
        } catch {
          log('operator_audit_failed', { op });
          return false;
        }
      };
      const refuse = code => {
        const froze = guard.refused(code);
        log('operator_refused', { op, code, principal, ...(froze ? { auto_frozen: true } : {}) });
        const out = { ok: false, error: code };
        journal('denied', code, out);
        return out;
      };

      const signed = verifier.verify(ctx.operator, { id: ctx.id, op, args, principal });
      if (!signed.ok) return refuse(signed.error);
      if (!Number.isInteger(tier) || signed.tier !== tier) return refuse('tier_mismatch');
      if (tier > policy.maxTier) return refuse('tier_not_allowed');
      const admitted = guard.admit(tier);
      if (admitted) return refuse(admitted);
      const schema = schemas[op];
      const parsed = schema ? schema.safeParse(args ?? {}) : { success: false };
      if (!parsed.success) return refuse('invalid_arguments');
      if (parsed.data.host !== policy.host) return refuse('host_mismatch');

      let data;
      try {
        data = await tools[op](parsed.data);
      } catch {
        log('operator_op_failed', { op });
        data = { ok: false, error: 'internal_error' };
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) data = { ok: false, error: 'internal_error' };
      if (data.ok === false && !CODE_RE.test(String(data.error))) data = { ok: false, error: 'internal_error' };
      // A secret path request from the model counts like a policy refusal (prompt injection).
      if (data.ok === false) guard.refused(data.error);
      const { data: out } = finalizeResult(ref !== null ? { ...data, ref } : data);
      if (!journal(data.ok === false ? 'denied' : 'ok', data.ok === false ? data.error : null, out)) {
        return { ok: false, error: 'audit_unavailable' };
      }
      return out;
    };
  }
  return { handlers };
}
