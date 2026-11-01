import { appPayloadRequest, newAppChoice, verifyAppChoice, requireCallbackObservation, type AppPayloadChoice } from "./generation-app-payload.js";
import { CodexRouterOwner } from "./router-owner.js";
import { canonicalGenerationPath } from "./generation-files.js";
import { randomUUID, createHash } from "node:crypto";
import { realpath, readFile, stat } from "node:fs/promises";
import { join, sep, dirname } from "node:path";
import type { CodexAppServerHealth, CodexGenerationHostUsage, CodexGenerationFenceState, CodexGenerationDirectory } from "@opencraft/account-pool-host";
import { CodexGenerationRegistry, type GenerationDefinition, type GenerationRecord, type GenerationTicket } from "./generation-registry.js";
import { GenerationPeer, NativeGenerationError, rpcRecord, type RpcRecord } from "./generation-peer.js";
import type { GenerationRuntimeDirectory } from "./generation-router.js";
import type { GenerationProcessIdentity, GenerationSupervisor } from "./generation-supervisor.js";
import { readNativeHistory, type NativeHistoryFailures } from "./native-history-read.js";

export type GenerationHostUsage = CodexGenerationHostUsage;
export interface GenerationColdReplacement {
  (old: GenerationRecord, current: GenerationRecord, threadIds: readonly string[], options?: { appBundleOnly: boolean; restoringSourceApp?: boolean }): Promise<unknown>;
  readonly historyFailures?: NativeHistoryFailures;
}
const paused = () => new NativeGenerationError({ code: -32000, message: "Codex is temporarily unavailable for maintenance; retry this request", data: { code: "CODEX_MAINTENANCE", retryable: true } });

/** Routing/lifecycle authority only. Native and Host remain the task/data authorities. */
export class CodexGenerationRuntime implements GenerationRuntimeDirectory {
  readonly registry: CodexGenerationRegistry;
  readonly owner: CodexRouterOwner;
  private readonly starting = new Map<string, Promise<CodexAppServerHealth>>();
  private readonly cached = new Map<string, { at: number; health: CodexAppServerHealth }>();
  private readonly requests = new Map<string, number>();
  private readonly retiring = new Set<string>();
  private readonly changingPayload = new Set<string>();
  private readonly checking = new Set<string>();
  private readonly probes = new Map<string, { incarnation: number; peer: GenerationPeer; unexpectedRequests: number }>();
  private readonly preparations = new Map<string, { id: string; incarnation: number; epoch: number; identity: string; host: string; expires: number }>();
  private closed = false;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private monitoring: Promise<void> | undefined;
  serverRequestCount: (id: string) => number = () => 0;
  constructor(private readonly options: {
    directory: string; dataDirectory: string; proxyBaseUrl: string; supervisor: GenerationSupervisor;
    requireHostUsage: boolean; replaceRetiredHome: GenerationColdReplacement;
    executionUid?: number; executionGid?: number; runtimeParentDirectory?: string; socketParentDirectory?: string;
    now?: () => number;
    nativeHistoryFailures?: NativeHistoryFailures;
    maintenanceFile?: string;
  }) {
    this.registry = new CodexGenerationRegistry(options.directory);
    try { this.owner = new CodexRouterOwner(this.registry, options.maintenanceFile); }
    catch (error) { this.registry.close(); throw error; }
    const previous = rpcRecord(this.registry.metadata("retirement-fences"));
    if (this.owner.isOpen()) this.registry.setMetadata("retirement-fences", { epoch: Number(previous.epoch ?? 0) + 1, ids: this.registry.list().filter(g => g.state === "retiring").map(g => g.id) });
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  setRetention(value: Record<string, unknown>) {
    const keys = ["id", "retained", "expectedIncarnation", "expectedEpoch", "expectedOwner", "expectedHost"];
    if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))
      || ["id", "expectedOwner", "expectedHost"].some(key => typeof value[key] !== "string" || !value[key])
      || typeof value.retained !== "boolean" || ![value.expectedIncarnation, value.expectedEpoch].every(v => Number.isSafeInteger(v) && Number(v) >= 0)) throw new Error("Invalid generation retention selection");
    const id = value.id as string;
    this.verifyOwner(value.expectedOwner as string, value.expectedHost as string);
    const generation = this.registry.get(id);
    if (this.closed || !this.owner.isOpen() || !generation || !["active", "ready", "draining", "retired"].includes(generation.state)
      || generation.incarnation !== value.expectedIncarnation || this.registry.epoch() !== value.expectedEpoch
      || this.starting.has(id) || this.checking.has(id) || this.retiring.has(id) || this.changingPayload.has(id)) throw new Error("Generation retention identity changed");
    const receipt = { version: 1, retained: value.retained, incarnation: generation.incarnation, admissionEpoch: this.registry.epoch(), owner: this.registry.ownerEpoch, at: this.now() };
    this.registry.setMetadata(`retention:${id}`, receipt);
    return receipt;
  }
  private isRetained(id: string): boolean {
    const value = this.registry.metadata(`retention:${id}`);
    if (value === null) return false;
    const receipt = rpcRecord(value);
    if (receipt.version !== 1 || typeof receipt.retained !== "boolean") throw new Error("Invalid durable generation retention");
    return receipt.retained;
  }
  directory(threadId?: string): CodexGenerationDirectory {
    const generations = this.registry.list().filter(generation => generation.state !== "discarded");
    const route = threadId === undefined ? null : this.registry.route(threadId);
    return { protocolVersion: 1, routingEpoch: this.registry.ownerEpoch, admissionEpoch: this.registry.epoch(),
      homes: generations.map(generation => ({ generationId: generation.id, codexHome: join(generation.runtimeDataDirectory, "runtime"), incarnation: generation.incarnation })),
      route: route ? { threadId: threadId!, generationId: route.generationId } : null };
  }
  async prepare(definition: GenerationDefinition, legacy = false, expectedOwner?: string, expectedHost?: string): Promise<GenerationRecord> {
    if (this.closed) throw new Error("Generation runtime is closing");
    this.verifyOwner(expectedOwner, expectedHost);
    const executionUid = this.options.executionUid ?? process.getuid!(), executionGid = this.options.executionGid ?? process.getgid!();
    if ((definition.executionUid !== undefined && definition.executionUid !== executionUid) || (definition.executionGid !== undefined && definition.executionGid !== executionGid)) throw new Error("Generation execution identity differs from this deployment");
    if (definition.externalUnit) {
      // Adoption can observe an existing owner, never create privileged paths on its behalf.
      for (const path of [definition.runtimeDataDirectory, join(definition.runtimeDataDirectory, "runtime"), dirname(definition.endpoint)]) {
        const owner = await stat(path);
        if (owner.uid !== executionUid || owner.gid !== executionGid) throw new Error("Adopted generation directory identity mismatch");
      }
    } else {
      for (const [path, parent] of [[definition.runtimeDataDirectory, this.options.runtimeParentDirectory], [dirname(definition.endpoint), this.options.socketParentDirectory]]) {
        if (!parent) continue;
        const canonicalParent = await realpath(parent), canonicalPath = await canonicalGenerationPath(path!);
        if (!canonicalPath.startsWith(canonicalParent + sep) || canonicalPath.split(sep).includes("..")) throw new Error("Generation path is outside deployment roots");
      }
    }
    this.verifyOwner(expectedOwner, expectedHost);
    const generation = this.registry.register({ ...definition, executionUid, executionGid });
    if (legacy) {
      if (await realpath(definition.runtimeDataDirectory) !== await realpath(this.options.dataDirectory)) throw new Error("Legacy generation must own the original runtime directory");
      const previous = this.registry.metadata("legacy-generation");
      if (previous !== null && previous !== definition.id) throw new Error("Legacy generation identity is already fixed");
      this.registry.setMetadata("legacy-generation", definition.id);
    }
    await this.ensure(generation.id); return this.registry.get(generation.id)!;
  }
  async ensure(id: string, preserveRetiredPayload = false, refresh = false): Promise<CodexAppServerHealth> {
    if (this.closed || this.retiring.has(id) || this.changingPayload.has(id) || ["retiring", "revoking"].includes(this.registry.get(id)?.state ?? "")) throw paused();
    const pending = this.starting.get(id); if (pending) return pending;
    const cached = this.cached.get(id);
    if (!refresh && cached && this.now() - cached.at < 1_000) return cached.health;
    const operation = this.open(id, preserveRetiredPayload); this.starting.set(id, operation);
    try { return await operation; } finally { if (this.starting.get(id) === operation) this.starting.delete(id); }
  }
  private async open(id: string, preserveRetiredPayload: boolean): Promise<CodexAppServerHealth> {
    let generation = this.registry.get(id);
    if (!generation || generation.state === "discarded") throw new Error("Unknown or discarded generation");
    if (generation.executionUid !== (this.options.executionUid ?? process.getuid!()) || generation.executionGid !== (this.options.executionGid ?? process.getgid!())) throw new Error("Stored generation execution identity mismatch");
    let appChoice = this.registry.metadata(`app-payload:${id}`) as AppPayloadChoice | null;
    if (appChoice) await verifyAppChoice(generation, appChoice);
    if (generation.state === "retired") {
      const active = this.registry.current().generation;
      // Rolling the default back must never silently downgrade a newer HOME.
      // Only comparable stable Codex releases can be upgraded automatically.
      const version = (g: GenerationRecord) => /^codex-cli (\d+)\.(\d+)\.(\d+)$/u.exec((this.registry.metadata(`runtime:${g.id}`) as GenerationProcessIdentity | null)?.cliVersion ?? "")?.slice(1).map(Number);
      const before = version(generation), after = version(active);
      const comparison = before && after ? after.reduce((order, value, index) => order || Math.sign(value - before[index]!), 0) : null;
      const replacement = appChoice ? { ...generation, bundle: appChoice.bundle } : !preserveRetiredPayload && comparison !== null && comparison >= 0 ? active : generation;
      const receipt = await this.options.replaceRetiredHome(generation, replacement, this.registry.durableThreadIds(id), { appBundleOnly: !!appChoice, restoringSourceApp: appChoice?.restoringSourceApp });
      this.registry.setMetadata(`cold-replacement:${id}`, { version: 1, at: this.now(), receipt });
      if (appChoice) await verifyAppChoice(generation, appChoice);
      generation = appChoice ? this.registry.applyAppPayload(id, appChoice) : this.registry.replaceRetired(id, { executable: replacement.executable, bundle: replacement.bundle, node: replacement.node, nativeLauncher: replacement.nativeLauncher });
    }
    appChoice = this.registry.metadata(`app-payload:${id}`) as AppPayloadChoice | null;
    const health = await this.options.supervisor.start(generation);
    if (await realpath(health.dataDirectory) !== await realpath(this.options.dataDirectory) || health.proxyBaseUrl !== this.options.proxyBaseUrl) throw new Error("Generation account Core identity mismatch");
    const expectedHome = await realpath(join(generation.runtimeDataDirectory, "runtime"));
    const actualHome = health.codexHome ?? (await readFile(`/proc/${health.codexPid}/environ`, "utf8")).split("\0").find(value => value.startsWith("CODEX_HOME="))?.slice(11);
    if (!actualHome || await realpath(actualHome) !== expectedHome) throw new Error("Generation native HOME mismatch");
    const identity = await this.options.supervisor.identify(generation, health);
    if (appChoice?.applied) {
      await verifyAppChoice(generation, appChoice);
      if (identity.cliSha256 !== appChoice.cliSha256 || identity.cliVersion !== appChoice.cliVersion) throw new Error("APP-only CLI identity changed");
      if (generation.state === "candidate" && !appChoice.restoringSourceApp) requireCallbackObservation(health);
    }
    const previous = this.registry.metadata(`runtime:${id}`) as GenerationProcessIdentity | null;
    if (generation.state === "candidate") this.registry.ready(id);
    else if (previous && JSON.stringify(previous) !== JSON.stringify(identity)) {
      this.registry.runtimeChanged(id); this.probes.get(id)?.peer.close(); this.probes.delete(id);
    }
    this.registry.setMetadata(`runtime:${id}`, identity); this.cached.set(id, { at: this.now(), health }); return health;
  }
  async selectAppPayload(value: Record<string, unknown>): Promise<AppPayloadChoice> {
    const request = appPayloadRequest(value), id = request.id;
    if (this.closed || this.changingPayload.has(id) || this.starting.has(id) || this.checking.has(id) || this.retiring.has(id)) throw paused();
    this.changingPayload.add(id);
    try {
      const verify = () => {
        this.verifyOwner(request.expectedOwner, request.expectedHost);
        const g = this.registry.get(id);
        if (!g || g.incarnation !== request.expectedIncarnation || this.registry.epoch() !== request.expectedEpoch
          || this.registry.current().generation.id === id || !["ready", "draining", "retired", "candidate"].includes(g.state)) throw new Error("APP payload selection identity changed");
        return g;
      };
      const g = verify(), recovering = g.state === "candidate";
      if (recovering && !(this.registry.metadata(`app-payload:${id}`) as AppPayloadChoice | null)?.applied) throw new Error("Only a failed explicit APP candidate can be recovered");
      const identity = this.registry.metadata(`runtime:${id}`) as GenerationProcessIdentity;
      if (!recovering && ["ready", "draining"].includes(g.state)) {
        if (!this.options.supervisor.inspect) throw new Error("APP selection requires read-only process inspection");
        const health = await this.options.supervisor.inspect(g);
        if (JSON.stringify(await this.options.supervisor.identify(g, health)) !== JSON.stringify(identity)) throw new Error("APP source identity changed");
      }
      const choice = await newAppChoice(g, identity, request, this.registry.metadata(`app-payload:${id}`) as AppPayloadChoice | null);
      verify();
      if (recovering) { await this.options.supervisor.discardUnready(g); verify(); }
      this.registry.selectAppPayload(id, request.expectedIncarnation, request.expectedEpoch, choice, recovering);
      this.cached.delete(id); return choice;
    } finally { this.changingPayload.delete(id); }
  }
  private hostIdentity(): string {
    const host = rpcRecord(this.registry.metadata("host-usage"));
    return JSON.stringify([this.registry.ownerEpoch, host.instanceId ?? null, host.lease ?? null]);
  }
  preparationOwner(): string { return createHash("sha256").update(this.hostIdentity()).digest("hex"); }
  private verifyOwner(expectedOwner?: string, expectedHost?: string): void {
    if (expectedOwner !== undefined && expectedOwner !== this.registry.ownerEpoch || expectedHost !== undefined && expectedHost !== this.preparationOwner()) throw new Error("Generation owner or Host changed");
  }
  async preparation(id: string, expectedOwner?: string, expectedHost?: string): Promise<string> {
    this.verifyOwner(expectedOwner, expectedHost);
    await this.ensure(id, true, true);
    this.verifyOwner(expectedOwner, expectedHost);
    const g = this.registry.get(id)!;
    if (!["ready", "active", "draining"].includes(g.state)) throw new Error("Generation is not prepared");
    const token = randomUUID();
    this.preparations.set(token, { id, incarnation: g.incarnation, epoch: this.registry.epoch(),
      identity: JSON.stringify(this.registry.metadata(`runtime:${id}`)), host: this.hostIdentity(), expires: this.now() + 60_000 });
    return token;
  }
  private verifyPreparation(id: string, expectedEpoch: number, token: string): void {
    const proof = this.preparations.get(token), g = this.registry.get(id);
    if (!proof || proof.id !== id || proof.epoch !== expectedEpoch || this.registry.epoch() !== expectedEpoch
      || proof.incarnation !== g?.incarnation || proof.identity !== JSON.stringify(this.registry.metadata(`runtime:${id}`))
      || proof.host !== this.hostIdentity() || proof.expires < this.now()) throw new Error("Generation preparation changed or expired");
  }
  async revoke(id: string, expectedEpoch: number, token: string): Promise<{ revoked: true }> {
    if (this.retiring.has(id) || this.changingPayload.has(id) || this.starting.has(id) || this.checking.has(id)) throw paused();
    // Take the lifecycle fence before any await. No in-flight ensure can pass
    // the starting check and no later ensure/activate can race the final stop.
    this.retiring.add(id);
    try {
      this.verifyPreparation(id, expectedEpoch, token);
      this.registry.assertRevocable(id, this.registry.get(id)!.incarnation, expectedEpoch);
      const health = await this.open(id, true);
      this.verifyPreparation(id, expectedEpoch, token);
      const g = this.registry.get(id)!;
      if (this.acceptedReasons(id).length || (health.pendingCallbacks ?? 0) > 0 || (health.pendingOrchestrationMutations ?? 0) > 0) throw new Error("Candidate has accepted work");
      const native = await this.probe(g, health), loaded = rpcRecord(await native.peer.call("thread/loaded/list", {}));
      if (!Array.isArray(loaded.data) || loaded.data.length || native.unexpectedRequests) throw new Error("Candidate has native threads or unknown work");
      if (!await this.options.supervisor.processesQuiet(this.registry.metadata(`runtime:${id}`) as GenerationProcessIdentity)) throw new Error("Candidate native processes are not quiet");
      this.verifyPreparation(id, expectedEpoch, token);
      this.registry.beginRevoke(id, g.incarnation, expectedEpoch);
      this.preparations.delete(token);
      const identity = this.registry.metadata(`runtime:${id}`) as GenerationProcessIdentity;
      await this.options.supervisor.stop(g, identity);
      this.registry.finishRevoke(id, g.incarnation);
      this.cached.delete(id); this.probes.get(id)?.peer.close(); this.probes.delete(id);
      this.registry.setMetadata(`revocation:${id}`, { version: 1, at: this.now(), incarnation: g.incarnation, routingEpoch: this.registry.ownerEpoch });
      return { revoked: true };
    } finally { this.retiring.delete(id); }
  }
  async activate(id: string, expectedEpoch: number, preparation?: string, expectedOwner?: string, expectedHost?: string, operationId?: string): Promise<number> {
    this.verifyOwner(expectedOwner, expectedHost);
    if (operationId !== undefined && !/^[a-f0-9]{64}$/u.test(operationId)) throw new Error("Invalid activation operation");
    if (this.registry.epoch() !== expectedEpoch) throw new Error("Generation admission epoch changed");
    // Shared per-HOME starting lease serializes cold validation with concurrent reads.
    await this.ensure(id, true, preparation !== undefined);
    if (preparation !== undefined) this.verifyPreparation(id, expectedEpoch, preparation);
    if (this.retiring.has(id) || this.changingPayload.has(id) || this.registry.get(id)?.state === "revoking") throw paused();
    this.verifyOwner(expectedOwner, expectedHost);
    const epoch = this.registry.activate(id, expectedEpoch, operationId);
    if (preparation !== undefined) this.preparations.delete(preparation);
    return epoch;
  }
  async discard(id: string): Promise<void> {
    const generation = this.registry.get(id);
    if (this.closed || !generation || generation.state !== "candidate" || this.starting.has(id) || this.changingPayload.has(id)
      || this.checking.has(id) || this.retiring.has(id) || this.registry.metadata(`admitted:${id}`) || this.registry.durableThreadIds(id).length) throw new Error("Candidate cannot be discarded");
    this.changingPayload.add(id);
    try {
      await this.options.supervisor.discardUnready(generation);
      if (JSON.stringify(this.registry.get(id)) !== JSON.stringify(generation)) throw new Error("Discard candidate identity changed");
      this.registry.discard(id);
    } finally { this.changingPayload.delete(id); }
  }
  admit(ticket: GenerationTicket): () => void {
    if (this.closed || this.retiring.has(ticket.generationId) || !this.registry.valid(ticket)) throw paused();
    const id = ticket.generationId; this.requests.set(id, (this.requests.get(id) ?? 0) + 1);
    let released = false;
    return () => { if (!released) { released = true; this.requests.set(id, (this.requests.get(id) ?? 1) - 1); } };
  }
  observe(_generation: GenerationRecord, _message: RpcRecord): void { /* Observations do not invent task completion. */ }
  claimHost(instanceId: string, routingEpoch: string): { lease: string; routingEpoch: string } {
    if (routingEpoch !== this.registry.ownerEpoch || !instanceId) throw new Error("Stale routing owner epoch");
    const lease = randomUUID();
    this.registry.setMetadata("host-usage", { version: 1, routingEpoch, instanceId, lease, sequence: 0, at: 0,
      blockedThreadIds: [], unscopedBusy: true, discoveryComplete: false });
    return { lease, routingEpoch };
  }
  publishHostUsage(value: GenerationHostUsage): CodexGenerationFenceState {
    const current = rpcRecord(this.registry.metadata("host-usage"));
    if (value.routingEpoch !== this.registry.ownerEpoch || value.lease !== current.lease || !Number.isSafeInteger(value.sequence)
      || value.sequence <= Number(current.sequence) || !Array.isArray(value.blockedThreadIds) || !value.blockedThreadIds.every(id => typeof id === "string")
      || typeof value.unscopedBusy !== "boolean" || typeof value.discoveryComplete !== "boolean" || !Number.isSafeInteger(value.acknowledgedFenceEpoch)
      || value.acknowledgedFenceEpoch < 0 || value.acknowledgedFenceEpoch > this.fences().fenceEpoch) throw new Error("Stale or invalid Host usage receipt");
    const legacy = this.registry.metadata("legacy-generation");
    if (typeof legacy === "string") for (const id of value.blockedThreadIds) if (!this.registry.route(id)) this.registry.discover(id, legacy);
    this.registry.setMetadata("host-usage", { ...current, ...value, at: this.now() });
    return this.fences(value.acknowledgedFenceEpoch !== this.fences().fenceEpoch);
  }
  fences(includeRoutes = false): CodexGenerationFenceState {
    const state = rpcRecord(this.registry.metadata("retirement-fences")), legacy = this.registry.metadata("legacy-generation");
    let defaultGenerationId: string | null = null;
    try { defaultGenerationId = this.registry.current().generation.id; } catch { /* Bootstrap has no admission yet. */ }
    return { defaultGenerationId, routingEpoch: this.registry.ownerEpoch, fenceEpoch: Number(state.epoch), fencedGenerationIds: state.ids as string[],
      legacyGenerationId: typeof legacy === "string" ? legacy : null, ...(includeRoutes ? { routes: this.registry.routes() } : {}) };
  }
  private fenceHost(id: string, enable: boolean): number {
    const current = this.fences(), ids = new Set(current.fencedGenerationIds);
    enable ? ids.add(id) : ids.delete(id);
    if (ids.size !== current.fencedGenerationIds.length || enable !== current.fencedGenerationIds.includes(id)) {
      this.registry.setMetadata("retirement-fences", { epoch: current.fenceEpoch + 1, ids: [...ids] });
    }
    return this.fences().fenceEpoch;
  }
  private hostReasons(id: string): string[] {
    if (!this.options.requireHostUsage) return [];
    const usage = rpcRecord(this.registry.metadata("host-usage"));
    if (usage.routingEpoch !== this.registry.ownerEpoch || this.now() - Number(usage.at) > 15_000 || usage.discoveryComplete !== true) return ["host-proof-unavailable"];
    if (usage.unscopedBusy === true) return ["host-unscoped-work"];
    for (const threadId of usage.blockedThreadIds as string[]) {
      const route = this.registry.route(threadId);
      if (!route || route.generationId === id) return ["host-thread-work"];
    }
    return [];
  }
  private async probe(generation: GenerationRecord, health: CodexAppServerHealth): Promise<{ peer: GenerationPeer; unexpectedRequests: number }> {
    const existing = this.probes.get(generation.id);
    if (existing?.incarnation === generation.incarnation) return existing;
    existing?.peer.close();
    const state = { incarnation: generation.incarnation, peer: undefined as unknown as GenerationPeer, unexpectedRequests: 0 };
    const connection = await GenerationPeer.open(health.nativeSocket, { clientInfo: { name: "opencraft-generation-drain", version: "1" }, capabilities: { experimentalApi: true } }, {
      message: message => { if (message.id !== undefined && message.method) state.unexpectedRequests++; },
      disconnected: () => { if (this.probes.get(generation.id) === state) this.probes.delete(generation.id); },
    });
    state.peer = connection.peer; this.probes.set(generation.id, state); return state;
  }
  private async nativeReasons(generation: GenerationRecord, health: CodexAppServerHealth): Promise<string[]> {
    if ((health.pendingCallbacks ?? 0) > 0 || (health.pendingOrchestrationMutations ?? 0) > 0) return ["native-orchestration-callback"];
    const check = await this.probe(generation, health), loaded = rpcRecord(await check.peer.call("thread/loaded/list", {}));
    if (!Array.isArray(loaded.data)) throw new Error("Invalid native drain response");
    for (const threadId of loaded.data) {
      if (typeof threadId !== "string") throw new Error("Invalid native Thread identity");
      this.registry.discover(threadId, generation.id);
      const thread = rpcRecord(rpcRecord(await check.peer.call("thread/read", { threadId, includeTurns: false })).thread);
      if (thread.ephemeral === true) this.registry.markNonpersistent(threadId, "ephemeral");
      if (rpcRecord(thread.status).type !== "idle") return ["native-turn"];
      try {
        const result = await check.peer.call("thread/goal/get", { threadId });
        if (rpcRecord(rpcRecord(result).goal).status === "active") return ["native-goal"];
      } catch (reason) {
        if (!(thread.ephemeral === true && reason instanceof NativeGenerationError && /ephemeral.*not support.*goal/iu.test(reason.message))) throw reason;
      }
    }
    return check.unexpectedRequests ? ["native-server-request"] : [];
  }
  private acceptedReasons(id: string): string[] {
    if (this.owner.snapshot().uncertain) return ["router-outcome-unknown"];
    return (this.requests.get(id) ?? 0) || this.registry.unresolvedCreations(id) || this.serverRequestCount(id) ? ["accepted-work"] : [];
  }
  private async finishRetirement(generation: GenerationRecord): Promise<void> {
    const id = generation.id, identity = this.registry.metadata(`runtime:${id}`) as GenerationProcessIdentity;
    await this.options.supervisor.stop(generation, identity);
    this.registry.retire(id, generation.incarnation); this.cached.delete(id); this.probes.get(id)?.peer.close(); this.probes.delete(id);
    this.registry.setMetadata(`retirement:${id}`, { version: 1, at: this.now(), incarnation: generation.incarnation, identity });
  }
  async retire(id: string): Promise<{ retired: boolean; reasons: string[] }> {
    const record = this.registry.get(id);
    if (!record || !["draining", "retiring"].includes(record.state)) return { retired: false, reasons: ["not-draining"] };
    if (this.isRetained(id)) return { retired: false, reasons: ["operator-retained"] };
    if (this.checking.has(id) || this.changingPayload.has(id) || this.starting.has(id)) return { retired: false, reasons: ["lifecycle-operation"] };
    this.checking.add(id);
    try {
      const expected = this.options.nativeHistoryFailures?.failures.filter(row => row.generationId === id) ?? [];
      if (expected.length && JSON.stringify(this.options.replaceRetiredHome.historyFailures?.failures.filter(row => row.generationId === id)) !== JSON.stringify(expected)) throw new Error("Cold HOME reader does not support the retained history policy");
      if (record.state === "retiring") {
        this.retiring.add(id); await this.finishRetirement(record); return { retired: true, reasons: [] };
      }
      let reasons = [...this.hostReasons(id), ...this.acceptedReasons(id)];
      if (reasons.length) return { retired: false, reasons };
      const health = await this.ensure(id, false, true), generation = this.registry.get(id)!;
      reasons = await this.nativeReasons(generation, health);
      if (reasons.length) return { retired: false, reasons };
      let acknowledgedHost: string | undefined, acknowledgedFence: number | undefined;
      if (this.options.requireHostUsage) {
        const epoch = this.fenceHost(id, true), deadline = Date.now() + 15_000;
        for (;;) {
          const usage = rpcRecord(this.registry.metadata("host-usage"));
          if (usage.routingEpoch === this.registry.ownerEpoch && usage.acknowledgedFenceEpoch === epoch) {
            acknowledgedHost = this.hostIdentity(); acknowledgedFence = epoch; break;
          }
          if (Date.now() >= deadline) return { retired: false, reasons: ["host-fence-unacknowledged"] };
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        reasons = [...this.hostReasons(id), ...this.acceptedReasons(id)];
        if (reasons.length) return { retired: false, reasons };
      }
      // The Host has frozen new admissions and reported all admissions preceding the fence.
      // Existing queued/goal work never gets frozen while waiting for that acknowledgement.
      const latestHealth = await this.ensure(id, false, true);
      if(this.registry.get(id)!.incarnation!==generation.incarnation)return {retired:false,reasons:["native-incarnation-changed"]};
      this.retiring.add(id);
      reasons = [...await this.nativeReasons(generation, latestHealth), ...this.acceptedReasons(id), ...this.hostReasons(id)];
      if (reasons.length) return { retired: false, reasons };
      const identity = this.registry.metadata(`runtime:${id}`) as GenerationProcessIdentity;
      // A live source must still be recoverable under the selected cold reader.
      // Check while the per-generation admission barrier is held, before stop.
      const ids = this.registry.durableThreadIds(id);
      if (ids.length || expected.length) {
        const history = await readNativeHistory((await this.probe(generation, latestHealth)).peer, id, ids, expected);
        this.registry.setMetadata(`retirement-history:${id}`, { version: 1, at: this.now(), incarnation: generation.incarnation, history });
      }
      reasons = [...await this.nativeReasons(generation, latestHealth), ...this.acceptedReasons(id), ...this.hostReasons(id)];
      if (reasons.length) return { retired: false, reasons };
      if (!await this.options.supervisor.processesQuiet(identity)) return { retired: false, reasons: ["native-process"] };
      if (JSON.stringify(this.registry.durableThreadIds(id)) !== JSON.stringify(ids)) return { retired: false, reasons: ["native-history-changed"] };
      const usage = rpcRecord(this.registry.metadata("host-usage")), fences = this.fences();
      if (this.options.requireHostUsage && (this.hostIdentity() !== acknowledgedHost || usage.acknowledgedFenceEpoch !== acknowledgedFence
        || fences.fenceEpoch !== acknowledgedFence || !fences.fencedGenerationIds.includes(id))) return { retired: false, reasons: ["host-fence-changed"] };
      reasons = [...this.acceptedReasons(id), ...this.hostReasons(id)];
      if (reasons.length) return { retired: false, reasons };
      this.registry.fenceRetirement(id, generation.incarnation);
      await this.finishRetirement(generation); return { retired: true, reasons: [] };
    } finally {
      this.retiring.delete(id); this.checking.delete(id);
      if (this.registry.get(id)?.state !== "retiring") this.fenceHost(id, false);
    }
  }
  startMonitor(intervalMs = 5_000): void {
    if (this.monitor) return;
    this.monitor = setInterval(() => {
      if (this.closed || this.monitoring || !this.owner.isOpen()) return;
      this.monitoring = (async () => {
        for (const g of this.registry.list().filter(value => ["draining", "retiring"].includes(value.state))) {
          try { const result = await this.retire(g.id); this.registry.setMetadata(`drain:${g.id}`, { at: this.now(), ...result }); }
          catch { this.registry.setMetadata(`drain:${g.id}`, { at: this.now(), retired: false, reasons: ["drain-observation-unavailable"] }); }
        }
      })().finally(() => { this.monitoring = undefined; });
    }, intervalMs);
    this.monitor.unref();
  }
  async quiesceRouter() {
    await this.monitoring;
    for (const { peer } of this.probes.values()) peer.close();
    this.probes.clear();
  }
  async handoffObservation() {
    const counts = { starting: this.starting.size, lifecycle: this.checking.size + this.retiring.size + this.registry.list().filter(g => ["retiring", "revoking", "candidate"].includes(g.state) || g.state === "retired" && this.registry.durableThreadIds(g.id).length).length,
      rpc: [...this.requests.values()].reduce((a, b) => a + b, 0), monitor: this.monitoring ? 1 : 0,
      unresolvedCreations: this.registry.list().reduce((n, g) => n + this.registry.unresolvedCreations(g.id), 0), nativeAdmission: 0 };
    let coverage: "complete" | "unknown" = "complete";
    try {
      for (const g of this.registry.list().filter(g => ["active", "draining", "ready"].includes(g.state))) {
        const health = await this.options.supervisor.inspect!(g);
        const identity = await this.options.supervisor.identify(g, health);
        if (JSON.stringify(identity) !== JSON.stringify(this.registry.metadata(`runtime:${g.id}`))
          || health.callbackProtocolVersion !== 1 || !Number.isSafeInteger(health.pendingCallbacks) || !Number.isSafeInteger(health.pendingOrchestrationMutations)) throw new Error("Native admission coverage unavailable");
        counts.nativeAdmission += health.pendingCallbacks! + health.pendingOrchestrationMutations!;
      }
    } catch { coverage = "unknown"; }
    return { coverage, counts, activeCount: Object.values(counts).reduce((a, b) => a + b, 0), historicalCount: this.registry.routes().length };
  }
  async coldReadNative() {
    const values = [];
    const failures = this.options.nativeHistoryFailures?.failures ?? [];
    if (failures.some(row => !this.registry.list().some(g => ["active", "draining", "ready"].includes(g.state) && g.id === row.generationId))) throw new Error("Historical failure generation changed");
    if (this.registry.list().some(g => g.state === "retired" && this.registry.durableThreadIds(g.id).length)) throw new Error("Cold retired history combination is unverified");
    for (const g of this.registry.list().filter(g => ["active", "draining", "ready"].includes(g.state))) {
      const health = await this.options.supervisor.inspect!(g);
      const identity = await this.options.supervisor.identify(g, health);
      if (JSON.stringify(identity) !== JSON.stringify(this.registry.metadata(`runtime:${g.id}`)) || health.callbackProtocolVersion !== 1) throw new Error("Native identity changed");
      const { peer } = await GenerationPeer.open(health.nativeSocket, { clientInfo: { name: "opencraft-router-cold-read", version: "1" }, capabilities: { experimentalApi: true } }, { message() {}, disconnected() {} });
      try {
        const history = await readNativeHistory(peer, g.id, this.registry.durableThreadIds(g.id), failures.filter(row => row.generationId === g.id));
        values.push({ generation: g.id, identity, history });
      } finally { peer.close(); }
    }
    return values;
  }
  async close(): Promise<void> {
    this.owner.dispose();
    this.closed = true; clearInterval(this.monitor); await this.monitoring; await Promise.allSettled(this.starting.values());
    for (const { peer } of this.probes.values()) peer.close();
    this.probes.clear(); this.registry.close();
    // Independently supervised generation owners deliberately stay alive.
  }
}
