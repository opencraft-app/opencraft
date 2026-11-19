import { createHash } from 'node:crypto';
import type { Migration } from './migrations.js';
import { SqliteLifecycleError } from './errors.js';


export interface StorageMigrationContract {
  readonly baseline: readonly { readonly version: number; readonly name: string; readonly checksum: string }[];
  readonly migrations: readonly Migration[];
}

/** Product-owned schemas supply generated contracts without entering core registry. */
export function resolveMigrationContract(id: string, legacy: readonly Migration[], store: StorageMigrationContract): readonly Migration[] {
  if (!store || legacy.length !== store.baseline.length || legacy.some((migration, index) => {
    const expected = store.baseline[index];
    return migration.version !== index + 1 || migration.name !== expected.name
      || createHash('sha256').update(migration.sql).digest('hex') !== expected.checksum;
  })) throw new SqliteLifecycleError('history-mismatch', `Published migration prefix differs for ${id}`);
  return [...legacy, ...store.migrations];
}
