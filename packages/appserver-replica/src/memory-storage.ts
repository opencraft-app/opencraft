import type { ReplicaJsonValue } from "@opencraft/appserver-protocol";

import type {
  ReplicaAuthorityState,
  ReplicaClientState,
  ReplicaStorage,
} from "./storage";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryReplicaStorage<TValue extends ReplicaJsonValue = ReplicaJsonValue>
implements ReplicaStorage<TValue> {
  private readonly authorities = new Map<string, ReplicaAuthorityState<TValue>>();
  private readonly clients = new Map<string, ReplicaClientState<TValue>>();

  async loadAuthority(scope: string): Promise<ReplicaAuthorityState<TValue> | null> {
    const state = this.authorities.get(scope);
    return state === undefined ? null : clone(state);
  }

  async commitAuthority(state: ReplicaAuthorityState<TValue>): Promise<void> {
    this.authorities.set(state.scope, clone(state));
  }

  async clearAuthority(scope: string): Promise<void> {
    this.authorities.delete(scope);
  }

  async loadClient(storageKey: string): Promise<ReplicaClientState<TValue> | null> {
    const state = this.clients.get(storageKey);
    return state === undefined ? null : clone(state);
  }

  async commitClient(state: ReplicaClientState<TValue>): Promise<void> {
    this.clients.set(state.storageKey, clone(state));
  }

  async clearClient(storageKey: string): Promise<void> {
    this.clients.delete(storageKey);
  }
}
