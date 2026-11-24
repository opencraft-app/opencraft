// The model gateway's Node owner: the shared local SQLite file named by
// OPENCRAFT_MODEL_GATEWAY_DATABASE, opened by the managed lifecycle with a busy
// timeout for the other processes using it. The domain is runtime-neutral
// (model-gateway.ts); this module only opens the file and keeps the historical
// path-taking constructor every Node caller uses.
import { isAbsolute } from "node:path";
import { openManagedDatabase, createSchemaValidator, nodeSqlDatabase } from "@opencraft/sqlite-node";
import {
  ModelGatewayError,
  ModelGatewayStore as SqlModelGatewayStore,
  modelGatewayMigrations,
  type ModelGatewayDatabase,
} from "./model-gateway.js";

export * from "./model-gateway.js";

/** Node owner: the shared local SQLite file, with a busy timeout for the other processes using it. */
export function openModelGatewayDatabase(path: string): ModelGatewayDatabase {
  if (path !== ":memory:" && !isAbsolute(path)) throw new ModelGatewayError("gateway_path_must_be_absolute", 503);
  const managed = openManagedDatabase({
    schemaId: "model-gateway",
    path,
    migrations: [...modelGatewayMigrations],
    legacyPolicy: "reject",
    validateSchema: createSchemaValidator(modelGatewayMigrations.map((migration) => migration.sql).join("")),
  });
  managed.database.exec("PRAGMA busy_timeout=5000");
  return { database: nodeSqlDatabase(managed.database), outcome: managed.outcome, close: () => managed.database.close() };
}

/** The gateway store over a file path (opened here) or a database another owner migrated. */
export class ModelGatewayStore extends SqlModelGatewayStore {
  constructor(path: string | ModelGatewayDatabase, now = Date.now) {
    super(typeof path === "string" ? openModelGatewayDatabase(path) : path, now);
  }
}

export function configuredModelGatewayPath(): string | undefined {
  const path = process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
  if (path !== undefined && !isAbsolute(path)) throw new ModelGatewayError("gateway_path_must_be_absolute", 503);
  return path;
}
