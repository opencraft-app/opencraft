import type {
  ReplicaCursor,
  ReplicaJsonValue,
  ReplicaMutateResponse,
  ReplicaMutation,
  ReplicaSnapshotResponse,
  ReplicaSyncResponse,
} from "@opencraft/appserver-protocol";

import { ReplicaError } from "./errors";
import type { ReplicaLiveEvent, ReplicaSource } from "./source";
import {
  REPLICA_STORAGE_SCHEMA_VERSION,
  type ReplicaClientState,
  type ReplicaClientStorage,
} from "./storage";
import {
  validateClientState,
  validateEntry,
  validateSnapshot,
  validateSyncResponse,
} from "./validation";

export type ReplicaClientPhase = "empty" | "painted" | "syncing" | "live" | "offline" | "error";

export interface ReplicaClientSnapshot<TValue extends ReplicaJsonValue = ReplicaJsonValue> {
  readonly revision: number;
  readonly storageKey: string;
  readonly scope: string;
  readonly phase: ReplicaClientPhase;
  readonly authoritative: boolean;
  readonly epoch: string | null;
  readonly nextSeq: number | null;
  readonly journalStartSeq: number | null;
  readonly entities: ReadonlyMap<string, TValue>;
  readonly lastError: Error | null;
  /** An unavailable disposable cache is bypassed; source authority remains separate. */
  readonly cacheError?: Error | null;
}

export interface ReplicaClientConfig<TValue extends ReplicaJsonValue = ReplicaJsonValue> {
  scope: string;
  storageKey: string;
  storage: ReplicaClientStorage<TValue>;
  pageSize?: number;
  /** Client storage is a paint cache. Failure or timeout bypasses it for this instance;
   * accepted writes retain their order and never authorize source data. */
  storageTimeoutMs?: number;
  storageClock?: { setTimeout(callback: () => void, delay: number): unknown; clearTimeout(handle: unknown): void };
}

class CacheTimeout extends Error {}

function applyMutation<TValue extends ReplicaJsonValue>(
  entities: ReadonlyMap<string, TValue>,
  mutation: ReplicaMutation<TValue>,
): ReadonlyMap<string, TValue> {
  const next = new Map(entities);
  if (mutation.kind === "upsert") next.set(mutation.entityId, mutation.value);
  else next.delete(mutation.entityId);
  return next;
}

export class ReplicaClient<TValue extends ReplicaJsonValue = ReplicaJsonValue> {
  readonly scope: string;
  readonly storageKey: string;
  private readonly storage: ReplicaClientStorage<TValue>;
  private readonly pageSize: number;
  private readonly storageTimeoutMs: number;
  private readonly storageClock: NonNullable<ReplicaClientConfig["storageClock"]>;
  private cacheError: Error | null = null;
  private cacheRepairScheduled = false;
  private readonly listeners = new Set<() => void>();
  private snapshot: ReplicaClientSnapshot<TValue>;
  private prepared: Promise<void> | null = null;
  private cancelSync: (() => void) | null = null;
  private storageTail: Promise<void> = Promise.resolve();
  private syncOperation: Promise<ReplicaClientSnapshot<TValue>> | null = null;
  private unsubscribeSource: (() => void) | null = null;
  private source: ReplicaSource<TValue> | null = null;
  private sourceGeneration = 0;
  private bufferingLive = false;
  private liveBuffer: ReplicaLiveEvent<TValue>[] = [];
  private operationTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(config: ReplicaClientConfig<TValue>) {
    if (config.scope.length === 0 || config.storageKey.length === 0) {
      throw new RangeError("Replica scope and storageKey must not be empty");
    }
    this.scope = config.scope;
    this.storageKey = config.storageKey;
    this.storage = config.storage;
    this.storageTimeoutMs = config.storageTimeoutMs ?? 5_000;
    if (!Number.isFinite(this.storageTimeoutMs) || this.storageTimeoutMs <= 0) throw new RangeError("Replica storage timeout must be positive and finite");
    this.storageClock = config.storageClock ?? {
      setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.pageSize = config.pageSize ?? 100;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1) {
      throw new RangeError("Replica pageSize must be a positive integer");
    }
    this.snapshot = {
      revision: 0,
      storageKey: this.storageKey,
      scope: this.scope,
      phase: "empty",
      authoritative: false,
      epoch: null,
      nextSeq: null,
      journalStartSeq: null,
      entities: new Map(),
      lastError: null,
    };
  }

  getSnapshot = (): ReplicaClientSnapshot<TValue> => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(entityId: string): TValue | null {
    return this.snapshot.entities.get(entityId) ?? null;
  }

  prepare(): Promise<void> {
    this.assertActive();
    if (this.prepared !== null) return this.prepared;
    this.prepared = this.prepareOnce();
    return this.prepared;
  }

  synchronize(source: ReplicaSource<TValue>): Promise<ReplicaClientSnapshot<TValue>> {
    this.assertActive();
    if (source.scope !== this.scope) {
      return Promise.reject(new ReplicaError("PROTOCOL_ERROR", `Replica source belongs to ${source.scope}`));
    }
    if (this.syncOperation !== null) return this.syncOperation;
    const generation = ++this.sourceGeneration;
    let cancel!: () => void;
    const operation = new Promise<ReplicaClientSnapshot<TValue>>((resolve, reject) => {
      cancel = () => reject(new ReplicaError("DISPOSED", "Replica source generation was superseded"));
      void Promise.resolve().then(() => this.synchronizeOnce(source, generation)).then(resolve, reject);
    });
    this.cancelSync = cancel;
    this.syncOperation = operation;
    // Register ownership before prepare, subscriptions or synchronous observers.
    void operation.finally(() => {
      if (this.syncOperation === operation) { this.syncOperation = null; this.cancelSync = null; }
    }).catch(() => undefined);
    return operation;
  }

  async mutate(
    commandId: string,
    mutations: readonly ReplicaMutation<TValue>[],
  ): Promise<ReplicaMutateResponse> {
    this.assertActive();
    const source = this.source;
    if (source?.mutate === undefined) {
      throw new ReplicaError("PROTOCOL_ERROR", "Replica source does not support writes");
    }
    const generation = this.sourceGeneration;
    const cursor = this.cursor();
    const response = await source.mutate({ commandId, expectedCursor: cursor, mutations });
    this.ensureGeneration(generation);
    if (response.scope !== this.scope) throw new ReplicaError("PROTOCOL_ERROR", "Replica write returned wrong scope");
    await this.enqueue(async () => {
      await this.catchUp(source, generation);
    });
    return response;
  }

  disconnect(): void {
    const unsubscribe = this.unsubscribeSource;
    const cancel = this.cancelSync;
    this.unsubscribeSource = null;
    this.source = null;
    this.sourceGeneration += 1;
    this.syncOperation = null;
    this.cancelSync = null;
    cancel?.();
    this.bufferingLive = false;
    this.liveBuffer = [];
    try { unsubscribe?.(); } catch { /* Revocation cannot depend on source cleanup. */ }
    if (this.snapshot.phase !== "empty") {
      this.publish({ phase: "offline", authoritative: false });
    }
  }

  /**
   * Publishes a transport/resume failure that happened before a ReplicaSource
   * could be attached. Painted entities remain available while the consumer
   * receives an explicit non-authoritative error state.
   */
  reportSyncFailure(cause: unknown): void {
    this.assertActive();
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.publish({
      phase: "error",
      authoritative: false,
      lastError: error,
    });
  }

  /** Resume has started, but no authoritative source has been attached yet. */
  reportSyncStarted(): void {
    this.assertActive();
    this.publish({ phase: "syncing", authoritative: false, lastError: null });
  }

  /** Paint-only data during Resume. It must never advance a replay cursor or
   * authorize commands; only synchronize() can establish those facts. */
  reportPreview(entityId: string, value: TValue): void {
    this.assertActive();
    if (this.snapshot.authoritative) return;
    this.publish({ entities: new Map(this.snapshot.entities).set(entityId, value) });
  }

  async clear(): Promise<void> {
    this.disconnect();
    const generation = this.sourceGeneration;
    try {
      if (this.cacheError) throw this.cacheError;
      await this.awaitStorage(this.serializeStorage(() => this.storage.clearClient(this.storageKey)));
    } catch (error) {
      throw new ReplicaError("STORAGE_ERROR", "Failed to clear Replica client state", { cause: error });
    }
    this.ensureGeneration(generation);
    this.publish({
      phase: "empty",
      authoritative: false,
      epoch: null,
      nextSeq: null,
      journalStartSeq: null,
      entities: new Map(),
      lastError: null,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnect();
    this.listeners.clear();
  }

  private async prepareOnce(): Promise<void> {
    const generation = this.sourceGeneration;
    let stored: ReplicaClientState<TValue> | null;
    try {
      stored = await this.awaitStorage(Promise.resolve().then(() => this.storage.loadClient(this.storageKey)));
    } catch (error) {
      this.disableCache(error);
      if (!(error instanceof CacheTimeout)) this.scheduleCacheRepair();
      return;
    }
    if (stored === null || this.disposed || generation !== this.sourceGeneration) return;
    try {
      validateClientState(stored, this.storageKey, this.scope);
    } catch (error) {
      this.disableCache(error);
      this.scheduleCacheRepair();
      return;
    }
    this.publish({
      phase: "painted",
      authoritative: false,
      epoch: stored.epoch,
      nextSeq: stored.nextSeq,
      journalStartSeq: stored.journalStartSeq,
      entities: new Map(stored.entities.map((entity) => [entity.entityId, entity.value])),
      lastError: null,
    });
  }

  private async synchronizeOnce(source: ReplicaSource<TValue>, generation: number): Promise<ReplicaClientSnapshot<TValue>> {
    this.ensureGeneration(generation);
    await this.prepare();
    this.ensureGeneration(generation);
    this.unsubscribeSource?.();
    this.source = source;
    this.bufferingLive = true;
    this.liveBuffer = [];
    try {
      const unsubscribe = source.subscribe((event) => {
        if (generation !== this.sourceGeneration) return;
        if (this.bufferingLive) {
          this.liveBuffer.push(event);
          return;
        }
        void this.enqueue(() => this.applyLiveEvent(event, source, generation)).catch((error: unknown) => {
          if (generation === this.sourceGeneration && !this.disposed) this.fail(error);
        });
      });
      if (generation !== this.sourceGeneration || this.disposed) {
        unsubscribe();
        this.ensureGeneration(generation);
      }
      this.unsubscribeSource = unsubscribe;
      this.publish({ phase: "syncing", authoritative: false, lastError: null });
      await this.catchUp(source, generation);
      while (this.liveBuffer.length > 0) {
        const buffered = this.liveBuffer.splice(0);
        for (const event of buffered) await this.applyLiveEvent(event, source, generation);
      }
      this.ensureGeneration(generation);
      this.bufferingLive = false;
      this.publish({ phase: "live", authoritative: true, lastError: null });
      return this.snapshot;
    } catch (error) {
      if (generation === this.sourceGeneration) {
        this.bufferingLive = false;
        this.liveBuffer = [];
        const unsubscribe = this.unsubscribeSource;
        this.unsubscribeSource = null;
        if (this.source === source) this.source = null;
        try { unsubscribe?.(); } catch { /* Preserve the original synchronization error. */ }
        if (generation === this.sourceGeneration && !this.disposed) this.fail(error);
      }
      throw error;
    }
  }

  private async catchUp(source: ReplicaSource<TValue>, generation: number): Promise<void> {
    let cursor = this.cursor();
    for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
      this.ensureGeneration(generation);
      const response = await source.sync(cursor, this.pageSize);
      this.ensureGeneration(generation);
      validateSyncResponse(response, this.scope);
      await this.applySyncResponse(response, generation);
      if (response.kind === "snapshot" || !response.hasMore) return;
      const nextCursor = this.cursor();
      if (nextCursor === null || (cursor !== null && nextCursor.nextSeq === cursor.nextSeq)) {
        throw new ReplicaError("PROTOCOL_ERROR", "Replica catch-up made no cursor progress");
      }
      cursor = nextCursor;
    }
    throw new ReplicaError("PROTOCOL_ERROR", "Replica catch-up exceeded the page safety bound");
  }

  private async applySyncResponse(response: ReplicaSyncResponse<TValue>, generation: number): Promise<void> {
    if (response.kind === "snapshot") {
      await this.installSnapshot(response, generation);
      return;
    }
    const cursor = this.cursor();
    if (cursor === null || cursor.epoch !== response.epoch || cursor.nextSeq !== response.fromNextSeq) {
      throw new ReplicaError("PROTOCOL_ERROR", "Replica delta is not adjacent to the client cursor");
    }
    let entities = this.snapshot.entities;
    let nextSeq = cursor.nextSeq;
    for (const entry of response.entries) {
      if (entry.seq !== nextSeq) throw new ReplicaError("PROTOCOL_ERROR", `Replica gap at ${nextSeq}`);
      entities = applyMutation(entities, entry.mutation);
      nextSeq += 1;
    }
    await this.persistAndPublish({
      epoch: response.epoch,
      nextSeq,
      journalStartSeq: response.bounds.journalStartSeq,
      entities,
      lastError: null,
    }, generation);
  }

  private async installSnapshot(response: ReplicaSnapshotResponse<TValue>, generation: number): Promise<void> {
    validateSnapshot(response, this.scope);
    await this.persistAndPublish({
      epoch: response.epoch,
      nextSeq: response.bounds.nextSeq,
      journalStartSeq: response.bounds.journalStartSeq,
      entities: new Map(response.entities.map((entity) => [entity.entityId, entity.value])),
      lastError: null,
    }, generation);
  }

  private async applyLiveEvent(
    event: ReplicaLiveEvent<TValue>,
    source: ReplicaSource<TValue>,
    generation: number,
  ): Promise<void> {
    this.ensureGeneration(generation);
    if (event.kind === "snapshot") {
      await this.installSnapshot(event.snapshot, generation);
      return;
    }
    const entry = event.entry;
    if (entry.scope !== this.scope) return;
    const cursor = this.cursor();
    if (cursor === null || entry.epoch !== cursor.epoch || entry.seq > cursor.nextSeq) {
      await this.catchUp(source, generation);
    }
    const recovered = this.cursor();
    if (recovered === null || entry.epoch !== recovered.epoch) return;
    validateEntry(entry, this.scope, recovered.epoch);
    if (entry.seq < recovered.nextSeq) return;
    if (entry.seq > recovered.nextSeq) {
      throw new ReplicaError("PROTOCOL_ERROR", `Replica live gap remains at ${recovered.nextSeq}`);
    }
    await this.persistAndPublish({
      epoch: recovered.epoch,
      nextSeq: recovered.nextSeq + 1,
      journalStartSeq: this.snapshot.journalStartSeq ?? recovered.nextSeq,
      entities: applyMutation(this.snapshot.entities, entry.mutation),
      lastError: null,
    }, generation);
  }

  private cursor(): ReplicaCursor | null {
    return this.snapshot.epoch === null || this.snapshot.nextSeq === null
      ? null
      : { epoch: this.snapshot.epoch, nextSeq: this.snapshot.nextSeq };
  }

  private async persistAndPublish(update: {
    epoch: string;
    nextSeq: number;
    journalStartSeq: number;
    entities: ReadonlyMap<string, TValue>;
    lastError: Error | null;
  }, generation: number): Promise<void> {
    this.ensureGeneration(generation);
    const state: ReplicaClientState<TValue> = {
      schemaVersion: REPLICA_STORAGE_SCHEMA_VERSION,
      storageKey: this.storageKey,
      scope: this.scope,
      epoch: update.epoch,
      nextSeq: update.nextSeq,
      journalStartSeq: update.journalStartSeq,
      entities: [...update.entities].map(([entityId, value]) => ({ entityId, value })),
    };
    try {
      if (!this.cacheError) await this.awaitStorage(this.serializeStorage(async () => {
        this.ensureGeneration(generation);
        // A timeout never releases accepted I/O for a concurrent writer. Skip
        // queued cache writes once disabled, keeping the physical lane intact.
        if (!this.cacheError) await this.storage.commitClient(state);
      }));
    } catch (error) {
      this.disableCache(error);
      if (!(error instanceof CacheTimeout)) this.scheduleCacheRepair();
    }
    this.ensureGeneration(generation);
    this.publish(update);
  }

  private awaitStorage<T>(operation: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = this.storageClock.setTimeout(() => {
        const timeout = new CacheTimeout("Replica cache timed out; using source data without persistence");
        reject(this.disableCache(timeout));
      }, this.storageTimeoutMs);
      void operation.then(resolve, reject).finally(() => this.storageClock.clearTimeout(timer));
    });
  }

  private serializeStorage(run: () => Promise<void>): Promise<void> {
    const operation = this.storageTail.then(run, run);
    this.storageTail = operation.catch(() => undefined);
    return operation;
  }

  private disableCache(error: unknown): Error {
    if (this.cacheError !== null) return this.cacheError;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.cacheError = failure;
    if (!this.disposed) this.publish({ cacheError: failure });
    return failure;
  }

  private scheduleCacheRepair(): void {
    if (this.cacheRepairScheduled || this.disposed) return;
    this.cacheRepairScheduled = true;
    // A rejected operation is settled before repair is queued. The client keeps
    // persistence disabled for this lifetime; a later instance may reuse the
    // cache only after this best-effort removal of the broken row succeeds.
    void this.serializeStorage(() => this.storage.clearClient(this.storageKey)).catch(() => undefined);
  }

  private fail(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.publish({ phase: "error", authoritative: false, lastError: failure });
  }

  private publish(update: Partial<Omit<ReplicaClientSnapshot<TValue>, "revision" | "scope" | "storageKey">>): void {
    this.snapshot = {
      ...this.snapshot,
      ...update,
      revision: this.snapshot.revision + 1,
    };
    for (const listener of this.listeners) listener();
  }

  private ensureGeneration(generation: number): void {
    if (generation !== this.sourceGeneration || this.disposed) {
      throw new ReplicaError("DISPOSED", "Replica source generation was superseded");
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new ReplicaError("DISPOSED", "Replica client has been disposed");
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
