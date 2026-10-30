import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Resolve the owning service even when DelegateSubgroup puts its processes in a leaf. */
export function serviceCgroupRoot(relative) {
  if (typeof relative !== 'string' || !relative.startsWith('/') || /[\r\n\0]/u.test(relative)) throw new Error('Unsupported cgroup');
  const parts = relative.slice(1).split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Unsupported cgroup');
  const index = parts.findLastIndex(part => part.endsWith('.service'));
  if (index < 0) throw new Error('Unsupported cgroup');
  return '/' + parts.slice(0, index + 1).join('/');
}

/** A missing or unreadable descendant never certifies an empty owner. */
export function collectCgroupPids(root, io = { readFileSync, readdirSync }) {
  const snapshot = () => {
    const records = [];
    const pids = new Set();
    const collect = path => {
      const children = io.readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
      const members = io.readFileSync(join(path, 'cgroup.procs'), 'utf8').trim().split(/\s+/u).filter(Boolean).map(Number).sort((a, b) => a - b);
      for (const value of members) {
        if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid cgroup member');
        pids.add(value);
      }
      records.push([path, children, members]);
      for (const child of children) collect(join(path, child));
    };
    collect(root);
    return { signature: JSON.stringify(records), pids };
  };
  // A move can land after a destination was listed but before its source was
  // read. Never certify idle from one non-atomic walk during adoption.
  const first = snapshot(), second = snapshot();
  if (first.signature !== second.signature) throw new Error('Cgroup membership changed during inspection');
  return second.pids;
}

/** Linux/systemd is the first supported OS-work authority. Unknown topology
 * never certifies idle. Include nested delegated cgroups and all descendants. */
export function inspectOwnerCgroup(nativePids) {
  try {
    const relative = readFileSync('/proc/self/cgroup', 'utf8').trim().match(/^0::(\/[^\n]+)$/m)?.[1];
    const root = serviceCgroupRoot(relative);
    const pids = collectCgroupPids('/sys/fs/cgroup' + root);
    if (!pids.has(process.pid)) throw new Error('Cgroup identity changed');
    pids.delete(process.pid); for (const pid of nativePids) { if (!pids.delete(pid)) throw new Error("Native peer escaped owner cgroup"); }
    return { coverage: 'complete', activeCount: pids.size };
  } catch { return { coverage: 'unknown', activeCount: null }; }
}
