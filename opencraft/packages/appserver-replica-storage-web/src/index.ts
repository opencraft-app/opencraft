import type { ReplicaJsonValue } from "@opencraft/appserver-protocol";
import {
  REPLICA_STORAGE_SCHEMA_VERSION,
  type ReplicaClientState,
  type ReplicaClientStorage,
} from "@opencraft/appserver-replica";

const DATABASE_VERSION = 1;
const CLIENTS_STORE = "clients";

export interface IndexedDbReplicaClientStorageConfig {
  databaseName?: string;
  factory?: IDBFactory;
}

interface StoredClientRow<TValue extends ReplicaJsonValue> {
  storageKey: string;
  schemaVersion: number;
  state: ReplicaClientState<TValue>;
}

function requestResult<TResult>(request: IDBRequest<TResult>): Promise<TResult> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")));
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")));
  });
}

export class IndexedDbReplicaClientStorage<TValue extends ReplicaJsonValue = ReplicaJsonValue>
implements ReplicaClientStorage<TValue> {
  private readonly databaseName: string;
  private readonly factory: IDBFactory;
  private database: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;

  constructor(config: IndexedDbReplicaClientStorageConfig = {}) {
    this.databaseName = config.databaseName ?? "vela-appserver-replica";
    this.factory = config.factory ?? indexedDB;
  }

  async loadClient(storageKey: string): Promise<ReplicaClientState<TValue> | null> {
    const database = await this.open();
    const transaction = database.transaction(CLIENTS_STORE, "readonly");
    const completion = transactionComplete(transaction);
    const row = await requestResult<StoredClientRow<TValue> | undefined>(
      transaction.objectStore(CLIENTS_STORE).get(storageKey),
    );
    await completion;
    if (row === undefined) return null;
    if (row.schemaVersion !== REPLICA_STORAGE_SCHEMA_VERSION) {
      await this.clearClient(storageKey);
      return null;
    }
    return structuredClone(row.state);
  }

  async commitClient(state: ReplicaClientState<TValue>): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(CLIENTS_STORE, "readwrite");
    const completion = transactionComplete(transaction);
    try {
      await requestResult(transaction.objectStore(CLIENTS_STORE).put({
        storageKey: state.storageKey,
        schemaVersion: REPLICA_STORAGE_SCHEMA_VERSION,
        state: structuredClone(state),
      } satisfies StoredClientRow<TValue>));
      await completion;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The engine may already have aborted the failed transaction.
      }
      await completion.catch(() => undefined);
      throw error;
    }
  }

  async clearClient(storageKey: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(CLIENTS_STORE, "readwrite");
    const completion = transactionComplete(transaction);
    await requestResult(transaction.objectStore(CLIENTS_STORE).delete(storageKey));
    await completion;
  }

  close(): void {
    this.database?.close();
    this.database = null;
    this.opening = null;
  }

  private open(): Promise<IDBDatabase> {
    if (this.database !== null) return Promise.resolve(this.database);
    if (this.opening !== null) return this.opening;
    this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.databaseName, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(CLIENTS_STORE)) {
          request.result.createObjectStore(CLIENTS_STORE, { keyPath: "storageKey" });
        }
      });
      request.addEventListener("success", () => {
        this.database = request.result;
        resolve(request.result);
      });
      request.addEventListener("error", () => reject(request.error ?? new Error("Failed to open Replica IndexedDB")));
      request.addEventListener("blocked", () => reject(new Error("Replica IndexedDB open was blocked")));
    }).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }
}
