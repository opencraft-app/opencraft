'use strict';
const { StringDecoder } = require('node:string_decoder');

// Private process-owner memory only: no files, console forwarding, persisted
// state, page socket or public API. Discard arbitrary messages; retain bounded
// fatal locations and stack symbols without arguments for incident inspection.
function createNativeDiagnostics() {
  const decoder = new StringDecoder('utf8');
  let partial = '', dropping = false, bytes = 0, discardedLines = 0, fatal = null;
  const frames = [];
  const line = value => {
    const location = value.match(/:FATAL:([\w./-]+\.(?:h|cc|cpp)):(\d{1,8})\]/);
    if (location) {
      fatal = { kind: /\bDCHECK failed:/.test(value) ? 'dcheck' : /\bCheck failed:/.test(value) ? 'check' : 'fatal',
        file: location[1].split('/').pop(), line: Number(location[2]) };
      frames.length = 0;
      return;
    }
    if (!fatal || frames.length >= 24) return;
    const stack = value.match(/^#(\d{1,3})\s+0x[\da-f]+\s+(.+)$/i);
    if (!stack) return;
    const library = stack[2].match(/^\([^()]*\/([\w.-]+\.so)\+(0x[\da-f]+)\)$/i);
    const symbol = library ? library[1] + '+' + library[2] : stack[2].split('(')[0];
    if (symbol.length <= 256 && /^[\w:~<>* &.,+\[\]-]+$/.test(symbol)) frames.push({ index: Number(stack[1]), symbol });
  };
  return {
    consume(chunk) {
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + input.length);
      for (let offset = 0; offset < input.length; offset += 2048) {
        const text = decoder.write(input.subarray(offset, offset + 2048));
        for (const [index, part] of text.split('\n').entries()) {
          if (index) { if (!dropping) line(partial); partial = ''; dropping = false; }
          if (dropping) continue;
          if (partial.length + part.length > 2048) { partial = ''; dropping = true; discardedLines++; }
          else partial += part;
        }
      }
    },
    finish() { if (!dropping && partial) line(partial); partial = ''; },
    snapshot() { return { bytes, discardedLines, fatal: fatal && { ...fatal }, frames: frames.map(frame => ({ ...frame })) }; },
  };
}
module.exports = { createNativeDiagnostics };
