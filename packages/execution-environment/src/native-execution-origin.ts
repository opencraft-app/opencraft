import { readFile, stat } from "node:fs/promises";

/** Identity of the live process that holds an execution, as its owner reports it.
 * `pid` is meaningful only inside the owner's PID namespace (a container, a VM or this
 * machine); `incarnation` is the only value compared across components and stored in
 * execution leases. Consumers never resolve either against their own `/proc`. */
export interface ExecutionProcessIdentity {
  readonly pid: number;
  readonly incarnation: string;
}

export interface NativeExecutionProcess extends ExecutionProcessIdentity {
  readonly startTicks: string;
}

const MAX_INCARNATION = 512;

/** Validates an identity an owner reported over its authenticated endpoint (engine Host
 * `/execution-origin`, DSH Host `/health`, Codex AppServer health). Throws on anything else. */
export function reportedExecutionProcess(value: unknown): ExecutionProcessIdentity {
  const pid = (value as { pid?: unknown } | null)?.pid,
    incarnation = (value as { incarnation?: unknown } | null)?.incarnation;
  if (
    !Number.isSafeInteger(pid) ||
    (pid as number) < 1 ||
    typeof incarnation !== "string" ||
    !incarnation ||
    incarnation.length > MAX_INCARNATION
  )
    throw new Error("Execution process identity unavailable");
  return Object.freeze({ pid: pid as number, incarnation });
}

/** Owner-side, in-namespace observation: only the process that owns the PID namespace
 * the PID belongs to calls this (an owner observing itself, or the parent observing the
 * child it spawned). The process birth and machine boot fence PID reuse; no environment
 * string is authority. Everyone else receives the result over the owner's endpoint. */
export async function observeNativeExecutionProcess(pid: number): Promise<NativeExecutionProcess> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1)
    throw new Error("Native process origin unavailable");
  const start = async () => {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const ticks = value
      .slice(value.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/u)[19];
    if (!ticks || !/^\d+$/u.test(ticks)) throw new Error("Native process identity unavailable");
    return ticks;
  };
  const before = await start(),
    owner = await stat(`/proc/${pid}`);
  if (owner.uid !== process.getuid!()) throw new Error("Native process owner mismatch");
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (before !== (await start())) throw new Error("Native process incarnation changed");
  return Object.freeze({ pid, startTicks: before, incarnation: JSON.stringify(["process", bootId, pid, before]) });
}

/** Owner-side: a runtime owner (the Codex AppServer) attests its direct native child in
 * its own PID namespace and reports the result in its health; the child's parent must
 * be the owner both before and after, so a reused PID never matches. */
export async function observeOwnedChildExecution(owner: {
  ownerPid: number;
  childPid: number;
}): Promise<NativeExecutionProcess> {
  const parent = await observeNativeExecutionProcess(owner.ownerPid);
  const native = await observeNativeExecutionProcess(owner.childPid);
  const stat = await readFile(`/proc/${native.pid}/stat`, "utf8");
  if (
    Number(
      stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/u)[1],
    ) !== parent.pid ||
    (await observeNativeExecutionProcess(parent.pid)).incarnation !== parent.incarnation ||
    (await observeNativeExecutionProcess(native.pid)).incarnation !== native.incarnation
  )
    throw new Error("Native child process ownership changed");
  return native;
}
