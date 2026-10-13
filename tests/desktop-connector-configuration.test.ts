import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DesktopConnectorConfigurationStore } from "../apps/workbench-electron/src/connector-configuration-store.js";
import { emptyConnectorConfiguration } from "@opencraft/workbench-runtime/connectors/configuration";

test("DesktopConnectorConfigurationStore: fresh, up-to-date, and CAS operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-connector-config-test-"));
  const path = join(root, "configuration.sqlite");
  try {
    // 1. Fresh
    const fresh = new DesktopConnectorConfigurationStore(path);
    assert.equal(fresh.outcome.status, "fresh");
    assert.deepEqual(fresh.load(), { revision: 0, value: emptyConnectorConfiguration() });

    // CAS: update from revision 0 to 1
    const testConfig = {
      ...emptyConnectorConfiguration(),
      connectors: [{ id: "c1", hostId: "host-1", server: "srv-1", title: "Test Server" }],
    };
    const updateResult = fresh.compareAndSet(0, testConfig);
    assert.equal(updateResult.updated, true);
    assert.equal(updateResult.record.revision, 1);
    assert.deepEqual(updateResult.record.value, testConfig);

    // CAS conflict: trying with wrong revision 0 should fail
    const conflictResult = fresh.compareAndSet(0, emptyConnectorConfiguration());
    assert.equal(conflictResult.updated, false);
    assert.equal(conflictResult.record.revision, 1);

    fresh.close();

    // 2. Up-to-date reopen
    const reopened = new DesktopConnectorConfigurationStore(path);
    assert.equal(reopened.outcome.status, "up-to-date");
    assert.deepEqual(reopened.load(), { revision: 1, value: testConfig });
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DesktopConnectorConfigurationStore adopts legacy matching database and moves aside mismatched legacy database", async () => {
  for (const matching of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), `oc-connector-config-legacy-${matching ? "match" : "mismatch"}-`));
    const path = join(root, "configuration.sqlite");
    try {
      const raw = new DatabaseSync(path);
      raw.exec(`
        CREATE TABLE connector_configuration (
          id INTEGER PRIMARY KEY CHECK(id=1),
          revision INTEGER NOT NULL,
          value TEXT NOT NULL
        ) STRICT;
      `);
      const legacyConfig = {
        ...emptyConnectorConfiguration(),
        connectors: [{ id: "legacy-c", hostId: "h", server: "s", title: "Legacy" }],
      };
      if (matching) {
        raw.prepare("INSERT INTO connector_configuration VALUES(1, ?, ?)").run(1, JSON.stringify(legacyConfig));
      } else {
        raw.exec("CREATE TABLE extra_table (id TEXT PRIMARY KEY)");
      }
      raw.close();

      const store = new DesktopConnectorConfigurationStore(path);
      try {
        assert.equal(store.outcome.status, matching ? "adopted" : "moved-aside");
        assert.ok(store.outcome.backupPath);
        const files = await readdir(root);
        assert.ok(files.some(f => f.includes(".pre-v1-")));
        assert.equal(files.some(f => f.includes(".legacy-")), !matching);

        if (matching) {
          assert.deepEqual(store.load(), { revision: 1, value: legacyConfig });
        } else {
          assert.deepEqual(store.load(), { revision: 0, value: emptyConnectorConfiguration() });
        }
      } finally {
        store.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
