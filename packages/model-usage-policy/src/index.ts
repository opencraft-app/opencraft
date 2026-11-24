// Node owner of model-usage-policy.sqlite. The store itself is runtime-neutral
// (store.ts); this entry opens the file through the managed SQLite lifecycle and
// keeps the Node readers (native.mjs) next to it.
import { openManagedDatabase, createSchemaValidator, nodeSqlDatabase } from "@opencraft/sqlite-node";
import {
  MODEL_POLICY_SCHEMA,
  modelPolicyMigrations,
  ModelPolicyStore as SqlModelPolicyStore,
  type ModelPolicyDatabase,
} from "./store.js";
export * from "./native.mjs";
export { MODEL_POLICY_SCHEMA, modelPolicyMigrations, type ModelPolicyDatabase, type ModelPolicyOutcome } from "./store.js";

/** Opens and migrates the policy file; the caller owns the returned handle. */
export function openModelPolicyDatabase(path: string): ModelPolicyDatabase {
  const managed = openManagedDatabase({
    schemaId: "model-usage-policy",
    path,
    migrations: [...modelPolicyMigrations],
    legacyPolicy: "reject",
    validateSchema: createSchemaValidator(MODEL_POLICY_SCHEMA),
  });
  return { database: nodeSqlDatabase(managed.database), outcome: managed.outcome, close: () => managed.database.close() };
}

/** The policy store over a file path (opened here) or a database another owner migrated. */
export class ModelPolicyStore extends SqlModelPolicyStore {
  constructor(path: string | ModelPolicyDatabase) {
    super(typeof path === "string" ? openModelPolicyDatabase(path) : path);
  }
}
