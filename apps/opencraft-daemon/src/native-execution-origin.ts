import { readFile, stat } from "node:fs/promises";

export interface NativeExecutionProcess {
  readonly pid: number;
  readonly startTicks: string;
  readonly incarnation: string;
}
/** Only pass a PID obtained from the managed local Host's verified attachment.
 * The process birth and machine boot fence PID reuse; no environment string is authority. */
export async function observeNativeExecutionProcess(pid: number): Promise<NativeExecutionProcess> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) throw new Error("Native process origin unavailable");
  const start = async () => {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const ticks = value.slice(value.lastIndexOf(")") + 1).trim().split(/\s+/u)[19];
    if (!ticks || !/^\d+$/u.test(ticks)) throw new Error("Native process identity unavailable");
    return ticks;
  };
  const before = await start(), owner = await stat(`/proc/${pid}`);
  if (owner.uid !== process.getuid!()) throw new Error("Native process owner mismatch");
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (before !== await start()) throw new Error("Native process incarnation changed");
  return Object.freeze({ pid, startTicks: before, incarnation: JSON.stringify(["process", bootId, pid, before]) });
}

/** Authenticated standalone Core health attests its direct native child. Routed
 * deployments must use their generation registry instead of this process key. */
export async function observeStandaloneCodexExecution(health: { pid: number; codexPid: number; appServerPid?: number; routingEpoch?: string }): Promise<NativeExecutionProcess> {
  if (health.routingEpoch) throw new Error("Routed Codex requires generation execution identity");
  const owner = await observeNativeExecutionProcess(health.appServerPid ?? health.pid);
  const native = await observeNativeExecutionProcess(health.codexPid);
  const stat = await readFile(`/proc/${native.pid}/stat`, "utf8");
  if (Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u)[1]) !== owner.pid
    || (await observeNativeExecutionProcess(owner.pid)).incarnation !== owner.incarnation
    || (await observeNativeExecutionProcess(native.pid)).incarnation !== native.incarnation) throw new Error("Standalone Codex process ownership changed");
  return native;
}
