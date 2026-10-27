import { createHash } from 'node:crypto';
import { stat, readFile, mkdir, open, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Parser } from 'tar';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { HARD_LIMITS, safePath, isSignatureFile, parseStrictJson, parseReplayState, acceptManifest, verifyPreflight, preflightFor } from './contract.mjs';

// Read entries as streams; never buffer executable/native payloads. This pass
// happens before extraction, and rejects aliases, duplicate paths and links.
export async function scanArchive(archive, limits = HARD_LIMITS) {
  const compressedBytes = (await stat(archive)).size;
  if (compressedBytes > limits.archiveBytes) throw new Error('Full release archive budget exceeded');
  const files = [], captured = new Map(), names = new Set();
  let bytes = 0, entries = 0;
  await new Promise((resolve, reject) => {
    const input = createReadStream(archive);
    const gunzip = createGunzip(); let streamBytes = 0; let prefix = Buffer.alloc(0);
    const counter = new Transform({ transform(chunk, encoding, done) {
      if (prefix.length < 2) prefix = Buffer.concat([prefix, chunk.subarray(0, 2 - prefix.length)]);
      // tar's Parser still auto-detects gzip after our bounded decompressor.
      // Permit exactly one gzip envelope, so every tar byte is counted here.
      if (prefix.length === 2 && prefix[0] === 0x1f && prefix[1] === 0x8b) return done(new Error('Nested gzip full release archive is unsupported'));
      streamBytes += chunk.length;
      // Include headers, padding, PAX and trailing data, not only file bodies.
      done(streamBytes > limits.unpackedBytes + limits.entries * 4096 + 1024 ? new Error('Full release expanded stream budget exceeded') : null, chunk);
    } });
    const parser = new Parser({ strict: true, gzip: false, brotli: false, zstd: false, maxMetaEntrySize: 16 * 1024, onReadEntry(entry) {
      if (failure) { entry.resume(); return; }
      try { inspect(entry); entry.resume(); } catch (error) { failed(error); }
    } });
    let failure = null;
    const failed = error => {
      if (failure) return;
      failure = error;
      input.unpipe(gunzip); gunzip.unpipe(counter); counter.unpipe(parser);
      input.destroy(); gunzip.destroy(); counter.destroy();
      // Let the current stream write unwind before destroying tar internals.
      queueMicrotask(() => parser.abort(failure));
      if (input.closed) reject(failure);
    };
    parser.on('error', failed); gunzip.on('error', failed); counter.on('error', failed);
    input.on('close', () => { if (failure) reject(failure); });
    parser.on('end', () => { if (!failure) resolve(); }); input.on('error', failed);
    function inspect(entry) {
      const path = entry.path;
      if (!path.startsWith('package/')) throw new Error('Unsafe full release archive');
      const name = path.slice(8).replace(/\/$/, '');
      if (entry.type === 'Directory' && (entry.mode & 0o7777) !== 0o755) throw new Error('Full release directory mode rejected');
      if (!name && entry.type !== 'Directory') throw new Error('Unsafe full release archive');
      if (name) safePath(name);
      if (names.has(name) || !['File', 'Directory'].includes(entry.type) || ++entries > limits.entries) throw new Error('Unsafe full release archive');
      names.add(name);
      if (entry.type === 'Directory') return;
      bytes += entry.size;
      if (!Number.isSafeInteger(bytes) || bytes > limits.unpackedBytes || ![0o644, 0o755].includes(entry.mode & 0o7777)) throw new Error('Full release content budget or mode rejected');
      const capture = isSignatureFile(name) || name === 'package.json' || name === 'web/version.json';
      const max = name === 'release/full-release.json' ? HARD_LIMITS.manifestBytes : HARD_LIMITS.metadataBytes;
      if (capture && entry.size > max) throw new Error('Full release metadata budget exceeded');
      const chunks = []; const hash = createHash('sha256'); let size = 0;
      entry.on('data', chunk => { if (failure) return; size += chunk.length; hash.update(chunk); if (capture) chunks.push(chunk); });
      entry.on('error', failed);
      entry.on('end', () => {
        if (failure) return;
        if (size !== entry.size) { failed(new Error('Full release file size mismatch')); return; }
        files.push([name, hash.digest('hex'), size, (entry.mode & 0o777) === 0o755 ? '0755' : '0644']);
        if (capture) captured.set(name, Buffer.concat(chunks));
      });
    }
    input.pipe(gunzip).pipe(counter).pipe(parser);
  });
  files.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  return { files, captured, compressedBytes, unpackedBytes: bytes, entries };
}
export async function readReplayState(path) {
  if (!path) return {};
  try {
    return parseReplayState(await readFile(path));
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
export async function writeReplayState(path, value) {
  // The caller owns the deployment writer lock. Atomic replacement preserves
  // the high-water mark through process failure and rollback.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.tmp';
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const parent = await open(dirname(path), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}
export async function verifyFullArchive(archive, trust, { state = {}, preflight = null, now = Date.now() } = {}) {
  const scanned = await scanArchive(archive);
  const bytes = scanned.captured.get('release/full-release.json');
  const sig = scanned.captured.get('release/full-release.sig');
  if (!bytes || !sig) throw new Error('Full release manifest or signature is missing from archive');
  const envelope = parseStrictJson(sig, HARD_LIMITS.metadataBytes);
  const accepted = acceptManifest(bytes, envelope, trust, state, preflight, now);
  const payload = scanned.files.filter(([name]) => !isSignatureFile(name));
  const expected = accepted.record.components.flatMap(c => c.fileList).sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  if (JSON.stringify(payload) !== JSON.stringify(expected)) throw new Error('Full release file list mismatch');
  const budgets = accepted.record.budgets.outer;
  if (scanned.compressedBytes > budgets.archiveBytes || scanned.unpackedBytes > budgets.unpackedBytes || scanned.entries > budgets.entries) throw new Error('Full release declared budget exceeded');
  const pkg = parseStrictJson(scanned.captured.get('package.json'), HARD_LIMITS.metadataBytes);
  if (pkg.name !== accepted.record.transport.packageName || pkg.version !== accepted.record.transport.exactVersion) throw new Error('Full release package identity mismatch');
  const web = parseStrictJson(scanned.captured.get('web/version.json'), HARD_LIMITS.metadataBytes);
  if (web.sourceRevision !== accepted.record.release.source.revision || web.buildId !== pkg.opencraftWeb?.buildId) throw new Error('Full release source or build mismatch');
  const metadata = verifyPreflight(pkg.opencraftFullRelease, trust, now);
  if (JSON.stringify(preflightFor(accepted.record)) !== JSON.stringify(metadata)) throw new Error('Full release metadata mismatch');
  return { ...accepted, ...scanned };
}
