import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import type { ReplicaJsonValue } from "@opencraft/appserver-protocol";
import {
  REPLICA_STORAGE_SCHEMA_VERSION,
  type ReplicaClientState,
  type ReplicaClientStorage,
} from "@opencraft/appserver-replica";

interface StoredClientRow {
  schema_version: number;
  payload: string;
}

export class ExpoSqliteReplicaClientStorage<TValue extends ReplicaJsonValue = ReplicaJsonValue>
implements ReplicaClientStorage<TValue> {
  private database: Promise<SQLiteDatabase> | null = null;

  constructor(readonly databaseName = "vela-appserver-replica.db") {
    if (databaseName.length === 0) throw new RangeError("Replica SQLite database name must not be empty");
  }

  async loadClient(storageKey: string): Promise<ReplicaClientState<TValue> | null> {
    const database = await this.open();
    const row = await database.getFirstAsync<StoredClientRow>(
      "SELECT schema_version, payload FROM replica_clients WHERE storage_key = ?",
      storageKey,
    );
    if (row === null) return null;
    if (row.schema_version !== REPLICA_STORAGE_SCHEMA_VERSION) {
      await this.clearClient(storageKey);
      return null;
    }
    return JSON.parse(row.payload) as ReplicaClientState<TValue>;
  }

  async commitClient(state: ReplicaClientState<TValue>): Promise<void> {
    const database = await this.open();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        `INSERT INTO replica_clients (storage_key, schema_version, payload)
         VALUES (?, ?, ?)
         ON CONFLICT(storage_key) DO UPDATE SET
           schema_version = excluded.schema_version,
           payload = excluded.payload`,
        state.storageKey,
        REPLICA_STORAGE_SCHEMA_VERSION,
        JSON.stringify(state),
      );
    });
  }

  async clearClient(storageKey: string): Promise<void> {
    const database = await this.open();
    await database.runAsync("DELETE FROM replica_clients WHERE storage_key = ?", storageKey);
  }

  private open(): Promise<SQLiteDatabase> {
    this.database ??= openDatabaseAsync(this.databaseName).then(async (database) => {
      await database.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS replica_clients (
          storage_key TEXT PRIMARY KEY NOT NULL,
          schema_version INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
      `);
      return database;
    });
    return this.database;
  }
}
