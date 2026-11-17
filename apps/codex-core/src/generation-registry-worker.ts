import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexGenerationRegistry, GenerationRecord, GenerationTicket } from "./generation-registry.js";

import { REGISTRY_WRITES, REGISTRY_PENDING_LIMIT } from "./generation-registry-protocol.js";
export { REGISTRY_WRITES } from "./generation-registry-protocol.js";
type Write = typeof REGISTRY_WRITES[number];
export type GenerationRegistryPort = Omit<CodexGenerationRegistry, Write | "metadataTransaction" | "projection"> & {
  [K in Write]: (...args: Parameters<CodexGenerationRegistry[K]>) => ReturnType<CodexGenerationRegistry[K]> | Promise<ReturnType<CodexGenerationRegistry[K]>>;
};
type Projection = ReturnType<CodexGenerationRegistry["projection"]>;
export type RegistryProjectionMessage = Omit<Projection, "metadata"> & {
  metadata: Record<string, string>; removedMetadata: string[]; revision: number; baseRevision: number;
};
type AsyncWrites = { [K in Write]: (...args: Parameters<CodexGenerationRegistry[K]>) => Promise<ReturnType<CodexGenerationRegistry[K]>> };

/** A read-only projection of committed Worker state. All writes stay with its SQLite owner. */
export class GenerationRegistryWorker {
  private worker!: Worker;
  private sequence = 0;
  private historyRevision = 0;
  routerHistoryRevision(): string { this.readable(); return String(this.historyRevision); }
  private failure?: Error;
  private closing = false;
  private closingFlight?: Promise<void>;
  private projection?: Projection;
  private projectionRevision = 0;
  private generations: ReadonlyMap<string, GenerationRecord> = new Map();
  private threadRoutes: ReadonlyMap<string, Projection["routes"][number]> = new Map();
  private claims: ReadonlyMap<string, Projection["claims"][number]> = new Map();
  private routesByGeneration: ReadonlyMap<string, readonly string[]> = new Map();
  private unresolvedByGeneration: ReadonlyMap<string, number> = new Map();
  private claimsByGeneration: ReadonlyMap<string, number> = new Map();
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private constructor() {}
  static async open(directory: string): Promise<GenerationRegistryWorker & AsyncWrites> {
    const port = new GenerationRegistryWorker();
    const ownFile = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
    port.worker = new Worker(join(dirname(ownFile), "generation-registry-worker.mjs"), { workerData: { directory }, execArgv: [] });
    port.worker.on("error", error => port.fail(error instanceof Error ? error : new Error(String(error))));
    port.worker.on("exit", code => port.fail(new Error(`Generation storage Worker exited (${code})`)));
    port.worker.on("message", (message: { id: number; projection?: RegistryProjectionMessage; result?: unknown; fatal?: boolean; error?: {message: string; code?: string} }) => {
      if (message.fatal) { port.fail(Object.assign(new Error(message.error?.message ?? "Generation storage effect is unknown"), {code:message.error?.code})); return; }
      const pending = port.pending.get(message.id); if (!pending) return;
      port.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else {
        try { if (message.projection) port.install(message.projection); pending.resolve(message.result); }
        catch (error) { port.fail(error as Error); pending.reject(error as Error); void port.worker.terminate(); }
      }
    });
    for (const method of REGISTRY_WRITES) if (method !== "close") Object.defineProperty(port, method, { value: async (...args: unknown[]) => {
      if (method === "discover") { const existing = port.route(String(args[0])); if (existing) { if(existing.generationId !== args[1]) return Promise.reject(new Error("Thread identity exists in another generation")); return Promise.resolve(existing); } }
      return port.request(method, args);
    } });
    try { await port.request("initialize", []); return port as GenerationRegistryWorker & AsyncWrites; }
    catch (error) { await port.worker.terminate(); throw error; }
  }
  private fail(error: Error) { this.failure ??= error; for (const request of this.pending.values()) request.reject(this.failure); this.pending.clear(); }
  private request(method: string, args: unknown[]): Promise<unknown> {
    if (this.failure || this.closing && method !== "close") return Promise.reject(this.failure ?? new Error("Generation storage is closing"));
    if (method !== "close" && this.pending.size >= REGISTRY_PENDING_LIMIT) return Promise.reject(Object.assign(new Error("Generation storage queue is full"), {code:"REGISTRY_QUEUE_FULL"}));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, {resolve, reject}); try { this.worker.postMessage({id, method, args}); } catch (error) { this.pending.delete(id); reject(error as Error); } });
  }
  private readable(): Projection {
    if (this.failure || this.closing || !this.projection) throw this.failure ?? new Error("Generation storage projection is unavailable");
    return this.projection;
  }
  private install(message: RegistryProjectionMessage): void {
    if (message.baseRevision !== this.projectionRevision || message.revision !== message.baseRevision + 1)
      throw new Error("Generation storage projection revision changed");
    const metadata = { ...this.projection?.metadata, ...message.metadata };
    for (const key of message.removedMetadata) delete metadata[key];
    if (message.routingUnchanged && !this.projection) throw new Error("Missing initial registry routing projection");
    const projection: Projection = message.routingUnchanged
      ? { ...this.projection!, ...message, metadata, generations: this.projection!.generations, routes: this.projection!.routes, claims: this.projection!.claims }
      : { ...message, metadata };
    if ([...Object.keys(message.metadata), ...message.removedMetadata].some(key => key.startsWith("router-history:"))) this.historyRevision++;
    if (message.routingUnchanged) { this.projection = projection; this.projectionRevision = message.revision; return; }
    // These are indexes of the one committed projection, never independent mutable facts.
    const generations = new Map(projection.generations.map(row => [row.id,row]));
    if(generations.size!==projection.generations.length)throw new Error("Invalid committed generation projection");
    const routes = new Map<string, Projection["routes"][number]>();
    const byGeneration = new Map<string,string[]>();
    for (const row of projection.routes) {
      const id=String(row.thread_id),generation=String(row.generation_id);
      if(routes.has(id)||!generations.has(generation)) throw new Error("Invalid committed generation route projection");
      routes.set(id,row); const ids=byGeneration.get(generation)??[];ids.push(id);byGeneration.set(generation,ids);
    }
    const claims=new Map<string,Projection["claims"][number]>(),unresolved=new Map<string,number>(),counts=new Map<string,number>();
    for(const row of projection.claims){const id=String(row.id),generation=String(row.generation_id);if(claims.has(id)||!generations.has(generation))throw new Error("Invalid committed generation claim projection");claims.set(id,row);counts.set(generation,(counts.get(generation)??0)+1);if(["accepted","sent"].includes(String(row.state)))unresolved.set(generation,(unresolved.get(generation)??0)+1);}
    this.generations=generations;this.threadRoutes=routes;this.routesByGeneration=byGeneration;
    this.claims=claims;this.unresolvedByGeneration=unresolved;this.claimsByGeneration=counts;this.projection=projection;this.projectionRevision=message.revision;
  }
  get available(): boolean { return !this.failure && !this.closing && !!this.projection; }
  get ownerEpoch() { return this.readable().ownerEpoch; }
  get outcome() { return this.readable().outcome; }
  get(id: string): GenerationRecord | null { this.readable(); return structuredClone(this.generations.get(id) ?? null); }
  list(): GenerationRecord[] { return structuredClone(this.readable().generations); }
  epoch(): number { return Number(this.readable().admission.epoch); }
  current() { const generation = this.get(String(this.readable().admission.generation_id)); if (!generation || generation.state !== "active") throw new Error("No generation is accepting new Threads"); return {generation, epoch: this.epoch()}; }
  metadata(key: string): unknown { const metadata=this.readable().metadata;return Object.hasOwn(metadata,key)?JSON.parse(metadata[key]!):null; }
  routes() { return this.readable().routes.map(row => ({threadId: String(row.thread_id), generationId: String(row.generation_id)})); }
  threadIds(generationId: string): string[] { this.readable();return [...this.routesByGeneration.get(generationId)??[]]; }
  isNonpersistent(threadId: string): boolean { return this.metadata(`thread-retention:${threadId}`) !== null; }
  durableThreadIds(generationId: string): string[] { return this.threadIds(generationId).filter(id => !this.isNonpersistent(id)); }
  route(threadId: string): GenerationTicket | null { this.readable();const row=this.threadRoutes.get(threadId);if(!row)return null;const generation=this.generations.get(String(row.generation_id))!;return {ownerEpoch:this.ownerEpoch,generationId:generation.id,incarnation:generation.incarnation,admissionEpoch:Number(row.epoch),threadId}; }
  valid(ticket: GenerationTicket): boolean { if (!this.available || ticket.ownerEpoch !== this.ownerEpoch) return false; const g = this.generations.get(ticket.generationId); if (!g || g.incarnation !== ticket.incarnation || !["ready","active","draining"].includes(g.state)) return false; const route = ticket.threadId ? this.route(ticket.threadId) : null; return !ticket.threadId || !!route && route.generationId === ticket.generationId && route.admissionEpoch === ticket.admissionEpoch; }
  unresolvedCreations(id: string): number { this.readable();return this.unresolvedByGeneration.get(id)??0; }
  creationTicket(operationId: string, allowRejected = false): GenerationTicket | null { this.readable();const row=this.claims.get(`orchestration:${operationId}`);if(!row)return null;const generation=this.generations.get(String(row.generation_id));if(!generation||row.incarnation!==generation.incarnation||row.state==="rejected"&&!allowRejected)throw new Error("Orchestration creation outcome is unconfirmed in this incarnation");return {ownerEpoch:this.ownerEpoch,generationId:generation.id,incarnation:generation.incarnation,admissionEpoch:Number(row.epoch),claimId:String(row.id)}; }
  assertRevocable(id: string, incarnation: number, expectedEpoch: number): void { const g=this.get(id);if(this.epoch()!==expectedEpoch||!g||g.state!=="ready"||g.incarnation!==incarnation||g.externalUnit||this.metadata(`admitted:${id}`)||this.durableThreadIds(id).length||(this.claimsByGeneration.get(id)??0)>0)throw new Error("Only a never admitted owned ready candidate can be revoked"); }
  close(): Promise<void> { return this.closingFlight ??= (async () => { this.closing=true; try { await this.request("close",[]); } finally { await this.worker.terminate(); } })(); }
}

/** One-shot lifecycle/evidence work; it never acquires the registry writer role. */
export async function routerStorageTask<T>(method: "inspect" | "read-maintenance" | "verify-maintenance" | "check-databases" | "create-directory", args: unknown[]): Promise<T> {
  const ownFile = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
  const worker = new Worker(join(dirname(ownFile), "generation-registry-worker.mjs"), {workerData:{task:{method,args}},execArgv:[]});
  try { return await new Promise<T>((resolve,reject) => {
    worker.once("message", message => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
    worker.once("error",reject); worker.once("exit",()=>reject(new Error("Router storage task exited before acknowledgement")));
  }); } finally { await worker.terminate(); }
}
