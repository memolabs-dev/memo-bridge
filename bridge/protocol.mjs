// Hub <-> agent wire protocol, version 2 (Phase 4, TODO-P4-03).
//
// The WebSocket subprotocol name and the Ed25519 challenge handshake stay exactly as in v1
// (challenge -> authenticate -> authenticated, bridge/crypto.mjs). Version 2 starts after it:
//
//   agent -> hub  {v:2, type:'hello', host, version, ops:[...], max_inflight}
//   hub -> agent  {v:2, type:'welcome', ops:[...]}                 effective ops (registry ∩ advertised)
//   hub -> agent  {v:2, type:'request', id, op, args, principal:{id}, timeout_ms, request_key?}
//   agent -> hub  {v:2, type:'result', id, data}  |  {v:2, type:'error', id, code}
//   either way    {v:2, type:'part', id, seq, last, data}            one slice of a message above 16 KiB
//
// A v1 agent never sends hello; the hub then speaks v1 to it ({type:'request', id, op} and
// {type:'result', id, data}) for host_status only. A v2 agent answers a v1 request in v1, so
// an old hub keeps working with a new agent and the other way round.
//
// Every WebSocket frame stays at or below MAX_FRAME_BYTES (ws maxPayload on both ends, so a
// larger frame closes the connection with 1009). A message that encodes larger is sent as
// ordered 'part' frames and reassembled up to a per-direction cap. Liveness uses WebSocket
// ping/pong control frames (RFC 6455 §5.5.2-5.5.3): the hub pings every PING_INTERVAL_MS
// and drops an agent that missed a pong; ws answers pings automatically (autoPong, ws 8.x).
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const PROTOCOL_VERSION = 2;
export const SUBPROTOCOL = 'memo-bridge-agent-v1';
export const MAX_FRAME_BYTES = 16 * 1024;
// Raw bytes per part: base64 makes 12 KiB of it, leaving room for the envelope under 16 KiB.
export const PART_RAW_BYTES = 9 * 1024;
export const MAX_REQUEST_BYTES = 128 * 1024;
export const MAX_RESULT_BYTES = 1024 * 1024;
export const MAX_IN_FLIGHT = 8;
export const MAX_ADVERTISED_OPS = 128;
export const PING_INTERVAL_MS = 15_000;
export const BACKOFF = Object.freeze({ minMs: 1_000, maxMs: 60_000 });

export const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const OP_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const PRINCIPAL_ID_RE = /^[a-z]+:[A-Za-z0-9._@-]{1,120}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;

// Error codes a hub or agent may put on the wire, plus the tool-level codes they wrap.
export const ERROR_CODES = Object.freeze([
  'unsupported_op', 'agent_disconnected', 'host_offline', 'agent_busy', 'timeout', 'invalid_request',
  'invalid_arguments', 'invalid_agent_response', 'request_too_large', 'result_too_large', 'forbidden',
  'mutating_disabled', 'runtime_disabled', 'unknown_principal', 'unsupported_version', 'internal_error', 'shutting_down'
]);

export const PACKAGE_VERSION = (() => {
  try {
    const v = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    return typeof v === 'string' && VERSION_RE.test(v) ? v : 'unknown';
  } catch { return 'unknown'; }
})();

// A short error the agent's operation handlers throw to answer {type:'error', code}.
export class OperationError extends Error {
  constructor(code) {
    super(CODE_RE.test(code) ? code : 'internal_error');
    this.code = this.message;
  }
}

export const newId = () => randomUUID();
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// Parse one text frame into a plain object, or null.
export function parseFrame(raw) {
  let msg;
  try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { return null; }
  return isPlainObject(msg) ? msg : null;
}

// Encode a message as one or more frames, each at most maxFrameBytes. Returns null when the
// whole message is above maxMessageBytes (the caller answers *_too_large instead).
export function encodeFrames(message, { maxMessageBytes, maxFrameBytes = MAX_FRAME_BYTES, partBytes = PART_RAW_BYTES } = {}) {
  const text = JSON.stringify(message);
  const bytes = Buffer.byteLength(text);
  if (maxMessageBytes !== undefined && bytes > maxMessageBytes) return null;
  if (bytes <= maxFrameBytes) return [text];
  const raw = Buffer.from(text, 'utf8');
  const id = typeof message.id === 'string' ? message.id : newId();
  const frames = [];
  for (let seq = 0, at = 0; at < raw.length; seq++, at += partBytes) {
    frames.push(JSON.stringify({ v: PROTOCOL_VERSION, type: 'part', id, seq,
      last: at + partBytes >= raw.length, data: raw.subarray(at, at + partBytes).toString('base64') }));
  }
  return frames;
}

// Reassembles 'part' frames. accept(frame) returns null while a message is incomplete,
// {message} when it is complete, or {error, id} when the parts are invalid or too large.
// Parts arrive in order (one WebSocket over TCP), so a gap is an error, not a reorder.
export function createReassembler({ maxMessageBytes, tooLarge = 'result_too_large', maxPartial = MAX_IN_FLIGHT * 2,
  timeoutMs = 120_000, now = Date.now } = {}) {
  const partial = new Map();
  return {
    get size() { return partial.size; },
    accept(frame) {
      const t = now();
      for (const [key, entry] of partial) if (t - entry.started > timeoutMs) partial.delete(key);
      const { id, seq, last, data } = frame;
      if (typeof id !== 'string' || !ID_RE.test(id) || !Number.isInteger(seq) || seq < 0 || typeof last !== 'boolean'
        || typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        if (typeof id === 'string') partial.delete(id);
        return { error: 'invalid_request', id: typeof id === 'string' && ID_RE.test(id) ? id : null };
      }
      let entry = partial.get(id);
      if (!entry) {
        if (seq !== 0) return { error: 'invalid_request', id };
        if (partial.size >= maxPartial) return { error: 'agent_busy', id };
        entry = { started: t, next: 0, bytes: 0, chunks: [] };
        partial.set(id, entry);
      }
      if (seq !== entry.next) { partial.delete(id); return { error: 'invalid_request', id }; }
      const chunk = Buffer.from(data, 'base64');
      entry.bytes += chunk.length;
      if (entry.bytes > maxMessageBytes) { partial.delete(id); return { error: tooLarge, id }; }
      entry.chunks.push(chunk);
      entry.next++;
      if (!last) return null;
      partial.delete(id);
      const message = parseFrame(Buffer.concat(entry.chunks));
      // A part may not carry another part, and must belong to the message it reassembles.
      if (!message || message.type === 'part' || message.id !== id) return { error: 'invalid_request', id };
      return { message };
    },
    clear() { partial.clear(); }
  };
}

export function makeHello({ host, ops, version = PACKAGE_VERSION, maxInFlight = MAX_IN_FLIGHT }) {
  return { v: PROTOCOL_VERSION, type: 'hello', host, version, ops: [...ops], max_inflight: maxInFlight };
}

// Hub side: validate a hello for an agent already authenticated as `host`.
export function validateHello(msg, host) {
  if (msg?.type !== 'hello') return { ok: false, code: 'invalid_request' };
  if (msg.v !== PROTOCOL_VERSION) return { ok: false, code: 'unsupported_version' };
  if (msg.host !== host) return { ok: false, code: 'invalid_request' };
  if (!Array.isArray(msg.ops) || msg.ops.length > MAX_ADVERTISED_OPS || !msg.ops.every(op => typeof op === 'string' && OP_RE.test(op))) {
    return { ok: false, code: 'invalid_request' };
  }
  const version = typeof msg.version === 'string' && VERSION_RE.test(msg.version) ? msg.version : 'unknown';
  const maxInFlight = Number.isInteger(msg.max_inflight) && msg.max_inflight >= 1 ? Math.min(msg.max_inflight, MAX_IN_FLIGHT) : MAX_IN_FLIGHT;
  return { ok: true, ops: [...new Set(msg.ops)], version, maxInFlight };
}

export function makeRequest({ id = newId(), op, args = {}, principal, timeoutMs, requestKey }) {
  return { v: PROTOCOL_VERSION, type: 'request', id, op, args, principal: { id: principal.id },
    timeout_ms: timeoutMs, ...(requestKey ? { request_key: requestKey } : {}) };
}

// Agent side: validate a v2 request envelope. Capabilities never travel on the wire: the
// receiving side maps principal.id to capabilities with its own table.
export function validateRequest(msg) {
  if (msg?.v !== PROTOCOL_VERSION || msg.type !== 'request') return { ok: false, code: 'invalid_request' };
  const id = typeof msg.id === 'string' && ID_RE.test(msg.id) ? msg.id : null;
  if (!id) return { ok: false, code: 'invalid_request', id: null };
  if (typeof msg.op !== 'string' || !OP_RE.test(msg.op)) return { ok: false, code: 'invalid_request', id };
  if (!isPlainObject(msg.args ?? {})) return { ok: false, code: 'invalid_arguments', id };
  if (!isPlainObject(msg.principal) || typeof msg.principal.id !== 'string' || !PRINCIPAL_ID_RE.test(msg.principal.id)) {
    return { ok: false, code: 'unknown_principal', id };
  }
  const timeoutMs = Number.isInteger(msg.timeout_ms) && msg.timeout_ms > 0 ? msg.timeout_ms : null;
  const requestKey = typeof msg.request_key === 'string' && /^[0-9a-f]{64}$/.test(msg.request_key) ? msg.request_key : null;
  return { ok: true, value: { id, op: msg.op, args: msg.args ?? {}, principal: { id: msg.principal.id }, timeoutMs, requestKey } };
}

export const resultFrame = (id, data) => ({ v: PROTOCOL_VERSION, type: 'result', id, data });
export const errorFrame = (id, code) => ({ v: PROTOCOL_VERSION, type: 'error', id, code: CODE_RE.test(code) ? code : 'internal_error' });

// Idempotency key for a mutating op that carries client_request_id (spec §4): the hub
// derives it so a client cannot collide with another principal's retries.
export function idempotencyKey(principalId, op, clientRequestId) {
  if (typeof clientRequestId !== 'string' || clientRequestId.length === 0 || clientRequestId.length > 128) return null;
  return createHash('sha256').update(`${principalId}|${op}|${clientRequestId}`).digest('hex');
}

// Reconnect delay: exponential from minMs, capped at maxMs, with "equal jitter" (half fixed,
// half random) so a hub restart does not make every agent reconnect in the same instant.
export function backoffDelay(attempt, { minMs = BACKOFF.minMs, maxMs = BACKOFF.maxMs, random = Math.random } = {}) {
  const ceiling = Math.min(maxMs, minMs * 2 ** Math.min(Math.max(0, attempt), 30));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
