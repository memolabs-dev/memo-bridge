// MCP content of an operator result (repatriated tools, spec D2). Every operator result is one
// JSON text part; a result carrying `media` ([{mime, base64, ...}], operator_read_media) also gets
// one MCP image part per entry, and the text part keeps the entries' metadata without the bytes.
// OpenAI support (community forum, 2026-04-22): a ChatGPT connector does not guarantee that an
// image block becomes model-visible input, so the text part is always first and complete.
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// {data: the result without image bytes, images: [{type:'image', data, mimeType}]}
export function splitMedia(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.media)) return { data, images: [] };
  const images = [];
  const media = data.media.map(m => {
    if (!m || typeof m !== 'object') return m;
    const { base64, ...meta } = m;
    if (typeof base64 === 'string' && base64 && IMAGE_MIMES.has(m.mime) && BASE64_RE.test(base64)) {
      images.push({ type: 'image', data: base64, mimeType: m.mime });
      return { ...meta, image_part: images.length };
    }
    return meta;
  });
  return { data: { ...data, media }, images };
}

export function operatorContent(data) {
  const { data: text, images } = splitMedia(data);
  return { content: [{ type: 'text', text: JSON.stringify(text) }, ...images] };
}
