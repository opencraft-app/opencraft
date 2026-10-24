import type {
  ReplicaCursor,
  ReplicaEntry,
  ReplicaJsonValue,
  ReplicaMutateParams,
  ReplicaMutateResponse,
  ReplicaSnapshotResponse,
  ReplicaSyncResponse,
} from "@opencraft/appserver-protocol";

export type ReplicaLiveEvent<TValue extends ReplicaJsonValue = ReplicaJsonValue> =
  | { kind: "entry"; entry: ReplicaEntry<TValue> }
  | { kind: "snapshot"; snapshot: ReplicaSnapshotResponse<TValue> };

export interface ReplicaSource<TValue extends ReplicaJsonValue = ReplicaJsonValue> {
  readonly scope: string;
  sync(cursor: ReplicaCursor | null, limit: number): Promise<ReplicaSyncResponse<TValue>>;
  subscribe(listener: (event: ReplicaLiveEvent<TValue>) => void): () => void;
  mutate?(params: Omit<ReplicaMutateParams<TValue>, "scope">): Promise<ReplicaMutateResponse>;
}
