import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExecutionEngineClient, ExecutionEngineProvider } from "@opencraft/appserver-client";
import type { HostInputPort } from "@opencraft/appserver-protocol/host-inputs";
import { AcpHostHandoff, type HostHandoffExpectation } from "./host-handoff.js";
import { AcpEngine, type AcpEngineOptions, type AcpOrchestrationPort } from "./index.js";

type Value = Record<string, any>;
interface Generation { id: string; configPath: string; state: "serving" | "draining" | "dormant" | "retired"; configurationDigest?: string }
interface Registry { lastActivation?: { operationId: string | null; generationId: string; epoch: number; owner: string }; admissionEpoch?: number; schemaVersion: 1; current: string; generations: Generation[] }
export interface AcpGenerationHostOptions {
  id: "acp" | "dsh-acp" | "claude-code";
  modelPolicyPath?: string;
  dataDirectory: string;
  initialGeneration: { id: string; configPath: string };
  /** Deployment authority counts OS work outside the supervised native peers. */
  inspectOsWork?(nativePids: readonly number[]): { coverage: "complete" | "unknown"; activeCount: number | null };
  runtimeIdentity?: string;
  /** Reads private configuration; the registry stores a digest, not credentials. */
  readConfig(path: string, generationId: string): Promise<AcpEngineOptions>;
}
const generationId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/u.test(id);
const configurationDigest = (config: AcpEngineOptions) => createHash("sha256").update(JSON.stringify({
  command: config.command, args: config.args ?? [], cwd: config.cwd, permission: config.permission ?? "reject",
  env: Object.fromEntries(Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b))), reconnectWindowMs: config.reconnectWindowMs ?? 15000,
})).digest("hex");

/** One independent Host, multiple pinned ACP process generations. New sessions
 * follow current; existing sessions keep their native id and fixed generation. */
export class AcpGenerationHost implements ExecutionEngineProvider {
  readonly id: "acp" | "dsh-acp" | "claude-code";
  readonly label: string;
  readonly threadPrefix: string;
  readonly modelPrefix: string;
  get extensions() { return { ...(this.providers.get(this.registry?.current)?.extensions ?? {}),
    "opencraft/agent-driver": { version: 1, generationDraining: true, callbackReplay: true },
    ...(this.orchestration ? { "opencraft/thread-orchestration": { version: 1, driver: this.id === "dsh-acp" ? "dsh" : this.id, callbackReplay: true } } : {}) }; }
  readonly inputs: HostInputPort;
  readonly ownerIncarnation = randomUUID();
  private readonly preparations = new Map<string, { id: string; current: string; epoch: number; identity: string; expires: number }>();
  private readonly handoff: AcpHostHandoff;
  private registry!: Registry;
  private readonly providers = new Map<string, AcpEngine>();
  private readonly bindings = new Map<string, string>();
  private readonly listeners = new Set<(method: string, params: Value) => void>();
  private readonly transitioning = new Set<string>();
  private readonly admissions = new Map<string, number>();
  private starting: Promise<void> | null = null;
  private mutation: Promise<unknown> = Promise.resolve();
  private persistenceFailed = false;
  private persistence: Promise<void> = Promise.resolve();
  private orchestration?: AcpOrchestrationPort;
  constructor(private readonly options: AcpGenerationHostOptions) {
    if (!isAbsolute(options.dataDirectory)) throw new Error("ACP generation data directory must be absolute");
    this.handoff = new AcpHostHandoff(options.dataDirectory, this.ownerIncarnation);
    this.id = options.id; this.label = options.id === "dsh-acp" ? "DeepSeek Harness (ACP)" : options.id === "claude-code" ? "Claude Code (ACP)" : "ACP Agent";
    this.threadPrefix = this.id === "claude-code" ? "claude_" : this.id.replaceAll("-", "_") + "_"; this.modelPrefix = this.id + ":";
    this.inputs = {
      receipt: async (threadId, inputId) => { await this.start(); return this.handoff.run(() => this.owner(threadId).inputs.receipt(threadId, inputId), true); },
      submit: async (threadId, inputId, text, canAdmit) => {
        await this.start(); const generation = this.bindings.get(threadId);
        if (!generation) throw new Error("ACP thread generation is unavailable");
        return this.handoff.run(() => this.admit(generation, provider => provider.inputs.submit(threadId, inputId, text, canAdmit)));
      },
    };
  }
  setOrchestration(port: AcpOrchestrationPort): void { this.orchestration = port; for (const provider of this.providers.values()) provider.setOrchestration(port); }
  ownsThread(id: string): boolean { return id.startsWith(this.threadPrefix); }
  ownsModel(id: string): boolean { return id.startsWith(this.modelPrefix); }
  subscribe(listener: (method: string, params: Value) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private owner(threadId: string): AcpEngine {
    const generation = this.bindings.get(threadId), provider = generation && this.providers.get(generation);
    if (!provider) throw new Error("ACP thread generation is unavailable"); return provider;
  }
  private current(): AcpEngine { const provider = this.providers.get(this.registry.current); if (!provider) throw new Error("ACP default generation is unavailable"); return provider; }
  private save(): Promise<void> {
    const serialized = JSON.stringify(this.registry), path = join(this.options.dataDirectory, "generations.json");
    const operation = this.persistence.catch(() => {}).then(async () => {
      if (this.persistenceFailed) throw new Error("ACP registry persistence is unavailable");
      const temporary = `${path}.${randomUUID()}.tmp`;
      let file;
      try {
        file = await open(temporary, "wx", 0o600); await file.writeFile(serialized); await file.sync(); await file.close(); file = undefined;
        await rename(temporary, path);
        const directory = await open(this.options.dataDirectory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) { this.persistenceFailed = true; throw error; }
      finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    });
    this.persistence = operation; return operation;
  }
  private async loadGeneration(record: Generation): Promise<AcpEngine> {
    if (!generationId(record.id) || !isAbsolute(record.configPath)) throw new Error("Invalid ACP generation declaration");
    const config = await this.options.readConfig(record.configPath, record.id);
    if (this.id === "dsh-acp") config.env = { ...config.env, DSH_HOME: join(this.options.dataDirectory, "native", record.id) };
    const digest = configurationDigest(config);
    if (record.configurationDigest && record.configurationDigest !== digest) { await config.history?.close?.(); throw new Error("Pinned ACP generation command or options changed"); }
    record.configurationDigest = digest;
    if (config.id && config.id !== this.id) { await config.history?.close?.(); throw new Error("ACP generation driver kind cannot change"); }
    const provider = new AcpEngine({ ...config, modelPolicyPath: this.options.modelPolicyPath, id: this.id, dataDirectory: join(this.options.dataDirectory, "generations", record.id) });
    if (this.orchestration) provider.setOrchestration(this.orchestration);
    provider.subscribe((method, params) => { for (const listener of this.listeners) listener(method, { ...params, engineGenerationId: record.id }); });
    try {
      // A dormant native owner stays asleep across a Host restart. Catalog and
      // history access only hydrate control metadata, never a native process.
      if (record.state !== "dormant") await provider.start();
      for (const id of await provider.catalogThreadIds()) {
        if (this.bindings.has(id)) throw new Error("ACP thread has conflicting generation owners");
        this.bindings.set(id, record.id);
      }
      return provider;
    } catch (error) { await provider.close(); throw error; }
  }
  start(): Promise<void> {
    if (this.persistenceFailed) return Promise.reject(new Error("ACP registry persistence is unavailable"));
    return this.starting ??= (async () => {
      await mkdir(this.options.dataDirectory, { recursive: true, mode: 0o700 });
      await this.handoff.load();
      try { this.registry = JSON.parse(await readFile(join(this.options.dataDirectory, "generations.json"), "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.registry = { schemaVersion: 1, current: this.options.initialGeneration.id, generations: [{ ...this.options.initialGeneration, state: "serving" }] };
      }
      if (this.registry.schemaVersion !== 1 || !Array.isArray(this.registry.generations) || !this.registry.generations.some(record => record.id === this.registry.current && record.state === "serving") || new Set(this.registry.generations.map(record => record.id)).size !== this.registry.generations.length
        || this.registry.generations.some(record => !["serving", "draining", "dormant", "retired"].includes(record.state))) throw new Error("Invalid ACP generation registry");
      for (const record of this.registry.generations) if (record.state !== "retired") {
        const provider = await this.loadGeneration(record); this.providers.set(record.id, provider);
      }
      await this.save();
    })().catch(async error => { await Promise.allSettled([...this.providers.values()].map(provider => provider.close())); throw error; });
  }
  private async admit<T>(generation: string, operation: (provider: AcpEngine) => Promise<T>, wake = true): Promise<T> {
    const record = this.registry.generations.find(record => record.id === generation), provider = this.providers.get(generation);
    if (!record || record.state === "retired" || !provider) throw new Error("Prepared ACP generation is unavailable");
    if (this.transitioning.has(generation)) throw new Error("ACP generation transition is in progress");
    this.admissions.set(generation, (this.admissions.get(generation) ?? 0) + 1);
    try {
      if (wake && record.state === "dormant") { record.state = "draining"; await this.save(); }
      return await operation(provider);
    } finally { this.admissions.set(generation, this.admissions.get(generation)! - 1); }
  }
  async request(method: string, params: Value, client: ExecutionEngineClient): Promise<any> {
    await this.start();
    return this.handoff.run(() => this.handleRequest(method, params, client), method === "opencraft/orchestration/ack");
  }
  admitHostRequest<T>(method: string, operation: () => Promise<T>): Promise<T> {
    return this.handoff.run(operation, method === "opencraft/orchestration/ack");
  }
  private async handleRequest(method: string, params: Value, client: ExecutionEngineClient): Promise<any> {
    if (method === "opencraft/orchestration/prepare") {
      let generation = params.sourceSettings === undefined && typeof params.threadId === "string"
        ? this.bindings.get(params.threadId) ?? this.registry.current : this.registry.current;
      if (params.sourceOnly !== true && typeof params.operationId === "string") {
        const owners = (await Promise.all([...this.providers].map(async ([id, provider]) => await provider.ownsOperation(params.operationId) ? id : null))).filter((id): id is string => id !== null);
        if (owners.length > 1) throw new Error("ACP operation has conflicting generation owners");
        if (owners.length) generation = owners[0]!;
      }
      const result = await this.admit(generation, provider => provider.request(method, params, client), false);
      return { ...result, orchestrationGenerationId: generation };
    }
    if (method === "thread/start" || method === "opencraft/orchestration/create") {
      const generation = method === "thread/start" ? this.registry.current : params.settings?.orchestrationGenerationId;
      const result = await this.admit(generation, provider => provider.request(method, params, client));
      const threadId = result.threadId ?? result.thread.id; this.bindings.set(threadId, generation);
      return method === "thread/start" ? result : { ...result, generationId: generation };
    }
    if (method === "opencraft/orchestration/ack") {
      const results = await Promise.all([...this.providers.values()].map(provider => provider.request(method, params, client)));
      return { acknowledged: results.every(result => result.acknowledged) };
    }
    if (method === "thread/list") {
      const data: Value[] = [];
      for (const provider of this.providers.values()) {
        let cursor: string | null = null;
        do { const page = await provider.request(method, { ...params, limit: 200, cursor }, client); data.push(...page.data); cursor = page.nextCursor; } while (cursor !== null);
      }
      data.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      const offset = Number(params.cursor ?? 0), limit = Number(params.limit ?? 100);
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid ACP catalog page");
      return { data: data.slice(offset, offset + limit), nextCursor: offset + limit < data.length ? String(offset + limit) : null };
    }
    if (method === "model/list") return this.current().request(method, params, client);
    const threadId = String(params.threadId ?? ""), generation = this.bindings.get(threadId);
    if (["thread/resume", "turn/start", "turn/interrupt"].includes(method)) {
      if (!generation) throw new Error("ACP thread generation is unavailable");
      return this.admit(generation, provider => provider.request(method, params, client));
    }
    return this.owner(threadId).request(method, params, client);
  }
  incarnation(threadId: string): string { return this.owner(threadId).incarnation; }
  executionObservation(threadId: string) { return this.owner(threadId).executionObservation(threadId); }
  snapshot(): Value { return { handoff: this.handoff.snapshot(), ownerIncarnation: this.ownerIncarnation, lastActivation: this.registry.lastActivation ?? null, admissionEpoch: this.registry.admissionEpoch ?? 0, current: this.registry.current, generations: this.registry.generations.map(record => ({ ...record, configPath: undefined, pid: this.providers.get(record.id)?.processId ?? null, incarnation: this.providers.get(record.id)?.incarnation ?? null, bindings: [...this.bindings.values()].filter(id => id === record.id).length, occupancy: this.providers.get(record.id)?.occupancy ?? null })) }; }
  /** Private local control; suspension preserves bindings and native provenance. */
  manage(action: "add" | "activate" | "suspend" | "retire" | "preparation", input: { id: string; configPath?: string; expectedCurrent?: string; expectedEpoch?: number; expectedOwner?: string; operationId?: string; preparation?: string }): Promise<Value> {
    const operation = this.mutation.catch(() => {}).then(async () => {
      if (input.expectedOwner !== undefined && input.expectedOwner !== this.ownerIncarnation) throw new Error("ACP owner changed");
      if (input.operationId !== undefined && !/^[a-f0-9]{64}$/u.test(input.operationId)) throw new Error("Invalid ACP activation operation");
      await this.start();
      return this.handoff.run(async () => {
      if (!generationId(input.id)) throw new Error("Invalid ACP generation id");
      if (input.expectedEpoch !== undefined && input.expectedEpoch !== (this.registry.admissionEpoch ?? 0)) throw new Error("ACP admission epoch changed");
      if (input.expectedCurrent !== undefined && input.expectedCurrent !== this.registry.current) throw new Error("ACP current generation changed");
      if (action === "preparation") {
        const record = this.registry.generations.find(record => record.id === input.id), provider = this.providers.get(input.id);
        if (!record || record.state === "retired" || record.state === "dormant" || !provider?.processId) throw new Error("ACP candidate is not ready");
        const token = randomUUID();
        this.preparations.set(token, { id: input.id, current: this.registry.current, epoch: this.registry.admissionEpoch ?? 0, identity: JSON.stringify([this.ownerIncarnation, provider.incarnation, provider.processId, record.configurationDigest]), expires: Date.now() + 60_000 });
        return { ...this.snapshot(), preparation: token };
      }
      if (action === "add") {
        if (!isAbsolute(input.configPath ?? "") || this.registry.generations.some(record => record.id === input.id)) throw new Error("ACP generation already exists or configuration path is invalid");
        const record: Generation = { id: input.id, configPath: input.configPath!, state: "serving" };
        const provider = await this.loadGeneration(record);
        this.providers.set(record.id, provider); this.registry.generations.push(record); await this.save();
      } else {
        const record = this.registry.generations.find(record => record.id === input.id);
        if (!record || record.state === "retired") throw new Error("ACP generation is unavailable");
        this.transitioning.add(record.id);
        try {
          const provider = this.providers.get(record.id)!;
          if (input.preparation !== undefined) {
            const proof = this.preparations.get(input.preparation);
            if (!proof || proof.id !== record.id || proof.current !== this.registry.current || proof.epoch !== (this.registry.admissionEpoch ?? 0) || proof.expires < Date.now()
              || proof.identity !== JSON.stringify([this.ownerIncarnation, provider.incarnation, provider.processId, record.configurationDigest])) throw new Error("ACP preparation changed or expired");
            this.preparations.delete(input.preparation);
          }
          if (action === "activate") {
            if (record.state === "dormant") await provider.start();
            const old = this.registry.generations.find(record => record.id === this.registry.current)!;
            old.state = "draining"; record.state = "serving"; this.registry.current = record.id; this.registry.admissionEpoch = (this.registry.admissionEpoch ?? 0) + 1;
            this.registry.lastActivation = { operationId: input.operationId ?? null, generationId: record.id, epoch: this.registry.admissionEpoch, owner: this.ownerIncarnation }; await this.save();
          } else {
            if (record.id === this.registry.current) throw new Error("Cannot suspend or retire the current ACP generation");
            if ((this.admissions.get(record.id) ?? 0) > 0 || Object.values(provider.occupancy).some(count => count > 0)) throw new Error("ACP generation still has active turns, callbacks, preparations or unacknowledged receipts");
            if (action === "suspend") {
              await provider.suspend(); record.state = "dormant"; await this.save();
            } else {
              if ([...this.bindings.values()].some(id => id === record.id)) throw new Error("ACP generation still owns resumable threads");
              record.state = "retired"; await this.save(); await provider.close(); this.providers.delete(record.id);
            }
          }
        } finally { this.transitioning.delete(record.id); }
      }
      return this.snapshot();
      });
    });
    this.mutation = operation; return operation;
  }
  /** Complete for this ACP Host: ACP has no independent queue/goal/schedule
   * executor. Native pending RPCs and callbacks remain owner authority. */
  occupancy() {
    const state = this.handoff.snapshot();
    const generations = [...this.providers].map(([id, provider]) => ({ id, ...provider.occupancy }));
    const os = this.options.inspectOsWork?.([...this.providers.values()].flatMap(p => p.processId ? [p.processId] : []));
    const coverage = this.persistenceFailed || state.persistence !== "ready" || os?.coverage !== "complete" || !Number.isSafeInteger(os.activeCount) || os.activeCount! < 0 ? "unknown" : "complete";
    const activeCount = coverage === "complete" ? state.activeCalls + os!.activeCount! + generations.reduce((sum, row) => sum + Object.entries(row).reduce((n, [key, count]) => key === "id" ? n : n + Number(count), 0), 0) : null;
    return { coverage, activeCount, osWork: os ?? { coverage: "unknown", activeCount: null }, historicalCount: this.bindings.size, generations };
  }
  private coldProof() {
    const snapshot = this.snapshot(), occupancy = this.occupancy();
    if (occupancy.coverage !== "complete" || occupancy.activeCount !== 0 || snapshot.generations.some((g: Value) => {
      if (g.state === "retired") return false;
      const provider = this.providers.get(g.id)!;
      return g.state !== "dormant" && !g.pid || g.bindings > 0 && !provider.supportsResume;
    })) throw new Error("ACP cold native readiness or historical Resume unavailable");
    return { owner: this.ownerIncarnation, current: snapshot.current, generations: snapshot.generations, capabilities: this.extensions, runtimeIdentity: this.options.runtimeIdentity ?? null };
  }
  ownerControl(action: "fence" | "inspect" | "release" | "cold-ready" | "resume", input: HostHandoffExpectation & { identity?: string }): Promise<Value> {
    const operation = this.mutation.catch(() => {}).then(async () => {
      await this.start();
      if (action === "fence") await this.handoff.fence(input);
      else if (action === "release") await this.handoff.release(input, () => this.occupancy(), async () => {
        for (const provider of this.providers.values()) await provider.suspend();
        if ([...this.providers.values()].some(provider => provider.processId !== null)) throw new Error("ACP native writer did not release");
        await this.persistence;
        const os = this.options.inspectOsWork?.([]);
        if (os?.coverage !== "complete" || os.activeCount !== 0) throw new Error("ACP OS writer release is unconfirmed");
      });
      else if (action === "cold-ready") {
        await this.handoff.coldReady(input, this.coldProof());
      } else if (action === "resume") {
        await this.handoff.resume(input, input.identity ?? "", this.coldProof());
      } else if (action !== "inspect") throw new Error("Invalid ACP Host control action");
      return { ...this.snapshot(), occupancy: this.occupancy() };
    });
    this.mutation = operation; return operation;
  }
  disconnect(client: ExecutionEngineClient): void { for (const provider of this.providers.values()) provider.disconnect(client); }
  async close(): Promise<void> { await Promise.all([...this.providers.values()].map(provider => provider.close())); await this.persistence; }
}
