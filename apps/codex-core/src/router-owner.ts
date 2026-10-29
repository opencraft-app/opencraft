import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CodexGenerationRegistry } from "./generation-registry.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type State = { version: 1; epoch: number; phase: "open" | "fenced" | "released" | "cold-ready";
  operationId?: string; fence?: string; sourceOwner?: string; sealed?: string; configuration?: string;
  ready?: { owner: string; identity: string }; pending?: string[]; uncertain: boolean };
export interface RouterExpectation { expectedOwner: string; expectedEpoch: number; operationId: string; fence: string }
export interface RouterObservation { coverage: "complete" | "unknown"; activeCount: number; historicalCount: number; counts: Record<string, number> }

/** Registry authority only. Native processes and HOME writers remain independent. */
export class CodexRouterOwner {
  readonly owner = randomUUID();
  readonly incarnation = randomUUID();
  readonly bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  private state: State;
  private failed = false;
  private calls = 0;
  private busy = false;
  private proof?: { identity: string; expires: number; storage: string };
  constructor(private readonly registry: CodexGenerationRegistry) {
    const stored = registry.metadata("router-handoff") as State | null;
    this.state = stored ?? { version: 1, epoch: 0, phase: "open", uncertain: false };
    if (this.state.version !== 1 || !Number.isSafeInteger(this.state.epoch) || this.state.epoch < 0
      || !["open", "fenced", "released", "cold-ready"].includes(this.state.phase) || typeof this.state.uncertain !== "boolean"
      || this.state.phase !== "open" && (![this.state.operationId, this.state.fence, this.state.sourceOwner].every(v => typeof v === "string" && v.length > 0))
      || ["released", "cold-ready"].includes(this.state.phase) && (!this.state.sealed || !this.state.configuration)) throw new Error("Invalid router handoff state");
    if (this.state.pending?.length || this.state.uncertain) throw new Error("Router accepted work is unconfirmed; recovery required");
    if (this.state.phase === "fenced") throw new Error("Router old writer release is unconfirmed; recovery required");
    if (this.state.phase !== "open" && this.storage() !== this.state.sealed) throw new Error("Router current registry differs from release");
  }
  isOpen = () => !this.failed && !this.busy && this.state.phase === "open";
  enter(reconciliation = false) {
    const sourceReply = reconciliation && !this.failed && !this.busy && this.state.phase === "fenced" && this.state.sourceOwner === this.owner;
    if (!this.isOpen() && !sourceReply) throw new Error("Router admission is fenced");
    return this.retain();
  }
  retainNativeCallback() {
    if (this.failed || this.busy || !["open", "fenced"].includes(this.state.phase)
      || this.state.phase === "fenced" && this.state.sourceOwner !== this.owner) throw new Error("Router callback admission is unconfirmed");
    return this.retain();
  }
  retainConnectionTool() {
    if (this.failed || !this.calls || !["open", "fenced"].includes(this.state.phase)) throw new Error("Router tool admission is unconfirmed");
    return this.retain();
  }
  private retain() {
    const id = randomUUID();
    this.save({ ...this.state, pending: [...(this.state.pending ?? []), id] });
    this.calls++; let done = false;
    return () => { if (!done) { done = true; this.calls--; this.save({ ...this.state, pending: this.state.pending?.filter(value => value !== id) }); } };
  }
  uncertain() { this.save({ ...this.state, uncertain: true }); }
  private storage() { return digest(this.registry.coldSnapshot()); }
  private save(state: State) {
    try { this.registry.setMetadata("router-handoff", state); this.state = state; }
    catch (error) { this.failed = true; throw error; }
  }
  snapshot() { return { ...this.state, owner: this.owner, incarnation: this.incarnation, bootId: this.bootId,
    protocolVersion: 1, pid: process.pid, activeCalls: this.calls, persistence: this.failed ? "unknown" : "ready" }; }
  private check(input: RouterExpectation, existing = true) {
    if (this.failed || input.expectedOwner !== this.owner || input.expectedEpoch !== this.state.epoch
      || ![input.operationId, input.fence].every(v => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(v))
      || existing && (input.operationId !== this.state.operationId || input.fence !== this.state.fence)) throw new Error("Router handoff conflict");
  }
  fence(input: RouterExpectation) {
    this.check(input, this.state.phase !== "open");
    if (this.state.phase !== "open") return;
    this.save({ version: 1, epoch: this.state.epoch + 1, phase: "fenced", operationId: input.operationId,
      fence: input.fence, sourceOwner: this.owner, pending: this.state.pending, uncertain: this.state.uncertain });
  }
  abort(input: RouterExpectation) {
    this.check(input);
    if (this.state.phase !== "fenced" || this.state.sourceOwner !== this.owner || this.busy) throw new Error("Router source cannot abort after release");
    this.save({ ...this.state, phase: "open" });
  }
  inspect(input: RouterExpectation, observation: RouterObservation) {
    this.check(input);
    const coverage = this.failed || this.state.uncertain ? "unknown" : observation.coverage;
    const proof = { ownerId: this.owner, operationId: this.state.operationId, epoch: this.state.epoch, fence: this.state.fence,
      bootId: this.bootId, incarnation: this.incarnation, expiresAt: new Date(Date.now() + 15000).toISOString(), coverage,
      activeCount: coverage === "complete" ? observation.activeCount + this.calls : null, historicalCount: observation.historicalCount, counts: observation.counts };
    const identity = digest(proof);
    this.proof = proof.activeCount === 0 ? { identity, expires: Date.parse(proof.expiresAt), storage: this.storage() } : undefined;
    return { ...proof, identity };
  }
  release(input: RouterExpectation & { proof?: string }, observation: RouterObservation, configuration: string) {
    this.check(input);
    if (this.busy || this.state.phase !== "fenced" || this.state.uncertain || this.calls || observation.coverage !== "complete" || observation.activeCount
      || !this.proof || this.proof.identity !== input.proof || this.proof.expires <= Date.now() || this.storage() !== this.proof.storage) throw new Error("Router is not drained or exact proof changed");
    this.save({ ...this.state, phase: "released", sealed: this.proof.storage, configuration });
  }
  async coldReady(input: RouterExpectation, configuration: string, readNative: () => Promise<unknown>) {
    this.check(input);
    if (this.busy || !["released", "cold-ready"].includes(this.state.phase) || this.state.sourceOwner === this.owner) throw new Error("Cold router successor required");
    this.busy = true;
    try {
      if (configuration !== this.state.configuration || this.storage() !== this.state.sealed) throw new Error("Router configuration or current registry changed");
      const native = await readNative();
      if (this.storage() !== this.state.sealed) throw new Error("Router registry changed during cold read");
      const value = { owner: this.owner, bootId: this.bootId, incarnation: this.incarnation, storageSha256: this.state.sealed,
        manifestSha256: createHash("sha256").update(readFileSync(process.argv[1]!)).digest("hex"), configurationSelectorSha256: configuration,
        capabilitySha256: digest({ protocol: 1, node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch, native }), storageOutcome: "ready" };
      const identity = digest(value);
      this.save({ ...this.state, phase: "cold-ready", ready: { owner: this.owner, identity } });
      return { ...value, identity, evidenceId: identity };
    } finally { this.busy = false; }
  }
  async resume(input: RouterExpectation & { identity?: string }, configuration: string, readNative: () => Promise<unknown>) {
    this.check(input);
    if (this.state.phase !== "cold-ready" || this.state.ready?.owner !== this.owner || input.identity !== this.state.ready.identity) throw new Error("Router readiness incarnation changed");
    const ready = await this.coldReady(input, configuration, readNative);
    if (ready.identity !== input.identity) throw new Error("Router cold readiness changed");
    this.save({ ...this.state, phase: "open", sealed: undefined, ready: undefined });
  }
}
