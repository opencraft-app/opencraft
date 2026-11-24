import { createHash } from 'node:crypto';
import { nodeSqlDatabase, openManagedDatabase, type DatabaseOutcome } from '@opencraft/sqlite-node';
import { PUSH_MIGRATIONS, SqlPushStore, type PushStorage } from './sql-store';

export * from './sql-store';

const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');

/** Opens the push database file through the managed lifecycle (ledger, backups, recovery). */
export function openPushDatabase(path: string): PushStorage<DatabaseOutcome> {
  const managed = openManagedDatabase({schemaId:"web-push-node",path,migrations:PUSH_MIGRATIONS});
  return {database:nodeSqlDatabase(managed.database),outcome:managed.outcome,close:()=>managed.database.close()};
}

/** The Node owner of the push database file; it runs in the push storage Worker (`openPushStore`). */
export class PushStore extends SqlPushStore<DatabaseOutcome> {
  constructor(path: string, now: () => number = Date.now) {
    super(openPushDatabase(path), {sha256Hex, now});
  }
}
