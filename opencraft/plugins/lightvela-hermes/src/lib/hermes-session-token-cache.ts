export interface HermesSessionTokenCache {
  get(instanceId: string): Promise<string | null>;
  put(instanceId: string, token: string): Promise<void>;
  remove(instanceId: string, expectedToken: string): Promise<void>;
  close?(): void;
  clear?(): Promise<void>;
}

interface StoredHermesSessionToken {
  readonly instanceId: string;
  readonly token: string;
  readonly updatedAt: number;
}

export interface IndexedDbHermesSessionTokenCacheOptions {
  readonly databaseName?: string;
  readonly factory?: IDBFactory;
}

const DATABASE_VERSION = 1;
const TOKEN_STORE = "tokens";

function requestResult<TResult>(request: IDBRequest<TResult>): Promise<TResult> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("IndexedDB request failed"));
    });
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => {
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    });
    transaction.addEventListener("error", () => {
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    });
  });
}

function isStoredToken(value: unknown): value is StoredHermesSessionToken {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<StoredHermesSessionToken>;
  return typeof record.instanceId === "string"
    && typeof record.token === "string"
    && record.token.trim().length > 0
    && typeof record.updatedAt === "number"
    && Number.isFinite(record.updatedAt);
}

/**
 * A browser-local performance hint for adopting an already-running Hermes
 * backend. The Host remains the process/lock authority; every cached token is
 * authenticated against that Host before use.
 */
export class IndexedDbHermesSessionTokenCache implements HermesSessionTokenCache {
  private databasePromise: Promise<IDBDatabase> | null = null;
  private closed = false;

  constructor(private readonly options: IndexedDbHermesSessionTokenCacheOptions = {}) {}

  async get(instanceId: string): Promise<string | null> {
    const database = await this.database();
    const transaction = database.transaction(TOKEN_STORE, "readonly");
    const completion = transactionComplete(transaction);
    const value = await requestResult<unknown>(transaction.objectStore(TOKEN_STORE).get(instanceId));
    await completion;
    return isStoredToken(value) && value.instanceId === instanceId ? value.token.trim() : null;
  }

  async put(instanceId: string, token: string): Promise<void> {
    const normalizedToken = token.trim();
    if (!instanceId.trim() || !normalizedToken) return;
    const database = await this.database();
    const transaction = database.transaction(TOKEN_STORE, "readwrite");
    const completion = transactionComplete(transaction);
    await requestResult(transaction.objectStore(TOKEN_STORE).put({
      instanceId,
      token: normalizedToken,
      updatedAt: Date.now(),
    } satisfies StoredHermesSessionToken));
    await completion;
  }

  async remove(instanceId: string, expectedToken: string): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(TOKEN_STORE, "readwrite");
    const completion = transactionComplete(transaction);
    const store = transaction.objectStore(TOKEN_STORE);
    const current = await requestResult<unknown>(store.get(instanceId));
    if (isStoredToken(current) && current.token === expectedToken) {
      await requestResult(store.delete(instanceId));
    }
    await completion;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.databasePromise?.then((database) => database.close(), () => undefined);
  }

  async clear(): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(TOKEN_STORE, "readwrite");
    const completion = transactionComplete(transaction);
    transaction.objectStore(TOKEN_STORE).clear();
    await completion;
  }

  private database(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error("Hermes session token cache is closed"));
    if (this.databasePromise !== null) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const factory = this.options.factory ?? globalThis.indexedDB;
      if (factory === undefined) {
        reject(new Error("IndexedDB is unavailable"));
        return;
      }
      const request = factory.open(
        this.options.databaseName ?? "vela-lightvela-hermes-session-tokens",
        DATABASE_VERSION,
      );
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(TOKEN_STORE)) {
          request.result.createObjectStore(TOKEN_STORE, { keyPath: "instanceId" });
        }
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => {
        reject(request.error ?? new Error("Could not open the Hermes session token cache"));
      });
    });
    return this.databasePromise;
  }
}
