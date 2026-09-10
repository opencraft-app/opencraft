import type { SidebarLayoutDocument, SidebarLayoutStorage } from "@opencraft/sidebar-layout";

const DATABASE_VERSION = 1;
const LAYOUT_STORE = "layouts";

interface StoredSidebarLayout extends SidebarLayoutDocument {
  readonly scope: string;
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

export class IndexedDbSidebarLayoutStorage implements SidebarLayoutStorage {
  private closed = false;
  private constructor(private readonly database: IDBDatabase) {}

  static async open(options: { readonly databaseName?: string; readonly factory?: IDBFactory } = {}) {
    const request = (options.factory ?? indexedDB).open(options.databaseName ?? "vela-sidebar-layout", DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(LAYOUT_STORE)) {
        request.result.createObjectStore(LAYOUT_STORE, { keyPath: "scope" });
      }
    });
    return new IndexedDbSidebarLayoutStorage(await requestResult(request));
  }

  async load(scope: string): Promise<SidebarLayoutDocument | null> {
    this.ensureOpen();
    const transaction = this.database.transaction(LAYOUT_STORE, "readonly");
    const completion = transactionComplete(transaction);
    const value = await requestResult<StoredSidebarLayout | undefined>(transaction.objectStore(LAYOUT_STORE).get(scope));
    await completion;
    return value === undefined ? null : {
      schemaVersion: value.schemaVersion,
      pinnedEntityKeys: value.pinnedEntityKeys,
      ownership: value.ownership,
    };
  }

  async save(scope: string, document: SidebarLayoutDocument): Promise<SidebarLayoutDocument> {
    this.ensureOpen();
    const transaction = this.database.transaction(LAYOUT_STORE, "readwrite");
    const completion = transactionComplete(transaction);
    await requestResult(transaction.objectStore(LAYOUT_STORE).put({ scope, ...structuredClone(document) }));
    await completion;
    return document;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("IndexedDB Sidebar layout storage is closed");
  }
}
