import type {
  ReplicaEntry,
  ReplicaJsonValue,
  ReplicaMutateResponse,
  ReplicaSnapshotEntity,
} from "@opencraft/appserver-protocol";

export const REPLICA_STORAGE_SCHEMA_VERSION = 1;

export interface ReplicaCommandReceipt {
  commandId: string;
  fingerprint: string;
  response: ReplicaMutateResponse;
}

export interface ReplicaAuthorityState<TValue extends ReplicaJsonValue = ReplicaJsonValue> {
  schemaVersion: typeof REPLICA_STORAGE_SCHEMA_VERSION;
  scope: string;
  epoch: string;
  nextSeq: number;
  journalStartSeq: number;
  entities: readonly ReplicaSnapshotEntity<TValue>[];
  journal: readonly ReplicaEntry<TValue>[];
  receipts: readonly ReplicaCommandReceipt[];
}

export interface ReplicaClientState<TValue extends ReplicaJsonValue = ReplicaJsonValue> {
  schemaVersion: typeof REPLICA_STORAGE_SCHEMA_VERSION;
  storageKey: string;
  scope: string;
  epoch: string;
  nextSeq: number;
  journalStartSeq: number;
  entities: readonly ReplicaSnapshotEntity<TValue>[];
}

export interface ReplicaAuthorityStorage<TValue extends ReplicaJsonValue = ReplicaJsonValue> {
  loadAuthority(scope: string): Promise<ReplicaAuthorityState<TValue> | null>;
  commitAuthority(state: ReplicaAuthorityState<TValue>): Promise<void>;
  clearAuthority(scope: string): Promise<void>;
}

export interface ReplicaClientStorage<TValue extends ReplicaJsonValue = ReplicaJsonValue> {
  loadClient(storageKey: string): Promise<ReplicaClientState<TValue> | null>;
  commitClient(state: ReplicaClientState<TValue>): Promise<void>;
  clearClient(storageKey: string): Promise<void>;
}

export type ReplicaStorage<TValue extends ReplicaJsonValue = ReplicaJsonValue> =
  & ReplicaAuthorityStorage<TValue>
  & ReplicaClientStorage<TValue>;
