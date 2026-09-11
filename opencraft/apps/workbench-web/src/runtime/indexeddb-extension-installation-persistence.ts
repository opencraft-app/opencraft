import type {
  ExtensionInstallationPersistence,
  ExtensionInstallationRecord,
} from "@opencraft/extension-runtime";

const DATABASE_VERSION = 1;
const INSTALLATION_STORE = "installations";

export interface IndexedDbExtensionInstallationPersistenceOptions {
  readonly databaseName?: string;
  readonly factory?: IDBFactory;
}

function result<TResult>(request: IDBRequest<TResult>): Promise<TResult> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")));
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")));
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")));
  });
}

export class IndexedDbExtensionInstallationPersistence implements ExtensionInstallationPersistence {
  private closed = false;

  private constructor(private readonly database: IDBDatabase) {}

  static async open(
    options: IndexedDbExtensionInstallationPersistenceOptions = {},
  ): Promise<IndexedDbExtensionInstallationPersistence> {
    const request = (options.factory ?? indexedDB).open(
      options.databaseName ?? "vela-extension-installations",
      DATABASE_VERSION,
    );
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(INSTALLATION_STORE)) {
        request.result.createObjectStore(INSTALLATION_STORE, { keyPath: "extensionId" });
      }
    });
    return new IndexedDbExtensionInstallationPersistence(await result(request));
  }

  async load(): Promise<readonly unknown[]> {
    this.ensureOpen();
    const transaction = this.database.transaction(INSTALLATION_STORE, "readonly");
    const done = complete(transaction);
    const values = await result<unknown[]>(transaction.objectStore(INSTALLATION_STORE).getAll());
    await done;
    return values;
  }

  async put(record: ExtensionInstallationRecord): Promise<void> {
    this.ensureOpen();
    const transaction = this.database.transaction(INSTALLATION_STORE, "readwrite");
    const done = complete(transaction);
    await result(transaction.objectStore(INSTALLATION_STORE).put(structuredClone(record)));
    await done;
  }

  async remove(extensionId: string): Promise<void> {
    this.ensureOpen();
    const transaction = this.database.transaction(INSTALLATION_STORE, "readwrite");
    const done = complete(transaction);
    await result(transaction.objectStore(INSTALLATION_STORE).delete(extensionId));
    await done;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("IndexedDB extension installation persistence is closed");
  }
}
