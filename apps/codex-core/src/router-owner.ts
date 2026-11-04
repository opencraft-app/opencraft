import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CodexGenerationRegistry } from "./generation-registry.js";
import { routerDigest, routerNativeDigest, routerPhysicalNativeDigest, hostRestartRuntime, readRouterMaintenance, routerFileDigest, verifyRouterController, verifyRouterConsumers, processStamp, archivedHostColdUnavailable, type RouterMaintenanceReceipt } from "./router-maintenance.js";

import { OperatorLease, type OperatorLeaseClaim, type OperatorLeaseAbort, type OperatorLeaseEnd } from "./operator-lease.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type State = { version: 1; epoch: number; phase: "open" | "fenced" | "released" | "cold-ready";
  operationId?: string; fence?: string; sourceOwner?: string; sealed?: string; configuration?: string;
  ready?: { owner: string; identity: string }; pending?: string[]; uncertain: boolean;
  operatorLease?: OperatorLeaseClaim; operatorLeaseAborts?: OperatorLeaseAbort[];
  history?: string[]; currentUncertain?: boolean; maintenanceSeal?: string };
export interface RouterExpectation { expectedOwner: string; expectedEpoch: number; operationId: string; fence: string; historicalUnknownSha256?: string; operatorLease?: OperatorLeaseClaim }
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
  private operatorLease?: OperatorLease;
  private proof?: { identity: string; expires: number; storage: string };
  private maintenance?: RouterMaintenanceReceipt;
  constructor(private readonly registry: CodexGenerationRegistry, maintenanceFile?: string) {
    const stored = registry.metadata("router-handoff") as State | null;
    this.state = stored ?? { version: 1, epoch: 0, phase: "open", uncertain: false };
    if (this.state.version !== 1 || !Number.isSafeInteger(this.state.epoch) || this.state.epoch < 0
      || !["open", "fenced", "released", "cold-ready"].includes(this.state.phase) || typeof this.state.uncertain !== "boolean"
      || this.state.phase !== "open" && (![this.state.operationId, this.state.fence, this.state.sourceOwner].every(v => typeof v === "string" && v.length > 0))
      || ["released", "cold-ready"].includes(this.state.phase) && (!this.state.sealed || !this.state.configuration)) throw new Error("Invalid router handoff state");
    this.history();
    if (["open", "fenced"].includes(this.state.phase) && maintenanceFile) {
      this.maintenance = readRouterMaintenance(maintenanceFile, this.state, this.storage(), createHash("sha256").update(readFileSync(process.argv[1]!)).digest("hex"), this.historicalPending().size, this.historicalUnknownSha256());
      this.busy = true; return;
    }
    if (this.currentUnconfirmed()) throw new Error("Router accepted work is unconfirmed; recovery required");
    if (this.state.phase === "open" && this.state.history?.length) throw Error("Router historical owner restart requires explicit cold recovery");
    if (this.state.phase === "fenced") throw new Error("Router old writer release is unconfirmed; recovery required");
    if (this.state.phase !== "open" && this.storage() !== this.state.sealed) throw new Error("Router current registry differs from release");
    if (this.state.phase === "open") this.registry.updateMetadata({ "router-live-owner": this.processIdentity() });
  }
  private processIdentity() { return { owner: this.owner, incarnation: this.incarnation, pid: process.pid, startTime: processStamp(process.pid), bootId: this.bootId,
    node: process.execPath, arguments: process.argv.slice(2).flatMap((value, i, args) =>
      ["--endpoint", "--core-endpoint", "--token-file", "--data-directory", "--registry-directory", "--bootstrap-file", "--native-history-failures-file", "--systemd-scope"].includes(value) && args[i + 1]
        ? [value, args[i + 1]!] : value === "--native-only" ? [value] : []),
    bundle: process.argv[1]!, bundleSha256: createHash("sha256").update(readFileSync(process.argv[1]!)).digest("hex") }; }
  private history() {
    if (this.state.history !== undefined && (!Array.isArray(this.state.history) || new Set(this.state.history).size !== this.state.history.length)) throw Error("Invalid router historical responsibility");
    const rows = (this.state.history ?? []).map(id => {
      if (!/^[a-f0-9]{64}$/u.test(id)) throw Error("Invalid router historical identity");
      const value = this.registry.metadata(`router-history:${id}`) as { version: number; receipt: RouterMaintenanceReceipt } | null;
      if (!value || routerDigest(value) !== id || value.version !== 1 || !value.receipt?.sourceHandoff
        || value.receipt.sourceHandoff.pending !== undefined && !Array.isArray(value.receipt.sourceHandoff.pending)) throw Error("Router historical responsibility changed");
      return { id, value };
    });
    if (rows.some(row => row.value.receipt.sourceHandoff.uncertain === true || (row.value.receipt.sourceHandoff.pending as unknown[] | undefined)?.length) && !this.state.uncertain
      || rows.flatMap(row => row.value.receipt.sourceHandoff.pending as string[] | undefined ?? []).some(id => !this.state.pending?.includes(id))) throw Error("Router historical responsibility was removed");
    return rows;
  }
  private historicalPending() { return new Set(this.history().flatMap(row => row.value.receipt.sourceHandoff.pending as string[] | undefined ?? [])); }
  private currentUnconfirmed() {
    const historical = this.historicalPending();
    return this.state.currentUncertain === true || !!this.state.uncertain && !this.state.history?.length
      || (this.state.pending ?? []).some(id => !historical.has(id));
  }
  private currentUnknown() { return this.state.currentUncertain === true || !!this.state.uncertain && !this.state.history?.length; }
  historicalUnknownSha256() { return this.state.history?.length ? digest(this.history()) : undefined; }
  maintenancePending() { return this.maintenance !== undefined; }
  hostRestartPending() { const receipt = this.hostRestartReceipt(); return receipt ? { sourceBootId: receipt.source.bootId, sourceOwner: receipt.source.owner, recoveryBootId: this.bootId, ...(this.maintenance ? {} : { policyArchived: true }) } : undefined; }
  private archivedColdUnavailable() { return archivedHostColdUnavailable(this.state.history, key => this.registry.metadata(key)); }
  hostColdUnavailable() { return (this.maintenance?.native as { hostColdUnavailable?: import("./router-maintenance.js").HostColdUnavailablePolicy } | undefined)?.hostColdUnavailable ?? this.archivedColdUnavailable(); }
  hostColdUnavailableArchived() { const policy = this.hostColdUnavailable(), archived = this.archivedColdUnavailable(); return !!policy && !!archived && routerDigest(policy) === routerDigest(archived); }
  private hostRestartReceipt() { const receipt = this.maintenance ?? this.history().find(row => row.id === this.state.maintenanceSeal)?.value.receipt; return receipt?.mode === "host-restart" ? receipt : undefined; }
  continuingNative() {
    const receipt = this.maintenance ?? this.history().find(row => row.id === this.state.maintenanceSeal)?.value.receipt;
    return (receipt?.mode === "interrupted-source" || receipt?.mode === "crashed-source")
      && (receipt.native as { policy?: string } | undefined)?.policy === "continuing-v1";
  }
  currentResponsibilityConfirmed() { return !this.failed && !this.currentUnknown(); }
  async importMaintenance(configuration: string, readNative: () => Promise<unknown>) {
    const receipt = this.maintenance;
    if (!receipt || !this.busy) throw Error("Explicit router maintenance required");
    verifyRouterController(receipt); verifyRouterConsumers(receipt.consumers, receipt.systemdScope);
    const source = this.registry.metadata("router-live-owner") as Record<string, unknown> | null;
    if (source && ["pid", "startTime", "bootId", "owner", "bundleSha256"].some(key => source[key] !== (receipt.source as unknown as Record<string, unknown>)[key])) throw Error("Durable router source identity changed");
    if (receipt.configurationSha256 !== configuration || await routerFileDigest(receipt.source.bundle) !== receipt.source.bundleSha256) throw Error("Router maintenance configuration or source payload changed");
    const native = await readNative();
    if (routerNativeDigest(native) !== routerNativeDigest(receipt.native) || this.storage() !== receipt.registrySha256
      || digest(this.registry.metadata("router-handoff")) !== digest(receipt.sourceHandoff)) throw Error("Router maintenance current data or Native proof changed");
    const adoptions: { key: string; value: unknown }[] = [];
    if (receipt.mode === "host-restart") {
      const proof = native as { generations: { generationId: string; incarnation: number; previousIdentity: unknown; identity: unknown }[] };
      const generations = this.registry.list().filter(g => g.state !== "discarded");
      if (!Array.isArray(proof.generations) || proof.generations.length !== generations.length
        || new Set(proof.generations.map(g => g.generationId)).size !== generations.length) throw Error("Incomplete host runtime adoption");
      for (const g of generations) {
        const row = proof.generations.find(row => row.generationId === g.id), key = `runtime:${g.id}`;
        if (!row || row.incarnation !== g.incarnation || digest(row.previousIdentity) !== digest(this.registry.metadata(key))) throw Error("Host runtime adoption changed");
        adoptions.push({ key, value: hostRestartRuntime(row.previousIdentity, row.identity) });
      }
    }
    verifyRouterController(receipt); verifyRouterConsumers(receipt.consumers, receipt.systemdScope);
    const archive = { version: 1, receipt }, id = digest(archive);
    try {
      this.registry.metadataTransaction(() => {
        if (this.registry.metadata(`router-history:${id}`) !== null) throw Error("Router maintenance receipt already exists");
        this.registry.setMetadata(`router-history:${id}`, archive);
        for (const row of adoptions) this.registry.setMetadata(row.key, row.value);
        const next: State = { ...this.state, epoch: this.state.epoch + (this.state.phase === "open" ? 1 : 0), phase: "released", operatorLease: undefined,
          operationId: receipt.operationId, fence: receipt.fence, sourceOwner: receipt.source.owner,
          history: [...(this.state.history ?? []), id], currentUncertain: false, maintenanceSeal: id,
          uncertain: this.state.uncertain || !!this.state.pending?.length,
          sealed: this.storage(), configuration, ready: undefined };
        this.registry.setMetadata("router-handoff", next); this.state = next;
      });
      this.maintenance = undefined; this.busy = false;
    } catch (error) { this.failed = true; throw error; }
  }
  dispose() { this.operatorLease?.dispose(); this.operatorLease = undefined; }
  private expireOperatorLease(lease: OperatorLease, reason: OperatorLeaseEnd) {
    if (!lease.ended() || this.operatorLease !== lease || this.failed || this.busy || this.state.phase !== "fenced" || this.state.sourceOwner !== this.owner) return;
    const receipt: OperatorLeaseAbort = { version: 1, owner: this.owner, epoch: this.state.epoch,
      operationId: this.state.operationId!, fence: this.state.fence!, operatorLease: lease.claim, reason, abortedAt: new Date().toISOString() };
    this.save({ ...this.state, phase: "open", operatorLease: undefined,
      operatorLeaseAborts: [...(this.state.operatorLeaseAborts ?? []), receipt] });
    this.proof = undefined; this.dispose();
  }
  renewOperatorLease(input: RouterExpectation) {
    this.check(input);
    if (this.busy || this.state.phase !== "fenced" || this.state.sourceOwner !== this.owner || !this.operatorLease) throw Error("Operator lease unavailable");
    this.operatorLease.renew(input.operatorLease);
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
        this.save({ ...this.state, uncertain: true, currentUncertain: true }, { [key]: record, [RECENT_LEASES]: this.recent().filter(value => value !== id) });
      },
    });
    return release;
  }
  uncertain(reason: RouterUnknownReason = "unattributed", context: RouterLeaseContext = {}) {
    const id = randomUUID();
    this.save({ ...this.state, uncertain: true, currentUncertain: true }, { [`router-uncertainty:${id}`]: { version: 1, id, reason,
      at: new Date().toISOString(), routerOwner: this.owner, routerIncarnation: this.incarnation, bootId: this.bootId, pid: process.pid, ...leaseContext(context) } });
  }
  private storage() { return digest(this.registry.coldSnapshot()); }
  private save(state: State, evidence: Record<string, unknown> = {}, remove: readonly string[] = []) {
    try { this.registry.updateMetadata({ "router-handoff": state, ...evidence }, remove); this.state = state; }
    catch (error) {
      this.failed = true;
      // A later successful counter release must retain a failed unknown write's
      // restart barrier. Keep the conservative bit in memory for that retry.
      if (state.currentUncertain || state.uncertain && !this.state.history?.length) this.state = { ...this.state, uncertain: true, currentUncertain: true };
      throw error;
    }
  }
  snapshot() { return { ...this.state, operatorLease: this.state.operatorLease && structuredClone(this.state.operatorLease),
    operatorLeaseAborts: this.state.operatorLeaseAborts && structuredClone(this.state.operatorLeaseAborts), owner: this.owner, incarnation: this.incarnation, bootId: this.bootId,
    operatorLeaseProtocolVersion: 1, operatorLeaseStatus: this.operatorLease?.status(),
    protocolVersion: 1, pid: process.pid, activeCalls: this.calls, persistence: this.failed ? "unknown" : "ready",
    releaseKind: this.state.maintenanceSeal ? "legacy-maintenance" : "protocol",
    historicalUnknownSha256: this.historicalUnknownSha256(), historicalPendingCount: this.historicalPending().size,
    historicalUnknownSnapshots: this.history().map(row => ({ id: row.id, source: row.value.receipt.source, sourceHandoff: row.value.receipt.sourceHandoff })) }; }
  private check(input: RouterExpectation, existing = true) {
    if (this.failed || input.expectedOwner !== this.owner || input.expectedEpoch !== this.state.epoch
      || ![input.operationId, input.fence].every(v => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(v))
      || input.historicalUnknownSha256 !== this.historicalUnknownSha256()
      || existing && (input.operationId !== this.state.operationId || input.fence !== this.state.fence)) throw new Error("Router handoff conflict");
  }
  fence(input: RouterExpectation) {
    this.check(input, this.state.phase !== "open");
    if (this.state.phase !== "open") return;
    const lease = new OperatorLease(input.operatorLease, this.state.operatorLeaseAborts?.map(receipt => receipt.operatorLease.id));
    this.save({ ...this.state, operatorLease: lease.claim, version: 1, epoch: this.state.epoch + 1, phase: "fenced", operationId: input.operationId, maintenanceSeal: undefined,
      fence: input.fence, sourceOwner: this.owner, pending: this.state.pending, uncertain: this.state.uncertain });
    this.operatorLease = lease;
    lease.start(reason => this.expireOperatorLease(lease, reason), () => { this.failed = true; lease.dispose(); });
  }
  abort(input: RouterExpectation) {
    this.check(input);
    if (this.state.phase !== "fenced" || this.state.sourceOwner !== this.owner || this.busy) throw new Error("Router source cannot abort after release");
    this.save({ ...this.state, phase: "open", operatorLease: undefined });
    this.proof = undefined; this.dispose();
  }
  inspect(input: RouterExpectation, observation: RouterObservation) {
    this.check(input);
    const coverage = this.failed || this.currentUnknown() ? "unknown" : observation.coverage;
    const proof = { ownerId: this.owner, operationId: this.state.operationId, epoch: this.state.epoch, fence: this.state.fence,
      bootId: this.bootId, incarnation: this.incarnation, expiresAt: new Date(Date.now() + 15000).toISOString(), coverage,
      activeCount: coverage === "complete" ? observation.activeCount + this.calls : null, historicalCount: observation.historicalCount, counts: observation.counts,
      historicalUnknownSha256: this.historicalUnknownSha256(), historicalPendingCount: this.historicalPending().size };
    const identity = digest(proof);
    this.proof = proof.activeCount === 0 ? { identity, expires: Date.parse(proof.expiresAt), storage: this.storage() } : undefined;
    return { ...proof, identity };
  }
  release(input: RouterExpectation & { proof?: string }, observation: RouterObservation, configuration: string) {
    this.check(input);
    if (this.busy || this.state.phase !== "fenced" || this.currentUnconfirmed() || this.calls || observation.coverage !== "complete" || observation.activeCount
      || !this.proof || this.proof.identity !== input.proof || this.proof.expires <= Date.now() || this.storage() !== this.proof.storage) throw new Error("Router is not drained or exact proof changed");
    if (!this.operatorLease) throw Error("Live operator lease required");
    this.operatorLease.assertLive();
    this.save({ ...this.state, operatorLease: undefined, phase: "released", sealed: this.proof.storage, configuration });
    this.dispose();
  }
  async coldReady(input: RouterExpectation, configuration: string, readNative: () => Promise<unknown>) {
    this.check(input);
    if (this.busy || !["released", "cold-ready"].includes(this.state.phase) || this.state.sourceOwner === this.owner) throw new Error("Cold router successor required");
    this.busy = true;
    try {
      if (configuration !== this.state.configuration || this.storage() !== this.state.sealed) throw new Error("Router configuration or current registry changed");
      const native = await readNative();
      if (this.continuingNative()) {
        const receipt = this.history().find(row => row.id === this.state.maintenanceSeal)!.value.receipt;
        if (routerNativeDigest(native) !== routerNativeDigest(receipt.native)) throw Error("Continuing Native owner changed after import");
      }
      const host = this.hostRestartReceipt();
      if (host && routerPhysicalNativeDigest(native) !== routerPhysicalNativeDigest(host.native)) throw Error("Host Native owner changed after import");
      if (this.storage() !== this.state.sealed) throw new Error("Router registry changed during cold read");
      const value = { owner: this.owner, bootId: this.bootId, incarnation: this.incarnation, storageSha256: this.state.sealed,
        releaseKind: this.state.maintenanceSeal ? "legacy-maintenance" : "protocol", historicalUnknownSha256: this.historicalUnknownSha256(),
        manifestSha256: createHash("sha256").update(readFileSync(process.argv[1]!)).digest("hex"), configurationSelectorSha256: configuration,
        capabilitySha256: digest({ protocol: 1, node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch,
          native: this.continuingNative() ? routerNativeDigest(native) : native }), storageOutcome: "ready" };
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
    this.save({ ...this.state, phase: "open", sealed: undefined, ready: undefined }, { "router-live-owner": this.processIdentity() });
  }
}
