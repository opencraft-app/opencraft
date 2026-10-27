import { defaultDatabaseDirectory, openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { File } from "expo-file-system";
import { createReplicaDatabaseIdentityMigration } from "./database-identity";
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

const databaseFile = (name: string) => new File(`file://${defaultDatabaseDirectory}`, name);
let snapshotSequence = 0;
const prepareDatabaseIdentity = createReplicaDatabaseIdentityMigration({
  exists: name => databaseFile(name).exists,
  async snapshot(name) {
    const database = await openDatabaseAsync(name, { useNewConnection: true });
    try {
      const check = await database.getFirstAsync<{ quick_check: string }>("PRAGMA quick_check");
      const schema = await database.getFirstAsync("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'replica_clients'");
      if (check?.quick_check !== "ok" || schema === null) throw new Error("Unknown or damaged former Replica database");
      return await database.serializeAsync();
    } finally { await database.closeAsync(); }
  },
  async install(name, snapshot) {
    const destination = databaseFile(name);
    const temporary = databaseFile(`.${name}.${Date.now().toString(36)}-${++snapshotSequence}.migration`);
    temporary.create({ overwrite: false });
    try {
      temporary.write(snapshot);
      await temporary.move(destination, { overwrite: false });
    } finally { if (temporary.exists && temporary.uri !== destination.uri) temporary.delete(); }
  },
});

export class ExpoSqliteReplicaClientStorage<TValue extends ReplicaJsonValue = ReplicaJsonValue>
implements ReplicaClientStorage<TValue> {
  private database: Promise<SQLiteDatabase> | null = null;

  constructor(readonly databaseName = "opencraft-appserver-replica.db") {
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
    this.database ??= prepareDatabaseIdentity(this.databaseName).then(() => openDatabaseAsync(this.databaseName)).then(async (database) => {
      try {
        await database.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS replica_clients (
          storage_key TEXT PRIMARY KEY NOT NULL,
          schema_version INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
        `);
        return database;
      } catch (error) { await database.closeAsync(); throw error; }
    }).catch(error => {
      this.database = null;
      throw error;
    });
    return this.database;
  }
}
