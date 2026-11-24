import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applySqlMigrations, hashSqlMigrations } from "@opencraft/sql/migrations";
import { isMigrationLedgerObject } from "@opencraft/sql/schema-ledgers";
import { recordSealer } from "@opencraft/secret-storage/sealed-records";
import { migrateModelPolicySqlDatabase } from "@opencraft/model-usage-policy/sql-owner";
import {
  openAccountPoolSqlStorage,
  ownedByAccountPoolSchemas,
} from "../../packages/account-pool-host/src/account-pool-sql-owner.ts";
import { nodeSqlDatabase, resolveStoreMigrations, schemaFingerprint } from "@opencraft/sqlite-node";
import {
  ACCOUNT_POOL_MIGRATIONS,
  AccountPool,
  AccountPoolStore,
  type AccountCredentialRecords,
  type AccountPoolSettings,
} from "../../packages/account-pool-host/src/index.js";

// AccountCore storage conformance: the account pool domain runs on the
// runtime-neutral SQL port plus a credential-record port. The same cases run
// on the Node file owner and on a bare `nodeSqlDatabase` migrated with the
// lean ledger path a Durable Object would use (no backup, legacy adoption or
// process lock), with in-memory credential records.

/** Credential records kept beside the SQL rows, as a Durable Object adapter would. */
function memoryCredentialRecords(options: { failWrites?: () => boolean } = {}): AccountCredentialRecords {
  const accounts = new Map<string, string>(),
    hosts = new Map<string, string>();
  return {
    readAccount(id) {
      const text = accounts.get(id);
      if (text === undefined) throw new Error("missing");
      return JSON.parse(text);
    },
    hasAccount: (id) => accounts.has(id),
    writeAccount(id, record) {
      if (options.failWrites?.()) throw new Error("credential write failed");
      accounts.set(id, JSON.stringify(record));
    },
    deleteAccount: (id) => {
      accounts.delete(id);
    },
    detachAccount(id) {
      const text = accounts.get(id);
      accounts.delete(id);
      return {
        restore: () => {
          if (text !== undefined) accounts.set(id, text);
        },
        commit: () => undefined,
      };
    },
    readHostToken: (hostId) => hosts.get(hostId),
    writeHostToken: (hostId, text) => {
      hosts.set(hostId, text);
    },
    hostTokens: () => [...hosts.values()],
    readExternalFile() {
      throw new Error("External credential files are not available in this runtime");
    },
  };
}

interface Fixture {
  pool: AccountPool;
  schema(): string;
  close(): Promise<void>;
}
type Factory = (settings: AccountPoolSettings, failWrites?: () => boolean) => Promise<Fixture>;

const factories: Record<string, Factory> = {
  async "node file owner (AccountPoolStore)"(settings) {
    const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-port-"));
    const databasePath = join(root, "account-pool.sqlite");
    const pool = new AccountPoolStore({ ...settings, databasePath, secretsDirectory: join(root, "secrets") });
    return {
      pool,
      schema() {
        const reader = new DatabaseSync(databasePath, { readOnly: true });
        try {
          return schemaFingerprint(reader);
        } finally {
          reader.close();
        }
      },
      async close() {
        pool.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  },
  // The AccountCore Durable Object's layout: the pool's chains beside the policy's in one database,
  // credential records sealed in the same SQL (tests/storage/schema-ledgers.test.ts covers the chains).
  async "shared database + schema ledgers + sealed SQL credential records"(settings) {
    const connection = new DatabaseSync(":memory:");
    connection.exec("PRAGMA foreign_keys=ON");
    const database = nodeSqlDatabase(connection);
    migrateModelPolicySqlDatabase(database, {
      ownedByRuntime: (name) => isMigrationLedgerObject(name) || ownedByAccountPoolSchemas(name),
    });
    const storage = openAccountPoolSqlStorage(database, recordSealer(`k1.${"A".repeat(43)}`));
    let closed = false;
    const pool = new AccountPool({ ...storage, close: () => ((closed = true), connection.close()) }, settings);
    return {
      pool,
      schema: () => schemaFingerprint(connection),
      async close() {
        if (!closed) pool.close();
      },
    };
  },
  async "nodeSqlDatabase + lean ledger + memory credentials"(settings, failWrites) {
    const connection = new DatabaseSync(":memory:");
    const database = nodeSqlDatabase(connection);
    const migrations = hashSqlMigrations(resolveStoreMigrations("account-pool-host", ACCOUNT_POOL_MIGRATIONS), (text) =>
      createHash("sha256").update(text).digest("hex"),
    );
    applySqlMigrations(database, migrations);
    let closed = false;
    const pool = new AccountPool(
      {
        database,
        credentials: memoryCredentialRecords({ failWrites }),
        close: () => {
          closed = true;
          connection.close();
        },
      },
      settings,
    );
    return {
      pool,
      schema: () => schemaFingerprint(connection),
      async close() {
        if (!closed) pool.close();
      },
    };
  },
};

const account = (id: string, priority: number) => ({
  id,
  provider: "codex" as const,
  label: id.toUpperCase(),
  upstreamAccountId: `upstream-${id}`,
  priority,
  enabled: true,
});
const secret = (token: string) => ({ accessToken: token, refreshToken: `${token}-refresh`, expiresAt: null });

const cases: Record<string, (factory: Factory) => Promise<void>> = {
  async "accounts, credentials and listing"(factory) {
    const fixture = await factory({ now: () => 1_000 });
    try {
      const { pool } = fixture;
      pool.addAccount(account("a", 2), secret("token-a"));
      pool.addAccount(account("b", 1), secret("token-b"));
      assert.throws(() => pool.addAccount(account("a", 3), secret("again")), /already exists/);
      assert.deepEqual(
        pool.listAccounts().map((row) => [row.id, row.credentialConfigured, row.credentialSource]),
        [
          ["b", true, "managed"],
          ["a", true, "managed"],
        ],
      );
      assert.equal(pool.readCredential(" a ").accessToken, "token-a");
      pool.replaceCredential("a", secret("token-a2"));
      assert.equal(pool.readCredential("a").accessToken, "token-a2");
      pool.reorder("codex", ["a", "b"]);
      assert.deepEqual(
        pool.listAccounts().map((row) => row.id),
        ["a", "b"],
      );
      pool.setEnabled("b", false);
      pool.setAllowCredits("a", true);
      assert.deepEqual(
        pool.listAccountStates().map((row) => [row.accountId, row.status]),
        [
          ["a", "ready"],
          ["b", "disabled"],
        ],
      );
      pool.updateSubscriptionMetadata("a", {
        email: "a@example.test",
        resetCredits: { availableCount: 2, observedAt: 900 },
      });
      assert.deepEqual(pool.listAccountStates()[0]!.resetCredits, { availableCount: 2, observedAt: 900 });
    } finally {
      await fixture.close();
    }
  },

  async "selection reserves affinity in one transaction and rotates on exhaustion"(factory) {
    let now = 10_000;
    const fixture = await factory({ now: () => now });
    try {
      const { pool } = fixture;
      pool.addAccount(account("a", 1), secret("token-a"));
      pool.addAccount(account("b", 2), secret("token-b"));
      const first = pool.select({ provider: "codex", hostId: "host", affinityId: "thread-1" });
      assert.equal(first.account.id, "a");
      assert.equal(first.secret.accessToken, "token-a");
      first.accept();
      assert.equal(pool.listAccountStates().find((row) => row.accountId === "a")!.lastUsedAt, now);
      assert.equal(pool.affinityCount(), 1);
      pool.observeQuota("a", { utilization: 1, resetAt: now + 60_000 });
      // The bound account is exhausted: the Thread moves to the next eligible account.
      assert.equal(pool.select({ provider: "codex", hostId: "host", affinityId: "thread-1" }).account.id, "b");
      // Metadata reads neither allocate nor move the cursor.
      assert.equal(
        pool.select({ provider: "codex", hostId: "host", affinityId: "metadata", purpose: "metadata" }).account.id,
        "b",
      );
      assert.equal(pool.affinityCount(), 1);
      pool.markAccountError("b", "authorization-rejected");
      assert.throws(
        () => pool.select({ provider: "codex", hostId: "host", affinityId: "thread-2" }),
        /No eligible account/,
      );
      now += 61_000;
      assert.equal(pool.select({ provider: "codex", hostId: "host", affinityId: "thread-2" }).account.id, "a");
    } finally {
      await fixture.close();
    }
  },

  async "removal cascades rows and credentials, then the id is reusable"(factory) {
    const fixture = await factory({});
    try {
      const { pool } = fixture;
      pool.addAccount(account("a", 1), secret("token-a"));
      pool.select({ provider: "codex", hostId: "host", affinityId: "thread" }).accept();
      pool.observeQuota("a", { utilization: 0.1, resetAt: null });
      pool.removeAccount("a");
      assert.equal(pool.affinityCount(), 0);
      assert.deepEqual(pool.listAccountStates(), []);
      assert.throws(() => pool.readCredential("a"), /not found/);
      pool.addAccount(account("a", 1), secret("token-new"));
      assert.equal(pool.readCredential("a").accessToken, "token-new");
    } finally {
      await fixture.close();
    }
  },

  async "Host tokens are stable and authenticate exactly one Host"(factory) {
    const fixture = await factory({});
    try {
      const { pool } = fixture;
      const local = pool.issueHostToken("local-codex");
      assert.match(local, /^[A-Za-z0-9_-]{43}$/u);
      assert.equal(pool.issueHostToken("local-codex"), local);
      const other = pool.issueHostToken("caller:pi");
      assert.notEqual(other, local);
      assert.equal(pool.authenticateHostToken(local), "local-codex");
      assert.equal(pool.authenticateHostToken(other), "caller:pi");
      assert.equal(pool.authenticateHostToken("x".repeat(43)), null);
    } finally {
      await fixture.close();
    }
  },

  async "Human owners see only their own accounts in one store"(factory) {
    const fixture = await factory({ ownerActor: "human-a" });
    try {
      fixture.pool.addAccount(account("a", 1), secret("token-a"));
      assert.deepEqual(
        fixture.pool.listAccounts().map((row) => row.id),
        ["a"],
      );
      assert.equal(fixture.pool.select({ provider: "codex", hostId: "host", affinityId: "thread" }).account.id, "a");
    } finally {
      await fixture.close();
    }
  },
};

for (const [factoryName, factory] of Object.entries(factories)) {
  for (const [caseName, run] of Object.entries(cases)) {
    test(`account pool over ${factoryName}: ${caseName}`, () => run(factory));
  }
}

test("a failed credential write rolls back the account row through the SQL port transaction", async () => {
  let fail = false;
  const fixture = await factories["nodeSqlDatabase + lean ledger + memory credentials"]!({}, () => fail);
  try {
    fail = true;
    assert.throws(() => fixture.pool.addAccount(account("a", 1), secret("token-a")), /credential write failed/);
    fail = false;
    assert.deepEqual(fixture.pool.listAccounts(), []);
    fixture.pool.addAccount(account("a", 1), secret("token-a"));
    assert.equal(fixture.pool.listAccounts().length, 1);
  } finally {
    await fixture.close();
  }
});

test("the lean ledger path yields the same schema as the managed Node owner", async () => {
  const [file, lean] = await Promise.all(
    ["node file owner (AccountPoolStore)", "nodeSqlDatabase + lean ledger + memory credentials"].map((name) =>
      factories[name]!({}),
    ),
  );
  try {
    assert.equal(lean!.schema(), file!.schema());
  } finally {
    await Promise.all([file!.close(), lean!.close()]);
  }
});

test("invalid settings close the handed-over storage instead of leaking it", async () => {
  const connection = new DatabaseSync(":memory:");
  let closed = 0;
  assert.throws(
    () =>
      new AccountPool(
        {
          database: nodeSqlDatabase(connection),
          credentials: memoryCredentialRecords(),
          close: () => {
            closed++;
            connection.close();
          },
        },
        { switchThreshold: 2 },
      ),
    /Invalid switch threshold/,
  );
  assert.equal(closed, 1);
});
