import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

// A receipt reopens an installation's completed comparison. It is not a
// substitute for verifying new payloads, nor an audit of immutable files.
export async function releaseMetadataIdentity(root) {
  try {
    const hash = createHash('sha256');
    for (const [name, limit] of [['package.json', 65536], ['web/version.json', 65536],
      ['release/full-release.json', 16 * 1024 ** 2], ['release/full-release.sig', 65536]]) {
      const path = join(root, name), info = await lstat(path);
      if (!info.isFile() || info.size > limit) return null;
      const content = await readFile(path);
      hash.update(name).update('\0').update(String(content.length)).update('\0').update(content);
    }
    return hash.digest('hex');
  } catch { return null; }
}

export async function linuxProcessIdentity(pid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const [boot, stat] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    if (!/^[0-9]+$/.test(fields[19] || '') || ['Z', 'X'].includes(fields[0])) return null;
    return { pid, bootId: boot.trim(), startTicks: fields[19] };
  } catch { return null; }
}

export function sameProcess(left, right) {
  return !!left && !!right && Number.isSafeInteger(left.pid) && left.pid > 0
    && typeof left.bootId === 'string' && left.bootId.length > 0
    && /^[0-9]+$/.test(left.startTicks || '')
    && left.pid === right.pid && left.bootId === right.bootId && left.startTicks === right.startTicks;
}

export async function readEquivalenceReceipt(path, expected) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 8192 || (info.mode & 0o077)
      || (process.getuid && info.uid !== process.getuid())) return false;
    const record = JSON.parse(await readFile(path, 'utf8'));
    return Object.keys(expected).every(key => key === 'process'
      ? sameProcess(record.process, expected.process) : record[key] === expected[key]);
  } catch { return false; }
}

export async function writeEquivalenceReceipt(path, record) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch { /* An unavailable optimization cannot change readiness. */ }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
