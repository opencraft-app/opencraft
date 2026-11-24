// Node owner of the MCP apps database file: opens it through the managed
// lifecycle (ledger, backups, recovery, strict schema) and lends the
// runtime-neutral store the SQL port over that connection.
import { createHash } from "node:crypto";
import {
  createSchemaValidator,
  nodeSqlDatabase,
  openManagedDatabase,
  type DatabaseOutcome,
} from "@opencraft/sqlite-node";
import { appMigrations, appSchema, type AppStorage } from "./store";
import { McpAppsService } from "./server";

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

export function openMcpAppsDatabase(path: string): AppStorage<DatabaseOutcome> {
  const opened = openManagedDatabase({
    schemaId: "mcp-apps",
    path,
    legacyPolicy: "reject",
    validateSchema: createSchemaValidator(appSchema),
    migrations: appMigrations,
  });
  return {
    database: nodeSqlDatabase(opened.database),
    outcome: opened.outcome,
    close: () => opened.database.close(),
  };
}

export function openMcpAppsService(path: string): McpAppsService<DatabaseOutcome> {
  return new McpAppsService(openMcpAppsDatabase(path), { sha256Hex });
}
