import {
  UI_PREFERENCE_KEYS,
  type CompareAndSetPreferenceResult,
  type StoredUiPreference,
  type UiPreferenceKey,
  type UiPreferenceStore,
} from "@opencraft/ui-preferences";

const DATABASE_VERSION = 1;
const PREFERENCES_STORE = "preferences";
const CHANNEL_NAME = "opencraft-ui-preferences-v1";

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

function isPreferenceKey(value: unknown): value is UiPreferenceKey {
  return typeof value === "string" && UI_PREFERENCE_KEYS.includes(value as UiPreferenceKey);
}

export class IndexedDbUiPreferenceStore implements UiPreferenceStore {
  readonly #listeners = new Set<(key: UiPreferenceKey) => void>();
  readonly #channel: BroadcastChannel | null;
  #closed = false;

  private constructor(private readonly database: IDBDatabase, channel: BroadcastChannel | null) {
    this.#channel = channel;
    if (channel !== null) {
      channel.addEventListener("message", (event) => {
        if (isPreferenceKey(event.data)) this.#publish(event.data, false);
      });
    }
  }

  static async open(options: {
    readonly databaseName: string;
    readonly factory?: IDBFactory;
    readonly createChannel?: (name: string) => BroadcastChannel;
  }): Promise<IndexedDbUiPreferenceStore> {
    const request = (options.factory ?? indexedDB).open(options.databaseName, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(PREFERENCES_STORE)) {
        request.result.createObjectStore(PREFERENCES_STORE, { keyPath: "key" });
      }
    });
    const createChannel = options.createChannel
      ?? (typeof BroadcastChannel === "undefined" ? null : (name: string) => new BroadcastChannel(name));
    return new IndexedDbUiPreferenceStore(
      await requestResult(request),
      createChannel === null ? null : createChannel(`${CHANNEL_NAME}:${options.databaseName}`),
    );
  }

  async load(key: UiPreferenceKey): Promise<StoredUiPreference | null> {
    this.#ensureOpen();
    const transaction = this.database.transaction(PREFERENCES_STORE, "readonly");
    const completion = transactionComplete(transaction);
    const record = await requestResult<StoredUiPreference | undefined>(
      transaction.objectStore(PREFERENCES_STORE).get(key),
    );
    await completion;
    return record ?? null;
  }

  async compareAndSet(
    key: UiPreferenceKey,
    expectedRevision: number,
    valueJson: string,
  ): Promise<CompareAndSetPreferenceResult> {
    this.#ensureOpen();
    const transaction = this.database.transaction(PREFERENCES_STORE, "readwrite");
    const store = transaction.objectStore(PREFERENCES_STORE);
    const current = await requestResult<StoredUiPreference | undefined>(store.get(key));
    const revision = current?.revision ?? 0;
    if (revision !== expectedRevision) {
      transaction.abort();
      try { await transactionComplete(transaction); } catch { /* Expected abort: no write was committed. */ }
      return { outcome: "conflict", revision };
    }
    const record = Object.freeze({
      key,
      revision: revision + 1,
      valueJson,
      updatedAt: Date.now(),
    });
    await requestResult(store.put(record));
    await transactionComplete(transaction);
    this.#publish(key, true);
    return { outcome: "updated", record };
  }

  subscribe(listener: (key: UiPreferenceKey) => void): () => void {
    this.#ensureOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#channel?.close();
    this.database.close();
  }

  #publish(key: UiPreferenceKey, broadcast: boolean): void {
    for (const listener of this.#listeners) listener(key);
    if (broadcast) this.#channel?.postMessage(key);
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("IndexedDB UI preference store is closed");
  }
}
