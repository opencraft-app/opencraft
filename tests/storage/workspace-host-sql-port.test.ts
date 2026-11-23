// WorkspaceHost stores on the runtime-neutral SQL port (workspace-host-split.md
// §4.1): the published migrations run through the SQL ledger runner on
// nodeSqlDatabase(:memory:) and produce the same schema and ledger as the Node
// owners' managed files, and the stores' key operations run on the port alone.
// The Durable Object comparison is tests/storage/workspace-host-workerd.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlDatabase } from "@opencraft/sqlite-node";
import { ConversationSchedules } from "@opencraft/host-schedules";
import { InterruptedTurnRecovery, ProviderTurnRetry } from "@opencraft/host-recovery";
import { OpenCraftHostStateDatabase } from "../../apps/opencraft-daemon/src/opencraft-host-state-database.ts";
import { ProvisionalThreads } from "../../apps/opencraft-daemon/src/provisional-threads.ts";
import { ledger, migrate, publishedMigrations, scenario, schema, WORKSPACE_HOST_STORES, type WorkspaceHostStore } from "./workerd/workspace-host-domain.ts";

function memory() {
  const connection = new DatabaseSync(":memory:");
  return { connection, database: nodeSqlDatabase(connection) };
}

/** The Node owners exactly as WorkspaceHost opens them; each closes its own file. */
function openNodeOwner(store: WorkspaceHostStore, root: string): { database: DatabaseSync; close(): unknown } {
  const port = {} as never;
  switch (store) {
    case "opencraft-host-state": {
      const owner = new OpenCraftHostStateDatabase(root);
      return { database: owner.database, close: () => owner.close() };
    }
    case "thread-creations": {
      const owner = new ProvisionalThreads(root);
      return { database: fileOf(root, "thread-creations.sqlite"), close: () => owner.close() };
    }
    case "conversation-schedules": {
      const owner = new ConversationSchedules(root, port, Date.now, undefined, undefined, undefined, () => ({ arm() {}, cancel() {} }));
      return { database: fileOf(root, "conversation-schedules.sqlite"), close: () => owner.close() };
    }
    case "interrupted-turn-recovery": {
      const owner = new InterruptedTurnRecovery(root, port);
      return { database: fileOf(root, "interrupted-turn-recovery.sqlite"), close: () => owner.close() };
    }
    case "provider-turn-retry": {
      const owner = new ProviderTurnRetry(root, port);
      return { database: fileOf(root, "provider-turn-retry.sqlite"), close: () => owner.close() };
    }
  }
}
const readers: DatabaseSync[] = [];
function fileOf(root: string, name: string) {
  const reader = new DatabaseSync(join(root, name), { readOnly: true });
  readers.push(reader);
  return reader;
}

for (const store of WORKSPACE_HOST_STORES) {
  test(`${store}: published migrations on the SQL port match the Node owner's file`, async () => {
    const root = await mkdtemp(join(tmpdir(), `wh-sql-port-${store}-`));
    const { connection, database } = memory();
    try {
      const applied = migrate(database, store);
      assert.deepEqual(
        applied,
        publishedMigrations(store).map(({ version, name, checksum }) => ({ version, name, checksum })),
      );
      const owner = openNodeOwner(store, root);
      try {
        const file = nodeSqlDatabase(owner.database);
        assert.deepEqual(ledger(file), applied, "same ledger rows and checksums");
        assert.deepEqual(schema(database), schema(file), "same schema objects");
      } finally {
        for (const reader of readers.splice(0)) reader.close();
        await owner.close();
      }
      // Reapplying validates the ledger and applies nothing.
      migrate(database, store);
      assert.deepEqual(ledger(database), applied);
    } finally {
      connection.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${store}: key operations run on nodeSqlDatabase alone`, async () => {
    const { connection, database } = memory();
    try {
      migrate(database, store);
      const first = await scenario(database, store);
      const again = memory();
      try {
        migrate(again.database, store);
        assert.deepEqual(await scenario(again.database, store), first, "deterministic across fresh databases");
      } finally {
        again.connection.close();
      }
      if (store === "opencraft-host-state") {
        const steps = first as Record<string, any>;
        assert.deepEqual(steps.order, ["c2", "c1"]);
        assert.equal(steps.duplicate.ok, false);
        assert.deepEqual(steps.nested, { inner: { ok: false, error: "abort inner" }, rolledBack: true });
        assert.equal(steps.active.status, "unowned", "an internal start has no human owner");
        assert.equal(steps.ended, "expired");
        assert.deepEqual(steps.senders, { forked: { kind: "employee", loginName: "alice" }, inherited: true, employees: true });
      }
      if (store === "conversation-schedules") {
        const steps = first as Record<string, any>;
        assert.equal(steps.saved.revision, 1);
        assert.match(steps.conflict, /Schedule changed/);
        assert.equal(steps.suspended.schedule.status, "paused");
      }
    } finally {
      connection.close();
    }
  });
}

test("each WorkspaceHost store keeps its own schema_migrations ledger (merging needs the §4.1 import migration)", () => {
  const { connection, database } = memory();
  try {
    migrate(database, "conversation-schedules");
    assert.throws(() => migrate(database, "interrupted-turn-recovery"), /Unsupported database migration history/);
  } finally {
    connection.close();
  }
});
