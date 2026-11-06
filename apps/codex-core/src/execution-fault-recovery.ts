import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { GenerationProcessIdentity } from "./generation-supervisor.js";

function validSource(value: GenerationProcessIdentity | undefined): boolean {
  if (value === undefined) return true;
  if (!value || ![value.ownerPid, value.nativePid].every(pid => Number.isSafeInteger(pid) && pid > 0)
    || ![value.ownerStart, value.nativeStart, value.cliSha256, value.cliVersion, value.unit].every(text => typeof text === "string" && text.length > 0)) return false;
  if (value.invocationId !== undefined && (typeof value.invocationId !== "string" || !value.invocationId)) return false;
  return !value.launcher || Number.isSafeInteger(value.launcher.childPid) && value.launcher.childPid > 0
    && [value.launcher.childStart, value.launcher.childExecutable, value.launcher.nodeSha256, value.launcher.entrypointSha256, value.launcher.wrapperSha256].every(text => typeof text === "string" && text.length > 0);
}
export interface ExecutionFault {
  readonly source?: GenerationProcessIdentity;
  readonly target?: GenerationProcessIdentity;
  readonly threadIds: readonly string[];
  readonly id: string;
  readonly generationId: string;
  readonly incarnation: number;
  readonly state: "recovering" | "recovered";
  readonly attempts: number;
  readonly retryAt: number;
}

/** The instance owner owns recovery; health reads only observe it. No idle/drain prerequisite. */
export class ExecutionFaultRecovery {
  private readonly faults = new Map<string, ExecutionFault>();
  private readonly evidence = new Map<string, ExecutionFault>();
  private readonly flights = new Map<string, Promise<void>>();
  private writes = Promise.resolve();
  private initialized: Promise<void> | undefined;
  private closed = false;
  constructor(private readonly file: string, private readonly changed: (fault: ExecutionFault) => void,
    private readonly now: () => number = Date.now) {}
  initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      let input: unknown;
      try { input = JSON.parse(await readFile(this.file, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (!Array.isArray(input)) throw new Error("Invalid execution recovery state");
      for (const row of input) {
        if (!row || typeof row.id !== "string" || !row.id || typeof row.generationId !== "string" || !Number.isSafeInteger(row.incarnation) || row.incarnation < 0
          || !["recovering", "recovered"].includes(row.state) || !Number.isSafeInteger(row.attempts) || row.attempts < 0
          || !Number.isFinite(row.retryAt) || !validSource(row.source) || !validSource(row.target) || row.threadIds !== undefined && (!Array.isArray(row.threadIds) || row.threadIds.some((id: unknown) => typeof id !== "string" || !id))) throw new Error("Invalid execution recovery state");
        if (this.evidence.has(row.id)) throw new Error("Duplicate execution recovery identity");
        const fault = {...row, threadIds: row.threadIds ?? []};
        this.evidence.set(fault.id, fault); this.faults.set(fault.generationId, fault);
      }
    })();
  }
  snapshot(): readonly ExecutionFault[] { return [...this.faults.values()]; }
  /** Completed source proofs remain necessary for old unknown Router leases. */
  evidenceSnapshot(): readonly ExecutionFault[] { return [...this.evidence.values()]; }
  blocked(id: string): boolean { return this.faults.get(id)?.state === "recovering"; }
  private async commit(fault: ExecutionFault): Promise<void> {
    // A failed durable write must not authorize a stop that cannot be explained after restart.
    const operation = this.writes.then(async () => {
      const rows = [...this.evidence.values()].filter(row => row.id !== fault.id).concat(fault);
      await mkdir(dirname(this.file), {recursive: true, mode: 0o700});
      const temporary = this.file + "." + randomUUID();
      try { await writeFile(temporary, JSON.stringify(rows), {mode: 0o600, flag: "wx"}); await rename(temporary, this.file); }
      finally { await unlink(temporary).catch(() => {}); }
      this.evidence.delete(fault.id); this.evidence.set(fault.id, fault);
      this.faults.set(fault.generationId, fault); this.changed(fault);
    });
    this.writes = operation.catch(() => {});
    await operation;
  }
  recover(id: string, incarnation: number, restart: (fault: ExecutionFault, rememberTarget: (target: GenerationProcessIdentity) => Promise<void>) => Promise<void>, source?: GenerationProcessIdentity, threadIds: readonly string[] = []): Promise<void> {
    if (this.closed) return Promise.resolve();
    const existing = this.flights.get(id);
    if (existing) return existing;
    const operation = (async () => {
      await this.initialize();
      const prior = this.faults.get(id);
      if (prior?.state === "recovering" && prior.retryAt > this.now()) return;
      let fault: ExecutionFault = {id: prior?.state === "recovering" ? prior.id : randomUUID(), generationId: id,
        incarnation: prior?.state === "recovering" ? prior.incarnation : incarnation,
        source: prior?.state === "recovering" ? prior.source ?? source : source, target: prior?.state === "recovering" ? prior.target : undefined,
        threadIds: prior?.state === "recovering" ? prior.threadIds : [...threadIds], state: "recovering", attempts: (prior?.state === "recovering" ? prior.attempts : 0) + 1, retryAt: 0};
      await this.commit(fault);
      if (this.closed) return;
      try {
        await restart(fault, async target => {
          if (JSON.stringify(fault.target) === JSON.stringify(target)) return;
          fault = {...fault, target}; await this.commit(fault);
        });
        await this.commit({...fault, state: "recovered"});
      } catch {
        await this.commit({...fault, retryAt: this.now() + Math.min(30_000, 1_000 * 2 ** Math.min(fault.attempts - 1, 5))});
      }
    })().finally(() => { if (this.flights.get(id) === operation) this.flights.delete(id); });
    this.flights.set(id, operation); return operation;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.flights.values()); await this.writes;
  }
}
