import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Limits the kernel enforces on this process's cgroup (v2, or v1 with the CPU
 * controller co-mounted or alone). `null`: that dimension is unlimited. */
export interface CgroupLimits {
  readonly cpuMillis: number | null;
  readonly memoryBytes: number | null;
  readonly tasks: number | null;
}

const optional = async (path: string) => {
  try { return (await readFile(path, "utf8")).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};
const limit = (value: string | undefined) => {
  if (value === undefined || value === "max") return null;
  const number = Number(value);
  // cgroup v1 reports "unlimited" memory as a page-rounded maximum signed 64-bit value.
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

export async function readCgroupLimits(root = "/sys/fs/cgroup"): Promise<CgroupLimits> {
  const cpuMax = await optional(join(root, "cpu.max"));
  if (cpuMax !== undefined) {
    const [quota, period] = cpuMax.split(/\s+/u);
    return {
      cpuMillis: quota === "max" || !Number(period) ? null : Math.round(Number(quota) / Number(period) * 1000),
      memoryBytes: limit(await optional(join(root, "memory.max"))),
      tasks: limit(await optional(join(root, "pids.max"))),
    };
  }
  for (const controller of ["cpu,cpuacct", "cpuacct,cpu", "cpu"]) {
    const quota = await optional(join(root, controller, "cpu.cfs_quota_us"));
    if (quota === undefined) continue;
    const period = Number(await optional(join(root, controller, "cpu.cfs_period_us")));
    return {
      cpuMillis: Number(quota) <= 0 || !period ? null : Math.round(Number(quota) / period * 1000),
      memoryBytes: limit(await optional(join(root, "memory/memory.limit_in_bytes"))),
      tasks: limit(await optional(join(root, "pids/pids.max"))),
    };
  }
  throw Error("No mounted cgroup CPU controller");
}
