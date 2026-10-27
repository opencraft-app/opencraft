import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, writeFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ARCHIVE_BYTES, verifyArchiveIntegrity } from '../../scripts/web-deployment/archive-limits.mjs';

async function integrity(path) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return 'sha512-' + hash.digest('base64');
}
test('full runtime archives above the previous limit verify with bounded streaming', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-runtime-archive-'));
  try {
    const path = join(root, 'runtime.tgz'), file = await open(path, 'w');
    await file.truncate(256 * 1024 * 1024 + 1); await file.close();
    await verifyArchiveIntegrity(path, await integrity(path), ['sha512']);
    const oversized = await open(path, 'w'); await oversized.truncate(MAX_ARCHIVE_BYTES + 1); await oversized.close();
    await assert.rejects(verifyArchiveIntegrity(path, 'sha512-AA=='), /too large/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('local archive integrity and algorithm checks still reject changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-runtime-integrity-'));
  try {
    const path = join(root, 'release.tgz'); await writeFile(path, 'original'); const expected = await integrity(path);
    await writeFile(path, 'changed'); await assert.rejects(verifyArchiveIntegrity(path, expected), /mismatch/);
    for (const digest of ['md5-AA==', 'sha512-no:payload', 'sha256-AA=='])
      await assert.rejects(verifyArchiveIntegrity(path, digest, ['sha512']), /Invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
