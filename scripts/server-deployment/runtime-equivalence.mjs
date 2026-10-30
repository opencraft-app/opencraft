import { readFile } from 'node:fs/promises';

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

