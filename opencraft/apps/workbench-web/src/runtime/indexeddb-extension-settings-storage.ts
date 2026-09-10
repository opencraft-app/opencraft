import type {
  ExtensionSettingsStorage,
  StoredExtensionSetting,
} from "@opencraft/extension-runtime";

const DATABASE_VERSION = 1;
const VALUE_STORE = "values";

export interface IndexedDbExtensionSettingsStorageOptions {
  readonly databaseName?: string;
  readonly factory?: IDBFactory;
}

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

export class IndexedDbExtensionSettingsStorage implements ExtensionSettingsStorage {
  private closed = false;

  private constructor(private readonly database: IDBDatabase) {}

  static async open(
    options: IndexedDbExtensionSettingsStorageOptions = {},
  ): Promise<IndexedDbExtensionSettingsStorage> {
    const factory = options.factory ?? indexedDB;
    const request = factory.open(
      options.databaseName ?? "vela-extension-settings",
      DATABASE_VERSION,
    );
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(VALUE_STORE)) {
        request.result.createObjectStore(VALUE_STORE, { keyPath: "key" });
      }
    });
    return new IndexedDbExtensionSettingsStorage(await requestResult(request));
  }

  async load(): Promise<readonly StoredExtensionSetting[]> {
    this.ensureOpen();
    const transaction = this.database.transaction(VALUE_STORE, "readonly");
    const completion = transactionComplete(transaction);
    const values = await requestResult<StoredExtensionSetting[]>(
      transaction.objectStore(VALUE_STORE).getAll(),
    );
    await completion;
    return values;
  }

  async put(record: StoredExtensionSetting): Promise<void> {
    this.ensureOpen();
    const transaction = this.database.transaction(VALUE_STORE, "readwrite");
    const completion = transactionComplete(transaction);
    await requestResult(transaction.objectStore(VALUE_STORE).put(structuredClone(record)));
    await completion;
  }

  async remove(key: string): Promise<void> {
    this.ensureOpen();
    const transaction = this.database.transaction(VALUE_STORE, "readwrite");
    const completion = transactionComplete(transaction);
    await requestResult(transaction.objectStore(VALUE_STORE).delete(key));
    await completion;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("IndexedDB extension settings storage is closed");
  }
}
