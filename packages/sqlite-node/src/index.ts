export { openManagedDatabase, verifyManagedDatabaseHistory, createMissingLegacyObjects, createSchemaValidator, type ManagedDatabaseOptions, type DatabaseOutcome } from "./lifecycle.js";
export { type Migration, schemaFingerprint, transaction as sqliteTransaction } from "./migrations.js";
export { SqliteLifecycleError, type SqliteLifecycleErrorKind } from "./errors.js";
export { durableJson, assertRecoveryState } from "./recovery.js";
export { acquireProcessWriter } from './writer-lock.js';
