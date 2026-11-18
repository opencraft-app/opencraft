import { Readable } from 'node:stream';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, normalize, relative, sep } from 'node:path';
import { ArtifactCatalog, artifactFileBody, type Artifact } from './catalog.js';
import { captureGeneratedImage, type GeneratedFileReader } from './generated-output.js';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const INLINE_LIMIT = 32 * 1024 * 1024;
const extensions: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/webm': 'weba',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'image/png': 'png', 'image/jpeg': 'jpg',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
/** `type/subtype` with optional parameters such as `audio/webm;codecs=opus`. */
const MIME = /^[\w.+-]+\/[\w.+-]+(?:[ \t]*;[ \t]*[\w.+-]+=(?:[\w.+-]+|"[^"\\\r\n]*"))*$/;

interface Output { slot: string; mimeType: string; name?: string; base64?: string; text?: string; savedPath?: string; invalid?: string }
function dataOutput(slot: string, url: unknown): Output | null {
  const match = /^data:([^,]+?);base64,(.*)$/s.exec(text(url));
  return match ? { slot, mimeType: match[1]!, base64: match[2]! } : null;
}

/** Only explicit delivered content is captured; prose, URLs and workspace edits are not outputs. */
function outputs(item: Record<string, unknown>): Output[] {
  const result = record(item.result);
  const content = item.type === 'mcpToolCall' ? result.content
    : item.type === 'dynamicToolCall' ? item.contentItems : item.output;
  const found: Output[] = [];
  if (Array.isArray(content)) content.forEach((value, index) => {
    const block = record(value), slot = `content:${index}`;
    if (['audio', 'image'].includes(text(block.type)) && typeof block.data === 'string') {
      found.push({ slot, mimeType: text(block.mimeType), base64: block.data });
    } else if (block.type === 'resource') {
      const resource = record(block.resource);
      if (typeof resource.blob === 'string' || typeof resource.text === 'string') {
        found.push({ slot, mimeType: text(resource.mimeType) || (typeof resource.text === 'string' ? 'text/plain' : 'application/octet-stream'),
          base64: typeof resource.blob === 'string' ? resource.blob : undefined,
          text: typeof resource.text === 'string' ? resource.text : undefined });
      }
    } else {
      const data = dataOutput(slot, block.imageUrl ?? block.audioUrl ?? block.image_url ?? block.audio_url);
      if (data) found.push(data);
    }
  });
  // Producer contract for large files: explicit immutable output IDs and execution-side paths.
  // A malformed entry is reported on its own and never discards valid siblings.
  const artifacts = record(result.structuredContent).artifacts;
  if (item.type === 'mcpToolCall' && Array.isArray(artifacts)) {
    const slots = new Set<string>();
    artifacts.forEach((value, index) => {
      const output = record(value), id = text(output.id);
      if (!id || id.length > 512 || slots.has(id)) {
        found.push({ slot: `artifact-index:${index}`, mimeType: '', invalid: 'Invalid generated output identity' });
        return;
      }
      slots.add(id);
      found.push({ slot: `artifact:${id}`, name: text(output.name), mimeType: text(output.mimeType),
        base64: typeof output.dataBase64 === 'string' ? output.dataBase64 : undefined,
        savedPath: text(output.savedPath) });
    });
  }
  return found;
}

export interface GeneratedOutputOptions {
  /**
   * Directories a tool-declared `savedPath` may name. Tool output is untrusted, so
   * without an explicit root every path-only output is rejected (fail closed).
   */
  readonly savedPathRoots?: readonly string[];
}

const contains = (base: string, path: string) => {
  const rest = relative(base, path);
  return !!rest && rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest);
};
/**
 * Local reads resolve symbolic links on both sides. A custom execution reader owns the
 * remote filesystem, so only the declared path is checked lexically before it is asked.
 */
async function insideRoots(path: string, roots: readonly string[], local: boolean): Promise<boolean> {
  if (!roots.length || !isAbsolute(path) || path.includes('\0')) return false;
  if (!local) return roots.some(root => isAbsolute(root) && normalize(path) === path && contains(normalize(root), path));
  let actual: string;
  try { actual = await realpath(path); } catch { return false; }
  for (const root of roots) {
    try { if (contains(await realpath(root), actual)) return true; } catch { /* unavailable root */ }
  }
  return false;
}

export async function captureGeneratedOutputs(catalog: ArtifactCatalog, scope: string, threadId: string,
  item: Record<string, unknown>, reader?: GeneratedFileReader,
  signal?: AbortSignal, options: GeneratedOutputOptions = {}): Promise<Artifact[]> {
  const read: GeneratedFileReader = reader ?? (async path => ({ body: artifactFileBody(path), dispose: async () => {} }));
  if (item.type === 'imageGeneration') {
    const image = await captureGeneratedImage(catalog, scope, threadId, item, read, signal);
    return image ? [image] : [];
  }
  if (!['mcpToolCall', 'dynamicToolCall', 'functionCallOutput'].includes(text(item.type))
    || !threadId || !text(item.id) || item.error || item.success === false || record(item.result).isError === true
    || item.status && !['completed', 'complete', 'success'].includes(text(item.status))) return [];
  const captured: Artifact[] = [], failures: unknown[] = [];
  const owner = JSON.stringify(['thread', threadId]);
  for (const output of outputs(item)) {
    try {
      signal?.throwIfAborted();
      if (output.invalid) throw Error(output.invalid);
      const key = JSON.stringify(['generation', threadId, item.id, output.slot]);
      const slot = JSON.stringify(['output', item.id, output.slot]);
      // History replay of a path output reuses the committed copy; its source may be gone.
      // Inline bytes are always re-ingested so changed content for one slot is rejected.
      if (output.savedPath && output.base64 === undefined && output.text === undefined) {
        const existing = catalog.get(catalog.id({ scope, key }));
        if (existing) { catalog.retain(existing.id, owner, slot); captured.push(existing); continue; }
      }
      if (output.mimeType.length > 255 || !MIME.test(output.mimeType)) throw Error('Invalid generated output MIME type');
      const baseType = output.mimeType.split(';')[0]!.trim().toLowerCase();
      const name = output.name || (output.savedPath ? basename(output.savedPath) : `generated.${extensions[baseType] ?? 'bin'}`);
      if (!name || name.length > 255 || /[\\/\0]/.test(name)) throw Error('Invalid generated output name');
      let body: Readable, dispose = async () => {};
      if (output.base64 !== undefined) {
        const encoded = output.base64;
        if (encoded.length > Math.ceil(INLINE_LIMIT / 3) * 4 || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw Error('Invalid generated output encoding');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length > INLINE_LIMIT || bytes.toString('base64') !== encoded) throw Error('Invalid generated output bytes');
        body = Readable.from([bytes]);
      } else if (output.text !== undefined) {
        if (Buffer.byteLength(output.text) > INLINE_LIMIT) throw Error('Generated output exceeds inline budget');
        body = Readable.from([Buffer.from(output.text)]);
      } else if (output.savedPath) {
        if (!await insideRoots(output.savedPath, options.savedPathRoots ?? [], !reader)) throw Error('Generated output path is outside authorized roots');
        const file = await read(output.savedPath, signal); body = file.body; dispose = file.dispose;
      } else { throw Error('Generated output requires bytes or an authorized saved path'); }
      try {
        captured.push(await catalog.ingest({ scope, key }, { name, mimeType: output.mimeType, origin: 'generation' }, body,
          { maxBytes: 1024 ** 3, signal, reference: { owner, slot } }));
      } finally { await dispose(); }
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Some generated outputs could not be saved');
  return captured;
}
