'use strict';
const { randomUUID } = require('node:crypto');
const { THUMBNAIL_LIMIT, FAVICON_LIMIT } = require('@opencraft/browser-core/presentation');
/** Owned by the physical page. Reads never capture, navigate, or activate media. */
function createPresentation({ capture, fetchIcon, decode, document, notify, now = Date.now }) {
  let closed = false, generation = 0, lastCapture = -Infinity, pending = null, iconAbort = null;
  let value;
  const publish = () => { value = { ...value, revision: randomUUID(), updatedAt: now() }; notify({ version: 1, document: value.document, revision: value.revision, updatedAt: value.updatedAt }); };
  const reset = () => { generation++; iconAbort?.abort(); iconAbort = null; lastCapture = -Infinity;
    value = { version: 1, document: document(), revision: randomUUID(), updatedAt: now(), thumbnail: null, favicon: null }; if (!closed) publish(); };
  reset();
  const thumbnail = async (image) => {
    if (closed || pending || now() - lastCapture < 5000) return;
    lastCapture = now(); const epoch = generation;
    pending = (async () => { try {
      const source = image ?? await capture();
      if (closed || epoch !== generation || source.isEmpty()) return;
      const size = source.getSize(), width = Math.min(360, size.width), height = Math.min(450, Math.round(size.height * width / size.width));
      if (!width || !height) return;
      const bytes = source.crop({ x: 0, y: 0, width: size.width, height: Math.min(size.height, Math.round(height * size.width / width)) }).resize({ width, height }).toJPEG(65);
      const src = 'data:image/jpeg;base64,' + bytes.toString('base64');
      if (src.length > THUMBNAIL_LIMIT || src === value.thumbnail) return;
      value = { ...value, thumbnail: src }; publish();
    } catch {} })();
    try { await pending; } finally { pending = null; if (!closed && epoch !== generation) void thumbnail(); }
  };
  const favicon = async urls => {
    iconAbort?.abort(); const controller = new AbortController(); iconAbort = controller; const epoch = generation;
    try {
      const url = Array.isArray(urls) ? urls.find(v => typeof v === 'string' && v.length < 8192 && /^(https?:|data:image\/(?:png|jpeg|webp|x-icon|vnd.microsoft.icon);base64,)/i.test(v)) : null;
      if (!url) { if (!closed && value.favicon) { value = { ...value, favicon: null }; publish(); } return; }
      const timer = setTimeout(() => controller.abort(), 5000); let bytes, mime;
      try {
        const response = await fetchIcon(url, { signal: controller.signal });
        if (!response.ok || Number(response.headers.get('content-length')) > 262144) return;
        mime = response.headers.get('content-type')?.split(';')[0] || 'image/x-icon';
        const reader = response.body?.getReader(); if (!reader) return;
        const chunks = []; let length = 0;
        try { while (true) { const next = await reader.read(); if (next.done) break; length += next.value.length;
          if (length > 262144) { await reader.cancel(); return; } chunks.push(Buffer.from(next.value)); } }
        finally { reader.releaseLock(); }
        bytes = Buffer.concat(chunks);
      } finally { clearTimeout(timer); }
      if (closed || controller.signal.aborted || epoch !== generation) return;
      const image = await decode(bytes, mime); if (closed || controller.signal.aborted || epoch !== generation || image.isEmpty()) return;
      const size = image.getSize(); if (size.width > 4096 || size.height > 4096) return;
      const src = 'data:image/png;base64,' + image.resize({ width: 32, height: 32 }).toPNG().toString('base64');
      if (src.length > FAVICON_LIMIT || src === value.favicon) return;
      value = { ...value, favicon: src }; publish();
    } catch {} finally { if (iconAbort === controller) iconAbort = null; }
  };
  return { read: () => value, reset, thumbnail, favicon, close() { closed = true; generation++; iconAbort?.abort(); } };
}
module.exports = { createPresentation };
