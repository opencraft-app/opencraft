import type { ExtensionJson } from "./index.js";

export interface ExtensionDocumentSnapshot {
  readonly revision: number;
  readonly version: number;
  readonly value: ExtensionJson;
}
export interface ExtensionDocumentMigration {
  /** Sequential target version, starting at 2. Published checksums are immutable. */
  readonly version: number;
  readonly checksum: string;
  migrate(value: ExtensionJson): ExtensionJson;
}
export interface ExtensionDocumentOptions {
  readonly version: number;
  readonly initialValue: ExtensionJson;
  readonly migrations?: readonly ExtensionDocumentMigration[];
}
export interface ExtensionDocument {
  read(): Promise<ExtensionDocumentSnapshot>;
  compareAndSet(expectedRevision: number, value: ExtensionJson): Promise<{ readonly updated: boolean; readonly snapshot: ExtensionDocumentSnapshot }>;
  subscribe(listener: () => void): () => void;
}
export interface ExtensionDocumentStore {
  open(namespace: string, options?: ExtensionDocumentOptions): Promise<ExtensionDocument>;
}
/** Local and Host data are distinct authorities, never automatic mirrors. */
export interface ExtensionStorageApiV1 extends ExtensionDocumentStore {
  forHost(hostId: string): Promise<ExtensionDocumentStore>;
}
