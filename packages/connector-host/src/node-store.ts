// Node owner of the connector database file: opens it through the managed
// lifecycle (ledger, backups, recovery, known unledgered adoption) and lends
// the runtime-neutral store the SQL port over that connection.
import {
  createMissingLegacyObjects,
  nodeSqlDatabase,
  openManagedDatabase,
  type DatabaseOutcome,
} from "@opencraft/sqlite-node";
import { CONNECTOR_BASELINE, CONNECTOR_MIGRATIONS, SqlConnectorDatabase, type ConnectorStorage } from "./store";

export function openConnectorDatabase(path: string): ConnectorStorage<DatabaseOutcome> {
  const managed = openManagedDatabase({
    schemaId: "connector-host",
    path,
    migrations: CONNECTOR_MIGRATIONS,
    legacyMigration: createMissingLegacyObjects(CONNECTOR_BASELINE),
  });
  return {
    database: nodeSqlDatabase(managed.database),
    outcome: managed.outcome,
    close: () => managed.database.close(),
  };
}

/** The connector database at `path` on Node. */
export class ConnectorDatabase extends SqlConnectorDatabase<DatabaseOutcome> {
  constructor(path: string) {
    super(openConnectorDatabase(path));
  }
}
