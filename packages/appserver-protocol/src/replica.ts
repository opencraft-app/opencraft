export type ReplicaJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReplicaJsonValue[]
  | { readonly [key: string]: ReplicaJsonValue };

export interface ReplicaCursor {
  epoch: string;
  /** The next sequence number the receiver must apply. */
  nextSeq: number;
}

export type ReplicaMutation<TValue = ReplicaJsonValue> =
  | { kind: "upsert"; entityId: string; value: TValue }
  | { kind: "delete"; entityId: string };

export interface ReplicaEntry<TValue = ReplicaJsonValue> {
  scope: string;
  epoch: string;
  seq: number;
  mutation: ReplicaMutation<TValue>;
  commandId?: string;
}

export interface ReplicaSnapshotEntity<TValue = ReplicaJsonValue> {
  entityId: string;
  value: TValue;
}

/** The retained Journal interval and the authority's current cursor. */
export interface ReplicaBounds {
  journalStartSeq: number;
  nextSeq: number;
}

export interface ReplicaSyncParams {
  scope: string;
  cursor: ReplicaCursor | null;
  limit: number;
}

export interface ReplicaSnapshotResponse<TValue = ReplicaJsonValue> {
  kind: "snapshot";
  scope: string;
  epoch: string;
  bounds: ReplicaBounds;
  entities: readonly ReplicaSnapshotEntity<TValue>[];
  reason: "initial" | "epoch_changed" | "journal_compacted" | "rewind" | "forced";
}

export interface ReplicaDeltaResponse<TValue = ReplicaJsonValue> {
  kind: "delta";
  scope: string;
  epoch: string;
  bounds: ReplicaBounds;
  fromNextSeq: number;
  entries: readonly ReplicaEntry<TValue>[];
  hasMore: boolean;
}

export type ReplicaSyncResponse<TValue = ReplicaJsonValue> =
  | ReplicaSnapshotResponse<TValue>
  | ReplicaDeltaResponse<TValue>;

export interface ReplicaMutateParams<TValue = ReplicaJsonValue> {
  scope: string;
  commandId: string;
  expectedCursor?: ReplicaCursor | null;
  mutations: readonly ReplicaMutation<TValue>[];
}

export interface ReplicaMutateResponse {
  scope: string;
  epoch: string;
  firstSeq: number | null;
  nextSeq: number;
  replayed: boolean;
}

export interface ReplicaEntryNotification<TValue = ReplicaJsonValue> {
  entry: ReplicaEntry<TValue>;
}

export interface ReplicaSnapshotNotification<TValue = ReplicaJsonValue> {
  snapshot: ReplicaSnapshotResponse<TValue>;
}
