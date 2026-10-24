import { createReadStream } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';

// Full browser runtimes ship with headless distributions. Keep both compressed
// and expanded bounds; verify large archives without buffering them in memory.
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;
export async function verifyArchiveIntegrity(path, integrity, allowedAlgorithms = ['sha512', 'sha256']) {
  const match = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity || '');
  if (!match || !allowedAlgorithms.includes(match[1])) throw new Error('Invalid release integrity');
  if ((await stat(path)).size > MAX_ARCHIVE_BYTES) throw new Error('Release archive too large');
  const hash = createHash(match[1]);
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > MAX_ARCHIVE_BYTES) throw new Error('Release archive too large');
    hash.update(chunk);
  }
  const actual = hash.digest(), expected = Buffer.from(match[2], 'base64');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Release integrity mismatch');
}
