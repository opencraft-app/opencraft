import type { GenerationProcessIdentity } from "./generation-supervisor.js";

export interface FaultUnitState {pid: number; active: string; invocationId?: string}
export interface FaultStopPort {
  state(): Promise<FaultUnitState>;
  birth(pid: number): Promise<string | null>;
  stop(): Promise<void>;
  kill(): Promise<void>;
  now(): number;
  wait(): Promise<void>;
}

/** A stop may be resumed after controller death, without trusting a dead HTTP endpoint. */
export async function stopFailedGeneration(expected: GenerationProcessIdentity, port: FaultStopPort): Promise<void> {
  const sources: readonly (readonly [number, string])[] = [[expected.ownerPid, expected.ownerStart], [expected.nativePid, expected.nativeStart],
    ...(expected.launcher ? [[expected.launcher.childPid, expected.launcher.childStart] as const] : [])];
  const sourceAlive = async () => (await Promise.all(sources.map(async ([pid, birth]) => await port.birth(pid) === birth))).some(Boolean);
  const initial = await port.state();
  const sameInvocation = (state: FaultUnitState) => !!expected.invocationId && state.invocationId === expected.invocationId;
  const ownerMatches = async (state: FaultUnitState) => state.pid === expected.ownerPid && await port.birth(state.pid) === expected.ownerStart;
  const initialOwner = await ownerMatches(initial);
  if (!initialOwner && !sameInvocation(initial)) {
    if (await sourceAlive()) throw new Error("Fault recovery source no longer belongs to its unit");
    return; // Source already exited; never signal a successor or a reused PID.
  }
  const invocationId = initial.invocationId;
  const deadline = port.now() + 15_000, forceAt = port.now() + 2_000;
  await port.stop();
  let forced = false;
  for (;;) {
    const state = await port.state();
    if (state.pid === 0 && ["inactive", "failed"].includes(state.active)) {
      if (await sourceAlive()) throw new Error("Fault recovery source outlived its unit");
      return;
    }
    if ((invocationId && state.invocationId !== invocationId) || (state.pid !== 0 && !await ownerMatches(state))) {
      if (await sourceAlive()) throw new Error("Fault recovery unit changed before source exit");
      return;
    }
    if (port.now() >= deadline) throw new Error("Fault recovery stop is unconfirmed");
    if (!forced && port.now() >= forceAt) { await port.kill(); forced = true; }
    await port.wait();
  }
}
