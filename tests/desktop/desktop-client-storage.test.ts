import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { retireManagedDatabase, retiredInto, SqliteLifecycleError } from "../../packages/sqlite-node/src/index.ts";
import { SqliteDocumentStore } from "../../packages/document-storage/src/node-store.ts";
import { SqliteClientResources } from "../../packages/document-storage/src/client-resources-sqlite.ts";
import type { ClientResourceKey } from "../../packages/document-storage/src/client-resources.ts";
import { DesktopUiPreferenceStore } from "../../apps/desktop/src/ui-preferences-store.ts";
import { DesktopConnectorConfigurationStore } from "../../apps/desktop/src/connector-configuration-store.ts";
import { DESKTOP_CLIENT_DATABASE } from "../../apps/desktop/src/desktop-client-storage.ts";
import { openDesktopClientStorage } from "../../apps/desktop/src/desktop-client-import.ts";

const resource: ClientResourceKey = {
  namespace: "product/server/account-a",
  name: "draft",
  id: "thread-1",
  authority: "local",
};
const connectors = { version: 1, connectors: [], selections: [] };

function withProfile(run: (directory: string) => Promise<void> | void) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencraft-desktop-client-"));
    try {
      await run(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

/** What an earlier release leaves in userData: four standalone files written by their own stores. */
async function seedLegacyProfile(directory: string) {
  const ui = new DesktopUiPreferenceStore(join(directory, "opencraft-ui.sqlite"));
  assert.equal(ui.compareAndSet("chat.defaultFollowUpAction", 0, '"queue"').outcome, "updated");
  ui.close();
  const connector = new DesktopConnectorConfigurationStore(join(directory, "opencraft-connectors.sqlite"));
  assert.equal(connector.compareAndSet(0, connectors).updated, true);
  connector.close();
  const documents = new SqliteDocumentStore(join(directory, "opencraft-extensions.sqlite"));
  assert.equal(documents.compareAndSet("plugin.example/settings", 0, 1, { theme: "dark" }).updated, true);
  documents.close();
  const resources = new SqliteClientResources(join(directory, "opencraft-client-resources.sqlite"));
  assert.equal(await resources.compareAndSet(resource, 0, { value: "unsent draft", savedAt: 1, version: 1 }), true);
  resources.close();
}

function assertSeededData(storage: ReturnType<typeof openDesktopClientStorage>) {
  assert.equal(new DesktopUiPreferenceStore(storage).load("chat.defaultFollowUpAction")?.valueJson, '"queue"');
  assert.deepEqual(new DesktopConnectorConfigurationStore(storage).load(), { revision: 1, value: connectors });
  assert.deepEqual(new SqliteDocumentStore(storage).read("plugin.example/settings"), {
    revision: 1,
    version: 1,
    value: { theme: "dark" },
  });
}

test(
  "a fresh profile gets one client database shared by the four stores",
  withProfile(async (directory) => {
    const storage = openDesktopClientStorage(directory);
    try {
      assert.equal(storage.outcome.status, "fresh");
      const ui = new DesktopUiPreferenceStore(storage);
      const connector = new DesktopConnectorConfigurationStore(storage);
      const documents = new SqliteDocumentStore(storage);
      const resources = new SqliteClientResources(storage);
      assert.equal(ui.compareAndSet("shell.applicationsPinned", 0, "true").outcome, "updated");
      assert.equal(connector.compareAndSet(0, connectors).updated, true);
      assert.equal(documents.compareAndSet("plugin.example/settings", 0, 1, { a: 1 }).updated, true);
      assert.equal(await resources.compareAndSet(resource, 0, { value: "draft", savedAt: 1, version: 1 }), true);
      // Borrowers never close the shared connection.
      ui.close();
      connector.close();
      documents.close();
      resources.close();
      assert.equal(ui.load("shell.applicationsPinned")?.valueJson, "true");
    } finally {
      storage.database.close();
    }
    for (const file of [
      "opencraft-ui.sqlite",
      "opencraft-connectors.sqlite",
      "opencraft-extensions.sqlite",
      "opencraft-client-resources.sqlite",
    ])
      assert.equal(existsSync(join(directory, file)), false, `${file} is not created`);
  }),
);

test(
  "an upgraded profile keeps every row, records receipts and retires the old files",
  withProfile(async (directory) => {
    await seedLegacyProfile(directory);
    const storage = openDesktopClientStorage(directory);
    try {
      assertSeededData(storage);
      assert.deepEqual(await new SqliteClientResources(storage).read(resource), {
        revision: 1,
        version: 1,
        savedAt: 1,
        value: "unsent draft",
      });
      const receipts = storage.database
        .prepare("SELECT source,row_count FROM desktop_client_imports ORDER BY source")
        .all();
      assert.deepEqual(
        receipts.map((row) => [row.source, row.row_count]),
        [
          ["opencraft-client-resources.sqlite", 1],
          ["opencraft-connectors.sqlite", 1],
          ["opencraft-extensions.sqlite", 1],
          ["opencraft-ui.sqlite", 1],
        ],
      );
    } finally {
      storage.database.close();
    }

    // An older release that still opens a standalone file is refused, not handed stale rows.
    assert.throws(
      () => new DesktopUiPreferenceStore(join(directory, "opencraft-ui.sqlite")),
      (error: unknown) => error instanceof SqliteLifecycleError && error.kind === "newer-schema",
    );
    const old = new DatabaseSync(join(directory, "opencraft-extensions.sqlite"), { readOnly: true });
    try {
      assert.equal(retiredInto(old), DESKTOP_CLIENT_DATABASE);
    } finally {
      old.close();
    }

    // Reopening is a no-op and later writes stay in the merged database.
    const reopened = openDesktopClientStorage(directory);
    try {
      assert.equal(reopened.outcome.status, "up-to-date");
      const ui = new DesktopUiPreferenceStore(reopened);
      assert.equal(ui.compareAndSet("chat.defaultFollowUpAction", 1, '"steer"').outcome, "updated");
      assert.equal(ui.load("chat.defaultFollowUpAction")?.revision, 2);
    } finally {
      reopened.database.close();
    }
  }),
);

test(
  "an import interrupted before retirement finishes only if the old file is unchanged",
  withProfile(async (directory) => {
    await seedLegacyProfile(directory);
    openDesktopClientStorage(directory).database.close();
    const unretire = () => {
      const raw = new DatabaseSync(join(directory, "opencraft-ui.sqlite"));
      try {
        raw.exec("DELETE FROM schema_migrations WHERE name LIKE 'retired-into:%'");
      } finally {
        raw.close();
      }
    };

    // Crash between the receipt commit and the retirement marker.
    unretire();
    const resumed = openDesktopClientStorage(directory);
    try {
      assertSeededData(resumed);
    } finally {
      resumed.database.close();
    }
    const marked = new DatabaseSync(join(directory, "opencraft-ui.sqlite"), { readOnly: true });
    try {
      assert.equal(retiredInto(marked), DESKTOP_CLIENT_DATABASE);
    } finally {
      marked.close();
    }

    // An older release wrote to the file in that window: keep both, do not guess.
    unretire();
    const stale = new DesktopUiPreferenceStore(join(directory, "opencraft-ui.sqlite"));
    assert.equal(stale.compareAndSet("chat.defaultFollowUpAction", 1, '"steer"').outcome, "updated");
    stale.close();
    assert.throws(
      () => openDesktopClientStorage(directory),
      (error: unknown) =>
        error instanceof SqliteLifecycleError &&
        error.kind === "history-mismatch" &&
        /changed after it was imported/u.test(error.message),
    );
  }),
);

test(
  "an old file is not merged over rows the client database already has",
  withProfile(async (directory) => {
    const storage = openDesktopClientStorage(directory);
    try {
      assert.equal(
        new DesktopUiPreferenceStore(storage).compareAndSet("shell.applicationsPinned", 0, "true").outcome,
        "updated",
      );
    } finally {
      storage.database.close();
    }
    await seedLegacyProfile(directory);
    assert.throws(
      () => openDesktopClientStorage(directory),
      (error: unknown) => error instanceof SqliteLifecycleError && /already holds ui_preferences/u.test(error.message),
    );
    // The refused file is left exactly as it was.
    const kept = new DesktopUiPreferenceStore(join(directory, "opencraft-ui.sqlite"));
    try {
      assert.equal(kept.load("chat.defaultFollowUpAction")?.valueJson, '"queue"');
    } finally {
      kept.close();
    }
  }),
);

test(
  "retirement is idempotent for one target and refuses a second target or an unledgered file",
  withProfile((directory) => {
    const ui = new DesktopUiPreferenceStore(join(directory, "opencraft-ui.sqlite"));
    ui.close();
    const database = new DatabaseSync(join(directory, "opencraft-ui.sqlite"));
    const bare = new DatabaseSync(":memory:");
    try {
      retireManagedDatabase(database, "first.sqlite");
      retireManagedDatabase(database, "first.sqlite");
      assert.deepEqual(
        database
          .prepare("SELECT version,name FROM schema_migrations ORDER BY version")
          .all()
          .map((row) => [row.version, row.name]),
        [
          [1, "ui-preferences"],
          [2, "retired-into:first.sqlite"],
        ],
      );
      assert.throws(() => retireManagedDatabase(database, "second.sqlite"), /already retired/u);
      assert.throws(() => retireManagedDatabase(bare, "first.sqlite"), /ledgered/u);
    } finally {
      database.close();
      bare.close();
    }
  }),
);
