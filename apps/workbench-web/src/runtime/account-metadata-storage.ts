/** Account-scoped metadata only. Resource catalogs, media and authorization
 * remain capabilities of their respective owners. Local adapters may omit ACKs. */
export interface AccountMetadataStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Last Server acknowledgement, excluding optimistic writes still in flight. */
  getCommittedItem?(key: string): string | null;
  /** Additive Server projection at exactly the committed sideChats revision. */
  getCommittedSideChatDirectory?(): string | null;
  /** Same metadata CAS, with a v1-compatible leaf and an additive binding intent. */
  setSideChatDirectory?(value: string): void;
  onCommittedMetadataChanged?(listener: (field: string) => void): () => void;
  /** A completed anti-entropy pass, including an equal root, can refresh external owners. */
  onReconciled?(listener: () => void): () => void;
  flushKey?(key: string): Promise<void>;
  flush?(): Promise<void>;
  /** Server-pushed metadata commits from another device. */
  onMetadataChanged?(listener: (field: string) => void): () => void;
}
export interface ReadyAccountMetadataStorage extends AccountMetadataStorage {
  whenReady(): Promise<void>;
}

/** A committed null means absence; never fall back to an optimistic value. */
export function readCommittedMetadata(storage: AccountMetadataStorage, key: string): string | null {
  return storage.getCommittedItem ? storage.getCommittedItem(key) : storage.getItem(key);
}

export function flushMetadataKey(storage: AccountMetadataStorage, key: string): Promise<void> {
  return storage.flushKey ? storage.flushKey(key) : (storage.flush?.() ?? Promise.resolve());
}

export function observeCommittedMetadata(
  storage: AccountMetadataStorage,
  field: string,
  listener: () => void,
): () => void {
  const observe = storage.onCommittedMetadataChanged?.bind(storage) ?? storage.onMetadataChanged?.bind(storage);
  return (
    observe?.((changed) => {
      if (changed === field || changed === "*") listener();
    }) ?? (() => {})
  );
}
