import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Fingerprint the immutable browser payload, including nested native files.
 * Compare executable capability after the owned mount normalizes permissions.
 * Stream large binaries; this runs at deployment/owner attachment, never per frame. */
export async function browserRuntimeIdentity(directory) {
  const hash = createHash('sha256');
  async function visit(prefix = '') {
    const entries = await readdir(join(directory, prefix), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, relative);
      if (entry.isDirectory()) { await visit(relative); continue; }
      if (!entry.isFile()) throw new Error('Browser runtime must contain only regular files and directories');
      const info = await stat(path);
      hash.update(JSON.stringify([relative, info.size, Number(Boolean(info.mode & 0o111))])); hash.update('\0');
      for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
      hash.update('\0');
    }
  }
  await visit();
  return hash.digest('hex');
}

/** Candidate read failures must not authorize attachment or empty-owner stop.
 * A retained payload that cannot be identified is not verified as current;
 * its inventory still decides whether replacement is safe. */
export async function browserRuntimeMatches(directory, retainedDirectory) {
  const candidate = await browserRuntimeIdentity(directory);
  return retainedBrowserRuntimeMatches(candidate, retainedDirectory);
}

/** A prepared connector owns the identity of its immutable candidate payload;
 * each distinct retained mount still needs a complete byte comparison. */
export async function retainedBrowserRuntimeMatches(candidate, retainedDirectory) {
  try { return candidate === await browserRuntimeIdentity(retainedDirectory); }
  catch { return false; }
}
