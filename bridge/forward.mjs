// Forwarding of remote tool calls from the public listener to the runtime (Phase 5, D5, D10).
//
// The hub executes nothing: a remote tool handler hands its call to forwarder.call(), which
//  1. gives the call a request id (shared by the hub journal line and the runtime event);
//  2. applies the rate limits (bridge/ratelimit.mjs);
//  3. reads the conversation hint `_meta["openai/session"]` from the MCP request context and
//     keeps only a hash of it (D8; OpenAI says not to use it for authorization, and it is not);
//  4. forwards {op, args, principal, request_id, client_session} through requestAgent();
//  5. for a mutating op still running at the soft deadline, answers
//     {ok:true, status:'accepted', request_id, client_request_id} and lets the runtime finish:
//     the outcome is read later with workspace_status or task_status, and a retry with the
//     same client_request_id creates nothing new (REQ-P5-15, REQ-P4-07);
//  6. writes one journal line per call: {at, request_id, principal, client_ref, op, outcome,
//     code, ms, bytes}. Never arguments, tokens, session values or file contents (REQ-P5-17).
import { createHash, randomUUID } from 'node:crypto';
import { OPS } from './ops.mjs';
import { REQUEST_ID_RE, SOFT_DEADLINE } from './write-gate.mjs';

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const OP_RE = /^[a-z][a-z0-9_]{0,63}$/;
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_SESSION_CHARS = 512;

// Refusals counted as 'denied' in the journal; any other failure is an 'error'.
export const DENIED_CODES = Object.freeze(new Set(['forbidden', 'rate_limited', 'write_gate_closed', 'mutating_disabled',
  'project_not_allowed', 'path_protected', 'session_mismatch', 'protected_branch', 'push_rejected', 'lease_held',
  'stale_lease', 'host_not_remote_enabled', 'head_not_pushed_by_workspace', 'default_branch_refused', 'workspace_closed',
  'no_live_claim', 'claim_required', 'unsupported_op']));

const sha256 = value => createHash('sha256').update(value).digest('hex');

// Hash of the ChatGPT conversation hint, or null. Read from the SDK request context
// (ctx.mcpReq._meta, @modelcontextprotocol/server 2.3.1 BaseContext); never from arguments.
// Mutating ops whose runtime handler replays the first result for the same client_request_id
// (runOnce or the jobs request table): the only ones that may answer `accepted`.
export const RETRY_SAFE_OPS = Object.freeze(new Set(['task_claim', 'worktree_push', 'github_create_pr', 'jobs_submit']));

export function clientSessionHash(ctx) {
  const value = ctx?.mcpReq?._meta?.['openai/session'];
  if (typeof value !== 'string' || !value || value.length > MAX_SESSION_CHARS) return null;
  return sha256(`openai/session|${value}`).slice(0, 32);
}

// A short, stable, non-reversible reference to the OAuth client (client_id), for logs.
export function clientRef(clientId) {
  return typeof clientId === 'string' && clientId ? sha256(`client|${clientId}`).slice(0, 12) : null;
}

// The journal line. Built from an explicit list of fields so nothing else can leak into it.
export function hubAuditLine({ at, request_id, principal, client_ref, op, outcome, code, ms, bytes, event = 'remote_call' }) {
  return {
    at: new Date(at).toISOString(),
    event: ['remote_call', 'remote_call_completed', 'remote_refused'].includes(event) ? event : 'remote_call',
    request_id: REQUEST_ID_RE.test(request_id ?? '') ? request_id : null,
    principal: typeof principal === 'string' ? principal.slice(0, 130) : null,
    client_ref: /^[0-9a-f]{12}$/.test(client_ref ?? '') ? client_ref : null,
    op: OP_RE.test(op ?? '') ? op : 'invalid',
    outcome: ['ok', 'denied', 'error', 'accepted'].includes(outcome) ? outcome : 'error',
    code: CODE_RE.test(code ?? '') ? code : null,
    ms: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null,
    bytes: Number.isInteger(bytes) && bytes >= 0 ? bytes : null
  };
}

export function outcomeOf(result) {
  if (result?.status === 'accepted') return { outcome: 'accepted', code: null };
  if (result?.ok === false) {
    const code = typeof result.error === 'string' && CODE_RE.test(result.error) ? result.error : 'internal_error';
    return { outcome: DENIED_CODES.has(code) ? 'denied' : 'error', code };
  }
  return { outcome: 'ok', code: null };
}

const byteLength = value => { try { return Buffer.byteLength(JSON.stringify(value)); } catch { return null; } };
const isMutatingOp = op => Boolean(Object.hasOwn(OPS, op) && OPS[op].mutating);

// requestAgent(host, op, {args, principal, requestId, clientSession}) resolves with the
// runtime's data or {ok:false, error}. It is the hub's agent channel; the envelope fields
// requestId and clientSession travel next to the principal, never inside args.
export function createForwarder({ requestAgent, host = 'vps', softDeadlineMs = SOFT_DEADLINE.default, limiter = null,
  audit = () => {}, now = Date.now, isMutating = isMutatingOp, newRequestId = randomUUID } = {}) {
  if (typeof requestAgent !== 'function') throw new Error('requestAgent required');
  if (!Number.isInteger(softDeadlineMs) || softDeadlineMs < 1) throw new Error('invalid soft deadline');

  const journal = fields => { try { audit(hubAuditLine(fields)); } catch { /* the journal never fails a call */ } };

  return {
    async call({ op, args = {}, principal, ctx = null, clientId = null } = {}) {
      const started = now();
      const requestId = newRequestId();
      const base = { request_id: requestId, principal: principal?.id ?? null, client_ref: clientRef(clientId), op };
      const finish = (result, event = 'remote_call') => {
        const { outcome, code } = outcomeOf(result);
        journal({ ...base, at: now(), event, outcome, code, ms: now() - started, bytes: byteLength(result) });
        return result;
      };
      if (!OP_RE.test(op ?? '') || !principal?.id) return finish(fail('invalid_request', { request_id: requestId }), 'remote_refused');

      const slot = limiter ? limiter.acquire(principal.id, op) : { ok: true, release() {} };
      if (!slot.ok) {
        const { class: cls, reason, ...refusal } = slot;
        return finish({ ...refusal, request_id: requestId }, 'remote_refused');
      }

      const mutating = isMutating(op);
      // Fix F6: only an op the runtime makes idempotent on client_request_id may answer
      // `accepted` past the soft deadline; every other mutating op waits for its outcome, so a
      // retry never repeats it (a second workspace_open, a second commit).
      const retrySafe = mutating && RETRY_SAFE_OPS.has(op);
      let forwardArgs = args ?? {};
      // Such a call always carries a client_request_id, so that an `accepted` answer can be
      // retried safely: the model's own id when it gave a valid one, else one derived here.
      let clientRequestId = null;
      if (retrySafe) {
        clientRequestId = CLIENT_REQUEST_ID_RE.test(forwardArgs.client_request_id ?? '') ? forwardArgs.client_request_id : `rq_${requestId}`;
        forwardArgs = { ...forwardArgs, client_request_id: clientRequestId };
      }

      let forwarded;
      try {
        forwarded = Promise.resolve(requestAgent(host, op, { args: forwardArgs, principal, requestId,
          clientSession: clientSessionHash(ctx) }));
      } catch {
        forwarded = Promise.resolve(fail('internal_error'));
      }
      const settled = forwarded.then(value => value, () => fail('internal_error'));
      settled.finally(() => slot.release());
      const withId = result => (result && typeof result === 'object' && !Array.isArray(result) && !('request_id' in result)
        ? { ...result, request_id: requestId } : result);

      if (!retrySafe) return finish(withId(await settled));

      let timer;
      const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), softDeadlineMs); timer.unref?.(); });
      const first = await Promise.race([settled, deadline]);
      clearTimeout(timer);
      if (first !== null) return finish(withId(first));

      // Past the soft deadline: answer now, journal the final outcome when it lands.
      settled.then(late => finish(withId(late), 'remote_call_completed'));
      return finish({
        ok: true, status: 'accepted', request_id: requestId, op, client_request_id: clientRequestId,
        detail: 'still running on the runtime; read the outcome with workspace_status (requests) or task_status. ' +
          'A retry with the same client_request_id returns the first result instead of repeating task_claim, ' +
          'worktree_push, github_create_pr or jobs_submit'
      });
    }
  };
}
