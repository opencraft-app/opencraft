import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlDatabase, openManagedDatabase, schemaFingerprint, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { ACCOUNT_POOL_BASELINE_SQL, ACCOUNT_POOL_CREDIT_POLICY_SQL, ACCOUNT_POOL_MIGRATIONS, ACCOUNT_POOL_RESET_CREDITS_SQL } from "./account-pool-schema.js";
import { AccountPool, accountPoolSettings, type AccountCredentialRecords, type AccountPoolSettings } from "./account-pool.js";

export * from "./account-pool.js";
export { ACCOUNT_POOL_MIGRATIONS } from "./account-pool-schema.js";

// Node owner of the account pool: opens `account-pool.sqlite` through the
// managed lifecycle and keeps credentials in private files. Domain rules live
// in ./account-pool.ts over the runtime-neutral SQL port.

const BASELINE = ACCOUNT_POOL_BASELINE_SQL;
const RESET_CREDITS_SQL = ACCOUNT_POOL_RESET_CREDITS_SQL;
const CREDIT_POLICY_SQL = ACCOUNT_POOL_CREDIT_POLICY_SQL;

// The pre-ledger owner created these four tables and appended the nullable
// account metadata and quota windows columns. Accept only those known shapes.
const legacyAccountPoolMigration = {
  accepts(fingerprint: string): boolean {
    const tables = JSON.parse(fingerprint) as Array<{ name: string; columns: unknown[]; indexes: string[] }>;
    if (!tables.some(table => table.name === "pool_accounts")) return false;
    const target = new DatabaseSync(":memory:");
    try {
      target.exec(BASELINE);
      target.exec(RESET_CREDITS_SQL);
      target.exec(CREDIT_POLICY_SQL);
      const expected = JSON.parse(schemaFingerprint(target)) as typeof tables;
      const minimumColumns: Record<string, number> = { pool_accounts: 7, pool_affinity: 3, pool_active_account: 2, pool_quota: 6 };
      return tables.every(table => {
        const current = expected.find(candidate => candidate.name === table.name);
        return current !== undefined && table.columns.length >= minimumColumns[table.name]!
          && table.columns.length <= current.columns.length
          && JSON.stringify(table.columns) === JSON.stringify(current.columns.slice(0, table.columns.length))
          && JSON.stringify(table.indexes) === JSON.stringify(current.indexes);
      });
    } finally { target.close(); }
  },
  migrate(database: DatabaseSync): void {
    database.exec(BASELINE.replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
    for (const [table, additions] of [
      ["pool_accounts", ["email TEXT", "subscription_type TEXT", "rate_limit_tier TEXT", "last_used_at INTEGER", "last_used_host_id TEXT", "reset_credit_count INTEGER CHECK(reset_credit_count >= 0)", "reset_credits_observed_at INTEGER", "allow_credits INTEGER NOT NULL DEFAULT 1 CHECK(allow_credits IN (0,1))"]],
      ["pool_quota", ["limit_windows_json TEXT NOT NULL DEFAULT '[]'"]],
    ] as const) {
      const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
      for (const definition of additions) {
        if (!columns.has(definition.split(" ")[0]!)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      }
    }
  },
};

const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * Credential records as private files in `directory` (0700): one
 * `account-<id>.json` per account and one `host-<sha256(hostId)>.json` per
 * Host token, each written atomically through a temporary file with 0600.
 */
export function fileAccountCredentialRecords(directory: string): AccountCredentialRecords {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const accountPath = (id: string) => {
    if (!ACCOUNT_ID.test(id)) throw new TypeError("Invalid account id");
    return join(directory, `account-${id}.json`);
  };
  const hostPath = (hostId: string) => join(directory, `host-${createHash("sha256").update(hostId).digest("hex")}.json`);
  const writePrivate = (destination: string, text: string) => {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, destination);
      chmodSync(destination, 0o600);
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  return {
    readAccount: id => JSON.parse(readFileSync(accountPath(id), "utf8")),
    hasAccount: id => existsSync(accountPath(id)),
    writeAccount: (id, record) => writePrivate(accountPath(id), `${JSON.stringify(record)}\n`),
    deleteAccount: id => rmSync(accountPath(id), { force: true }),
    detachAccount(id) {
      const source = accountPath(id);
      const tombstone = `${source}.${randomUUID()}.removed`;
      if (existsSync(source)) renameSync(source, tombstone);
      return {
        restore: () => { if (existsSync(tombstone)) renameSync(tombstone, source); },
        commit: () => rmSync(tombstone, { force: true }),
      };
    },
    readHostToken(hostId) {
      try { return readFileSync(hostPath(hostId), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
      }
    },
    writeHostToken: (hostId, text) => writePrivate(hostPath(hostId), text),
    *hostTokens() {
      for (const name of readdirSync(directory)) {
        if (!name.startsWith("host-") || !name.endsWith(".json")) continue;
        yield readFileSync(join(directory, name), "utf8");
      }
    },
    readExternalFile: path => readFileSync(path),
  };
}

export interface AccountPoolStoreOptions extends AccountPoolSettings {
  readonly databasePath: string;
  readonly secretsDirectory: string;
}

/** Node assembly: `account-pool.sqlite` and the private `secrets/` directory. */
export class AccountPoolStore extends AccountPool {
  readonly outcome: DatabaseOutcome;

  constructor(options: AccountPoolStoreOptions) {
    const credentials = fileAccountCredentialRecords(options.secretsDirectory);
    accountPoolSettings(options);
    const managed = openManagedDatabase({ schemaId: "account-pool-host",
      path: options.databasePath,
      migrations: ACCOUNT_POOL_MIGRATIONS,
      legacyMigration: legacyAccountPoolMigration,
    });
    managed.database.exec("PRAGMA foreign_keys=ON;");
    super({ database: nodeSqlDatabase(managed.database), credentials, close: () => managed.database.close() }, options);
    this.outcome = managed.outcome;
  }
}
