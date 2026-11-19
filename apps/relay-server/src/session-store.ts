/** Authentication records retain their exact origin/instance scope in every backend. */
export type SessionKind = "starts" | "tickets" | "sessions";
export interface RelaySessionStore {
  get<T>(kind: SessionKind, id: string): Promise<T | null>;
  take<T>(kind: SessionKind, id: string): Promise<T | null>;
  put(kind: SessionKind, id: string, value: unknown, expiresAt: number, limit: number): Promise<boolean>;
  delete(kind: SessionKind, id: string): Promise<void>;
}
export class MemoryRelaySessionStore implements RelaySessionStore {
  readonly #records = new Map<SessionKind, Map<string, { value: unknown; expiresAt: number }>>();
  readonly #nextPrune = new Map<SessionKind, number>();
  #recordsFor(kind: SessionKind) {
    let values = this.#records.get(kind);
    if (!values) {
      values = new Map();
      this.#records.set(kind, values);
    }
    const now = Date.now();
    if (now >= (this.#nextPrune.get(kind) ?? 0)) {
      for (const [key, record] of values) if (record.expiresAt <= now) values.delete(key);
      this.#nextPrune.set(kind, now + 1000);
    }
    return values;
  }
  async get<T>(kind: SessionKind, id: string): Promise<T | null> {
    const records = this.#recordsFor(kind),
      record = records.get(id);
    if (!record || record.expiresAt <= Date.now()) {
      records.delete(id);
      return null;
    }
    return record.value as T;
  }
  async take<T>(kind: SessionKind, id: string): Promise<T | null> {
    const records = this.#recordsFor(kind),
      value = records.get(id);
    records.delete(id);
    return value && value.expiresAt > Date.now() ? (value.value as T) : null;
  }
  async put(kind: SessionKind, id: string, value: unknown, expiresAt: number, limit: number) {
    const records = this.#recordsFor(kind);
    if (expiresAt <= Date.now() || records.size >= limit) return false;
    records.set(id, { value, expiresAt });
    return true;
  }
  async delete(kind: SessionKind, id: string) {
    this.#recordsFor(kind).delete(id);
  }
}
