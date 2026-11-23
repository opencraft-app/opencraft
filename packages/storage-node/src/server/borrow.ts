import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { nodeSqlDatabase } from '@opencraft/sqlite-node';
import { DEFAULT_SERVER_MIGRATION_COMPOSITION } from './migration-composition.js';

const SERVER_DATA_CONTRACT = DEFAULT_SERVER_MIGRATION_COMPOSITION.contract;
import type { ServerDatabaseSource } from './repository.js';

/** A child process borrows an already migrated installation. It cannot bootstrap,
 * import, acquire ownership, or recover its parent's database. */
export interface BorrowOptions {
  /** The contract version the owner opened; defaults to this build's contract. */
  readonly migrationVersion?: number;
  /** Child processes enforce foreign keys; the owner's own process keeps its connection settings. */
  readonly foreignKeys?: boolean;
  readonly busyTimeoutMs?: number;
}
export function borrowServerDatabase(directory: string, options: BorrowOptions = {}): Exclude<ServerDatabaseSource,string> & { close(): void } {
  const migrationVersion = options.migrationVersion ?? SERVER_DATA_CONTRACT.migrationVersion;
  const location = join(directory,'opencraft-server.sqlite');
  const db = new DatabaseSync(location, {open:false});
  // Never create an empty installation when the owning process has not prepared it.
  const probe = new DatabaseSync(location, {readOnly:true});
  try {
    const version=Number(probe.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version);
    if(version!==migrationVersion)throw Error('Server storage owner must migrate before borrowing');
    if(probe.prepare('PRAGMA journal_mode').get()?.journal_mode!=='wal')throw Error('Borrowed Server storage requires WAL');
  } finally {probe.close();}
  try {
    db.open();
    if (options.foreignKeys !== false) db.exec('PRAGMA foreign_keys=ON');
    if (options.busyTimeoutMs !== undefined) db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(options.busyTimeoutMs))}`);
    return {database:nodeSqlDatabase(db),location,outcome:{status:'up-to-date',appliedVersion:migrationVersion,movedAsidePaths:[]},close:()=>db.close()};
  }
  catch(error){db.close();throw error;}
}
