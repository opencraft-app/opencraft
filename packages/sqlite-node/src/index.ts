export { openManagedDatabase, createMissingLegacyObjects, createSchemaValidator, type ManagedDatabaseOptions, type DatabaseOutcome } from "./lifecycle.js";
export { type Migration, schemaFingerprint } from "./migrations.js";
export { SqliteLifecycleError, type SqliteLifecycleErrorKind } from "./errors.js";
