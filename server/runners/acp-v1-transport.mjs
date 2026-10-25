// Restricted internal ACP v1 session transport for a trusted, lease-bound
// OpenCode child. This module intentionally registers NO public MCP tool.
// The caller must own the child and must have completed ACP v1 initialize.
// Permission requests are always cancelled. No client FS/terminal capabilities.
import { isAbsolute } from 'node:path';

const FRAME_LIMIT = 64 * 1024;
const PROMPT_LIMIT = 8 * 1024;
const STOP_REASONS = new Set(['end_turn', 'max_turn_requests', 'max_tokens', 'cancelled', 'refusal']);
const fail = code => new Error(code);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ID = /^[A-Za-z0-9._:-]{1,256}$/;

export function createAcpV1Transport({ stdin, stdout } = {}, {
  protocolVersion = 1, onUpdate = () => {}, sessionTimeoutMs = 10_000,
  promptTimeoutMs = 120_000
} = {}) {
  if (protocolVersion !== 1 || !stdin || typeof stdin.write !== 'function' ||
      !stdout || typeof stdout.on !== 'function' || typeof onUpdate !== 'function' ||
      !Number.isInteger(sessionTimeoutMs) || sessionTimeoutMs < 1 || sessionTimeoutMs > 30_000 ||
      !Number.isInteger(promptTimeoutMs) || promptTimeoutMs < 1 || promptTimeoutMs > 300_000)
    throw new TypeError('invalid_acp_v1_transport');

  let closed = false;
  let received = Buffer.alloc(0);
  let nextId = 0;
  let sessionId = null;
  let preparing = false;
  let prompting = false;
  const pending = new Map();
  let updatesLeft = 256;

  const send = message => {
    if (closed) throw fail('acp_transport_closed');
    try {
      const wire = JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n';
      if (Buffer.byteLength(wire) > FRAME_LIMIT) throw fail('acp_send_oversized');
      stdin.write(wire);
    } catch {
      abort('acp_write_failed');
      throw fail('acp_write_failed');
    }
  };
  const remove = () => {
    stdout.off('data', onData);
    stdout.off('end', onExit);
    stdout.off('error', onExit);
    stdin.off?.('error', onExit);
  };
  const abort = reason => {
    if (closed) return;
    closed = true;
    remove();
    for (const [, row] of pending) {
      clearTimeout(row.timer);
      row.reject(fail(reason));
    }
    pending.clear();
    sessionId = null;
    received = Buffer.alloc(0);
  };
  const onExit = () => abort('acp_disconnected');
  const respondDenied = id => {
    // In v1, explicit cancelled is the only safe choice without a real
    // owner confirmation UI. Never select an allow option or imply consent.
    send({ id, result: { outcome: { outcome: 'cancelled' } } });
  };
  const onFrame = line => {
    let msg;
    try { msg = JSON.parse(line.toString('utf8')); }
    catch { abort('acp_invalid_json'); return; }
    if (!object(msg) || msg.jsonrpc !== '2.0') {
      abort('acp_invalid_frame');
      return;
    }
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined) {
        if ((typeof msg.id !== 'string' && typeof msg.id !== 'number') || msg.id === null) {
          abort('acp_invalid_frame');
          return;
        }
        if (msg.method === 'session/request_permission') {
          try { respondDenied(msg.id); } catch { /* abort is handled by send */ }
        } else {
          // Explicit method-not-found. The client advertised neither file
          // writes nor shell/terminal. Do not execute any agent request.
          try { send({ id: msg.id, error: {
            code: -32601, message: 'Method not available'
          } }); } catch { /* closed */ }
        }
      } else if (msg.method === 'session/update' && sessionId &&
                 msg.params?.sessionId === sessionId && updatesLeft > 0) {
        const update = msg.params?.update;
        if (!object(update) || typeof update.sessionUpdate !== 'string') return;
        updatesLeft--;
        try {
          // Only a bounded text chunk or the update kind; do not forward
          // file paths, tool inputs, permission options or raw JSON.
          const chunk = update.content;
          const text = object(chunk) && chunk.type === 'text' &&
            typeof chunk.text === 'string' && update.sessionUpdate === 'agent_message_chunk'
              ? chunk.text.slice(0, 2048) : null;
          onUpdate({ type: update.sessionUpdate.slice(0, 64), text });
        } catch { /* observer cannot compromise the lease-bound channel */ }
      }
      return;
    }
    if (msg.id === undefined) {
      abort('acp_invalid_frame');
      return;
    }
    const row = pending.get(msg.id);
    if (!row || (msg.error !== undefined && msg.result !== undefined)) {
      abort('acp_unexpected_response');
      return;
    }
    pending.delete(msg.id);
    clearTimeout(row.timer);
    if (msg.error !== undefined || !object(msg.result)) row.reject(fail('acp_rpc_refused'));
    else row.resolve(msg.result);
  };
  const onData = chunk => {
    if (closed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (!closed) {
      const end = data.indexOf(10, start);
      if (end < 0) break;
      const segment = data.subarray(start, end);
      if (received.length + segment.length > FRAME_LIMIT) {
        abort('acp_frame_oversized'); return;
      }
      const line = received.length ? Buffer.concat([received, segment]) : segment;
      received = Buffer.alloc(0);
      start = end + 1;
      if (line.length) onFrame(line);
    }
    if (closed) return;
    const tail = data.subarray(start);
    if (received.length + tail.length > FRAME_LIMIT) {
      abort('acp_frame_oversized'); return;
    }
    received = received.length ? Buffer.concat([received, tail]) : Buffer.from(tail);
  };
  stdout.on('data', onData);
  stdout.once('end', onExit);
  stdout.once('error', onExit);
  stdin.once?.('error', onExit);

  const rpc = (method, params, ms) => {
    if (closed) return Promise.reject(fail('acp_transport_closed'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(fail('acp_rpc_timeout'));
        // A late response is not safe to correlate; destroy this transport.
        abort('acp_rpc_timeout');
      }, ms);
      // A pending RPC must keep the event loop alive until its deadline.
      // Unref would strand the promise on Node 22 when no other handles exist.
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); }
      catch (error) {
        if (pending.has(id)) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      }
    });
  };
  return Object.freeze({
    async newSession({ cwd } = {}) {
      if (closed) throw fail('acp_transport_closed');
      if (sessionId || preparing) throw fail('acp_session_already_open');
      // Caller supplies this from the authenticated registered worktree,
      // NEVER from an agent message or an MCP tool argument.
      if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 4096 ||
          cwd.includes('\0')) throw fail('acp_invalid_cwd');
      preparing = true;
      try {
        const result = await rpc('session/new', { cwd, mcpServers: [] }, sessionTimeoutMs);
        if (typeof result.sessionId !== 'string' || !ID.test(result.sessionId)) {
          abort('acp_invalid_session_id');
          throw fail('acp_invalid_session_id');
        }
        sessionId = result.sessionId;
        return { ok: true, session_id: sessionId };
      } finally { preparing = false; }
    },
    async prompt(text) {
      if (closed) throw fail('acp_transport_closed');
      if (!sessionId) throw fail('acp_session_not_open');
      if (prompting) throw fail('acp_prompt_busy');
      if (typeof text !== 'string' || !text.trim() ||
          Buffer.byteLength(text, 'utf8') > PROMPT_LIMIT) throw fail('acp_prompt_invalid');
      prompting = true;
      try {
        const result = await rpc('session/prompt', {
          sessionId, prompt: [{ type: 'text', text }]
        }, promptTimeoutMs);
        if (!STOP_REASONS.has(result.stopReason)) {
          abort('acp_invalid_stop_reason');
          throw fail('acp_invalid_stop_reason');
        }
        return { ok: true, stop_reason: result.stopReason };
      } finally { prompting = false; }
    },
    cancel() {
      if (closed || !sessionId || !prompting) return false;
      try { send({ method: 'session/cancel', params: { sessionId } }); }
      catch { return false; }
      return true;
    },
    status: () => ({ state: closed ? 'closed' : sessionId ? 'session_ready' : 'initialized',
      busy: prompting }),
    close: () => abort('acp_transport_closed')
  });
}
