// Bounded, one-shot ACP JSON-RPC initialization gate. This is NOT a prompt
// transport: no model/provider permissions, provider credentials or prompts.
// Never mark a sandboxed agent running until the real child acknowledges ACP.
import { randomUUID } from 'node:crypto';

const MAX_FRAME = 64 * 1024;
const fail = code => new Error(code);

export function initializeAcp({ stdin, stdout }, { timeoutMs = 3_500 } = {}) {
  if (!stdin || typeof stdin.write !== 'function' ||
      !stdout || typeof stdout.on !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    return Promise.reject(fail('acp_initialize_invalid_transport'));
  }
  const id = 'bridge-init-' + randomUUID();
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      stdout.off('data', onData);
      stdout.off('end', onEnd);
      stdout.off('error', onError);
      stdin.off?.('error', onError);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onEnd = () => finish(fail('acp_initialize_disconnected'));
    const onError = () => finish(fail('acp_initialize_disconnected'));
    const processLine = raw => {
      if (raw.length > MAX_FRAME) return finish(fail('acp_initialize_oversized'));
      const text = raw.toString('utf8').trim();
      if (!text) return;
      let msg;
      try { msg = JSON.parse(text); } catch {
        return finish(fail('acp_initialize_invalid_frame'));
      }
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
        return finish(fail('acp_initialize_invalid_frame'));
      }
      if (msg.id !== id) {
        // Notifications are permitted before initialize; other responses and
        // server-to-client requests are not evidence that init succeeded.
        if (typeof msg.method === 'string' && msg.id === undefined) return;
        if (msg.id === undefined) return finish(fail('acp_initialize_invalid_frame'));
        return finish(fail('acp_initialize_unexpected_response'));
      }
      if (msg.error || !msg.result || msg.result.protocolVersion !== 1)
        return finish(fail('acp_initialize_refused'));
      // Only acknowledge the protocol, never copy agent-provided strings or
      // request-controlled capabilities to the controller's public status.
      finish(null, Object.freeze({ protocolVersion: 1 }));
    };
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      while (!settled) {
        const end = bytes.indexOf(10, start);
        if (end < 0) break;
        const line = bytes.subarray(start, end);
        if (pending.length + line.length > MAX_FRAME)
          return finish(fail('acp_initialize_oversized'));
        processLine(pending.length ? Buffer.concat([pending, line]) : line);
        pending = Buffer.alloc(0);
        start = end + 1;
      }
      if (settled) return;
      const tail = bytes.subarray(start);
      if (pending.length + tail.length > MAX_FRAME)
        return finish(fail('acp_initialize_oversized'));
      pending = pending.length ? Buffer.concat([pending, tail]) : Buffer.from(tail);
    };
    timer = setTimeout(() => finish(fail('acp_initialize_timeout')), timeoutMs);
    stdout.on('data', onData);
    stdout.once('end', onEnd);
    stdout.once('error', onError);
    stdin.once?.('error', onError);
    const request = { jsonrpc: '2.0', id, method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} } };
    try {
      stdin.write(JSON.stringify(request) + '\n');
    } catch {
      finish(fail('acp_initialize_disconnected'));
    }
  });
}
