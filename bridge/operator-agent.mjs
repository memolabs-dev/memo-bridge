// Operator agent (Phase 6, TODO-P6-05, spec D1 to D8): the host side of every operator call.
//
// The agent is a separate process per host (bridge/operator-agent-cli.mjs): `operator-vps` as
// the user memo-operator on lab, `operator-mac` as memo on the Mac. It connects out to the hub
// with the v2 wire (bridge/agent.mjs createAgent, own identity key) and serves the operator ops.
// Every request goes through the same pipeline, in this order, before anything is read or run:
//   1. signature: the hub's Ed25519 operator signature over id, op, host, tier, principal,
//      args hash, expiry and nonce (operator-signing.mjs); refused: bad, unknown key, expired,
//      replayed, or arguments that do not hash to the signed value;
//   2. tier: the call's tier from this side's own table (operator_run with as_root is T3) must
//      equal the signed tier, and be at most the local policy's max_tier (the hub cannot raise
//      it); then, when the local approval_mode says this call needs the owner's approval
//      (operator-dangerous.mjs), the signature must carry an approval id (approval_required);
//   3. kill switch and rate limit: FROZEN file, auto-freeze, per-tier limits (operator-guard.mjs);
//   4. arguments: the shared schema (server/tools/operator-tools.mjs), and host == this host;
//   5. the tool (operator-tools.mjs), then redaction and the 128 KiB bound (operator-output.mjs);
//   6. one hash-chained journal line (operator-audit.mjs) for every call, refusals included.
// T3 calls (operator_run as_root, operator_script) and root job status (rj_ ids) are passed on,
// with the hub's signature, to the root helper (operator-root-helper.mjs), which checks the
// signature and its policy again and runs them in transient units. Two internal ops, never
// tools: operator_audit_head (the hub's 15-minute anchoring) and operator_owner_unfreeze (the
// owner's Telegram /unfreeze), both signed like any op.
// Refusals answer {ok:false, error:<code>} as data, so the hub journals them like any result.
// Signature and policy refusals count towards auto-freeze.
import { OPERATOR_SCHEMAS } from '../server/tools/operator-tools.mjs';
import { z } from 'zod/v4';
import { operatorCallTier, OPERATOR_OPERATION_CAPABILITY } from '../server/coordinator/policy.mjs';
import { needsApproval } from './operator-dangerous.mjs';
import { finalizeResult } from './operator-output.mjs';
import { argsSha256 } from './operator-signing.mjs';

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

// Schemas of the internal ops (hub-only, bridge/ops.mjs OPERATOR_INTERNAL_OPS).
const host = z.enum(['mac', 'vps']);
export const INTERNAL_SCHEMAS = Object.freeze({
  operator_audit_head: z.object({ host, since_seq: z.number().int().min(1).optional() }),
  operator_owner_unfreeze: z.object({ host, by: z.string().min(1).max(64) })
});

// policy      parsed local policy (operator-policy.mjs)
// verifier    createOperatorVerifier for this host
// guard       createOperatorGuard(policy)
// chain       createAuditChain or helperAuditChain (sync or async; null: no journal, tests only)
// tools       {op: async (args) => data}: the T0, T1 and T2 tools (the caller builds them so the
//             guard and the chain they report on are the same objects)
// rootHelper  createRootHelperClient, or null (T3 answers root_unavailable_on_host). On the Mac the
//             client has available(): without the helper's socket, T3 answers the same code
// tierOf      (op, args) -> tier (policy.mjs operatorCallTier; tests inject a T1 op)
// schemas     op -> zod schema
export function createOperatorOperations({ policy, verifier, guard, chain = null, tools, rootHelper = null, tierOf = operatorCallTier,
  schemas = { ...OPERATOR_SCHEMAS, ...INTERNAL_SCHEMAS },
  ops = [...Object.keys(OPERATOR_OPERATION_CAPABILITY), ...Object.keys(INTERNAL_SCHEMAS)], now = Date.now, log = () => {} } = {}) {
  if (!policy || !verifier || !guard || !tools) throw new Error('operator agent needs policy, verifier, guard and tools');
  const internal = {
    async operator_audit_head({ since_seq: since }) {
      if (!chain?.headInfo) return { ok: false, error: 'audit_unavailable' };
      return { ok: true, host: policy.host, ...(await chain.headInfo(since ?? null)) };
    },
    async operator_owner_unfreeze({ by }, ctx) {
      const cleared = guard.clearAuto();
      let helper = null;
      if (rootHelper && (typeof rootHelper.available !== 'function' || rootHelper.available())) {
        helper = await rootHelper.request({ type: 'owner_unfreeze', id: ctx.id, op: 'operator_owner_unfreeze', args: ctx.args,
          principal: ctx.principal, operator: ctx.operator });
      }
      log('operator_owner_unfreeze', { by });
      return { ok: true, host: policy.host, cleared, root_helper: helper ? helper.ok === true : null };
    }
  };
  const handlers = {};
  for (const op of ops) {
    handlers[op] = async (args, ctx = {}) => {
      const started = now();
      const principal = typeof ctx.principal?.id === 'string' ? ctx.principal.id : null;
      const requestId = ctx.meta?.request_id ?? ctx.id ?? null;
      const ref = typeof args?.ref === 'string' ? args.ref.slice(0, 128) : null;
      const tier = tierOf(op, args) ?? (Object.hasOwn(INTERNAL_SCHEMAS, op) ? 0 : null);
      let approval = null;
      const journal = async (outcome, code, output) => {
        if (!chain) return true;
        try {
          await chain.append({ request_id: requestId, ref, op, tier, principal, args, args_sha256: argsSha256(args), approval, outcome, code,
            ms: now() - started, output });
          return true;
        } catch {
          log('operator_audit_failed', { op });
          return false;
        }
      };
      const refuse = async code => {
        const froze = guard.refused(code);
        log('operator_refused', { op, code, principal, ...(froze ? { auto_frozen: true } : {}) });
        const out = { ok: false, error: code };
        await journal('denied', code, out);
        return out;
      };

      const signed = verifier.verify(ctx.operator, { id: ctx.id, op, args, principal });
      if (!signed.ok) return refuse(signed.error);
      approval = signed.approval;
      if (!Number.isInteger(tier) || signed.tier !== tier) return refuse('tier_mismatch');
      if (tier > policy.maxTier) return refuse('tier_not_allowed');
      const admitted = guard.admit(tier);
      if (admitted) return refuse(admitted);
      if (needsApproval(policy.approvalMode, op, args, tier) && !signed.approval) return refuse('approval_required');
      const schema = schemas[op];
      const parsed = schema ? schema.safeParse(args ?? {}) : { success: false };
      if (!parsed.success) return refuse('invalid_arguments');
      if (parsed.data.host !== policy.host) return refuse('host_mismatch');

      const toRoot = tier === 3 || (op === 'operator_job_status' && String(parsed.data.job_id).startsWith('rj_'));
      let data;
      try {
        if (Object.hasOwn(internal, op)) {
          data = await internal[op](parsed.data, { id: ctx.id, args, principal, operator: ctx.operator });
        } else if (toRoot) {
          // The helper checks the same signature and its own policy, runs, journals, bounds.
          // On the Mac the helper is optional: forward only while its socket exists (available()).
          data = rootHelper && (typeof rootHelper.available !== 'function' || rootHelper.available())
            ? await rootHelper.request({ type: 'call', id: ctx.id, op, args, principal, operator: ctx.operator, request_id: requestId })
            : { ok: false, error: 'root_unavailable_on_host' };
        } else {
          data = await tools[op](parsed.data);
        }
      } catch {
        log('operator_op_failed', { op });
        data = { ok: false, error: 'internal_error' };
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) data = { ok: false, error: 'internal_error' };
      if (data.ok === false && !CODE_RE.test(String(data.error))) data = { ok: false, error: 'internal_error' };
      // A secret path request from the model counts like a policy refusal (prompt injection).
      if (data.ok === false) guard.refused(data.error);
      const { data: out } = finalizeResult(ref !== null && data.ref === undefined ? { ...data, ref } : data);
      if (!(await journal(data.ok === false ? 'denied' : 'ok', data.ok === false ? data.error : null, out))) {
        return { ok: false, error: 'audit_unavailable' };
      }
      return out;
    };
  }
  return { handlers };
}
