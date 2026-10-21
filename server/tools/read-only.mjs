// Read-only gate (#252, docs/READER_CONTRACT.md): wraps tool registration in a stdio process
// started with --read-only or MEMO_BRIDGE_READ_ONLY, so a tool that could change anything never
// runs. Its handler is replaced by a fixed refusal, {ok:false, error:"read_only"}, returned
// before any other wrapper (implicit workspace, learning review) or the runtime is reached.
//
// A tool runs only when it is a read: one of the observation tools listed by the entry point
// (`readTools`, no store and no capability), or one whose policy capability is not a write
// capability and is held by the principal. Anything else, an unknown name included, is refused:
// a tool added later without a policy entry is refused until it gets one (fail closed).
import { z } from 'zod/v4';
import { WRITE_CAPABILITIES, operationCapability } from '../coordinator/policy.mjs';

export const READ_ONLY_ERROR = 'read_only';
export const READ_ONLY_REFUSAL = Object.freeze({ ok: false, error: READ_ONLY_ERROR,
  detail: 'this Memo Bridge process was started read-only (--read-only or MEMO_BRIDGE_READ_ONLY): it changes nothing' });

export function readOnlyAllows(name, principal, readTools = []) {
  if (readTools.includes(name)) return true;
  const capability = operationCapability(name);
  return capability !== null && !WRITE_CAPABILITIES.includes(capability) && Boolean(principal?.capabilities?.has(capability));
}

const refusal = () => ({ content: [{ type: 'text', text: JSON.stringify(READ_ONLY_REFUSAL, null, 2) }] });

// Any arguments: a refused tool answers read_only whatever it is sent, never a validation error.
const ANY_INPUT = z.object({}).loose();

// A registration target whose write tools answer read_only. Refused tools stay listed, so a
// client sees the same names as the owner's process and gets a stable code instead of
// "unknown tool".
export function withReadOnly(server, principal, { readTools = [] } = {}) {
  return {
    registerTool(name, config, handler) {
      if (readOnlyAllows(name, principal, readTools)) return server.registerTool(name, config, handler);
      return server.registerTool(name, { ...config, inputSchema: ANY_INPUT,
        description: `Refused in this read-only process (read_only). ${config.description ?? ''}`.trim() }, async () => refusal());
    }
  };
}
