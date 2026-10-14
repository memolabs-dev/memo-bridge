// Binary payloads of operator results (repatriated tools, spec D1 and D2): the image bytes of
// operator_read_media (`media[].base64`) and the chunk of operator_read_chunk (`content_base64`).
// The agent redacts and bounds text before it leaves the host (operator-output.mjs); base64 is
// not text: a redaction pattern could match inside it and corrupt it, and the 128 KiB bound would
// cut it. So these two fields are taken out before finalizeResult and put back after, unchanged.
// Each tool bounds its own bytes (MEDIA_BUDGET_BYTES, 64 KiB chunks), and only well-formed base64
// passes: anything else stays in the result and goes through the redactor like any string.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
export const MAX_BINARY_BYTES = 900 * 1024;

export function detachBinary(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.ok === false) return { rest: data, attach: out => out };
  let budget = MAX_BINARY_BYTES;
  const take = value => {
    if (typeof value !== 'string' || value.length > budget || !BASE64_RE.test(value)) return null;
    budget -= value.length;
    return value;
  };
  const chunk = take(data.content_base64);
  const media = Array.isArray(data.media) ? data.media.map(m => (m && typeof m === 'object' ? take(m.base64) : null)) : [];
  if (chunk === null && !media.some(Boolean)) return { rest: data, attach: out => out };
  const rest = { ...data };
  if (chunk !== null) delete rest.content_base64;
  if (media.some(Boolean)) rest.media = data.media.map((m, i) => (media[i] ? { ...m, base64: '' } : m));
  return {
    rest,
    attach(out) {
      if (!out || typeof out !== 'object' || out.ok === false) return out;
      const back = { ...out };
      if (chunk !== null) back.content_base64 = chunk;
      if (Array.isArray(back.media)) back.media = back.media.map((m, i) => (media[i] && m && typeof m === 'object' ? { ...m, base64: media[i] } : m));
      return back;
    }
  };
}
