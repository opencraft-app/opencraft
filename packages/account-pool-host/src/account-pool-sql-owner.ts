// Account pool storage for an owner whose SQL database is exclusive, durable
// and shared with other chains (the AccountCore Durable Object;
// cloudflare-deployment §5.6, storage-ports §7). Runtime-neutral apart from
// node:crypto (Node, and workerd under nodejs_compat), which the Node owner
// uses for the same checksums.
//
// Two named chains share the database with its own chain (the model usage
// policy keeps `schema_migrations`), each with its rows in `schema_ledgers`:
//   account-pool-host           the published account pool chain, exactly as
//                               the Node file owner applies it (v1–v3 from
//                               account-pool-schema.ts, later versions from the
//                               generated store contract)
//   account-credential-records  sealed credential records in the same
//                               database, so "reserve affinity + read the
//                               credential" and "write the row + write the
//                               credential" are one storage transaction
// The Node owner (store.ts) keeps its file, its private credential files and
// its `openManagedDatabase` lifecycle; nothing here changes them.
import { createHash } from "node:crypto";
import type { SqlDatabase } from "@opencraft/sql";
import { hashSqlMigrations, resolveSqlMigrationContract, type SqlMigration } from "@opencraft/sql/migrations";
import { migrateSqlSchema, type SqlSchemaDeclaration, type SqlSchemaOutcome } from "@opencraft/sql/schema-ledgers";
import { STORE_MIGRATIONS } from "@opencraft/sqlite-node/store-migrations-data";
import type { RecordSealer } from "@opencraft/secret-storage/sealed-records";
import { ACCOUNT_POOL_MIGRATIONS } from "./account-pool-schema.js";
import type { AccountCredentialRecords, AccountPoolStorage } from "./account-pool.js";

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** The account pool chain's schema id: the Node owner's storage schema id. */
export const ACCOUNT_POOL_SCHEMA = "account-pool-host";
/** Sealed credential records beside the pool's rows. */
export const ACCOUNT_CREDENTIAL_RECORDS_SCHEMA = "account-credential-records";

/** Published: never rewrite; append version N+1. */
export const ACCOUNT_CREDENTIAL_RECORD_MIGRATIONS: readonly SqlMigration[] = [
  {
    version: 1,
    name: "account-credential-records",
    sql: "CREATE TABLE account_credential_records (kind TEXT NOT NULL CHECK(kind IN ('account','host')), id TEXT NOT NULL, sealed TEXT NOT NULL, PRIMARY KEY (kind, id)) STRICT",
  },
];

/** The two chains, as a shared database hosts them. Every object of either carries its chain's prefix. */
export function accountPoolSqlSchemas(): readonly SqlSchemaDeclaration[] {
  return [
    {
      schema: ACCOUNT_POOL_SCHEMA,
      migrations: hashSqlMigrations(
        resolveSqlMigrationContract(ACCOUNT_POOL_MIGRATIONS, STORE_MIGRATIONS[ACCOUNT_POOL_SCHEMA], sha256Hex),
        sha256Hex,
      ),
      owns: (name) => name.startsWith("pool_"),
    },
    {
      schema: ACCOUNT_CREDENTIAL_RECORDS_SCHEMA,
      migrations: hashSqlMigrations(ACCOUNT_CREDENTIAL_RECORD_MIGRATIONS, sha256Hex),
      owns: (name) => name.startsWith("account_credential_"),
    },
  ];
}

/** Whether a storage object belongs to one of the account pool's chains. */
export function ownedByAccountPoolSchemas(name: string): boolean {
  return accountPoolSqlSchemas().some((declaration) => declaration.owns(name));
}

/**
 * Credential records as sealed rows of `account_credential_records`, in the
 * pool's own database: reads and writes are synchronous and take part in the
 * pool's `transaction()`. Every value is sealed for its row (`account:<id>`,
 * `host:<sha256(hostId)>`); a value that does not open is unreadable, never
 * returned as plaintext. Operator-owned external files do not exist here.
 */
export function sqlAccountCredentialRecords(database: SqlDatabase, sealer: RecordSealer): AccountCredentialRecords {
  const read = database.prepare("SELECT sealed FROM account_credential_records WHERE kind=? AND id=?");
  const upsert = database.prepare(
    "INSERT INTO account_credential_records(kind,id,sealed) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET sealed=excluded.sealed",
  );
  const insert = database.prepare("INSERT INTO account_credential_records(kind,id,sealed) VALUES(?,?,?)");
  const remove = database.prepare("DELETE FROM account_credential_records WHERE kind=? AND id=?");
  const hostKey = (hostId: string) => sha256Hex(hostId);
  const sealedRow = (kind: "account" | "host", id: string) => {
    const row = read.get(kind, id);
    return row === undefined ? undefined : String(row.sealed);
  };
  return {
    readAccount(id) {
      const sealed = sealedRow("account", id);
      if (sealed === undefined) throw new Error("Account credentials are unavailable");
      return JSON.parse(sealer.unseal(`account:${id}`, sealed));
    },
    hasAccount: (id) => sealedRow("account", id) !== undefined,
    writeAccount(id, record) {
      upsert.run("account", id, sealer.seal(`account:${id}`, JSON.stringify(record)));
    },
    deleteAccount(id) {
      remove.run("account", id);
    },
    detachAccount(id) {
      // Hidden at once, as the file owner's tombstone rename hides it; restored only when absent.
      const sealed = sealedRow("account", id);
      if (sealed !== undefined) remove.run("account", id);
      return {
        restore() {
          if (sealed !== undefined && sealedRow("account", id) === undefined) insert.run("account", id, sealed);
        },
        commit() {},
      };
    },
    readHostToken(hostId) {
      const key = hostKey(hostId);
      const sealed = sealedRow("host", key);
      return sealed === undefined ? undefined : sealer.unseal(`host:${key}`, sealed);
    },
    writeHostToken(hostId, text) {
      const key = hostKey(hostId);
      insert.run("host", key, sealer.seal(`host:${key}`, text));
    },
    *hostTokens() {
      for (const row of database.prepare("SELECT id,sealed FROM account_credential_records WHERE kind='host'").all())
        yield sealer.unseal(`host:${String(row.id)}`, String(row.sealed));
    },
    readExternalFile() {
      throw new Error("External credential files are not available to this account owner");
    },
  };
}

export interface AccountPoolSqlStorage extends AccountPoolStorage {
  readonly outcomes: readonly SqlSchemaOutcome[];
}

/**
 * Migrates both chains in the shared database and returns the pool's storage.
 * A changed, newer or foreign history in either chain refuses the open. The
 * returned `close` releases nothing: the database belongs to its owner.
 */
export function openAccountPoolSqlStorage(database: SqlDatabase, sealer: RecordSealer): AccountPoolSqlStorage {
  const outcomes = accountPoolSqlSchemas().map((declaration) => migrateSqlSchema(database, declaration));
  return { database, credentials: sqlAccountCredentialRecords(database, sealer), outcomes, close() {} };
}
