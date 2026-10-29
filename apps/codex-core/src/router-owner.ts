import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CodexGenerationRegistry } from "./generation-registry.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type State = { version: 1; epoch: number; phase: "open" | "fenced" | "released" | "cold-ready";
  operationId?: string; fence?: string; sourceOwner?: string; sealed?: string; configuration?: string;
  ready?: { owner: string; identity: string }; pending?: string[]; uncertain: boolean };
export interface RouterExpectation { expectedOwner: string; expectedEpoch: number; operationId: string; fence: string }
export interface RouterObservation { coverage: "complete" | "unknown"; activeCount: number; historicalCount: number; counts: Record<string, number> }

export interface RouterLeaseContext {
  method?: string; connectionId?: string; parentLeaseId?: string; rpcId?: string; nativeRequestId?: string;
  generationId?: string; incarnation?: number; ownerEpoch?: string; admissionEpoch?: number;
  threadId?: string; turnId?: string; callId?: string; processId?: string; processHandle?: string; operation?: string;
}
export type RouterUnknownReason = "unattributed" | "consumer-disconnected" | "native-disconnected" | "generation-replaced"
  | "native-result-unknown" | "native-resolved-before-reply" | "ambiguous-native-completion";
export interface RouterLease {
  (): void;
  readonly id: string;
  update(context: RouterLeaseContext): void;
  sent(): void;
  unknown(reason: RouterUnknownReason): void;
}
type LeaseRecord = RouterLeaseContext & { version: 1; id: string; kind: string; routerOwner: string; routerIncarnation: string;
  bootId: string; pid: number; phase: "accepted" | "sent" | "released"; acceptedAt: string; sentAt?: string; releasedAt?: string;
  uncertainty?: Partial<Record<RouterUnknownReason, { firstAt: string; lastAt: string; count: number }>> };
const RECENT_LEASES = "router-lease-recent", RECENT_LIMIT = 32;
// Only protocol identity fields cross this boundary, never params, inputs, env,
// paths, tool results or exception messages. Unsupported identity shapes stay absent.
function leaseContext(input: RouterLeaseContext): RouterLeaseContext {
  const value: Record<string, string | number> = {};
  for (const key of ["method", "connectionId", "parentLeaseId", "rpcId", "nativeRequestId", "generationId", "ownerEpoch", "threadId", "turnId", "callId", "processId", "processHandle", "operation"] as const) {
    const field = input[key];
    if (typeof field === "string" && /^[a-zA-Z0-9_:/.-]{1,256}$/u.test(field)) value[key] = field;
  }
  for (const key of ["incarnation", "admissionEpoch"] as const) if (Number.isSafeInteger(input[key]) && input[key]! >= 0) value[key] = input[key]!;
  return value;
}

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
  enter(reconciliation = false, context: RouterLeaseContext = {}): RouterLease {
    const sourceReply = reconciliation && !this.failed && !this.busy && this.state.phase === "fenced" && this.state.sourceOwner === this.owner;
    if (!this.isOpen() && !sourceReply) throw new Error("Router admission is fenced");
    return this.retain("rpc", context);
  }
  retainNativeCallback(context: RouterLeaseContext = {}): RouterLease {
    if (this.failed || this.busy || !["open", "fenced"].includes(this.state.phase)
      || this.state.phase === "fenced" && this.state.sourceOwner !== this.owner) throw new Error("Router callback admission is unconfirmed");
    return this.retain("native-callback", context);
  }
  retainConnectionTool(context: RouterLeaseContext = {}): RouterLease {
    if (this.failed || !this.calls || !["open", "fenced"].includes(this.state.phase)) throw new Error("Router tool admission is unconfirmed");
    return this.retain("connection-tool", context);
  }
  private recent(): string[] {
    const recent = this.registry.metadata(RECENT_LEASES) ?? [];
    if (!Array.isArray(recent) || recent.length > RECENT_LIMIT || !recent.every(id => typeof id === "string" && /^[a-f0-9-]{36}$/u.test(id))) throw new Error("Invalid router lease retention state");
    return recent;
  }
  private retain(kind: string, context: RouterLeaseContext): RouterLease {
    const id = randomUUID(), key = `router-lease:${id}`;
    let record: LeaseRecord = { version: 1, id, kind, routerOwner: this.owner, routerIncarnation: this.incarnation,
      bootId: this.bootId, pid: process.pid, phase: "accepted", acceptedAt: new Date().toISOString(), ...leaseContext(context) };
    this.save({ ...this.state, pending: [...(this.state.pending ?? []), id] }, { [key]: record });
    this.calls++; let done = false;
    const release = (() => {
      if (done) return; done = true;
      record = { ...record, phase: "released", releasedAt: new Date().toISOString() };
      const recent = this.recent().filter(value => value !== id);
      if (!record.uncertainty) recent.push(id);
      const expired = recent.splice(0, Math.max(0, recent.length - RECENT_LIMIT));
      this.save({ ...this.state, pending: this.state.pending?.filter(value => value !== id) },
        { [key]: record, [RECENT_LEASES]: recent }, expired.map(value => `router-lease:${value}`));
      this.calls--;
    }) as RouterLease;
    Object.assign(release, {
      id,
      update: (context: RouterLeaseContext) => {
        if (done) return;
        record = { ...record, ...leaseContext(context) }; this.save(this.state, { [key]: record });
      },
      sent: () => {
        if (done || record.sentAt) return;
        record = { ...record, phase: "sent", sentAt: new Date().toISOString() }; this.save(this.state, { [key]: record });
      },
      unknown: (reason: RouterUnknownReason) => {
        const at = new Date().toISOString(), prior = record.uncertainty?.[reason];
        record = { ...record, uncertainty: { ...record.uncertainty, [reason]: { firstAt: prior?.firstAt ?? at, lastAt: at, count: (prior?.count ?? 0) + 1 } } };
        this.save({ ...this.state, uncertain: true }, { [key]: record, [RECENT_LEASES]: this.recent().filter(value => value !== id) });
      },
    });
    return release;
  }
  uncertain(reason: RouterUnknownReason = "unattributed", context: RouterLeaseContext = {}) {
    const id = randomUUID();
    this.save({ ...this.state, uncertain: true }, { [`router-uncertainty:${id}`]: { version: 1, id, reason,
      at: new Date().toISOString(), routerOwner: this.owner, routerIncarnation: this.incarnation, bootId: this.bootId, pid: process.pid, ...leaseContext(context) } });
  }
  private storage() { return digest(this.registry.coldSnapshot()); }
  private save(state: State, evidence: Record<string, unknown> = {}, remove: readonly string[] = []) {
    try { this.registry.updateMetadata({ "router-handoff": state, ...evidence }, remove); this.state = state; }
    catch (error) {
      this.failed = true;
      // A later successful counter release must retain a failed unknown write's
      // restart barrier. Keep the conservative bit in memory for that retry.
      if (state.uncertain) this.state = { ...this.state, uncertain: true };
      throw error;
    }
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
