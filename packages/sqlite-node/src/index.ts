export { openManagedDatabase, verifyManagedDatabaseHistory, createMissingLegacyObjects, createSchemaValidator, type ManagedDatabaseOptions, type DatabaseOutcome } from "./lifecycle.js";
export { type Migration, schemaFingerprint, transaction as sqliteTransaction } from "./migrations.js";
export { SqliteLifecycleError, type SqliteLifecycleErrorKind } from "./errors.js";
export { durableJson, assertRecoveryState } from "./recovery.js";
export { acquireProcessWriter } from './writer-lock.js';
export { retireManagedDatabase, retiredInto, type BorrowedDatabase } from "./retire.js";

export { resolveStoreMigrations, resolveMigrationContract, type StorageMigrationContract, type StorageSchemaId } from "./store-migrations.js";

export { captureSqliteReadGuard } from "./read-guard.js";

export { selectMigrationHistory, type MigrationHistory } from "./history-selection.js";
export { assertAppendOnlyMigrationHistories } from "./history-append-only.js";
