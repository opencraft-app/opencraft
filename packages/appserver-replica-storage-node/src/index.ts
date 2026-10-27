import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { ReplicaJsonValue } from "@opencraft/appserver-protocol";
import {
  REPLICA_STORAGE_SCHEMA_VERSION,
  type ReplicaAuthorityState,
  type ReplicaClientState,
  type ReplicaStorage,
} from "@opencraft/appserver-replica";

interface ReplicaFileDocument<TValue extends ReplicaJsonValue> {
  schemaVersion: typeof REPLICA_STORAGE_SCHEMA_VERSION;
  authorities: Record<string, ReplicaAuthorityState<TValue>>;
  clients: Record<string, ReplicaClientState<TValue>>;
}

function emptyDocument<TValue extends ReplicaJsonValue>(): ReplicaFileDocument<TValue> {
  return {
    schemaVersion: REPLICA_STORAGE_SCHEMA_VERSION,
    authorities: {},
    clients: {},
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parseDocument<TValue extends ReplicaJsonValue>(source: string): ReplicaFileDocument<TValue> {
  const value = JSON.parse(source) as Partial<ReplicaFileDocument<TValue>>;
  if (
    value === null
    || typeof value !== "object"
    || value.schemaVersion !== REPLICA_STORAGE_SCHEMA_VERSION
    || value.authorities === null
    || typeof value.authorities !== "object"
    || value.clients === null
    || typeof value.clients !== "object"
  ) {
    throw new Error("Replica storage file has an unsupported or malformed schema");
  }
  return value as ReplicaFileDocument<TValue>;
}

/** Node/server adapter. Each update is written to a sibling file and atomically renamed. */
export class JsonFileReplicaStorage<TValue extends ReplicaJsonValue = ReplicaJsonValue>
implements ReplicaStorage<TValue> {
  private document: ReplicaFileDocument<TValue> | null = null;
  private opening: Promise<void> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private tempCounter = 0;

  constructor(readonly path: string) {
    if (path.length === 0) throw new RangeError("Replica storage path must not be empty");
  }

  async loadAuthority(scope: string): Promise<ReplicaAuthorityState<TValue> | null> {
    await this.ensureOpen();
    const state = this.requireDocument().authorities[scope];
    return state === undefined ? null : clone(state);
  }

  commitAuthority(state: ReplicaAuthorityState<TValue>): Promise<void> {
    return this.update((document) => ({
      ...document,
      authorities: { ...document.authorities, [state.scope]: clone(state) },
    }));
  }

  clearAuthority(scope: string): Promise<void> {
    return this.update((document) => {
      const authorities = { ...document.authorities };
      delete authorities[scope];
      return { ...document, authorities };
    });
  }

  async loadClient(storageKey: string): Promise<ReplicaClientState<TValue> | null> {
    await this.ensureOpen();
    const state = this.requireDocument().clients[storageKey];
    return state === undefined ? null : clone(state);
  }

  commitClient(state: ReplicaClientState<TValue>): Promise<void> {
    return this.update((document) => ({
      ...document,
      clients: { ...document.clients, [state.storageKey]: clone(state) },
    }));
  }

  clearClient(storageKey: string): Promise<void> {
    return this.update((document) => {
      const clients = { ...document.clients };
      delete clients[storageKey];
      return { ...document, clients };
    });
  }

  private ensureOpen(): Promise<void> {
    if (this.document !== null) return Promise.resolve();
    if (this.opening !== null) return this.opening;
    this.opening = this.openOnce().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async openOnce(): Promise<void> {
    try {
      this.document = parseDocument<TValue>(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.document = emptyDocument();
    }
  }

  private update(
    updater: (document: ReplicaFileDocument<TValue>) => ReplicaFileDocument<TValue>,
  ): Promise<void> {
    return this.exclusive(async () => {
      await this.ensureOpen();
      const next = updater(this.requireDocument());
      await this.atomicWrite(next);
      this.document = next;
    });
  }

  private async atomicWrite(document: ReplicaFileDocument<TValue>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp-${process.pid}-${this.tempCounter++}`;
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.path);
      const directory = await open(dirname(this.path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private requireDocument(): ReplicaFileDocument<TValue> {
    if (this.document === null) throw new Error("Replica storage is not open");
    return this.document;
  }

  private exclusive<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
