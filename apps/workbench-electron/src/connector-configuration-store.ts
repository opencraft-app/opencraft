import type { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { emptyConnectorConfiguration, parseConnectorConfiguration, type ConnectorConfigurationRecord } from "@opencraft/workbench-runtime/connectors/configuration";

const BASELINE = "CREATE TABLE connector_configuration (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL) STRICT";

export class DesktopConnectorConfigurationStore {
  private readonly db: DatabaseSync;
  readonly outcome: DatabaseOutcome;
  constructor(path: string) {
    const managed = openManagedDatabase({
      path,
      migrations: [{ version: 1, name: "connector-configuration", sql: BASELINE }],
    });
    this.db = managed.database;
    this.outcome = managed.outcome;
  }
  load(): ConnectorConfigurationRecord {
    const row = this.db.prepare("SELECT revision, value FROM connector_configuration WHERE id=1").get() as { revision: number; value: string } | undefined;
    return row ? { revision: row.revision, value: parseConnectorConfiguration(JSON.parse(row.value)) } : { revision: 0, value: emptyConnectorConfiguration() };
  }
  compareAndSet(expected: unknown, raw: unknown) {
    if (!Number.isSafeInteger(expected) || Number(expected) < 0 || JSON.stringify(raw).length > 1024 * 1024) throw new TypeError("Invalid Connector configuration write");
    const value = parseConnectorConfiguration(raw);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.load();
      if (current.revision !== expected) { this.db.exec("ROLLBACK"); return { updated: false, record: current }; }
      const record = { revision: current.revision + 1, value };
      this.db.prepare("INSERT INTO connector_configuration VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value").run(record.revision, JSON.stringify(value));
      this.db.exec("COMMIT"); return { updated: true, record };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close() { this.db.close(); }
}
