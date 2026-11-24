// Node owner of `tasks.sqlite`: the managed lifecycle (ledger, backups,
// recovery, schema validation) around the runtime-neutral `SqlTasksStore`.
import {
  createSchemaValidator,
  nodeSqlDatabase,
  openManagedDatabase,
  type DatabaseOutcome,
} from "@opencraft/sqlite-node";
import { SqlTasksStore, TASKS_MIGRATIONS } from "./sqlite";

export * from "./sqlite";

export class TasksSqliteStore extends SqlTasksStore {
  readonly outcome: DatabaseOutcome;
  readonly #close: () => void;
  constructor(path: string, now: () => number = Date.now) {
    // node:sqlite enforces foreign keys by default (`enableForeignKeyConstraints`).
    const managed = openManagedDatabase({
      schemaId: "tasks",
      path,
      legacyPolicy: "reject",
      validateSchema: createSchemaValidator(TASKS_MIGRATIONS.map((migration) => migration.sql).join("")),
      migrations: TASKS_MIGRATIONS,
    });
    super(nodeSqlDatabase(managed.database), now);
    this.outcome = managed.outcome;
    this.#close = () => managed.database.close();
  }
  close(): void {
    this.#close();
  }
}
