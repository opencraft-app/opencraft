import type {
  ReplicaCursor,
  ReplicaEntry,
  ReplicaJsonValue,
  ReplicaMutateResponse,
  ReplicaMutation,
  ReplicaSnapshotEntity,
  ReplicaSnapshotResponse,
  ReplicaSyncResponse,
} from "@opencraft/appserver-protocol";

import { ReplicaError } from "./errors";
import type { ReplicaLiveEvent, ReplicaSource } from "./source";
import {
  REPLICA_STORAGE_SCHEMA_VERSION,
  type ReplicaAuthorityState,
  type ReplicaAuthorityStorage,
  type ReplicaCommandReceipt,
} from "./storage";
import { validateAuthorityState, validateCursor } from "./validation";

export interface ReplicaAuthorityConfig<TValue extends ReplicaJsonValue> {
  scope: string;
  storage: ReplicaAuthorityStorage<TValue>;
  createEpoch?: () => string;
}

export interface ReplicaCommitOptions {
  commandId: string;
  expectedCursor?: ReplicaCursor | null;
}

function fingerprint<TValue extends ReplicaJsonValue>(mutations: readonly ReplicaMutation<TValue>[]): string {
  return JSON.stringify(mutations);
}

function materialize<TValue extends ReplicaJsonValue>(
  entities: readonly ReplicaSnapshotEntity<TValue>[],
  mutations: readonly ReplicaMutation<TValue>[],
): readonly ReplicaSnapshotEntity<TValue>[] {
  const next = new Map(entities.map((entity) => [entity.entityId, entity.value]));
  for (const mutation of mutations) {
    if (mutation.kind === "upsert") next.set(mutation.entityId, mutation.value);
    else next.delete(mutation.entityId);
  }
  return [...next].map(([entityId, value]) => ({ entityId, value }));
}

function defaultEpoch(): string {
  return `epoch-${crypto.randomUUID()}`;
}

export class ReplicaAuthority<TValue extends ReplicaJsonValue = ReplicaJsonValue>
implements ReplicaSource<TValue> {
  readonly scope: string;
  private readonly storage: ReplicaAuthorityStorage<TValue>;
  private readonly createEpoch: () => string;
  private readonly listeners = new Set<(event: ReplicaLiveEvent<TValue>) => void>();
  private state: ReplicaAuthorityState<TValue> | null = null;
  private opening: Promise<void> | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(config: ReplicaAuthorityConfig<TValue>) {
    if (config.scope.length === 0) throw new RangeError("Replica scope must not be empty");
    this.scope = config.scope;
    this.storage = config.storage;
    this.createEpoch = config.createEpoch ?? defaultEpoch;
  }

  open(): Promise<void> {
    if (this.state !== null) return Promise.resolve();
    if (this.opening !== null) return this.opening;
    this.opening = this.openOnce().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  get cursor(): ReplicaCursor {
    const state = this.requireState();
    return { epoch: state.epoch, nextSeq: state.nextSeq };
  }

  get journalStartSeq(): number {
    return this.requireState().journalStartSeq;
  }

  get entities(): readonly ReplicaSnapshotEntity<TValue>[] {
    return this.requireState().entities;
  }

  subscribe(listener: (event: ReplicaLiveEvent<TValue>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sync(cursor: ReplicaCursor | null, limit: number): Promise<ReplicaSyncResponse<TValue>> {
    await this.open();
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Replica sync limit must be positive");
    const state = this.requireState();
    if (cursor === null) return this.snapshot("initial");
    validateCursor(cursor);
    if (cursor.epoch !== state.epoch) return this.snapshot("epoch_changed");
    if (cursor.nextSeq < state.journalStartSeq) return this.snapshot("journal_compacted");
    if (cursor.nextSeq > state.nextSeq) return this.snapshot("rewind");
    const entries = state.journal
      .filter((entry) => entry.seq >= cursor.nextSeq)
      .slice(0, limit);
    const pageNextSeq = entries.at(-1)?.seq === undefined
      ? cursor.nextSeq
      : (entries.at(-1)?.seq ?? cursor.nextSeq) + 1;
    return {
      kind: "delta",
      scope: this.scope,
      epoch: state.epoch,
      bounds: { journalStartSeq: state.journalStartSeq, nextSeq: state.nextSeq },
      fromNextSeq: cursor.nextSeq,
      entries,
      hasMore: pageNextSeq < state.nextSeq,
    };
  }

  commit(
    mutations: readonly ReplicaMutation<TValue>[],
    options: ReplicaCommitOptions,
  ): Promise<ReplicaMutateResponse> {
    return this.exclusive(async () => {
      await this.open();
      if (options.commandId.length === 0) throw new RangeError("Replica commandId must not be empty");
      const state = this.requireState();
      const mutationFingerprint = fingerprint(mutations);
      const receipt = state.receipts.find((candidate) => candidate.commandId === options.commandId);
      if (receipt !== undefined) {
        if (receipt.fingerprint !== mutationFingerprint) {
          throw new ReplicaError("COMMAND_CONFLICT", `Replica command ${options.commandId} was reused with different mutations`);
        }
        return { ...receipt.response, replayed: true };
      }
      if (options.expectedCursor != null) {
        validateCursor(options.expectedCursor);
        if (
          options.expectedCursor.epoch !== state.epoch
          || options.expectedCursor.nextSeq !== state.nextSeq
        ) {
          throw new ReplicaError("STALE_CURSOR", "Replica write cursor no longer matches the authority");
        }
      }
      const entries: ReplicaEntry<TValue>[] = mutations.map((mutation, index) => ({
        scope: this.scope,
        epoch: state.epoch,
        seq: state.nextSeq + index,
        mutation,
        commandId: options.commandId,
      }));
      const nextSeq = state.nextSeq + entries.length;
      const response: ReplicaMutateResponse = {
        scope: this.scope,
        epoch: state.epoch,
        firstSeq: entries[0]?.seq ?? null,
        nextSeq,
        replayed: false,
      };
      const nextReceipt: ReplicaCommandReceipt = {
        commandId: options.commandId,
        fingerprint: mutationFingerprint,
        response,
      };
      const next: ReplicaAuthorityState<TValue> = {
        ...state,
        nextSeq,
        entities: materialize(state.entities, mutations),
        journal: [...state.journal, ...entries],
        // Receipts are part of the durable command contract, not Journal cache.
        // Evicting one would allow a sufficiently old retry to execute twice.
        receipts: [...state.receipts, nextReceipt],
      };
      await this.persist(next);
      this.state = next;
      for (const entry of entries) this.publish({ kind: "entry", entry });
      return response;
    });
  }

  compact(retainFromSeq: number): Promise<void> {
    return this.exclusive(async () => {
      await this.open();
      const state = this.requireState();
      if (!Number.isSafeInteger(retainFromSeq)) throw new RangeError("retainFromSeq must be a safe integer");
      const journalStartSeq = Math.max(state.journalStartSeq, Math.min(retainFromSeq, state.nextSeq));
      if (journalStartSeq === state.journalStartSeq) return;
      const next: ReplicaAuthorityState<TValue> = {
        ...state,
        journalStartSeq,
        journal: state.journal.filter((entry) => entry.seq >= journalStartSeq),
      };
      await this.persist(next);
      this.state = next;
    });
  }

  replaceSnapshot(
    entities: readonly ReplicaSnapshotEntity<TValue>[],
    epoch = this.createEpoch(),
  ): Promise<ReplicaSnapshotResponse<TValue>> {
    return this.exclusive(async () => {
      await this.open();
      const current = this.requireState();
      if (epoch.length === 0) throw new RangeError("Replica epoch must not be empty");
      if (epoch === current.epoch) {
        throw new ReplicaError("INVALID_STATE", "A destructive Replica replacement must rotate epoch");
      }
      const next: ReplicaAuthorityState<TValue> = {
        schemaVersion: REPLICA_STORAGE_SCHEMA_VERSION,
        scope: this.scope,
        epoch,
        nextSeq: 1,
        journalStartSeq: 1,
        entities: materialize([], entities.map((entity) => ({
          kind: "upsert" as const,
          entityId: entity.entityId,
          value: entity.value,
        }))),
        journal: [],
        receipts: [],
      };
      await this.persist(next);
      this.state = next;
      const snapshot = this.snapshot("forced");
      this.publish({ kind: "snapshot", snapshot });
      return snapshot;
    });
  }

  async mutate(params: {
    commandId: string;
    expectedCursor?: ReplicaCursor | null;
    mutations: readonly ReplicaMutation<TValue>[];
  }): Promise<ReplicaMutateResponse> {
    return this.commit(params.mutations, {
      commandId: params.commandId,
      expectedCursor: params.expectedCursor,
    });
  }

  private async openOnce(): Promise<void> {
    const stored = await this.storage.loadAuthority(this.scope);
    if (stored !== null) {
      validateAuthorityState(stored, this.scope);
      this.state = stored;
      return;
    }
    const epoch = this.createEpoch();
    if (epoch.length === 0) throw new ReplicaError("INVALID_STATE", "Epoch generator returned an empty value");
    const initial: ReplicaAuthorityState<TValue> = {
      schemaVersion: REPLICA_STORAGE_SCHEMA_VERSION,
      scope: this.scope,
      epoch,
      nextSeq: 1,
      journalStartSeq: 1,
      entities: [],
      journal: [],
      receipts: [],
    };
    await this.persist(initial);
    this.state = initial;
  }

  private snapshot(reason: ReplicaSnapshotResponse<TValue>["reason"]): ReplicaSnapshotResponse<TValue> {
    const state = this.requireState();
    return {
      kind: "snapshot",
      scope: this.scope,
      epoch: state.epoch,
      bounds: { journalStartSeq: state.journalStartSeq, nextSeq: state.nextSeq },
      entities: state.entities,
      reason,
    };
  }

  private requireState(): ReplicaAuthorityState<TValue> {
    if (this.state === null) throw new ReplicaError("NOT_OPEN", "Replica authority is not open");
    return this.state;
  }

  private async persist(state: ReplicaAuthorityState<TValue>): Promise<void> {
    try {
      await this.storage.commitAuthority(state);
    } catch (error) {
      throw new ReplicaError("STORAGE_ERROR", "Failed to commit Replica authority state", { cause: error });
    }
  }

  private publish(event: ReplicaLiveEvent<TValue>): void {
    for (const listener of this.listeners) listener(event);
  }

  private exclusive<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
