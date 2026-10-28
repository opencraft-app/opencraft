import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Linux/systemd is the first supported OS-work authority. Unknown topology
 * never certifies idle. Include nested delegated cgroups and all descendants. */
export function inspectOwnerCgroup(nativePids) {
  try {
    const relative = readFileSync('/proc/self/cgroup', 'utf8').trim().match(/^0::(\/[^\n]+\.service)$/m)?.[1];
    if (!relative || relative.split('/').includes('..')) throw new Error('Unsupported cgroup');
    const pids = new Set();
    const collect = path => {
      for (const pid of readFileSync(join(path, 'cgroup.procs'), 'utf8').trim().split(/\s+/).filter(Boolean)) pids.add(Number(pid));
      for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) collect(join(path, entry.name));
    };
    collect('/sys/fs/cgroup' + relative);
    if (!pids.has(process.pid)) throw new Error('Cgroup identity changed');
    pids.delete(process.pid); for (const pid of nativePids) { if (!pids.delete(pid)) throw new Error("Native peer escaped owner cgroup"); }
    return { coverage: 'complete', activeCount: pids.size };
  } catch { return { coverage: 'unknown', activeCount: null }; }
}
